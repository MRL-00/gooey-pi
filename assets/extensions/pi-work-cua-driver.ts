/**
 * Extension-host CUA Driver MCP proxy.
 *
 * Prime uses its Python integration skill. OMP and base pi share this bundled
 * compact proxy so Computer Use has identical enable/disable semantics and the
 * driver receives only a narrow OS environment. The separately installed
 * driver starts only for the duration of a call.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

interface PiTypebox {
  Object(properties: Record<string, unknown>): unknown
  String(options?: Record<string, unknown>): unknown
}

interface PiToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
}

export interface PiCuaExtensionApi {
  typebox?: { Type: PiTypebox }
  registerTool<Params>(tool: {
    name: string
    label: string
    description: string
    parameters: unknown
    executionMode: 'sequential'
    execute(toolCallId: string, params: Params, signal?: AbortSignal): Promise<PiToolResult>
  }): void
}

interface RpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

const MAX_ARGUMENT_BYTES = 256 * 1024
const MAX_PROTOCOL_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000
const DRIVER_ENV_KEYS = [
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'USERNAME', 'PROGRAMDATA',
  '__CF_USER_TEXT_ENCODING',
] as const

async function importHostModule(specifier: string): Promise<Record<string, unknown> | undefined> {
  try { return (await import(specifier)) as Record<string, unknown> } catch { return undefined }
}

async function resolveTypebox(): Promise<PiTypebox> {
  const hostType = (await importHostModule('typebox'))?.Type as PiTypebox | undefined
  return hostType ?? {
    Object: (properties) => ({ type: 'object', properties, required: Object.keys(properties) }),
    String: (options) => ({ type: 'string', ...(options ?? {}) }),
  }
}

function executable(): string {
  const path = process.env.GOOEYPI_CUA_DRIVER_PATH
  if (!path) throw new Error('Cua Driver is not enabled. Turn on CUA Driver MCP and Computer Use in GooeyPi Plugins.')
  return path
}

function parseArguments(value: string): Record<string, unknown> {
  if (Buffer.byteLength(value, 'utf8') > MAX_ARGUMENT_BYTES) throw new TypeError('argumentsJson is too large')
  let parsed: unknown
  try { parsed = value.trim() ? JSON.parse(value) : {} } catch { throw new TypeError('argumentsJson must be valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('argumentsJson must contain a JSON object')
  return parsed as Record<string, unknown>
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function driverEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of DRIVER_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

async function callDriver(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new Error('Cua Driver MCP call was cancelled')
  const child = spawn(executable(), ['mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    env: driverEnvironment(),
  })
  let buffer = ''
  let protocolBytes = 0
  let stderr = ''
  let nextId = 1
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let fatalError: Error | null = null

  const fail = (error: Error) => {
    if (fatalError) return
    fatalError = error
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
    child.kill()
  }
  child.stdout.on('data', (chunk: Buffer) => {
    protocolBytes += chunk.length
    if (protocolBytes > MAX_PROTOCOL_BYTES) { fail(new Error('Cua Driver MCP output exceeded the supported limit')); return }
    buffer += chunk.toString('utf8')
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let response: RpcResponse
      try { response = JSON.parse(line) as RpcResponse } catch { fail(new Error('Cua Driver MCP returned invalid JSON')); return }
      if (!Number.isSafeInteger(response.id)) continue
      const waiter = pending.get(response.id)
      if (!waiter) continue
      pending.delete(response.id)
      if (response.error) waiter.reject(new Error(response.error.message || `Cua Driver MCP error ${response.error.code ?? 'unknown'}`))
      else waiter.resolve(response.result)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 8_192) stderr += chunk.toString('utf8').slice(0, 8_192 - stderr.length)
  })
  child.stdin.on('error', (error) => fail(error))
  child.stdout.on('error', (error) => fail(error))
  child.stderr.on('error', (error) => fail(error))
  child.on('error', (error) => fail(error))
  child.on('exit', (code) => {
    if (pending.size) fail(new Error(`Cua Driver MCP exited with code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
  })

  const request = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (fatalError) return Promise.reject(fatalError)
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      writeMessage(child, { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
    })
  }
  const abort = () => fail(new Error('Cua Driver MCP call was cancelled'))
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => fail(new Error('Cua Driver MCP call timed out')), REQUEST_TIMEOUT_MS)
  try {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'gooeypi-cua-driver', version: '1.0.0' },
    })
    writeMessage(child, { jsonrpc: '2.0', method: 'notifications/initialized' })
    return tool === 'list_tools'
      ? await request('tools/list')
      : await request('tools/call', { name: tool, arguments: args })
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    child.kill()
  }
}

export default function (pi: PiCuaExtensionApi): void | Promise<void> {
  const injected = pi.typebox?.Type
  if (injected) { registerTool(pi, injected); return }
  return resolveTypebox().then((Type) => { registerTool(pi, Type) })
}

function registerTool(pi: PiCuaExtensionApi, Type: PiTypebox): void {
  pi.registerTool<{ tool: string; argumentsJson: string }>({
    name: 'cua_driver_mcp',
    label: 'CUA Driver MCP',
    description: 'Discover and call the separately installed Cua Driver MCP tools. Call with tool="list_tools" first, then pass an advertised tool name and a JSON object string matching its live input schema.',
    parameters: Type.Object({
      tool: Type.String({ description: 'Use list_tools to discover the live surface, or an exact advertised tool name.' }),
      argumentsJson: Type.String({ description: 'A JSON object string for the selected tool. Use {} for list_tools or tools with no arguments.' }),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      const tool = params.tool.trim()
      if (!tool || tool.length > 200) throw new TypeError('tool must be a non-empty name of at most 200 characters')
      const result = await callDriver(tool, parseArguments(params.argumentsJson), signal)
      const text = JSON.stringify(result)
      return { content: [{ type: 'text', text }], details: { tool, result } }
    },
  })
}
