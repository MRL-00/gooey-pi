import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { AppMeta } from '../../src/types/api'
import { AgentRpcManager } from './agent-rpc'
import { GitService } from './git'
import { registerIpc, type IpcRegistration } from './ipc'
import { findPrimeAgent, runProcess, stopChildProcesses } from './process-utils'
import { PluginService } from './plugins'
import { ProjectService } from './projects'
import { ScheduleService, SettingsService } from './settings-schedules'
import { SessionService } from './sessions'
import { JsonStateStore } from './store'
import { TerminalService } from './terminal'

let mainWindow: BrowserWindow | null = null
let ipc: IpcRegistration | null = null
let agents: AgentRpcManager | null = null
let terminals: TerminalService | null = null
let shutdownStarted = false
let trustedRendererUrl = ''

function resolveRendererUrl(): string {
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (!developmentUrl) return pathToFileURL(join(__dirname, '../renderer/index.html')).href
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
  })
  window.webContents.on('will-navigate', (event, target) => {
    const current = window.webContents.getURL()
    if (target !== current) event.preventDefault()
  })
}

function createWindow(): BrowserWindow {
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
    if (!renderer.isDestroyed() && renderer.getURL() === trustedRendererUrl) ipc?.authorize(renderer)
  })
  renderer.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && url !== trustedRendererUrl) ipc?.revoke(rendererId)
  })
  renderer.on('render-process-gone', () => ipc?.revoke(rendererId))
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
  window.on('closed', () => {
    ipc?.revoke(rendererId)
    if (mainWindow === window) mainWindow = null
  })
  void window.loadURL(trustedRendererUrl)
  return window
}

async function bootstrap(): Promise<void> {
  const executable = await findPrimeAgent()
  const store = new JsonStateStore(join(app.getPath('userData'), 'prime-work-state.json'))
  const sessions = new SessionService(store, executable)
  const projects = new ProjectService(store, () => mainWindow)
  const git = new GitService((cwd) => projects.authorizeCwd(cwd))
  projects.bindProviders({ sessions: () => sessions.list(), branch: (cwd) => git.branch(cwd) })

  agents = new AgentRpcManager(executable, (cwd) => projects.authorizeCwd(cwd), (path) => sessions.requireSessionPath(path))
  sessions.bindRuntimeHooks({
    get: (path) => agents?.getForSession(path),
    stop: async (path) => { await agents?.stopForSession(path) },
    rename: async (path, title) => agents?.renameForSession(path, title) ?? false,
  })
  terminals = new TerminalService((cwd) => projects.authorizeCwd(cwd), () => store.snapshot().settings.terminalShell)
  const settings = new SettingsService(store, (shell) => terminals!.validateShell(shell))
  const browserProfile = session.fromPartition('persist:prime-work-browser')
  browserProfile.on('will-download', (event, item) => {
    const chainIsSafe = item.getURLChain().every(isAllowedBrowserUrl)
    const size = item.getTotalBytes()
    if (!settings.get().browserAskForDownloads || !item.hasUserGesture() || !chainIsSafe || size > 512 * 1024 * 1024) { event.preventDefault(); return }
    item.setSaveDialogOptions({ title: 'Save browser download', defaultPath: item.getFilename() })
    item.on('updated', () => { if (item.getReceivedBytes() > 512 * 1024 * 1024) item.cancel() })
  })
  const plugins = new PluginService(executable, (path) => projects.authorizeCwd(path))
  const schedules = new ScheduleService(agents, executable)
  const meta: AppMeta = {
    version: app.getVersion(),
    platform: process.platform,
    homeDir: homedir(),
    primeAgentPath: executable,
    primeAgentVersion: await primeVersion(executable),
  }
  trustedRendererUrl = resolveRendererUrl()
  ipc = registerIpc({ meta, projects, sessions, agents, terminals, git, plugins, settings, schedules }, trustedRendererUrl)
  agents.setEventSink((envelope) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:event', envelope)
  })
  createWindow()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else void app.whenReady().then(async () => {
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
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() }
  })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch((error) => {
  console.error('Prime Work failed to start:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  // On macOS the broker and active agents stay alive when the last window closes.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownStarted || (!agents && !terminals)) return
  event.preventDefault()
  shutdownStarted = true
  terminals?.killAll()
  void Promise.all([agents?.stopAll() ?? Promise.resolve(), stopChildProcesses()]).finally(() => {
    ipc?.dispose()
    app.quit()
  })
})
