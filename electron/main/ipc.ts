import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { AppMeta } from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import type { GitService } from './git'
import type { PluginService } from './plugins'
import type { PrimeProviderService } from './providers'
import type { ProjectService } from './projects'
import type { SettingsService } from './settings-schedules'
import type { AutomationService } from './schedules/service'
import type { HeartbeatService } from './schedules/heartbeats'
import type { SessionService } from './sessions'
import type { TerminalService } from './terminal'
import type { AgentBrowserService } from './browser/agent-service'
import { requireExistingPath, requireString, requireWebUrl } from './validation'

interface Services {
  meta: AppMeta
  projects: ProjectService
  sessions: SessionService
  agents: AgentRpcManager
  terminals: TerminalService
  git: GitService
  plugins: PluginService
  providers: PrimeProviderService
  settings: SettingsService
  heartbeats: HeartbeatService
  schedules: AutomationService
  browser: AgentBrowserService
}

type IpcEvent = IpcMainInvokeEvent | IpcMainEvent

export function isTrustedRendererUrl(url: string, expectedRendererUrl: string): boolean {
  try {
    const actual = new URL(url)
    const expected = new URL(expectedRendererUrl)
    // Fragments never cross the document/security boundary; allow in-document anchors only.
    actual.hash = ''
    expected.hash = ''
    return actual.href === expected.href
  } catch { return false }
}

export interface IpcRegistration {
  authorize(webContents: WebContents): void
  revoke(webContentsId: number): void
  dispose(): void
}

let activeIpcRegistration: IpcRegistration | null = null

export function registerIpc(services: Services, expectedRendererUrl: string): IpcRegistration {
  if (activeIpcRegistration) {
    console.warn('registerIpc called while a previous registration was still active; disposing the previous registration')
    activeIpcRegistration.dispose()
  }
  const authorized = new Map<number, WebContents>()
  const invokeChannels: string[] = []
  const eventChannels: string[] = []
  let closed = false

  const verify = (event: IpcEvent): void => {
    const trustedFrame = event.senderFrame === event.sender.mainFrame
      && isTrustedRendererUrl(event.senderFrame.url, expectedRendererUrl)
      && isTrustedRendererUrl(event.sender.getURL(), expectedRendererUrl)
    if (closed || !authorized.has(event.sender.id) || event.sender.isDestroyed() || !trustedFrame) throw new Error('IPC sender is not authorized')
  }
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => { verify(event); return listener(event, ...args) })
    invokeChannels.push(channel)
  }
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void => {
    const wrapped = (event: IpcMainEvent, ...args: unknown[]) => {
      try { verify(event); listener(event, ...args) } catch (error) { console.warn(`Rejected ${channel}:`, error instanceof Error ? error.message : error) }
    }
    // Symmetric with handle(): these are private fixed channels, so any prior listener is stale.
    ipcMain.removeAllListeners(channel)
    ipcMain.on(channel, wrapped)
    eventChannels.push(channel)
  }

  handle('app:get-meta', () => services.meta)
  handle('app:open-external', async (_event, url) => {
    try { await shell.openExternal(requireWebUrl(url, { mailto: true }), { activate: true }); return true } catch { return false }
  })
  handle('app:reveal-path', async (_event, path) => {
    let requested: string
    try { requested = await requireExistingPath(path) } catch { return false }
    const authorizations: Array<() => Promise<string> | string> = [
      () => services.projects.authorizePath(requested),
      () => services.sessions.requireSessionPath(requested),
      () => services.plugins.authorizeReveal(requested),
    ]
    for (const authorize of authorizations) {
      let authorized: string
      try { authorized = await authorize() } catch { continue /* denial here defers to the next authorization domain */ }
      try {
        shell.showItemInFolder(authorized)
        return true
      } catch (error) {
        console.warn('Rejected app:reveal-path:', error instanceof Error ? error.message : error)
        return false
      }
    }
    return false
  })

  handle('projects:list', () => services.projects.list())
  handle('projects:list-files', (_event, root) => services.projects.listFiles(root))
  handle('projects:add', () => services.projects.add())
  handle('projects:grant-inferred', (_event, path) => services.projects.grantInferred(path))
  handle('projects:remove', (_event, id) => services.projects.remove(id))
  handle('projects:touch', (_event, id) => services.projects.touch(id))

  handle('sessions:list', (_event, projectPath, includeArchived) => services.sessions.list(projectPath as string | undefined, includeArchived))
  handle('sessions:read', (_event, filePath) => services.sessions.read(filePath as string))
  handle('sessions:follow-up', (_event, filePath, message, intent) => services.sessions.followUp(filePath, message, intent))
  handle('sessions:rename', (_event, filePath, title) => services.sessions.rename(filePath as string, title as string))
  handle('sessions:archive', (_event, filePath, archived) => services.sessions.archive(filePath as string, archived))

  handle('agent:start', (_event, options) => services.agents.start(options))
  handle('agent:command', (_event, runtimeId, command) => services.agents.command(runtimeId, command))
  handle('agent:stop', (_event, runtimeId) => services.agents.stop(runtimeId))
  handle('agent:list', () => services.agents.list())

  const providerCatalog = (force = false) => services.providers.catalog(force, new Set(services.settings.get().disabledProviders))
  handle('providers:catalog', (_event, force) => providerCatalog(force === true))
  handle('providers:save-api-key', async (_event, providerId, apiKey) => {
    await services.providers.saveApiKey(providerId, apiKey)
    return providerCatalog(true)
  })
  handle('providers:logout', async (_event, providerId) => {
    await services.providers.logout(providerId)
    return providerCatalog(true)
  })
  handle('providers:set-enabled', async (_event, providerId, enabled) => {
    const id = requireString(providerId, 'providerId', { min: 1, max: 128, trim: true })
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    const catalog = await providerCatalog()
    if (!catalog.providers.some((provider) => provider.id === id)) throw new Error('Provider was not found')
    const disabled = new Set(services.settings.get().disabledProviders)
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    await services.settings.update({ disabledProviders: [...disabled].sort() })
    return providerCatalog()
  })
  handle('providers:start-oauth', (_event, providerId) => services.providers.startOAuth(providerId))
  handle('providers:respond-oauth', (_event, flowId, promptId, value) => services.providers.respondOAuth(flowId, promptId, value))
  handle('providers:cancel-oauth', (_event, flowId) => services.providers.cancelOAuth(flowId))

  handle('terminal:create', (event, options) => services.terminals.create(event.sender, options))
  on('terminal:input', (event, terminalId, data) => services.terminals.input(event.sender, terminalId, data))
  on('terminal:resize', (event, terminalId, cols, rows) => services.terminals.resize(event.sender, terminalId, cols, rows))
  handle('terminal:kill', (event, terminalId) => services.terminals.kill(event.sender, terminalId))

  handle('git:status', (_event, cwd) => services.git.status(cwd))
  handle('git:diff', (_event, cwd, path, staged) => services.git.diff(cwd, path, staged))
  handle('git:stage', (_event, cwd, paths) => services.git.stage(cwd, paths))
  handle('git:unstage', (_event, cwd, paths) => services.git.unstage(cwd, paths))
  handle('git:restore', (_event, cwd, paths) => services.git.restore(cwd, paths))
  handle('git:commit', (_event, cwd, message) => services.git.commit(cwd, message))

  handle('plugins:list', (_event, projectPath) => services.plugins.list(projectPath as string | undefined))
  handle('plugins:install', (_event, source) => services.plugins.install(source))
  handle('plugins:connect-mcp', (_event, input) => services.plugins.connectMcp(input))
  handle('plugins:refresh', () => services.plugins.refresh())

  handle('settings:get', () => services.settings.get())
  handle('settings:update', (_event, patch) => services.settings.update(patch))
  handle('settings:reset-browser-data', () => services.settings.resetBrowserData())

  handle('browser:state', () => services.browser.state())
  handle('browser:attach-tab', (_event, tabId, webContentsId) => services.browser.attachTab(tabId, webContentsId))
  handle('browser:select-tab', (_event, tabId) => services.browser.selectTab(tabId))
  handle('browser:close-tab', (_event, tabId) => services.browser.closeTab(tabId))
  handle('browser:set-preview-context', (_event, webContentsId, sessionFile) => services.browser.setPreviewContext(webContentsId, sessionFile))
  handle('browser:navigate-tab', (_event, tabId, action, url) => services.browser.navigateTab(tabId, action, url))

  handle('heartbeats:list', () => services.heartbeats.list())
  handle('heartbeats:manage', (_event, id, action) => services.heartbeats.manage(id, action))

  handle('schedules:list', () => services.schedules.list())
  handle('schedules:get', (_event, id) => services.schedules.get(id))
  handle('schedules:preview', (_event, timing, count) => services.schedules.preview(timing, count))
  handle('schedules:create', (_event, input) => services.schedules.create(input, 'user'))
  handle('schedules:update', (_event, id, patch) => services.schedules.update(id, patch))
  handle('schedules:pause', (_event, id) => services.schedules.pause(id))
  handle('schedules:resume', (_event, id) => services.schedules.resume(id))
  handle('schedules:delete', (_event, id) => services.schedules.delete(id))
  handle('schedules:run-now', (_event, id) => services.schedules.runNow(id))

  const unsubscribeSessionChanges = services.sessions.onDidChange((change) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('sessions:changed', change)
    }
  })
  const scheduleSubscription = services.schedules.onDidChange((change) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('schedules:changed', change)
    }
  })
  const unsubscribeScheduleChanges = typeof scheduleSubscription === 'function' ? scheduleSubscription : () => undefined
  const browserSubscription = services.browser.onDidChange((state) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:changed', state)
    }
  })
  const unsubscribeBrowserChanges = typeof browserSubscription === 'function' ? browserSubscription : () => undefined
  const pointerSubscription = services.browser.onPointer((event) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:pointer', event)
    }
  })
  const unsubscribeBrowserPointer = typeof pointerSubscription === 'function' ? pointerSubscription : () => undefined
  const activitySubscription = services.browser.onActivity((event) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:activity', event)
    }
  })
  const unsubscribeBrowserActivity = typeof activitySubscription === 'function' ? activitySubscription : () => undefined

  const registration: IpcRegistration = {
    authorize(webContents) { if (!closed) authorized.set(webContents.id, webContents) },
    revoke(webContentsId) { authorized.delete(webContentsId); void services.terminals.killOwner(webContentsId) },
    dispose() {
      if (closed) return
      closed = true
      if (activeIpcRegistration === registration) activeIpcRegistration = null
      authorized.clear()
      unsubscribeSessionChanges()
      if (typeof unsubscribeScheduleChanges === 'function') unsubscribeScheduleChanges()
      if (typeof unsubscribeBrowserChanges === 'function') unsubscribeBrowserChanges()
      if (typeof unsubscribeBrowserPointer === 'function') unsubscribeBrowserPointer()
      if (typeof unsubscribeBrowserActivity === 'function') unsubscribeBrowserActivity()
      for (const channel of invokeChannels) ipcMain.removeHandler(channel)
      // Event listeners are removed wholesale only for our private fixed channels.
      for (const channel of eventChannels) ipcMain.removeAllListeners(channel)
    },
  }
  activeIpcRegistration = registration
  return registration
}
