import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { canonicalSessionPath } from '../session-paths'
import { requireRecord, requireString } from '../validation'
import type { AgentBrowserService } from './agent-service'

const MAX_BODY_BYTES = 1_100_000
const TOKEN_TTL_MS = 24 * 60 * 60_000
const RATE_WINDOW_MS = 60_000
// Browser driving is chattier than scheduling: a single agent turn can issue
// dozens of read/act/verify calls.
const RATE_LIMIT = 240

interface CapabilityClaim {
  token: string
  cwd: string
  sessionPath?: string
  expiresAt: number
  windowStartedAt: number
  requests: number
}

export interface AgentBrowserBridgeOptions {
  service: AgentBrowserService
  extensionPath: string
  skillPath: string
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' })
  response.end(payload)
}

/**
 * Loopback capability broker for the agent-side browser tools. Mirrors
 * AgentScheduleBridge: a random bearer token per runtime, injected via the
 * child environment, scopes every call to that runtime's session. The
 * renderer never sees the token.
 */
export class AgentBrowserBridge {
  private server: Server | null = null
  private port = 0
  private readonly claims = new Map<string, CapabilityClaim>()

  constructor(private readonly options: AgentBrowserBridgeOptions) {}

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((request, response) => { void this.handle(request, response) })
    this.server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolveStart, reject) => {
      const server = this.server!
      const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
      const onListening = () => { server.off('error', onError); resolveStart() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    this.port = (this.server.address() as AddressInfo).port
  }

  environmentFor(scope: { cwd: string; sessionPath?: string }): NodeJS.ProcessEnv {
    if (!this.server || !this.port) return {}
    this.pruneClaims()
    const token = randomBytes(32).toString('base64url')
    this.claims.set(token, { token, ...scope, expiresAt: Date.now() + TOKEN_TTL_MS, windowStartedAt: Date.now(), requests: 0 })
    return {
      PRIME_WORK_BROWSER_URL: `http://127.0.0.1:${this.port}/v1/call`,
      PRIME_WORK_BROWSER_TOKEN: token,
      PRIME_WORK_BROWSER_EXTENSION_PATH: this.options.extensionPath,
      PRIME_WORK_BROWSER_SKILL_PATH: this.options.skillPath,
    }
  }

  /**
   * Runtimes started without --resume only learn their session file at
   * handshake; the manager reports it here so the claim gains its session
   * scope. An existing scope is never overwritten.
   */
  bindSession(token: string | undefined, sessionFile: string | undefined): void {
    if (!token || !sessionFile) return
    const claim = this.claims.get(token)
    if (claim && !claim.sessionPath) claim.sessionPath = sessionFile
  }

  async stop(): Promise<void> {
    this.claims.clear()
    const server = this.server
    this.server = null
    this.port = 0
    if (!server) return
    await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/call' || request.headers.origin !== undefined) {
        send(response, 404, { ok: false, error: 'Not found' }); return
      }
      const authorization = request.headers.authorization
      if (!authorization?.startsWith('Bearer ')) { send(response, 401, { ok: false, error: 'Unauthorized' }); return }
      const presented = authorization.slice(7)
      const claim = [...this.claims.values()].find((candidate) => safeEqual(candidate.token, presented))
      if (!claim || claim.expiresAt <= Date.now()) { send(response, 401, { ok: false, error: 'Capability expired' }); return }
      if (Date.now() - claim.windowStartedAt >= RATE_WINDOW_MS) { claim.windowStartedAt = Date.now(); claim.requests = 0 }
      claim.requests += 1
      if (claim.requests > RATE_LIMIT) { send(response, 429, { ok: false, error: 'Browser API rate limit exceeded; slow down and retry shortly' }); return }
      const raw = await this.readBody(request)
      const input = requireRecord(JSON.parse(raw), 'request')
      const method = requireString(input.method, 'method', { min: 1, max: 32, trim: true })
      const params = input.params === undefined ? {} : requireRecord(input.params, 'params')
      if (!claim.sessionPath) throw new Error('Browser control is not available yet for this thread; try again in a moment')
      const sessionKey = canonicalSessionPath(claim.sessionPath)
      const result = await this.call(method, params, sessionKey)
      send(response, 200, { ok: true, result })
    } catch (error) {
      send(response, error instanceof SyntaxError || error instanceof TypeError ? 400 : 409, {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000),
      })
    }
  }

  private call(method: string, params: Record<string, unknown>, sessionKey: string): Promise<Record<string, unknown>> {
    const service = this.options.service
    if (method === 'tabs.list') return service.listTabs(sessionKey)
    if (method === 'tabs.open') return service.openTab(sessionKey, params)
    if (method === 'tabs.close') return service.closeTabScoped(sessionKey, params)
    if (method === 'tabs.select') return service.selectTabScoped(sessionKey, params)
    if (method === 'navigate') return service.navigate(sessionKey, params)
    if (method === 'screenshot') return service.screenshot(sessionKey, params)
    if (method === 'click') return service.click(sessionKey, params)
    if (method === 'type') return service.type(sessionKey, params)
    if (method === 'press_key') return service.pressKey(sessionKey, params)
    if (method === 'scroll') return service.scroll(sessionKey, params)
    if (method === 'read_page') return service.readPage(sessionKey, params)
    if (method === 'evaluate') return service.evaluate(sessionKey, params)
    throw new TypeError(`Unsupported browser method ${method}`)
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolveBody, reject) => {
      const chunks: Buffer[] = []
      let bytes = 0
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) { reject(new TypeError('Request body is too large')); request.destroy(); return }
        chunks.push(chunk)
      })
      request.once('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
      request.once('error', reject)
    })
  }

  private pruneClaims(): void {
    const now = Date.now()
    for (const [token, claim] of this.claims) if (claim.expiresAt <= now) this.claims.delete(token)
  }
}
