export type ThemeMode = 'system' | 'light' | 'dark'
export type WorkspaceView = 'session' | 'projects' | 'activity' | 'scheduled' | 'plugins' | 'settings'
export type InspectorTab = 'summary' | 'changes' | 'browser' | 'files'
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'complete' | 'failed' | 'unknown'

export interface AppMeta {
  version: string
  platform: NodeJS.Platform
  homeDir: string
  primeAgentPath: string | null
  primeAgentVersion: string | null
}

export interface ProjectRecord {
  id: string
  name: string
  path: string
  folders: string[]
  primaryFolder: string
  pinned: boolean
  createdAt: string
  lastOpenedAt: string
  sessionCount: number
  gitBranch?: string
  inferred?: boolean
}

export interface SessionRecord {
  id: string
  filePath: string
  projectPath: string
  title: string
  createdAt: string
  updatedAt: string
  lastUserMessageAt?: string
  status: SessionStatus
  model?: string
  provider?: string
  thinkingLevel?: string
  depth: number
  pinned?: boolean
  unread?: boolean
  eventRevision?: number
  preview?: string
  archived?: boolean
  syncRevision?: number
}

export interface PromptImage {
  type: 'image'
  mimeType: string
  data: string
}

export interface BrowserAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

/** Element info captured from the embedded browser page. Every field is untrusted page data: bounded on capture, rendered as plain text only. */
export interface BrowserAnnotationElement {
  selector: string
  tagName: string
  id: string
  classes: string[]
  text: string
  href?: string
  src?: string
  rect: BrowserAnnotationRect
}

export interface BrowserAnnotation {
  id: string
  comment: string
  element: BrowserAnnotationElement
  pageUrl: string
  pageTitle: string
  /** True once the page navigated away after capture: the live marker is gone but the captured info remains valid. */
  stale: boolean
  createdAt: number
}

export type PrimeCompactionReason = 'manual' | 'threshold' | 'overflow' | 'requested'
export type PrimeCompactionStatus = 'running' | 'done' | 'failed' | 'cancelled'
export type PrimeCompactionOutcome = 'failed' | 'cancelled' | 'skipped'

export type MessagePart =
  | { type: 'text'; partId?: string; text: string }
  | { type: 'thinking'; partId?: string; text: string }
  | { type: 'toolCall'; partId?: string; id?: string; name: string; args?: unknown }
  | { type: 'toolResult'; partId?: string; name?: string; text: string; isError?: boolean }
  | { type: 'agentMessage'; partId?: string; text: string; agentName?: string }
  | { type: 'image'; partId?: string; mimeType?: string; data?: string; dataTruncated?: boolean }
  | {
      type: 'compaction'
      partId?: string
      status: PrimeCompactionStatus
      reason?: PrimeCompactionReason
      outcome?: PrimeCompactionOutcome
      tokensBefore?: number
      firstKeptEntryId?: string
      summary?: string
      error?: string
      customInstructions?: string
      willRetry?: boolean
    }

export interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'agent' | 'goal' | 'tool' | 'system'
  timestamp?: string | number
  agentName?: string
  startedAt?: string | number
  completedAt?: string | number
  parts: MessagePart[]
  streaming?: boolean
}

export interface PrimeContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface RuntimeInfo {
  runtimeId: string
  sessionId?: string
  sessionFile?: string
  cwd: string
  isStreaming: boolean
  sessionActions?: SessionActionSnapshot
  isCompacting?: boolean
  model?: { provider?: string; id?: string; name?: string } | null
  thinkingLevel?: string
  availableThinkingLevels?: PrimeThinkingLevel[]
  fastModeSupported?: boolean
  imageInputSupported?: boolean
  fastModeAvailable?: boolean
  serviceTier?: PrimeServiceTier
  contextUsage?: PrimeContextUsage
}

export type PrimeThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type PrimeServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null
export type ProviderAuthMethod = 'oauth' | 'api_key' | 'external'
export type ProviderAuthSource = 'stored' | 'runtime' | 'environment' | 'prime_cli' | 'fallback' | 'models_json_key' | 'models_json_command' | 'stale'

export interface PrimeModelDescriptor {
  key: string
  provider: string
  id: string
  name: string
  reasoning: boolean
  input: Array<'text' | 'image'>
  contextWindow: number
  maxTokens: number
  availableThinkingLevels: PrimeThinkingLevel[]
  fastModeSupported: boolean
  available: boolean
}

export interface PrimeProviderDescriptor {
  id: string
  name: string
  authMethod: ProviderAuthMethod
  configured: boolean
  authSource?: ProviderAuthSource
  authLabel?: string
  modelCount: number
  availableModelCount: number
  enabled: boolean
}

export interface PrimeModelCatalog {
  primeVersion: string
  refreshedAt: string
  models: PrimeModelDescriptor[]
  providers: PrimeProviderDescriptor[]
  warning?: string
}

export type ProviderAuthEvent =
  | { flowId: string; providerId: string; type: 'auth'; url: string; instructions?: string }
  | { flowId: string; providerId: string; type: 'progress'; message: string }
  | { flowId: string; providerId: string; type: 'prompt'; promptId: string; message: string; placeholder?: string; allowEmpty?: boolean }
  | { flowId: string; providerId: string; type: 'select'; promptId: string; message: string; options: Array<{ id: string; label: string }> }
  | { flowId: string; providerId: string; type: 'complete' | 'cancelled' }
  | { flowId: string; providerId: string; type: 'error'; error: string }

export interface PrimeEventEnvelope {
  runtimeId: string
  event: Record<string, unknown>
}

export interface SessionChangeEvent {
  filePath?: string
}

export interface SkillRecord {
  id: string
  name: string
  description: string
  kind: 'skill' | 'extension' | 'prompt' | 'package' | 'mcp'
  location: 'bundled' | 'user' | 'project' | 'system'
  path?: string
  enabled: boolean
  icon?: string
  source?: string
}

export interface PluginWarning {
  scope: 'user' | 'project'
  path: string
  message: string
}

export interface PluginCatalog {
  skills: SkillRecord[]
  warnings: PluginWarning[]
}

export type McpConnectionInput = {
  name: string
  scope: 'user' | 'project'
  projectPath?: string
} & (
  | { type: 'http'; url: string }
  | { type: 'stdio'; command: string; args?: string[] }
)

export interface ProjectFileEntry { path: string; type: 'file' | 'directory' }
export interface ProjectFileListing { entries: ProjectFileEntry[]; skipped: number }

export interface GitFileChange {
  path: string
  status: string
  staged: boolean
  additions: number
  deletions: number
}
export interface GitStatus {
  isRepo: boolean
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  files: GitFileChange[]
  truncated?: boolean
  error?: string
}
export interface GitDiff { path?: string; staged: boolean; text: string; truncated: boolean; error?: string }

/**
 * The one result shape for subprocess-backed operations (git commit, package
 * install, MCP settings updates). `reason` classifies failures: the subprocess
 * timed out, exceeded its output limit, exited non-zero, or the operation was
 * blocked before or instead of running the subprocess.
 */
export type ProcessFailureReason = 'timeout' | 'overflow' | 'exit' | 'blocked'
export interface ProcessOutcome { ok: boolean; output: string; reason?: ProcessFailureReason }

export interface TerminalSpawnOptions { cwd: string; shell?: string; cols?: number; rows?: number }
export interface TerminalDataEvent { terminalId: string; data: string }
export interface TerminalExitEvent { terminalId: string; exitCode: number; signal?: number }

export type MessageEnterAction = 'queue' | 'steer'
export type PromptDeliveryIntent = 'queue' | 'steer'

export interface QueuedPrompt {
  id: string
  text: string
  intent: PromptDeliveryIntent
}

export interface SessionActionSnapshot {
  queuedCount: number
  steering: string[]
  followUps: string[]
  active?: {
    kind: 'turn' | 'session_command'
    phase: 'preparing' | 'committing' | 'running'
    label?: string
  }
}

export interface AppSettings {
  theme: ThemeMode
  sidebarOpen: boolean
  inspectorOpen: boolean
  terminalOpen: boolean
  defaultInspectorTab: InspectorTab
  browserHome: string
  browserAskForDownloads: boolean
  terminalShell: string
  reduceMotion: boolean
  showReasoningSummaries: boolean
  showToolCalls: boolean
  messageEnterAction: MessageEnterAction
  telemetry: boolean
  disabledProviders: string[]
}

export type ScheduleDefinitionStatus = 'active' | 'paused' | 'completed' | 'blocked'
export type ScheduleRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted'
export type ScheduleCreatedBy = 'user' | 'agent'

export type ScheduleTarget =
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; projectId: string; sessionId: string }

export type ScheduleTiming =
  | { kind: 'once'; at: string }
  | { kind: 'rrule'; dtstartLocal: string; timeZone: string; rrule: string }

export interface ScheduleExecution {
  model: 'auto' | string
  thinking: 'auto' | PrimeThinkingLevel
  speed: 'normal' | 'fast'
}

export interface ScheduleRunRecord {
  id: string
  taskId: string
  taskRevision: number
  trigger: 'scheduled' | 'manual'
  scheduledFor: string
  queuedAt: string
  startedAt?: string
  finishedAt?: string
  status: ScheduleRunStatus
  execution: ScheduleExecution
  sessionId?: string
  sessionFile?: string
  error?: string
  skippedCount?: number
}

export interface ScheduleRecord {
  id: string
  title: string
  schedule: string
  prompt: string
  status: 'active' | 'paused' | 'completed' | 'failed' | 'unknown'
  nextRun?: string
  lastRun?: string
  runtimeId?: string
}

export interface AutomationScheduleRecord {
  schemaVersion: 1
  id: string
  revision: number
  title: string
  prompt: string
  target: ScheduleTarget
  timing: ScheduleTiming
  execution: ScheduleExecution
  status: ScheduleDefinitionStatus
  createdBy: ScheduleCreatedBy
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  blockedReason?: string
  runs: ScheduleRunRecord[]
}

export interface ScheduleInput {
  title?: string
  prompt: string
  target: ScheduleTarget
  timing: ScheduleTiming
  execution: ScheduleExecution
  createdBy?: ScheduleCreatedBy
}

export interface SchedulePatch {
  revision: number
  title?: string
  prompt?: string
  target?: ScheduleTarget
  timing?: ScheduleTiming
  execution?: ScheduleExecution
}

export interface SchedulePreview {
  timing: ScheduleTiming
  occurrences: string[]
}

export interface ScheduleChangeEvent {
  taskId?: string
  reason: 'created' | 'updated' | 'deleted' | 'run'
}

export interface NativeHeartbeatRecord {
  id: string
  source: 'heartbeat' | 'rlm_heartbeat'
  status: 'active' | 'paused'
  prompt: string
  schedule: string
  sessionId: string
  sessionFile: string
  activeSessionId: string
  deliveryMode?: 'steer' | 'follow_up'
  nextRunAt?: string
  lastRunAt?: string
  label?: string
  runtimeId?: string
}

/** One agent-controlled browser tab. The registry lives in the main process; the renderer hosts the webview guests and mirrors this state. */
export interface AgentBrowserTabRecord {
  tabId: string
  /** Canonical session file path of the thread this tab belongs to. */
  sessionFile: string
  url: string
  title: string
  /** Whether a live webview guest is currently bound to this tab. */
  attached: boolean
  /** Whether this is the session's currently targeted tab. */
  active: boolean
}

export interface AgentBrowserState {
  tabs: AgentBrowserTabRecord[]
}

/** Emitted when the agent moves the pointer in a tab, so the UI can animate a synthetic cursor along the same path on the same clock. */
export interface AgentBrowserPointerEvent {
  tabId: string
  sessionFile: string
  /** Previous pointer position, or null when the cursor first appears in a tab. */
  from: { x: number; y: number } | null
  to: { x: number; y: number }
  action: 'move' | 'click' | 'scroll'
  /** How long the glide takes; 0 means the cursor appears in place. */
  durationMs: number
}

export interface PrimeWorkApi {
  app: { getMeta(): Promise<AppMeta>; openExternal(url: string): Promise<boolean>; revealPath(path: string): Promise<boolean> }
  projects: { list(): Promise<ProjectRecord[]>; listFiles(root: string): Promise<ProjectFileListing>; add(): Promise<ProjectRecord | null>; grantInferred(path: string): Promise<ProjectRecord>; remove(id: string): Promise<boolean>; touch(id: string): Promise<boolean> }
  sessions: {
    list(projectPath?: string, includeArchived?: boolean): Promise<SessionRecord[]>
    read(filePath: string): Promise<TranscriptMessage[]>
    followUp(filePath: string, message: string, intent?: PromptDeliveryIntent): Promise<boolean>
    rename(filePath: string, title: string): Promise<boolean>
    archive(filePath: string, archived?: boolean): Promise<boolean>
    onChanged(callback: (event: SessionChangeEvent) => void): () => void
  }
  agent: {
    start(options: { cwd: string; sessionPath?: string; model?: string; thinking?: string; fast?: boolean }): Promise<RuntimeInfo>
    command(runtimeId: string, command: Record<string, unknown>): Promise<Record<string, unknown>>
    stop(runtimeId: string): Promise<boolean>
    list(): Promise<RuntimeInfo[]>
    onEvent(callback: (envelope: PrimeEventEnvelope) => void): () => void
  }
  providers: {
    catalog(force?: boolean): Promise<PrimeModelCatalog>
    saveApiKey(providerId: string, apiKey: string): Promise<PrimeModelCatalog>
    logout(providerId: string): Promise<PrimeModelCatalog>
    setEnabled(providerId: string, enabled: boolean): Promise<PrimeModelCatalog>
    startOAuth(providerId: string): Promise<{ flowId: string }>
    respondOAuth(flowId: string, promptId: string, value?: string): Promise<boolean>
    cancelOAuth(flowId: string): Promise<boolean>
    onAuthEvent(callback: (event: ProviderAuthEvent) => void): () => void
  }
  terminal: {
    create(options: TerminalSpawnOptions): Promise<{ terminalId: string; shell: string }>
    input(terminalId: string, data: string): void
    resize(terminalId: string, cols: number, rows: number): void
    kill(terminalId: string): Promise<boolean>
    onData(callback: (event: TerminalDataEvent) => void): () => void
    onExit(callback: (event: TerminalExitEvent) => void): () => void
  }
  git: { status(cwd: string): Promise<GitStatus>; diff(cwd: string, path?: string, staged?: boolean): Promise<GitDiff>; stage(cwd: string, paths: string[]): Promise<boolean>; unstage(cwd: string, paths: string[]): Promise<boolean>; restore(cwd: string, paths: string[]): Promise<boolean>; commit(cwd: string, message: string): Promise<ProcessOutcome> }
  plugins: { list(projectPath?: string): Promise<PluginCatalog>; install(source: string): Promise<ProcessOutcome>; connectMcp(input: McpConnectionInput): Promise<ProcessOutcome>; refresh(): Promise<PluginCatalog> }
  settings: { get(): Promise<AppSettings>; update(patch: Partial<AppSettings>): Promise<AppSettings>; resetBrowserData(): Promise<boolean> }
  browser: {
    state(): Promise<AgentBrowserState>
    attachTab(tabId: string, webContentsId: number): Promise<boolean>
    selectTab(tabId: string): Promise<boolean>
    closeTab(tabId: string): Promise<boolean>
    onChanged(callback: (state: AgentBrowserState) => void): () => void
  }
  heartbeats: {
    list(): Promise<NativeHeartbeatRecord[]>
    manage(id: string, action: 'pause' | 'resume' | 'stop'): Promise<NativeHeartbeatRecord>
  }
  schedules: {
    list(): Promise<AutomationScheduleRecord[]>
    get(id: string): Promise<AutomationScheduleRecord>
    preview(timing: ScheduleTiming, count?: number): Promise<SchedulePreview>
    create(input: ScheduleInput): Promise<AutomationScheduleRecord>
    update(id: string, patch: SchedulePatch): Promise<AutomationScheduleRecord>
    pause(id: string): Promise<AutomationScheduleRecord>
    resume(id: string): Promise<AutomationScheduleRecord>
    delete(id: string): Promise<boolean>
    runNow(id: string): Promise<ScheduleRunRecord>
    onChanged(callback: (event: ScheduleChangeEvent) => void): () => void
  }
}

declare global { interface Window { prime: PrimeWorkApi } }
