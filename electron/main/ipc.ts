import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { AppMeta, HarnessId, SessionChangeEvent } from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import type { GitService } from './git'
import type { ModelCatalogProvider } from './model-catalog'
import type { PluginService } from './plugins'
import type { PrimeProviderService } from './providers'
import type { ProjectService } from './projects'
import type { SettingsService } from './settings-schedules'
import type { AutomationService } from './schedules/service'
import type { HeartbeatService } from './schedules/heartbeats'
import type { SessionService } from './sessions'
import type { TerminalService } from './terminal'
import type { VoiceService } from './voice'
import type { AgentBrowserService } from './browser/agent-service'
import { requireExistingPath, requireRecord, requireString, requireWebUrl } from './validation'

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
  voice: VoiceService
  /** OMP-harness counterparts; always constructed, even when the omp CLI is absent. */
  omp: {
    projects: ProjectService
    sessions: SessionService
    agents: AgentRpcManager
    catalog: ModelCatalogProvider
  }
}

/** Strict enum gate for the untrusted optional harness argument; absence means 'prime'. */
function requireHarness(value: unknown): HarnessId {
  if (value === undefined) return 'prime'
  if (value === 'prime' || value === 'omp') return value
  throw new TypeError('Invalid harness')
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

  const projectsFor = (harness: HarnessId): ProjectService => harness === 'omp' ? services.omp.projects : services.projects
  const sessionsFor = (harness: HarnessId): SessionService => harness === 'omp' ? services.omp.sessions : services.sessions
  const agentsFor = (harness: HarnessId): AgentRpcManager => harness === 'omp' ? services.omp.agents : services.agents
  // Runtime ids route by ownership; ids no manager owns fall through to the
  // Prime manager so requireRuntime keeps its exact not-found semantics.
  const agentsForRuntime = (runtimeId: unknown): AgentRpcManager =>
    typeof runtimeId === 'string' && services.omp.agents.has(runtimeId) ? services.omp.agents : services.agents
  /**
   * Routes a session file to the harness whose validated session root contains
   * it, using each service's own canonicalizing path authorization (never
   * substring checks). Paths neither root accepts rethrow the Prime error, so
   * rejection shape and text are unchanged.
   */
  const sessionsForPath = async (filePath: unknown): Promise<{ harness: HarnessId; service: SessionService }> => {
    try {
      await services.sessions.requireSessionPath(filePath)
      return { harness: 'prime', service: services.sessions }
    } catch (primeError) {
      try { await services.omp.sessions.requireSessionPath(filePath) } catch { throw primeError }
      return { harness: 'omp', service: services.omp.sessions }
    }
  }
  /** OMP credentials stay CLI-owned; desktop-only visibility is routed separately below. */
  const requirePrimeProviderAuth = (harness: unknown): void => {
    if (requireHarness(harness) === 'omp') throw new Error('OMP provider authentication is managed by the omp CLI')
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
      () => services.omp.projects.authorizePath(requested),
      () => services.omp.sessions.requireSessionPath(requested),
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

  handle('projects:list', (_event, harness) => projectsFor(requireHarness(harness)).list())
  handle('projects:list-files', (_event, root, harness) => projectsFor(requireHarness(harness)).listFiles(root))
  handle('projects:list-worktrees', (_event, cwd, harness) => projectsFor(requireHarness(harness)).listWorktrees(cwd))
  handle('projects:open-worktree', (_event, cwd, path, harness) => projectsFor(requireHarness(harness)).openWorktree(cwd, path))
  handle('projects:create-worktree', (_event, cwd, branch, harness) => projectsFor(requireHarness(harness)).createWorktree(cwd, branch))
  handle('projects:add', (_event, harness) => projectsFor(requireHarness(harness)).add())
  handle('projects:grant-inferred', (_event, path, harness) => projectsFor(requireHarness(harness)).grantInferred(path))
  handle('projects:remove', (_event, id, harness) => projectsFor(requireHarness(harness)).remove(id))
  handle('projects:touch', (_event, id, harness) => projectsFor(requireHarness(harness)).touch(id))

  handle('sessions:list', (_event, projectPath, includeArchived, harness) => sessionsFor(requireHarness(harness)).list(projectPath, includeArchived))
  handle('sessions:read', async (_event, filePath) => (await sessionsForPath(filePath)).service.read(filePath))
  handle('sessions:follow-up', async (_event, filePath, message, intent) => {
    const routed = await sessionsForPath(filePath)
    // Daemon-socket follow-up is Prime-only; an OMP session answers exactly
    // like an inactive Prime session instead of introducing a new error shape.
    if (routed.harness === 'omp') return false
    return routed.service.followUp(filePath, message, intent)
  })
  handle('sessions:rename', async (_event, filePath, title) => (await sessionsForPath(filePath)).service.rename(filePath, title))
  handle('sessions:archive', async (_event, filePath, archived) => (await sessionsForPath(filePath)).service.archive(filePath, archived))

  handle('agent:start', (_event, rawOptions) => {
    const options = requireRecord(rawOptions, 'options')
    const harness = requireHarness(options.harness)
    // The manager start schema rejects unknown keys; the routing field must
    // not reach it.
    const { harness: _harness, ...startOptions } = options
    return agentsFor(harness).start(startOptions)
  })
  handle('agent:command', (_event, runtimeId, command) => agentsForRuntime(runtimeId).command(runtimeId, command))
  handle('agent:stop', (_event, runtimeId) => agentsForRuntime(runtimeId).stop(runtimeId))
  handle('agent:list', () => [...services.agents.list(), ...services.omp.agents.list()])

  const providerCatalog = (force = false) => services.providers.catalog(force, new Set(services.settings.get().disabledProviders))
  const ompProviderCatalog = (force = false) => services.omp.catalog.catalog(force, new Set(services.settings.get().ompDisabledProviders))
  handle('providers:catalog', (_event, force, harness) => requireHarness(harness) === 'omp' ? ompProviderCatalog(force === true) : providerCatalog(force === true))
  handle('providers:save-api-key', async (_event, providerId, apiKey, harness) => {
    requirePrimeProviderAuth(harness)
    await services.providers.saveApiKey(providerId, apiKey)
    return providerCatalog(true)
  })
  handle('providers:logout', async (_event, providerId, harness) => {
    requirePrimeProviderAuth(harness)
    await services.providers.logout(providerId)
    return providerCatalog(true)
  })
  handle('providers:set-enabled', async (_event, providerId, enabled, harness) => {
    const target = requireHarness(harness)
    const id = requireString(providerId, 'providerId', { min: 1, max: 128, trim: true })
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    const catalog = target === 'omp' ? await ompProviderCatalog() : await providerCatalog()
    if (!catalog.providers.some((provider) => provider.id === id)) throw new Error('Provider was not found')
    const settingsKey = target === 'omp' ? 'ompDisabledProviders' : 'disabledProviders'
    const disabled = new Set(services.settings.get()[settingsKey])
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    await services.settings.update({ [settingsKey]: [...disabled].sort() })
    return target === 'omp' ? ompProviderCatalog() : providerCatalog()
  })
  handle('providers:set-disabled', async (_event, providerIds, harness) => {
    const target = requireHarness(harness)
    if (!Array.isArray(providerIds) || providerIds.length > 256) throw new TypeError('providerIds must be a bounded array')
    const ids = [...new Set(providerIds.map((value, index) => requireString(value, `providerIds[${index}]`, { min: 1, max: 128, trim: true })))].sort()
    const catalog = target === 'omp' ? await ompProviderCatalog() : await providerCatalog()
    const known = new Set(catalog.providers.map((provider) => provider.id))
    if (ids.some((id) => !known.has(id))) throw new Error('Provider was not found')
    const settingsKey = target === 'omp' ? 'ompDisabledProviders' : 'disabledProviders'
    await services.settings.update({ [settingsKey]: ids })
    return target === 'omp' ? ompProviderCatalog() : providerCatalog()
  })
  handle('providers:start-oauth', (_event, providerId, harness) => {
    requirePrimeProviderAuth(harness)
    return services.providers.startOAuth(providerId)
  })
  handle('providers:respond-oauth', (_event, flowId, promptId, value) => services.providers.respondOAuth(flowId, promptId, value))
  handle('providers:cancel-oauth', (_event, flowId) => services.providers.cancelOAuth(flowId))

  handle('voice:credential-status', () => services.voice.credentialStatus())
  handle('voice:save-api-key', (_event, provider, apiKey) => services.voice.saveApiKey(provider, apiKey))
  handle('voice:delete-api-key', (_event, provider) => services.voice.deleteApiKey(provider))
  handle('voice:create-realtime-call', (_event, request) => services.voice.createRealtimeCall(request))
  handle('voice:transcribe', (_event, request) => services.voice.transcribe(request))
  handle('voice:execute-tool', (_event, request) => services.voice.executeTool(request))

  handle('terminal:create', (event, options) => services.terminals.create(event.sender, options))
  handle('terminal:bind-session', (event, terminalId, sessionPath) => services.terminals.bindSession(event.sender, terminalId, sessionPath))
  on('terminal:input', (event, terminalId, data) => services.terminals.input(event.sender, terminalId, data))
  on('terminal:resize', (event, terminalId, cols, rows) => services.terminals.resize(event.sender, terminalId, cols, rows))
  on('terminal:set-active-context', (event, terminalId, context) => services.terminals.setActiveContext(event.sender, terminalId, context))
  on('terminal:clear-active-context', (event, terminalId) => services.terminals.clearActiveContext(event.sender, terminalId))
  handle('terminal:kill', (event, terminalId) => services.terminals.kill(event.sender, terminalId))

  handle('git:status', (_event, cwd) => services.git.status(cwd))
  handle('git:diff', (_event, cwd, path, staged) => services.git.diff(cwd, path, staged))
  handle('git:stage', (_event, cwd, paths) => services.git.stage(cwd, paths))
  handle('git:unstage', (_event, cwd, paths) => services.git.unstage(cwd, paths))
  handle('git:restore', (_event, cwd, paths) => services.git.restore(cwd, paths))
  handle('git:commit', (_event, cwd, message) => services.git.commit(cwd, message))

  handle('plugins:list', (_event, projectPath) => services.plugins.list(projectPath))
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

  const forwardSessionChange = (change: SessionChangeEvent): void => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('sessions:changed', change)
    }
  }
  const unsubscribeSessionChanges = services.sessions.onDidChange(forwardSessionChange)
  const unsubscribeOmpSessionChanges = services.omp.sessions.onDidChange(forwardSessionChange)
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
      unsubscribeOmpSessionChanges()
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
