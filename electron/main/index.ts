import { app, BrowserWindow, protocol, session, shell } from 'electron'
import { extname, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { AppMeta, ProviderAuthEvent } from '../../src/types/api'
import { AgentRpcManager } from './agent-rpc'
import { BrowserDownloadGuard } from './browser-downloads'
import { GitService } from './git'
import { isTrustedRendererUrl, registerIpc, type IpcRegistration } from './ipc'
import { beginProcessShutdown, findPrimeAgent, runProcess, stopChildProcesses } from './process-utils'
import { PluginService } from './plugins'
import { PrimeProviderService } from './providers'
import { ProjectService } from './projects'
import { ScheduleService, SettingsService } from './settings-schedules'
import { SessionService } from './sessions'
import { JsonStateStore } from './store'
import { TerminalService } from './terminal'

protocol.registerSchemesAsPrivileged([{ scheme: 'prime-work', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

let mainWindow: BrowserWindow | null = null
let ipc: IpcRegistration | null = null
let agents: AgentRpcManager | null = null
let terminals: TerminalService | null = null
let downloads: BrowserDownloadGuard | null = null
let providerService: PrimeProviderService | null = null
let store: JsonStateStore | null = null
let shutdownStarted = false
let trustedRendererUrl = ''
let windowCreation: Promise<BrowserWindow | null> | null = null

function appIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'assets', 'icon.png')
}

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
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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

async function primeVersion(executable: string | null): Promise<string | null> {
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

function hardenRenderer(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.allowRunningInsecureContent = false
    const partition = typeof params.partition === 'string' ? params.partition : ''
    if (partition !== 'persist:prime-work-browser' || !isAllowedBrowserUrl(params.src)) event.preventDefault()
  })
  window.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, target) => { if (!isAllowedBrowserUrl(target)) event.preventDefault() })
    contents.on('will-redirect', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.on('will-frame-navigate', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.once('destroyed', () => downloads?.cancelOwner(contents.id))
  })
  window.webContents.on('will-navigate', (event, target) => {
    const current = window.webContents.getURL()
    if (target !== current) event.preventDefault()
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
  const executable = await findPrimeAgent()
  if (shutdownStarted) return
  const stateStore = new JsonStateStore(join(app.getPath('userData'), 'prime-work-state.json'))
  store = stateStore
  const sessions = new SessionService(stateStore, executable)
  const projects = new ProjectService(stateStore, () => mainWindow)
  const git = new GitService((cwd) => projects.authorizeCwd(cwd))
  // This matches the renderer's startup query so both consumers share SessionService's coalesced catalog scan.
  const listCatalogSessions = (): ReturnType<SessionService['list']> => sessions.list(undefined, true)

  const providers = new PrimeProviderService({ openExternal: async (url) => { await shell.openExternal(url, { activate: true }) } })
  providerService = providers
  agents = new AgentRpcManager(
    executable,
    (cwd) => projects.authorizeCwd(cwd),
    (path) => sessions.requireSessionPath(path),
    providers,
    () => new Set(stateStore.snapshot().settings.disabledProviders),
  )
  sessions.bindRuntimeHooks({
    get: (path) => agents?.getForSession(path),
    stop: async (path) => { await agents?.stopForSession(path) },
    rename: async (path, title) => agents?.renameForSession(path, title) ?? false,
  })
  terminals = new TerminalService((cwd) => projects.authorizeCwd(cwd), () => stateStore.snapshot().settings.terminalShell)
  projects.bindProviders({
    sessions: listCatalogSessions,
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => { await Promise.all([agents!.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)]) },
  })
  downloads = new BrowserDownloadGuard(isAllowedBrowserUrl)
  const settings = new SettingsService(stateStore, (shell) => terminals!.validateShell(shell), () => downloads?.cancelAll(true))
  const browserProfile = session.fromPartition('persist:prime-work-browser')
  browserProfile.on('will-download', (event, item, owner) => downloads?.handle(event, item, owner, settings.get().browserAskForDownloads))
  const plugins = new PluginService(executable, (path) => projects.authorizeCwd(path))
  const schedules = new ScheduleService(agents, executable)
  const detectedPrimeVersion = await primeVersion(executable)
  if (shutdownStarted) return
  const meta: AppMeta = {
    version: app.getVersion(),
    platform: process.platform,
    homeDir: homedir(),
    primeAgentPath: executable,
    primeAgentVersion: detectedPrimeVersion,
  }
  trustedRendererUrl = resolveRendererUrl()
  ipc = registerIpc({ meta, projects, sessions, agents, terminals, git, plugins, providers, settings, schedules }, trustedRendererUrl)
  agents.setEventSink((envelope) => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('agent:event', envelope)
    }
  })
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
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  const browserProfile = session.fromPartition('persist:prime-work-browser')
  browserProfile.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserProfile.setPermissionCheckHandler(() => false)
  if (!!app.isPackaged) {
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"],
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
  // On macOS the broker and active agents stay alive when the last window closes.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  event.preventDefault()
  shutdownStarted = true

  const registration = ipc
  ipc = null
  registration?.dispose()
  agents?.beginShutdown()
  beginProcessShutdown()
  downloads?.cancelAll()
  const storeDrain = store?.beginShutdown() ?? Promise.resolve()

  providerService?.cancelAll()
  void Promise.all([terminals?.killAll() ?? Promise.resolve(), agents?.stopAll() ?? Promise.resolve(), stopChildProcesses(), storeDrain]).finally(() => app.quit())
})
