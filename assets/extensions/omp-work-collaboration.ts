/** Shared GooeyPi session-collaboration tools for Prime Agent, OMP, and pi. */

interface SchemaOptions { description?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }
interface HostTypebox {
  Object(properties: Record<string, unknown>, options?: SchemaOptions): unknown
  String(options?: SchemaOptions): unknown
  Number(options?: SchemaOptions): unknown
  Optional(schema: unknown): unknown
}
interface ToolResult { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }
interface ExtensionApi {
  typebox?: { Type: HostTypebox }
  registerTool<Params>(tool: {
    name: string
    label: string
    description: string
    parameters: unknown
    execute(id: string, params: Params): Promise<ToolResult>
  }): void
}

async function importHostModule(specifier: string): Promise<Record<string, unknown> | undefined> {
  try { return (await import(specifier)) as Record<string, unknown> } catch { return undefined }
}

async function resolveHostTypebox(): Promise<HostTypebox> {
  const Type = (await importHostModule('typebox'))?.Type as HostTypebox | undefined
  if (Type) return Type
  const optional = new WeakSet<object>()
  return {
    Object: (properties, options) => ({
      type: 'object', properties,
      required: Object.entries(properties).filter(([, value]) => typeof value !== 'object' || value === null || !optional.has(value)).map(([key]) => key),
      ...(options ?? {}),
    }),
    String: (options) => ({ type: 'string', ...(options ?? {}) }),
    Number: (options) => ({ type: 'number', ...(options ?? {}) }),
    Optional: (schema) => { if (typeof schema === 'object' && schema !== null) optional.add(schema); return schema },
  }
}

interface BridgeResult { ok: boolean; result?: unknown; error?: string }
const BRIDGE_URL = process.env.GOOEYPI_COLLABORATION_URL
const BRIDGE_TOKEN = process.env.GOOEYPI_COLLABORATION_TOKEN

async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) throw new Error('GooeyPi session collaboration is not available in this runtime')
  let response: Response
  try {
    response = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
  } catch (error) {
    throw new Error(`GooeyPi's session collaboration broker is not reachable: ${String(error)}`)
  }
  const body = (await response.json()) as BridgeResult
  if (!body.ok) throw new Error(body.error || `Session collaboration call failed with status ${response.status}`)
  return body.result
}

function result(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], details: {} }
}

export default function (pi: ExtensionApi): void | Promise<void> {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) return
  const injected = pi.typebox?.Type
  if (injected) { registerTools(pi, injected); return }
  return resolveHostTypebox().then((Type) => { registerTools(pi, Type) })
}

function registerTools(pi: ExtensionApi, Type: HostTypebox): void {
  const target = Type.String({ description: 'Exact session UUID from an @session reference, Copy session UUID, session_list, or from_session_id in an incoming GooeyPi agent message' })

  pi.registerTool({
    name: 'session_list',
    label: 'List sessions',
    description: 'List other GooeyPi sessions in this working directory. Results include title, UUID, harness, status, and whether the session is live. Use an exact UUID with the other session tools.',
    parameters: Type.Object({}),
    async execute() { return result(await call('list')) },
  })
  pi.registerTool<{ target_session_id: string }>({
    name: 'session_read',
    label: 'Read session',
    description: 'Read bounded recent context from another GooeyPi session in this working directory without modifying its transcript.',
    parameters: Type.Object({ target_session_id: target }),
    async execute(_id, params) { return result(await call('read', params)) },
  })
  pi.registerTool<{ target_session_id: string; message: string }>({
    name: 'session_send',
    label: 'Message session',
    description: 'Send an attributed background message to another GooeyPi session in this working directory. For an incoming agent message, reply directly to its from_session_id; its signed reply_with field names this tool, so no session listing is needed. GooeyPi safely wakes an idle saved session when needed. This returns after delivery; call session_wait with cursor_before to wait for its response. Never busy-wait or create mutual waits.',
    parameters: Type.Object({
      target_session_id: target,
      message: Type.String({ minLength: 1, maxLength: 64 * 1024, description: 'The concise message or coordination request to send' }),
    }),
    async execute(_id, params) { return result(await call('send', params)) },
  })
  pi.registerTool<{ target_session_id: string; after_cursor?: string; timeout_ms?: number }>({
    name: 'session_wait',
    label: 'Wait for session',
    description: 'Wait briefly for another GooeyPi session to become idle and produce context after a cursor. Returns a bounded snapshot and timed_out; call again only when continued waiting is useful.',
    parameters: Type.Object({
      target_session_id: target,
      after_cursor: Type.Optional(Type.String({ description: 'cursor_before returned by session_send, or cursor returned by session_read/session_wait' })),
      timeout_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 30_000, description: 'Maximum wait, default 15000 and hard-capped at 30000' })),
    }),
    async execute(_id, params) { return result(await call('wait', params)) },
  })
}

export type OmpExtensionApi = ExtensionApi
