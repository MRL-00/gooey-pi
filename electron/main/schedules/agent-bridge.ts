import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { AutomationScheduleRecord, ScheduleInput, SchedulePatch, ScheduleTarget } from '../../../src/types/api'
import type { AutomationService } from './service'
import { isRecord, requireRecord, requireString } from '../validation'

const MAX_BODY_BYTES = 1_100_000
const TOKEN_TTL_MS = 24 * 60 * 60_000
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 60

interface CapabilityClaim {
  token: string
  cwd: string
  sessionPath?: string
  expiresAt: number
  windowStartedAt: number
  requests: number
}

interface AgentScheduleScope {
  projectId: string
  sessionId?: string
}

export interface AgentScheduleBridgeOptions {
  service: AutomationService
  skillPath: string
  resolveScope(input: { cwd: string; sessionPath?: string }): Promise<AgentScheduleScope>
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

function taskInScope(task: AutomationScheduleRecord, scope: AgentScheduleScope): boolean {
  return task.target.projectId === scope.projectId && (task.target.kind === 'project' || task.target.sessionId === scope.sessionId)
}

export class AgentScheduleBridge {
  private server: Server | null = null
  private port = 0
  private readonly claims = new Map<string, CapabilityClaim>()

  constructor(private readonly options: AgentScheduleBridgeOptions) {}

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
      PRIME_WORK_SCHEDULE_URL: `http://127.0.0.1:${this.port}/v1/call`,
      PRIME_WORK_SCHEDULE_TOKEN: token,
      PRIME_WORK_SCHEDULE_SKILL_PATH: this.options.skillPath,
    }
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
      if (claim.requests > RATE_LIMIT) { send(response, 429, { ok: false, error: 'Schedule API rate limit exceeded' }); return }
      const raw = await this.readBody(request)
      const input = requireRecord(JSON.parse(raw), 'request')
      const method = requireString(input.method, 'method', { min: 1, max: 32, trim: true })
      const params = input.params === undefined ? {} : requireRecord(input.params, 'params')
      const scope = await this.options.resolveScope({ cwd: claim.cwd, sessionPath: claim.sessionPath })
      const result = await this.call(method, params, scope)
      send(response, 200, { ok: true, result })
    } catch (error) {
      send(response, error instanceof SyntaxError || error instanceof TypeError ? 400 : 409, {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000),
      })
    }
  }

  private async call(method: string, params: Record<string, unknown>, scope: AgentScheduleScope): Promise<unknown> {
    if (method === 'list') return this.options.service.list().filter((task) => taskInScope(task, scope))
    if (method === 'create') {
      const raw = requireRecord(params.input, 'input')
      const targetName = requireString(params.target, 'target', { min: 1, max: 32, trim: true })
      let target: ScheduleTarget
      if (targetName === 'current_project') target = { kind: 'project', projectId: scope.projectId }
      else if (targetName === 'current_session' && scope.sessionId) target = { kind: 'session', projectId: scope.projectId, sessionId: scope.sessionId }
      else throw new TypeError('target must be current_project or an available current_session')
      const input: ScheduleInput = {
        title: typeof raw.title === 'string' ? raw.title : undefined,
        prompt: raw.prompt as string,
        timing: raw.timing as ScheduleInput['timing'],
        execution: raw.execution as ScheduleInput['execution'],
        target,
      }
      return this.options.service.create(input, 'agent')
    }
    const id = requireString(params.id, 'id', { min: 1, max: 256, trim: true })
    const task = this.options.service.get(id)
    if (!taskInScope(task, scope)) throw new Error('Scheduled task is outside this agent capability')
    if (method === 'pause') return this.options.service.pause(id)
    if (method === 'resume') return this.options.service.resume(id)
    if (method === 'delete') return this.options.service.delete(id)
    if (method === 'run_now') return this.options.service.runNow(id)
    if (method === 'update') {
      const rawPatch = requireRecord(params.patch, 'patch')
      if (rawPatch.target !== undefined) throw new TypeError('Agents cannot retarget an existing scheduled task')
      const patch: SchedulePatch = { ...rawPatch, revision: task.revision }
      return this.options.service.update(id, patch)
    }
    throw new TypeError(`Unsupported schedule method ${method}`)
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
