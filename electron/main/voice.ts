import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AppSettings,
  HarnessId,
  ProjectRecord,
  VoiceCredentialProvider,
  VoiceCredentialStatus,
  VoiceTaskStarted,
  VoiceToolResult,
} from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import type { ProcessResult } from './process-utils'
import type { ProjectService } from './projects'
import { isRecord, requireExistingPath, requireId, requireRecord, requireString } from './validation'

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_SECRET_BYTES = 16 * 1024
const MAX_SDP_BYTES = 256 * 1024
const REMOTE_TIMEOUT_MS = 90_000

interface SecretCodec {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface SecretFile {
  version: 1
  secrets: Partial<Record<VoiceCredentialProvider, string>>
}

interface VoiceServiceOptions {
  secretPath: string
  secretCodec: SecretCodec
  settings(): AppSettings
  projects: Record<HarnessId, ProjectService>
  agents: Record<HarnessId, AgentRpcManager>
  fetch?: typeof fetch
  runProcess(file: string, args: readonly string[], options?: { timeoutMs?: number; maxBytes?: number }): Promise<ProcessResult>
  environment?: NodeJS.ProcessEnv
}

function credentialProvider(value: unknown): VoiceCredentialProvider {
  if (value !== 'openai' && value !== 'groq' && value !== 'deepgram') throw new TypeError('Invalid voice credential provider')
  return value
}

function harnessId(value: unknown): HarnessId {
  if (value !== 'prime' && value !== 'omp') throw new TypeError('Invalid voice harness')
  return value
}

function boundedAudio(value: unknown): Uint8Array {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer ? new Uint8Array(value) : null
  if (!bytes || bytes.byteLength < 44 || bytes.byteLength > MAX_AUDIO_BYTES) throw new TypeError('Audio must be a WAV buffer no larger than 25 MB')
  return bytes
}

function cleanText(value: unknown, label: string, max = 1_000_000): string {
  return requireString(value, label, { min: 1, max, trim: true })
}

function localContext(harness: HarnessId): Record<string, string> {
  const now = new Date()
  const resolved = Intl.DateTimeFormat().resolvedOptions()
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0')
  const timeZoneParts = resolved.timeZone.split('/')
  const timeZoneCity = timeZoneParts.length > 1 ? timeZoneParts.at(-1)?.replaceAll('_', ' ') : undefined
  const countryCode = new Intl.Locale(resolved.locale).region
  const locationHint = [timeZoneCity, countryCode].filter(Boolean).join(', ')
  return {
    local_time: new Intl.DateTimeFormat(resolved.locale, { dateStyle: 'full', timeStyle: 'long', timeZone: resolved.timeZone }).format(now),
    iso_time: now.toISOString(),
    time_zone: resolved.timeZone,
    utc_offset: `${sign}${hours}:${minutes}`,
    locale: resolved.locale,
    active_harness: harness,
    ...(timeZoneCity ? { time_zone_city: timeZoneCity } : {}),
    ...(countryCode ? { country_code: countryCode } : {}),
    ...(locationHint ? { location_hint: locationHint } : {}),
    location_precision: timeZoneCity ? 'time-zone-derived approximation' : 'country or time-zone only',
  }
}

class VoiceSecretStore {
  private loaded = false
  private values: SecretFile['secrets'] = {}
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly codec: SecretCodec,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.secrets)) return
      for (const provider of ['openai', 'groq', 'deepgram'] as const) {
        const encrypted = raw.secrets[provider]
        if (typeof encrypted === 'string' && encrypted.length <= MAX_SECRET_BYTES * 4) this.values[provider] = encrypted
      }
    } catch { /* a missing or malformed secret file starts empty */ }
  }

  private environmentKey(provider: VoiceCredentialProvider): string | undefined {
    const key = this.environment[provider === 'openai' ? 'OPENAI_API_KEY' : provider === 'groq' ? 'GROQ_API_KEY' : 'DEEPGRAM_API_KEY']
    return key?.trim() || undefined
  }

  async status(): Promise<VoiceCredentialStatus> {
    await this.load()
    const configured = { openai: false, groq: false, deepgram: false }
    const source: VoiceCredentialStatus['source'] = {}
    for (const provider of ['openai', 'groq', 'deepgram'] as const) {
      if (this.values[provider]) { configured[provider] = true; source[provider] = 'saved' }
      else if (this.environmentKey(provider)) { configured[provider] = true; source[provider] = 'environment' }
    }
    return { configured, source }
  }

  async get(provider: VoiceCredentialProvider): Promise<string> {
    await this.load()
    const encrypted = this.values[provider]
    if (encrypted) {
      try { return this.codec.decrypt(Buffer.from(encrypted, 'base64')) }
      catch { throw new Error(`The saved ${provider} voice key could not be decrypted. Save it again in Voice settings.`) }
    }
    const fromEnvironment = this.environmentKey(provider)
    if (fromEnvironment) return fromEnvironment
    throw new Error(`Add a ${provider} API key in Settings → Voice.`)
  }

  async save(providerValue: unknown, keyValue: unknown): Promise<VoiceCredentialStatus> {
    const provider = credentialProvider(providerValue)
    const key = requireString(keyValue, 'apiKey', { min: 1, max: MAX_SECRET_BYTES, trim: true })
    await this.load()
    if (!this.codec.available()) throw new Error('Secure credential storage is unavailable on this system')
    this.values[provider] = this.codec.encrypt(key).toString('base64')
    await this.persist()
    return this.status()
  }

  async delete(providerValue: unknown): Promise<VoiceCredentialStatus> {
    const provider = credentialProvider(providerValue)
    await this.load()
    delete this.values[provider]
    await this.persist()
    return this.status()
  }

  private persist(): Promise<void> {
    const snapshot: SecretFile = { version: 1, secrets: { ...this.values } }
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
      await rename(temporary, this.path)
    })
    this.writeQueue = operation.catch(() => undefined)
    return operation
  }
}

function orchestrationInstructions(harness: HarnessId): string {
  const harnessName = harness === 'omp' ? 'OMP' : 'Prime Agent'
  return [
    'You are the voice orchestrator inside Prime Work, a desktop client for Prime Agent and OMP.',
    `This voice session is locked to the currently selected ${harnessName} harness. Never switch harnesses.`,
    'Be concise and conversational. Answer general questions directly.',
    'Use get_local_context for the local date, time, time zone, approximate location, locale, or selected harness. Use search_web for current information. Use list_projects to resolve a project within the selected harness.',
    'For local weather or another location-sensitive lookup when the user did not name a place: first call get_local_context, then call search_web with its location_hint included in the query. Do not ask the user for a location unless get_local_context returns no usable location_hint. Treat the hint as approximate.',
    'Call start_task only when the user explicitly asks you to start, create, kick off, delegate, or run a task.',
    'An explicit request to start work is sufficient authorization. Do not ask for a second confirmation.',
    'Only start tasks inside projects returned by list_projects. Never invent project IDs.',
    'Treat session creation, project selection, and harness selection as orchestration instructions for you, not as part of the delegated prompt.',
    'Rewrite the start_task prompt as a clean, self-contained task containing only the actual goal, useful constraints, and requested output. Do not include phrases such as start a session, create a thread, ask the agent, you are an agent, or working inside the project. Do not add generic process advice the user did not request.',
    'Example: "Start a new session in the Prime project workspace. Ask what the next logical feature to add should be" becomes the task prompt "Determine the next logical feature to add to this project and explain why."',
    'When the user asks to start work, you must call start_task. Never say a task started unless start_task returned started true.',
    'After starting a task, say which project and harness received it.',
  ].join(' ')
}

function realtimeSession(settings: AppSettings, harness: HarnessId): Record<string, unknown> {
  return {
    type: 'realtime',
    model: settings.voiceRealtimeModel,
    instructions: orchestrationInstructions(harness),
    audio: { output: { voice: settings.voiceRealtimeVoice } },
    tool_choice: 'auto',
    tools: [
      {
        type: 'function', name: 'list_projects',
        description: `Find explicitly granted projects in the currently selected ${harness === 'omp' ? 'OMP' : 'Prime Agent'} harness. Projects from the other harness are never returned.`,
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'Optional project-name search.' },
          },
        },
      },
      {
        type: 'function', name: 'start_task',
        description: `Immediately create and start a new task in the currently selected ${harness === 'omp' ? 'OMP' : 'Prime Agent'} harness after an explicit request. The prompt must contain only the delegated work, never voice-orchestration or routing instructions.`,
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            project_id: { type: 'string', description: 'An exact ID returned by list_projects.' },
            prompt: { type: 'string', description: 'A concise, self-contained task with the actual goal, useful user constraints, and requested output. Exclude session/thread creation, project/harness routing, agent-role preambles, and generic filler.' },
            title: { type: 'string', description: 'Optional concise title describing only the delegated work.' },
          },
          required: ['project_id', 'prompt'],
        },
      },
      {
        type: 'function', name: 'get_local_context',
        description: 'Get the local date, time, time zone, timezone-derived approximate location hint, locale, UTC offset, and selected harness. Call this before local weather or another location-sensitive lookup when the user did not name a place.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      {
        type: 'function', name: 'search_web',
        description: 'Search the live web for a quick current-information question and return a cited answer. For local weather with no named place, first call get_local_context and include its location_hint in this query.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
  }
}

function transcriptionSession(settings: AppSettings): Record<string, unknown> {
  return {
    type: 'transcription',
    audio: {
      input: {
        transcription: { model: settings.voiceOpenAiLiveTranscriptionModel, delay: 'low' },
        turn_detection: null,
      },
    },
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export class VoiceService {
  private readonly secrets: VoiceSecretStore
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: VoiceServiceOptions) {
    this.secrets = new VoiceSecretStore(options.secretPath, options.secretCodec, options.environment ?? process.env)
    this.fetchImpl = options.fetch ?? fetch
  }

  credentialStatus(): Promise<VoiceCredentialStatus> { return this.secrets.status() }
  saveApiKey(provider: unknown, key: unknown): Promise<VoiceCredentialStatus> { return this.secrets.save(provider, key) }
  deleteApiKey(provider: unknown): Promise<VoiceCredentialStatus> { return this.secrets.delete(provider) }

  async createRealtimeCall(raw: unknown): Promise<string> {
    const request = requireRecord(raw, 'realtime call')
    if (request.mode !== 'conversation' && request.mode !== 'transcription') throw new TypeError('Invalid realtime call mode')
    const sdp = requireString(request.sdp, 'sdp', { min: 16, max: MAX_SDP_BYTES })
    if (!sdp.startsWith('v=0')) throw new TypeError('Invalid WebRTC session description')
    const key = await this.secrets.get('openai')
    const form = new FormData()
    form.set('sdp', sdp)
    const settings = this.options.settings()
    const session = request.mode === 'conversation'
      ? realtimeSession(settings, harnessId(request.harness))
      : transcriptionSession(settings)
    form.set('session', JSON.stringify(session))
    const response = await this.withTimeout('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    }, 30_000)
    const answer = await response.text()
    if (!response.ok) throw new Error(`OpenAI realtime setup failed (${response.status}): ${answer.slice(0, 512)}`)
    if (!answer.startsWith('v=0')) throw new Error('OpenAI realtime setup returned an invalid session description')
    return answer
  }

  async transcribe(raw: unknown): Promise<string> {
    const request = requireRecord(raw, 'transcription request')
    const provider = request.provider
    if (provider !== 'openai' && provider !== 'groq' && provider !== 'deepgram' && provider !== 'local-whisper') throw new TypeError('Invalid transcription provider')
    const audio = boundedAudio(request.audio)
    if (provider === 'local-whisper') return this.transcribeLocal(audio)
    const settings = this.options.settings()
    if (provider === 'deepgram') {
      const key = await this.secrets.get('deepgram')
      const model = encodeURIComponent(settings.voiceDeepgramTranscriptionModel)
      const response = await this.withTimeout(`https://api.deepgram.com/v1/listen?model=${model}&smart_format=true&punctuate=true`, {
        method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' }, body: exactArrayBuffer(audio),
      })
      const data = await this.jsonResponse(response, 'Deepgram transcription')
      const text = isRecord(data.results) && Array.isArray(data.results.channels)
        && isRecord(data.results.channels[0]) && Array.isArray(data.results.channels[0].alternatives)
        && isRecord(data.results.channels[0].alternatives[0]) ? data.results.channels[0].alternatives[0].transcript : undefined
      return cleanText(text, 'Deepgram transcript')
    }
    const key = await this.secrets.get(provider)
    const form = new FormData()
    form.set('file', new Blob([exactArrayBuffer(audio)], { type: 'audio/wav' }), 'dictation.wav')
    form.set('model', provider === 'openai' ? settings.voiceOpenAiTranscriptionModel : settings.voiceGroqTranscriptionModel)
    form.set('response_format', 'json')
    const base = provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1'
    const response = await this.withTimeout(`${base}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
    })
    const data = await this.jsonResponse(response, `${provider} transcription`)
    return cleanText(data.text, `${provider} transcript`)
  }

  async executeTool(raw: unknown, harnessValue: unknown): Promise<VoiceToolResult> {
    const request = requireRecord(raw, 'voice tool request')
    const name = requireString(request.name, 'tool name', { min: 1, max: 64 })
    const args = requireRecord(request.arguments, 'tool arguments')
    const harness = harnessId(harnessValue)
    if (name === 'list_projects') return this.listProjects(args, harness)
    if (name === 'start_task') return this.startTask(args, harness)
    if (name === 'get_local_context') return this.getLocalContext(harness)
    if (name === 'search_web') return this.searchWeb(args)
    throw new TypeError('Voice tool is not supported')
  }

  private async listProjects(args: Record<string, unknown>, harness: HarnessId): Promise<VoiceToolResult> {
    const query = args.query === undefined ? '' : requireString(args.query, 'query', { max: 256, trim: true }).toLowerCase()
    const projects = (await this.options.projects[harness].list())
      .filter((project) => !project.inferred)
      .filter((project) => !query || project.name.toLowerCase().includes(query))
      .slice(0, 50)
      .map(({ id, name, harness: projectHarness, lastOpenedAt }) => ({ id, name, harness: projectHarness, lastOpenedAt }))
    return { output: JSON.stringify({ projects }) }
  }

  private async startTask(args: Record<string, unknown>, harness: HarnessId): Promise<VoiceToolResult> {
    const projectId = requireId(args.project_id, 'project_id')
    const prompt = cleanText(args.prompt, 'prompt')
    const title = args.title === undefined ? undefined : requireString(args.title, 'title', { min: 1, max: 200, trim: true })
    const project: ProjectRecord | undefined = (await this.options.projects[harness].list())
      .find((candidate) => candidate.id === projectId && !candidate.inferred)
    if (!project) throw new Error(`The requested project is not explicitly granted to the selected ${harness === 'omp' ? 'OMP' : 'Prime Agent'} harness`)
    const manager = this.options.agents[harness]
    const runtime = await manager.start({ cwd: project.primaryFolder })
    try {
      await manager.command(runtime.runtimeId, { type: 'prompt', message: prompt })
      if (title) await manager.command(runtime.runtimeId, { type: 'set_session_name', name: title }).catch(() => undefined)
      await manager.command(runtime.runtimeId, { type: 'get_state' })
    } catch (error) {
      await manager.stop(runtime.runtimeId).catch(() => false)
      throw error
    }
    const current = manager.list().find((candidate) => candidate.runtimeId === runtime.runtimeId) ?? runtime
    if (!current.sessionFile) {
      await manager.stop(runtime.runtimeId).catch(() => false)
      throw new Error(`${project.harness === 'omp' ? 'OMP' : 'Prime Agent'} accepted the prompt but did not create a visible session. The task was not reported as started.`)
    }
    const task: VoiceTaskStarted = {
      projectId: project.id, projectName: project.name, harness: project.harness,
      runtimeId: current.runtimeId, sessionFile: current.sessionFile,
    }
    return { output: JSON.stringify({ started: true, task }), task }
  }

  private getLocalContext(harness: HarnessId): VoiceToolResult {
    return { output: JSON.stringify(localContext(harness)) }
  }

  private async searchWeb(args: Record<string, unknown>): Promise<VoiceToolResult> {
    const query = requireString(args.query, 'query', { min: 1, max: 4_096, trim: true })
    const key = await this.secrets.get('openai')
    const response = await this.withTimeout('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        tools: [{ type: 'web_search', search_context_size: 'low' }],
        input: query,
      }),
    })
    const data = await this.jsonResponse(response, 'Web search')
    const text = typeof data.output_text === 'string' ? data.output_text : this.responseText(data.output)
    if (!text) throw new Error('Web search returned no answer')
    return { output: JSON.stringify({ answer: text }) }
  }

  private responseText(output: unknown): string {
    if (!Array.isArray(output)) return ''
    const parts: string[] = []
    for (const item of output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue
      for (const content of item.content) if (isRecord(content) && typeof content.text === 'string') parts.push(content.text)
    }
    return parts.join('\n').trim()
  }

  private async transcribeLocal(audio: Uint8Array): Promise<string> {
    const settings = this.options.settings()
    const executable = await requireExistingPath(settings.voiceLocalWhisperExecutable, 'whisper.cpp executable')
    const model = await requireExistingPath(settings.voiceLocalWhisperModel, 'whisper.cpp model')
    const directory = await mkdtemp(join(tmpdir(), 'prime-work-voice-'))
    const input = join(directory, 'dictation.wav')
    const output = join(directory, 'transcript')
    try {
      await writeFile(input, audio)
      const result = await this.options.runProcess(executable, ['-m', model, '-f', input, '-nt', '-otxt', '-of', output], { timeoutMs: 5 * 60_000, maxBytes: 2 * 1024 * 1024 })
      if (result.timedOut) throw new Error('Local Whisper transcription timed out')
      if (result.outputExceeded) throw new Error('Local Whisper produced too much output')
      if (result.code !== 0) throw new Error(`Local Whisper failed: ${result.stderr.trim().slice(0, 512) || `exit ${result.code}`}`)
      return cleanText(await readFile(`${output}.txt`, 'utf8'), 'Local Whisper transcript')
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async jsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
    const text = await response.text()
    if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text.slice(0, 512)}`)
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new Error(`${label} returned invalid JSON`) }
    return requireRecord(parsed, `${label} response`)
  }

  private async withTimeout(url: string, init: RequestInit, timeoutMs = REMOTE_TIMEOUT_MS): Promise<Response> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    timer.unref()
    try { return await this.fetchImpl(url, { ...init, signal: abort.signal }) }
    catch (error) {
      if (abort.signal.aborted) throw new Error('Voice provider request timed out')
      throw error
    } finally { clearTimeout(timer) }
  }
}

export type { SecretCodec, VoiceServiceOptions }
