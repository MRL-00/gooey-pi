import { app, BrowserWindow, Menu, protocol, safeStorage, session, shell, webContents } from 'electron'
import { extname, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { BROWSER_PARTITION, type AppMeta, type PrimeEventEnvelope, type ProviderAuthEvent } from '../../src/types/api'
import { AgentRpcManager, OMP_RPC_ADAPTER } from './agent-rpc'
import { BrowserDownloadGuard } from './browser-downloads'
import { installCrashGuards } from './crash-guard'
import { GitService } from './git'
import { isTrustedRendererUrl, registerIpc, type IpcRegistration } from './ipc'
import { HARNESSES } from './harness'
import { beginProcessShutdown, findHarnessExecutable, runProcess, stopChildProcesses } from './process-utils'
import { PluginService, beginPluginDiscoveryShutdown } from './plugins'
import { PrimeProviderService } from './providers'
import { OmpModelCatalogService } from './providers-omp'
import { ProjectService } from './projects'
import { SettingsService } from './settings-schedules'
import { ScheduledRunExecutor } from './schedules/executor'
import { HeartbeatService } from './schedules/heartbeats'
import { AutomationService } from './schedules/service'
import { AgentScheduleBridge } from './schedules/agent-bridge'
import { AgentBrowserBridge } from './browser/agent-bridge'
import { AgentBrowserService } from './browser/agent-service'
import { SessionService } from './sessions'
import { ompSessionServiceOptions } from './sessions/omp'
import { JsonStateStore } from './store'
import { TerminalService } from './terminal'
import { VoiceService } from './voice'
import { isAllowedRendererAudioPermission } from './voice-permissions'

protocol.registerSchemesAsPrivileged([{ scheme: 'prime-work', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

let mainWindow: BrowserWindow | null = null
let ipc: IpcRegistration | null = null
let agents: AgentRpcManager | null = null
let ompAgents: AgentRpcManager | null = null
let terminals: TerminalService | null = null
let downloads: BrowserDownloadGuard | null = null
let providerService: PrimeProviderService | null = null
let store: JsonStateStore | null = null
let automation: AutomationService | null = null
let agentScheduleBridge: AgentScheduleBridge | null = null
let agentBrowser: AgentBrowserService | null = null
let agentBrowserBridge: AgentBrowserBridge | null = null
let shutdownStarted = false
let trustedRendererUrl = ''
let windowCreation: Promise<BrowserWindow | null> | null = null

installCrashGuards({
  logPath: () => {
    try { return join(app.getPath('userData'), 'crash.log') } catch { return null }
  },
  cleanup: async () => {
    agents?.beginShutdown()
    ompAgents?.beginShutdown()
    beginProcessShutdown()
    await Promise.allSettled([agents?.stopAll() ?? Promise.resolve(), ompAgents?.stopAll() ?? Promise.resolve(), stopChildProcesses()])
  },
})

function appIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'assets', 'icon.png')
}

// One policy for every surface that serves renderer content: the app protocol
// response headers and the packaged browser-session header rewrite.
const RENDERER_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

const rendererContentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
}

function registerRendererProtocol(): void {
  if (!app.isPackaged) return
  const rendererRoot = resolve(__dirname, '../renderer')
  protocol.handle('prime-work', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app' || url.username || url.password || url.search || url.hash) return new Response('Not found', { status: 404 })
      const decoded = decodeURIComponent(url.pathname)
      if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return new Response('Not found', { status: 404 })
      const candidate = resolve(rendererRoot, `.${decoded === '/' ? '/index.html' : decoded}`)
      if (candidate !== rendererRoot && !candidate.startsWith(`${rendererRoot}/`)) return new Response('Not found', { status: 404 })
      const body = await readFile(candidate)
      return new Response(body, { headers: {
        'Content-Type': rendererContentTypes[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'Content-Security-Policy': RENDERER_CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
      } })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}

function resolveRendererUrl(): string {
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (!developmentUrl) return app.isPackaged ? 'prime-work://app/index.html' : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const parsed = new URL(developmentUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('ELECTRON_RENDERER_URL must use an uncredentialed loopback HTTP(S) origin')
  }
  return parsed.href
}

async function harnessVersion(executable: string | null): Promise<string | null> {
  if (!executable) return null
  try {
    const result = await runProcess(executable, ['--version'], { timeoutMs: 10_000, maxBytes: 64 * 1024 })
    return result.code === 0 ? result.stdout.trim().split(/\s+/).at(-1) ?? null : null
  } catch { return null }
}

function isAllowedBrowserUrl(raw: string): boolean {
  if (raw === 'about:blank') return true
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}

export function hardenRenderer(window: BrowserWindow, trustedUrl: () => string = () => trustedRendererUrl): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('context-menu', (_event, params) => {
    if (params.mediaType !== 'image' || !params.hasImageContents) return
    const contents = window.webContents
    Menu.buildFromTemplate([{
      label: 'Copy Image',
      click: () => { if (!window.isDestroyed() && !contents.isDestroyed()) contents.copyImageAt(params.x, params.y) },
    }]).popup({ window })
  })
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.allowRunningInsecureContent = false
    // A guest page must never be able to attach a nested guest of its own.
    preferences.webviewTag = false
    const partition = typeof params.partition === 'string' ? params.partition : ''
    if (partition !== BROWSER_PARTITION || !isAllowedBrowserUrl(params.src)) event.preventDefault()
  })
  window.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, target) => { if (!isAllowedBrowserUrl(target)) event.preventDefault() })
    contents.on('will-redirect', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.on('will-frame-navigate', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.once('destroyed', () => downloads?.cancelOwner(contents.id))
    // Guests reaching this point passed the will-attach-webview partition and
    // URL gates above, which makes them eligible for agent control.
    agentBrowser?.approveGuest(contents)
  })
  window.webContents.on('will-navigate', (event, target) => {
    const current = window.webContents.getURL()
    if (target !== current) event.preventDefault()
  })
  // Server redirects and sub-frame navigations bypass will-navigate; hold them
  // to the same trusted-renderer predicate the IPC gate uses.
  window.webContents.on('will-redirect', (event) => {
    if (!isTrustedRendererUrl(event.url, trustedUrl())) event.preventDefault()
  })
  window.webContents.on('will-frame-navigate', (event) => {
    if (!isTrustedRendererUrl(event.url, trustedUrl())) event.preventDefault()
  })
}

interface InitialRendererWindow {
  loadURL(url: string): Promise<unknown>
  isDestroyed(): boolean
  destroy(): void
}

export async function loadInitialRenderer(window: InitialRendererWindow, rendererUrl: string): Promise<void> {
  try {
    await window.loadURL(rendererUrl)
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}

async function createWindow(): Promise<BrowserWindow | null> {
  if (shutdownStarted) return null
  const macOptions = process.platform === 'darwin' ? {
    titleBarStyle: 'hiddenInset' as const,
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar' as const,
    visualEffectState: 'active' as const,
  } : { titleBarStyle: 'default' as const }
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f5f4',
    icon: appIconPath(),
    ...macOptions,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  })
  mainWindow = window
  const renderer = window.webContents
  const rendererId = renderer.id
  hardenRenderer(window)
  renderer.on('did-finish-load', () => {
    if (!renderer.isDestroyed() && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)) ipc?.authorize(renderer)
  })
  renderer.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isTrustedRendererUrl(url, trustedRendererUrl)) ipc?.revoke(rendererId)
  })
  renderer.on('render-process-gone', () => ipc?.revoke(rendererId))
  let rendererLoaded = false
  let readyToShow = false
  window.once('ready-to-show', () => {
    readyToShow = true
    if (rendererLoaded && !shutdownStarted && !window.isDestroyed() && mainWindow === window) window.show()
  })
  window.on('closed', () => {
    ipc?.revoke(rendererId)
    if (mainWindow === window) mainWindow = null
  })
  try {
    await loadInitialRenderer(window, trustedRendererUrl)
  } catch (error) {
    ipc?.revoke(rendererId)
    if (mainWindow === window) mainWindow = null
    throw error
  }
  if (shutdownStarted || window.isDestroyed() || mainWindow !== window) {
    ipc?.revoke(rendererId)
    if (!window.isDestroyed()) window.destroy()
    if (mainWindow === window) mainWindow = null
    return null
  }
  rendererLoaded = true
  if (readyToShow) window.show()
  return window
}

function ensureWindow(): Promise<BrowserWindow | null> {
  if (shutdownStarted) return Promise.resolve(null)
  if (mainWindow && !mainWindow.isDestroyed()) return windowCreation ?? Promise.resolve(mainWindow)
  if (windowCreation) return windowCreation
  const creation = createWindow()
  windowCreation = creation
  const clearCreation = () => { if (windowCreation === creation) windowCreation = null }
  void creation.then(clearCreation, clearCreation)
  return creation
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 512) || 'Unknown error'
}

export async function settleShutdown(
  steps: ReadonlyArray<PromiseLike<unknown>>,
  options: { watchdogMs?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const log = options.log ?? ((message: string) => console.error(message))
  const watchdogMs = options.watchdogMs ?? 10_000
  const settled = Promise.allSettled(steps).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') log(`Prime Work shutdown step failed: ${boundedErrorMessage(result.reason)}`)
    }
  })
  let timer: NodeJS.Timeout | undefined
  const watchdog = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log(`Prime Work shutdown did not finish within ${watchdogMs} ms; quitting anyway`)
      resolve()
    }, watchdogMs)
    timer.unref?.()
  })
  try {
    await Promise.race([settled, watchdog])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function requestWindow(reason: 'activation' | 'second instance'): void {
  void ensureWindow().then((window) => {
    if (!window || shutdownStarted || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }).catch((error: unknown) => {
    if (!shutdownStarted) console.error(`Prime Work failed to open a window after ${reason}: ${boundedErrorMessage(error)}`)
  })
}

async function bootstrap(): Promise<void> {
  const [executable, ompExecutable] = await Promise.all([
    findHarnessExecutable(HARNESSES.prime),
    findHarnessExecutable(HARNESSES.omp),
  ])
  if (shutdownStarted) return
  const stateStore = new JsonStateStore(join(app.getPath('userData'), 'prime-work-state.json'))
  store = stateStore
  const sessions = new SessionService(stateStore, executable)
  // OMP has no live-CLI overlay (`omp list --json` does not exist), so the OMP
  // catalog is constructed with a null executable and JSONL-only metadata.
  const ompSessions = new SessionService(stateStore, null, undefined, ompSessionServiceOptions())
  const projects = new ProjectService(stateStore, () => mainWindow)
  const ompProjects = new ProjectService(stateStore, () => mainWindow, 'omp')
  // Git and terminals are harness-agnostic: a cwd (or bound session) is valid
  // when either harness's own grants authorize it. Prime is consulted first so
  // Prime-only setups keep their exact behavior and error text.
  const authorizeEitherCwd = async (cwd: string): Promise<string> => {
    try { return await projects.authorizeCwd(cwd) } catch (error) {
      try { return await ompProjects.authorizeCwd(cwd) } catch { throw error }
    }
  }
  const requireEitherSessionPath = async (path: string): Promise<string> => {
    try { return await sessions.requireSessionPath(path) } catch (error) {
      try { return await ompSessions.requireSessionPath(path) } catch { throw error }
    }
  }
  const git = new GitService(authorizeEitherCwd)
  // This matches the renderer's startup query so both consumers share SessionService's coalesced catalog scan.
  const listCatalogSessions = (): ReturnType<SessionService['list']> => sessions.list(undefined, true)

  const providers = new PrimeProviderService({ openExternal: async (url) => { await shell.openExternal(url, { activate: true }) } })
  providerService = providers
  const disabledProviders = () => new Set(stateStore.getSettings().disabledProviders)
  const ompDisabledProviders = () => new Set(stateStore.getSettings().ompDisabledProviders)
  const ompCatalog = new OmpModelCatalogService(ompExecutable)
  agents = new AgentRpcManager(
    executable,
    (cwd) => projects.authorizeCwd(cwd),
    (path) => sessions.requireSessionPath(path),
    providers,
    disabledProviders,
  )
  // The OMP manager exists whether or not the omp CLI is installed; starting a
  // runtime without it fails with the adapter's per-harness not-found error.
  // OMP provider visibility is desktop-owned and independent from both Prime's
  // provider policy and OMP's own CLI configuration.
  const ompManager = new AgentRpcManager(
    ompExecutable,
    (cwd) => ompProjects.authorizeCwd(cwd),
    (path) => ompSessions.requireSessionPath(path),
    ompCatalog,
    ompDisabledProviders,
    OMP_RPC_ADAPTER,
    () => {
      const mode = stateStore.getSettings().ompApprovalMode
      return mode === 'inherit' ? undefined : mode
    },
  )
  ompAgents = ompManager
  sessions.bindRuntimeHooks({
    get: (path) => agents?.getForSession(path),
    all: () => agents?.list() ?? [],
    stop: async (path) => { await agents?.stopForSession(path) },
    rename: async (path, title) => agents?.renameForSession(path, title) ?? false,
  })
  ompSessions.bindRuntimeHooks({
    get: (path) => ompAgents?.getForSession(path),
    all: () => ompAgents?.list() ?? [],
    stop: async (path) => { await ompAgents?.stopForSession(path) },
    rename: async (path, title) => ompAgents?.renameForSession(path, title) ?? false,
  })
  terminals = new TerminalService(
    authorizeEitherCwd,
    () => stateStore.getSettings().terminalShell,
    requireEitherSessionPath,
  )
  projects.bindProviders({
    sessions: listCatalogSessions,
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      plugins.evictProjects(roots)
      await Promise.all([agents!.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  ompProjects.bindProviders({
    sessions: () => ompSessions.list(undefined, true),
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      await Promise.all([ompManager.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  downloads = new BrowserDownloadGuard(isAllowedBrowserUrl, app.getPath('downloads'))
  const settings = new SettingsService(stateStore, (shell) => terminals!.validateShell(shell), () => downloads?.cancelAll(true))
  const voice = new VoiceService({
    secretPath: join(app.getPath('userData'), 'voice-secrets.json'),
    secretCodec: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
    settings: () => stateStore.getSettings(),
    projects: { prime: projects, omp: ompProjects },
    agents: { prime: agents, omp: ompManager },
    runProcess,
  })
  const browserProfile = session.fromPartition(BROWSER_PARTITION)
  browserProfile.on('will-download', (event, item, owner) => downloads?.handle(event, item, owner, settings.get().browserAskForDownloads))
  const scheduleSkillPath = app.isPackaged
    ? join(process.resourcesPath, 'skills', 'prime-work-schedules')
    : join(app.getAppPath(), 'assets', 'skills', 'prime-work-schedules')
  const browserSkillPath = app.isPackaged
    ? join(process.resourcesPath, 'skills', 'prime-work-browser')
    : join(app.getAppPath(), 'assets', 'skills', 'prime-work-browser')
  const plugins = new PluginService(executable, (path) => projects.authorizeProjectRoot(path), {
    builtInSkills: [{
      id: 'prime-work-schedules', name: 'Prime Work schedules',
      description: 'Create and manage durable project and thread schedules from an agent.',
      kind: 'skill', location: 'system', path: scheduleSkillPath, enabled: true,
    }, {
      id: 'prime-work-browser', name: 'Prime Work browser',
      description: 'Drive the in-app browser for this thread: tabs, navigation, clicks, typing, and screenshots.',
      kind: 'skill', location: 'system', path: browserSkillPath, enabled: true,
    }],
  })
  const heartbeats = new HeartbeatService(agents, executable)
  const scheduledRuns = new ScheduledRunExecutor(
    projects,
    sessions,
    agents,
    providers,
    () => new Set(stateStore.getSettings().disabledProviders),
  )
  const schedules = new AutomationService(stateStore, {
    validateTarget: (target) => scheduledRuns.validateTarget(target),
    validateExecution: (execution) => scheduledRuns.validateExecution(execution),
    run: (task) => scheduledRuns.run(task),
  })
  automation = schedules
  await schedules.start()
  const scheduleBridge = new AgentScheduleBridge({
    service: schedules,
    skillPath: scheduleSkillPath,
    resolveScope: async ({ cwd, sessionPath }) => {
      const catalog = await projects.list()
      const canonicalCwd = resolve(cwd)
      const project = catalog.find((candidate) => !candidate.inferred && candidate.folders.some((folder) => {
        const root = resolve(folder)
        return canonicalCwd === root || canonicalCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)
      }))
      if (!project) throw new Error('The agent is not running in an explicitly granted Prime Work project')
      if (!sessionPath) return { projectId: project.id }
      const scheduledSession = (await sessions.list(undefined, true)).find((candidate) => resolve(candidate.filePath) === resolve(sessionPath))
      return { projectId: project.id, sessionId: scheduledSession?.id }
    },
  })
  await scheduleBridge.start()
  agentScheduleBridge = scheduleBridge
  const browserService = new AgentBrowserService({
    getGuest: (webContentsId) => {
      const contents = webContents.fromId(webContentsId)
      return contents && !contents.isDestroyed() ? contents : undefined
    },
  })
  agentBrowser = browserService
  const browserExtensionPath = app.isPackaged
    ? join(process.resourcesPath, 'extensions', 'prime-work-browser.ts')
    : join(app.getAppPath(), 'assets', 'extensions', 'prime-work-browser.ts')
  const browserBridge = new AgentBrowserBridge({ service: browserService, terminals, extensionPath: browserExtensionPath, skillPath: browserSkillPath })
  await browserBridge.start()
  agentBrowserBridge = browserBridge
  agents.setRuntimeEnvironmentProvider((scope) => ({ ...scheduleBridge.environmentFor(scope), ...browserBridge.environmentFor(scope) }))
  agents.setRuntimeStartListener((environment, info) => browserBridge.bindSession(environment.PRIME_WORK_BROWSER_TOKEN, info.sessionFile))
  // OMP runtimes get the same browser broker credentials but load the
  // OMP-flavored extension; OMP has no --skill flag, so the skill path is
  // stripped and the extension carries the usage guidance. The schedules
  // bridge stays Prime-only.
  const ompBrowserExtensionPath = app.isPackaged
    ? join(process.resourcesPath, 'extensions', 'omp-work-browser.ts')
    : join(app.getAppPath(), 'assets', 'extensions', 'omp-work-browser.ts')
  ompManager.setRuntimeEnvironmentProvider((scope) => {
    const { PRIME_WORK_BROWSER_SKILL_PATH: _skill, ...environment } = browserBridge.environmentFor(scope)
    return { ...environment, PRIME_WORK_BROWSER_EXTENSION_PATH: ompBrowserExtensionPath }
  })
  ompManager.setRuntimeStartListener((environment, info) => browserBridge.bindSession(environment.PRIME_WORK_BROWSER_TOKEN, info.sessionFile))
  const [detectedPrimeVersion, detectedOmpVersion] = await Promise.all([
    harnessVersion(executable),
    harnessVersion(ompExecutable),
  ])
  if (shutdownStarted) return
  const meta: AppMeta = {
    version: app.getVersion(),
    platform: process.platform,
    homeDir: homedir(),
    harnesses: {
      prime: { path: executable, version: detectedPrimeVersion },
      omp: { path: ompExecutable, version: detectedOmpVersion },
    },
  }
  trustedRendererUrl = resolveRendererUrl()
  ipc = registerIpc({
    meta, projects, sessions, agents, terminals, git, plugins, providers, settings, heartbeats, schedules, browser: browserService, voice,
    omp: { projects: ompProjects, sessions: ompSessions, agents: ompManager, catalog: ompCatalog },
  }, trustedRendererUrl)
  // Both managers share the one renderer forwarding path: envelopes carry the
  // runtimeId and RuntimeInfo carries the harness, so the renderer can route.
  const forwardAgentEvent = (envelope: PrimeEventEnvelope): void => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('agent:event', envelope)
    }
  }
  agents.setEventSink(forwardAgentEvent)
  ompManager.setEventSink(forwardAgentEvent)
  providers.setEventSink((event: ProviderAuthEvent) => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('providers:auth-event', event)
    }
  })
  await ensureWindow()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else void app.whenReady().then(async () => {
  registerRendererProtocol()
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath())
  const browserSession = session.defaultSession
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = permission === 'media' && 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(permission === 'media' && isAllowedRendererAudioPermission(contents.getURL(), contents.mainFrame.url, trustedRendererUrl, mediaTypes))
  })
  browserSession.setPermissionCheckHandler((contents, permission, _origin, details) => Boolean(contents && permission === 'media' && details.isMainFrame
    && isAllowedRendererAudioPermission(contents.getURL(), contents.mainFrame.url, trustedRendererUrl, details.mediaType ? [details.mediaType] : undefined)))
  const browserProfile = session.fromPartition(BROWSER_PARTITION)
  browserProfile.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserProfile.setPermissionCheckHandler(() => false)
  if (app.isPackaged) {
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [RENDERER_CONTENT_SECURITY_POLICY],
        },
      })
    })
  }
  await bootstrap()
  app.on('second-instance', () => {
    if (!shutdownStarted) requestWindow('second instance')
  })
  app.on('activate', () => {
    if (!shutdownStarted && BrowserWindow.getAllWindows().length === 0) requestWindow('activation')
  })
}).catch((error: unknown) => {
  if (!shutdownStarted) console.error(`Prime Work failed to start: ${boundedErrorMessage(error)}`)
  app.quit()
})

app.on('window-all-closed', () => {
  // Active Prime Work schedules keep the local broker alive. A second launch reopens the window.
  if (process.platform !== 'darwin' && !automation?.hasActiveSchedules()) app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  event.preventDefault()
  shutdownStarted = true

  const registration = ipc
  ipc = null
  registration?.dispose()
  agents?.beginShutdown()
  ompAgents?.beginShutdown()
  beginProcessShutdown()
  beginPluginDiscoveryShutdown()
  downloads?.cancelAll()
  providerService?.cancelAll()
  agentBrowser?.beginShutdown()
  void settleShutdown([
    agentScheduleBridge?.stop() ?? Promise.resolve(),
    agentBrowserBridge?.stop() ?? Promise.resolve(),
    automation?.stop() ?? Promise.resolve(),
    terminals?.killAll() ?? Promise.resolve(),
    agents?.stopAll() ?? Promise.resolve(),
    ompAgents?.stopAll() ?? Promise.resolve(),
    stopChildProcesses(),
  ]).then(async () => {
    // Await the drain so the final persist lands before the process exits.
    try { await store?.beginShutdown() } catch (error) { console.error(`Prime Work store shutdown failed: ${boundedErrorMessage(error)}`) }
  }).finally(() => app.quit())
})
