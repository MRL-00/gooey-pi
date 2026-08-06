import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication | undefined
let page: Page
let fixtureRoot = ''
let actionableErrors: string[] = []

const instrumentedPages = new WeakSet<Page>()

const attachDiagnostics = (target: Page) => {
  if (instrumentedPages.has(target)) return
  instrumentedPages.add(target)
  target.on('pageerror', (error) => actionableErrors.push(error.message))
  target.on('console', (message) => {
    if (message.type() === 'error') actionableErrors.push(message.text())
  })
}

async function closeHermeticApp(target: ElectronApplication | undefined): Promise<void> {
  if (!target) return
  const child = target.process()
  const closeEvent = target.waitForEvent('close', { timeout: 15_000 }).then(() => undefined, () => undefined)
  const gracefulClose = target.close().then(() => true, () => false)
  const closedGracefully = await Promise.race([
    gracefulClose,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ])
  if (closedGracefully) return
  if (child.exitCode === null) child.kill('SIGKILL')
  await closeEvent
}

function createHermeticFixture(): { userData: string; home: string; project: string; executable: string } {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'prime-work-e2e-'))
  const userData = join(fixtureRoot, 'user-data')
  const home = join(fixtureRoot, 'home')
  const project = join(fixtureRoot, 'project')
  const sessions = join(home, '.prime', 'agent', 'sessions')
  mkdirSync(userData, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  const canonicalProject = realpathSync(project)
  writeFileSync(join(project, 'README.md'), '# Hermetic Prime Work fixture\n')
  const sessionFile = join(sessions, 'fixture.jsonl')
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', id: 'fixture-session', cwd: canonicalProject, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'fixture-message', parentId: null, message: { role: 'user', content: 'Hermetic desktop fixture', timestamp: '2026-01-01T00:00:00.000Z' } }),
    JSON.stringify({
      type: 'custom_message', id: 'fixture-agent-message', parentId: 'fixture-message', customType: 'agent_message', display: true,
      content: '[from child:fixture-reviewer]\nAgent-to-agent message received.\n\nEnvelope metadata that should stay hidden.',
      details: { message: 'Fixture review complete. The readable agent response is available here.', from: { sessionName: 'fixture-reviewer', runtimeKind: 'subagent' } },
      timestamp: '2026-01-01T00:00:01.000Z',
    }),
    JSON.stringify({
      type: 'custom_message', id: 'fixture-goal-summary', parentId: 'fixture-agent-message', customType: 'goal_context', display: true,
      content: '<goal_context>Fixture control envelope that should stay hidden.</goal_context>',
      details: { kind: 'created', goalId: 'fixture-goal', objective: 'Verify the readable blue goal summary.', status: 'active', continuationsUsed: 0 },
      timestamp: '2026-01-01T00:00:02.000Z',
    }),
    '',
  ].join('\n'))
  writeFileSync(join(userData, 'prime-work-state.json'), JSON.stringify({
    version: 1,
    projects: [],
    settings: { browserHome: 'about:blank' },
    archivedSessions: [],
    dismissedProjectPaths: [],
  }))

  const executable = join(fixtureRoot, 'prime-agent-fixture.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('prime-agent 0.7.0\\n'); process.exit(0) }
if (args[0] === 'schedule') { process.stdout.write(JSON.stringify({ jobs: [] }) + '\\n'); process.exit(0) }
const resumeIndex = args.indexOf('--resume')
const sessionFile = resumeIndex >= 0 ? args[resumeIndex + 1] : ${JSON.stringify(sessionFile)}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let pendingPrompt
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { sessionId: 'fixture-session', sessionFile, isStreaming: false, thinkingLevel: 'medium', model: { provider: 'fixture', id: 'fixture-model', name: 'Fixture Model' } } })
  } else if (command.type === 'list_schedules') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { jobs: [] } })
  } else if (command.type === 'prompt' || command.type === 'follow_up') {
    pendingPrompt = command
    send({ type: 'agent_start' })
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Reviewing the available release channels before asking for input.' } })
    send({ type: 'tool_execution_start', toolCallId: 'ask-1', toolName: 'ask_user', args: { question: 'Which release channel?', options: ['Stable', 'Beta'] } })
    send({ type: 'extension_ui_request', id: 'fixture-question', method: 'select', title: 'Choose a release channel', options: ['Stable', 'Beta'] })
  } else if (command.type === 'extension_ui_response' && pendingPrompt) {
    const prompt = pendingPrompt
    pendingPrompt = undefined
    send({ type: 'tool_execution_end', toolCallId: 'ask-1', toolName: 'ask_user', result: { value: command.value } })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The selected release channel is ' + command.value + '.' } })
    const completedAt = new Date().toISOString()
    fs.appendFileSync(sessionFile, [
      JSON.stringify({ type: 'message', id: 'fixture-live-assistant', parentId: 'fixture-goal-summary', message: { role: 'assistant', timestamp: completedAt, content: [{ type: 'thinking', thinking: 'Reviewing the available release channels before asking for input.' }, { type: 'toolCall', id: 'ask-1', name: 'ask_user', arguments: { question: 'Which release channel?', options: ['Stable', 'Beta'] } }] } }),
      JSON.stringify({ type: 'message', id: 'fixture-live-result', parentId: 'fixture-live-assistant', message: { role: 'toolResult', timestamp: completedAt, toolCallId: 'ask-1', toolName: 'ask_user', content: JSON.stringify({ value: command.value }) } }),
      JSON.stringify({ type: 'message', id: 'fixture-live-final', parentId: 'fixture-live-result', message: { role: 'assistant', timestamp: completedAt, content: 'The selected release channel is ' + command.value + '.' } }),
    ].join('\\n') + '\\n')
    send({ type: 'agent_end' })
    send({ type: 'response', id: prompt.id, command: prompt.type, success: true, data: {} })
  } else if (command.id) {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
  }
})
`)
  chmodSync(executable, 0o755)
  return { userData, home, project, executable }
}

function hermeticEnvironment(home: string, executable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: fixtureRoot,
    SHELL: '/bin/zsh',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    PRIME_AGENT_BINARY: executable,
  }
  for (const key of ['USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING']) if (process.env[key]) env[key] = process.env[key]
  return env
}

test.describe('Prime Work desktop smoke', () => {
  test.beforeEach(async () => {
    actionableErrors = []
    app = undefined
    const fixture = createHermeticFixture()
    let startupError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      app = await electron.launch({
        args: ['.', `--user-data-dir=${fixture.userData}`],
        cwd: process.cwd(),
        env: hermeticEnvironment(fixture.home, fixture.executable),
        timeout: 20_000,
      })
      app.context().on('page', attachDiagnostics)
      for (const target of app.windows()) attachDiagnostics(target)
      try {
        page = await app.firstWindow({ timeout: 15_000 })
        attachDiagnostics(page)
        await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
        return
      } catch (error) {
        startupError = error
        await closeHermeticApp(app)
        app = undefined
      }
    }
    throw startupError ?? new Error('Prime Work did not create its initial window')
  })

  test.afterEach(async () => {
    await closeHermeticApp(app)
    app = undefined
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('loads the sandboxed preload bridge and hermetic service data', async () => {
    const bridge = await page.evaluate(() => {
      const prime = (window as typeof window & { prime?: Record<string, unknown> }).prime
      return { type: typeof prime, groups: prime ? Object.keys(prime).sort() : [] }
    })
    expect(bridge.type).toBe('object')
    expect(bridge.groups).toEqual(['agent', 'app', 'git', 'plugins', 'projects', 'providers', 'schedules', 'sessions', 'settings', 'terminal'])
    await expect(page.getByLabel('Prime Work by Prime Intellect')).toBeVisible()
    await expect(page.locator('.sidebar__brand small')).toHaveText('Work')
    await expect(page.locator('.sidebar__brand .prime-mark svg path')).toHaveCount(2)
    await expect(page.locator('.prime-mark img')).toHaveCount(0)
  })

  test('enforces the live preload and IPC frame boundaries', async () => {
    const initialMeta = await page.evaluate(() => window.prime.app.getMeta())
    expect(initialMeta.version).toBeTruthy()

    await page.evaluate(() => { window.location.hash = 'cfr-11-safe-fragment' })
    await expect(page).toHaveURL(/#cfr-11-safe-fragment$/)
    const fragmentMeta = await page.evaluate(() => window.prime.app.getMeta())
    expect(fragmentMeta).toEqual(initialMeta)

    await page.evaluate(() => {
      const iframe = document.createElement('iframe')
      iframe.name = 'untrusted-subframe'
      iframe.srcdoc = '<!doctype html><title>Untrusted subframe</title>'
      document.body.append(iframe)
    })
    await expect.poll(() => Boolean(page.frame({ name: 'untrusted-subframe' }))).toBe(true)
    const subframe = page.frame({ name: 'untrusted-subframe' })
    expect(subframe).not.toBeNull()
    await subframe!.waitForLoadState()
    expect(await subframe!.evaluate(() => typeof (window as Window & { prime?: unknown }).prime)).toBe('undefined')

    const deniedUrl = 'data:text/html,<title>Untrusted renderer</title><main>untrusted</main>'
    await app!.evaluate(async ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Expected the Prime Work window')
      await window.loadURL(url)
    }, deniedUrl)
    await expect(page).toHaveURL(/^data:text\/html,/)
    const deniedAccess = await page.evaluate(async () => {
      const prime = (window as Window & { prime?: typeof window.prime }).prime
      if (!prime) return { bridge: 'undefined', result: 'unavailable' }
      try {
        await prime.app.getMeta()
        return { bridge: 'object', result: 'resolved' }
      } catch (error) {
        return { bridge: 'object', result: error instanceof Error ? error.message : String(error) }
      }
    })
    expect(deniedAccess.bridge).toBe('object')
    expect(deniedAccess.result).toMatch(/IPC sender is not authorized/i)
  })

  test('keeps session options visible and starts a new session from a hovered project', async () => {
    const sessionOptions = page.locator('.session-row__more').first()
    await expect(sessionOptions).toBeVisible()
    await expect.poll(() => sessionOptions.evaluate((node) => getComputedStyle(node).opacity)).toBe('1')

    const projectRow = page.locator('.project-row').first()
    const projectSession = projectRow.getByRole('button', { name: /^New session in / })
    await expect.poll(() => projectSession.evaluate((node) => getComputedStyle(node).opacity)).toBe('0')
    await expect.poll(async () => {
      await projectRow.hover()
      return projectSession.evaluate((node) => getComputedStyle(node).opacity)
    }).toBe('1')
    await projectSession.click()

    await expect(projectRow).toHaveClass(/is-selected/)
    await expect(page.locator('.session-row-wrap.is-selected')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Message Prime' })).toHaveValue('')
  })

  test('shows agent messages as collapsed, expandable Prime handoffs instead of errors', async () => {
    const disclosure = page.getByRole('button', { name: 'Message from agent: fixture-reviewer' })
    await expect(disclosure).toBeVisible()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    const tones = await page.locator('.message--agent').evaluate((node) => {
      const styles = getComputedStyle(node)
      const probe = document.createElement('div')
      probe.style.background = 'var(--danger-soft)'
      document.body.append(probe)
      const danger = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { background: styles.backgroundColor, danger }
    })
    expect(tones.background).not.toBe(tones.danger)
    const content = page.locator('.message--agent .agent-message__content')
    await expect(content).toHaveCount(0)
    await disclosure.click()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(content).toContainText('Fixture review complete. The readable agent response is available here.')
    await expect(page.getByText('Envelope metadata that should stay hidden.')).toHaveCount(0)
  })

  test('shows goal summaries in collapsed blue disclosures', async () => {
    const disclosure = page.getByRole('button', { name: 'Goal summary' })
    await expect(disclosure).toBeVisible()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.goal-message__content')).toHaveCount(0)
    const colors = await page.locator('.message--goal').evaluate((node) => {
      const styles = getComputedStyle(node)
      const icon = node.querySelector('.goal-message__icon')
      const probe = document.createElement('div')
      probe.style.color = 'var(--annotation)'
      document.body.append(probe)
      const annotation = getComputedStyle(probe).color
      probe.remove()
      return { border: styles.borderColor, icon: icon ? getComputedStyle(icon).color : '', annotation }
    })
    expect(colors.border).not.toBe('rgba(0, 0, 0, 0)')
    expect(colors.icon).toBe(colors.annotation)
    await disclosure.click()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.goal-message__content')).toContainText('Verify the readable blue goal summary.')
    await expect(page.getByText('Fixture control envelope that should stay hidden.')).toHaveCount(0)
  })

  test('copies a specific user or agent message from the action directly below it', async () => {
    await page.evaluate(() => {
      const target = window as Window & { __copiedMessage?: string }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { target.__copiedMessage = text } },
      })
    })

    const userMessage = page.locator('.message--user').filter({ hasText: 'Hermetic desktop fixture' })
    await userMessage.hover()
    const userCopy = userMessage.locator('.message-actions button')
    await expect(userCopy).toHaveAccessibleName('Copy user message')
    await expect(userCopy).toBeVisible()
    await userCopy.click()
    await expect(userCopy).toHaveAccessibleName('Copied user message')
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedMessage?: string }).__copiedMessage)).toBe('Hermetic desktop fixture')

    const agentMessage = page.locator('.message--agent')
    await expect(agentMessage.getByRole('button', { name: 'Copy agent message' })).toHaveCount(0)
    await agentMessage.getByRole('button', { name: 'Message from agent: fixture-reviewer' }).click()
    await agentMessage.hover()
    const agentCopy = agentMessage.locator('.message-actions button')
    await expect(agentCopy).toHaveAccessibleName('Copy agent message')
    await expect(agentCopy).toBeVisible()
    await agentCopy.click()
    await expect(agentCopy).toHaveAccessibleName('Copied agent message')
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedMessage?: string }).__copiedMessage)).toBe('Fixture review complete. The readable agent response is available here.')
  })

  test('navigates all primary workspace pages and command palette', async () => {
    for (const destination of ['Projects', 'Activity', 'Scheduled', 'Plugins & skills']) {
      await page.getByRole('button', { name: destination, exact: true }).click()
      await expect(page.locator('.page')).toBeVisible()
    }
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await expect(page.getByLabel('Search providers')).toBeVisible()
    await expect(page.locator('.provider-row')).not.toHaveCount(0)
    await page.getByRole('tab', { name: /Models/ }).click()
    await expect(page.getByLabel('Search models')).toBeVisible()
    await expect(page.locator('.provider-model-row')).not.toHaveCount(0)
    await page.getByRole('button', { name: 'Prime Agent', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: /Show reasoning summaries/ })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: /Show tool calls/ })).toBeChecked()
    await page.keyboard.press('Meta+K')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('keeps transcript text from showing through the composer disclaimer', async () => {
    const colors = await page.locator('.composer-note').evaluate((node) => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--canvas)'
      document.body.append(probe)
      const canvas = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { note: getComputedStyle(node).backgroundColor, canvas }
    })
    expect(colors.note).toBe(colors.canvas)
    expect(colors.note).not.toContain('rgba')
  })

  test('applies dark appearance and restores system appearance', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByRole('button', { name: /Dark/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: /System/ }).click()
  })

  test('traps modal focus, closes on Escape, and restores the trigger', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Browser', exact: true }).first().click()
    const trigger = page.getByRole('button', { name: 'Clear data' })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Clear browser data?' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused()
    await expect(page.locator('.app-shell')).toHaveAttribute('inert')
    await page.keyboard.press('Meta+K')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('.app-shell')).not.toHaveAttribute('inert')
  })

  test('supports keyboard navigation for composer suggestions', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('/')
    const options = page.locator('.composer-menu').getByRole('option')
    await expect(options).toHaveCount(4)
    await expect(composer).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(composer).toHaveValue('/plan ')
    await expect(composer).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await expect(page.getByRole('combobox', { name: 'Message Prime' })).toHaveValue('')
  })

  test('round-trips an agent multiple-choice question through the desktop modal', async () => {
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Ask me which release channel to use')
    await composer.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Choose a release channel' })
    await expect(dialog).toBeVisible()
    const liveReasoning = page.locator('.activity-line--reasoning')
    await expect(liveReasoning).toContainText('Reviewing the available release channels before asking for input.')
    await expect(liveReasoning).not.toContainText('Reasoning')
    await expect(liveReasoning.locator('.activity-line__icon')).toHaveCount(0)
    await expect.poll(() => liveReasoning.evaluate((node) => getComputedStyle(node).fontStyle)).toBe('normal')
    await expect(page.locator('.thinking-dots > span')).toHaveCount(3)
    await expect(page.locator('.work-disclosure__button')).toHaveCount(0)
    await expect(dialog.getByRole('option', { name: 'Stable' })).toBeVisible()
    await expect(dialog.getByRole('option', { name: 'Beta' })).toBeVisible()
    await expect(dialog.getByRole('option', { name: 'Stable' })).toHaveClass(/is-selected/)
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await expect(dialog).toHaveCount(0)
    const worked = page.locator('.work-disclosure__button')
    await expect(worked).toContainText(/^Worked for (?:\d+s|\d+m\d{2}s|\d+h\d{2}m\d{2}s)$/)
    await expect(worked).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.activity-line--reasoning')).toHaveCount(0)
    await expect(page.locator('.thinking-dots')).toHaveCount(0)
    await expect(page.locator('.activity-line--question')).toHaveCount(0)
    const divider = await page.locator('.work-disclosure').evaluate((node) => {
      const styles = getComputedStyle(node)
      return { top: styles.borderTopStyle, bottom: styles.borderBottomStyle }
    })
    expect(divider).toEqual({ top: 'solid', bottom: 'none' })
    await worked.click()
    await expect(page.locator('.activity-line--question')).toContainText('Which release channel?')
    await expect(page.locator('.message--assistant .message-actions')).toBeVisible()

    const completedRow = page.locator('.session-row-wrap--complete').first()
    await expect(completedRow).toHaveClass(/has-attention/)
    await expect(page.locator('.unread-dot')).toHaveCount(0)
    await completedRow.locator('.session-row').click()
    await expect(completedRow).not.toHaveClass(/has-attention/)
  })

  test('preserves a rejected shell draft while rolling back the committed setting', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    const shell = page.getByLabel('Shell executable')
    const rejectedDraft = '/definitely/not-an-executable'
    await expect(shell).toHaveValue('/bin/zsh')
    await shell.fill(rejectedDraft)
    await expect(shell).toHaveValue(rejectedDraft)
    await expect(page.getByRole('alert')).toHaveCount(0)

    await shell.press('Enter')

    const inlineError = page.getByRole('alert').filter({ hasText: /setting could not be saved/i })
    await expect(inlineError).toBeVisible()
    await expect(shell).toHaveAttribute('aria-invalid', 'true')
    await expect(shell).toHaveAttribute('aria-describedby', await inlineError.getAttribute('id') ?? '')
    await expect(page.locator('.toast')).toContainText(/shell is not executable/i)
    await expect(shell).toHaveValue(rejectedDraft)
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect.poll(() => page.evaluate(() => window.prime.settings.get().then((settings) => settings.terminalShell))).toBe('/bin/zsh')
  })

  test('uses overlay panels at the compact desktop breakpoint', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.setViewportSize({ width: 960, height: 700 })
    await expect.poll(() => page.locator('.sidebar').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.inspector')).toHaveCount(0)
    const sidebarScrim = page.getByRole('button', { name: 'Close sidebar' })
    await expect(sidebarScrim).toBeVisible()
    await sidebarScrim.click({ position: { x: 900, y: 300 } })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
    await expect(page.locator('.title-toolbar')).not.toHaveAttribute('inert')
    const inspectorToggle = page.getByRole('button', { name: 'Toggle inspector' })
    await inspectorToggle.focus()
    await inspectorToggle.press('Enter')
    await expect.poll(() => page.locator('.inspector').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.locator('.panel-scrim--inspector')).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 920 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440)
    await page.getByRole('button', { name: /Show sidebar/ }).click()
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
  })

  test('attaches an isolated browser guest without navigation errors', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.getByRole('tab', { name: 'Browser' }).click()
    const guest = page.locator('webview[partition="persist:prime-work-browser"]')
    await expect(guest).toHaveCount(1)
    await expect.poll(() => guest.evaluate(async (node) => {
      const webview = node as HTMLElement & { executeJavaScript(script: string): Promise<unknown> }
      return webview.executeJavaScript('typeof window.prime')
    })).toBe('undefined')
    await page.waitForTimeout(2_500)
    expect(actionableErrors.filter((error) => /ERR_ABORTED|GUEST_VIEW_MANAGER_CALL/i.test(error))).toEqual([])
    await page.getByRole('tab', { name: 'Browser' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
  })

  test('resizes the inspector horizontally and terminal vertically', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.getByRole('tab', { name: 'Summary' }).click()

    const inspector = page.locator('.inspector')
    const inspectorHandle = page.getByRole('separator', { name: 'Resize inspector' })
    await expect(inspectorHandle).toBeVisible()
    const inspectorBefore = await inspector.boundingBox()
    const inspectorHandleBox = await inspectorHandle.boundingBox()
    expect(inspectorBefore).not.toBeNull()
    expect(inspectorHandleBox).not.toBeNull()
    await page.mouse.move(inspectorHandleBox!.x + inspectorHandleBox!.width / 2, inspectorHandleBox!.y + 80)
    await page.mouse.down()
    await page.mouse.move(inspectorHandleBox!.x - 72, inspectorHandleBox!.y + 80, { steps: 5 })
    await page.mouse.up()
    const inspectorAfter = await inspector.boundingBox()
    expect(inspectorAfter!.width).toBeGreaterThan(inspectorBefore!.width + 50)
    await inspectorHandle.focus()
    await page.keyboard.press('ArrowRight')
    expect((await inspector.boundingBox())!.width).toBeLessThan(inspectorAfter!.width)

    await page.getByLabel(/Toggle terminal/).click()
    const drawer = page.locator('.terminal-drawer')
    const terminalHandle = page.getByRole('separator', { name: 'Resize terminal' })
    await expect(terminalHandle).toBeVisible()
    const terminalBefore = await drawer.boundingBox()
    expect(terminalBefore).not.toBeNull()
    await expect.poll(async () => Number(await terminalHandle.getAttribute('aria-valuemax'))).toBeGreaterThan(terminalBefore!.height + 44)
    await terminalHandle.hover()
    const terminalHandleBox = await terminalHandle.boundingBox()
    expect(terminalHandleBox).not.toBeNull()
    const terminalHandleCenter = {
      x: terminalHandleBox!.x + terminalHandleBox!.width / 2,
      y: terminalHandleBox!.y + terminalHandleBox!.height / 2,
    }
    await page.mouse.move(terminalHandleCenter.x, terminalHandleCenter.y)
    await page.mouse.down()
    await expect(terminalHandle).toHaveAttribute('data-resizing', 'true')
    await page.mouse.move(terminalHandleCenter.x, terminalHandleCenter.y - 64, { steps: 5 })
    await page.mouse.up()
    const terminalAfter = await drawer.boundingBox()
    expect(terminalAfter!.height).toBeGreaterThan(terminalBefore!.height + 44)
    await terminalHandle.focus()
    await page.keyboard.press('ArrowDown')
    expect((await drawer.boundingBox())!.height).toBeLessThan(terminalAfter!.height)
    await page.getByLabel('Close terminal').click()
  })

  test('opens a real PTY and exposes only functional terminal controls', async () => {
    const project = await page.evaluate(async () => {
      const projects = await window.prime.projects.list()
      const selected = projects[0]
      if (!selected) return null
      return selected.inferred ? window.prime.projects.grantInferred(selected.primaryFolder) : selected
    })
    expect(project).not.toBeNull()
    await page.getByRole('tab', { name: 'Summary' }).click()
    await page.getByLabel(/Toggle terminal/).click()
    await expect(page.locator('.terminal-drawer .xterm')).toBeVisible()
    await expect(page.getByLabel(/New terminal/)).toHaveCount(0)
    await expect(page.getByLabel(/Split terminal/)).toHaveCount(0)
    const drawer = page.locator('.terminal-drawer')
    const before = await drawer.evaluate((node) => node.getBoundingClientRect().height)
    await page.getByLabel('Maximize terminal').click()
    await expect(drawer).toHaveClass(/is-maximized/)
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(before)
    await page.getByLabel('Restore terminal').click()
    await page.getByLabel('Close terminal').click()
  })

  test('closes and recreates the last macOS window cleanly', async () => {
    await page.close()
    await app!.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
    page = await app!.firstWindow({ timeout: 45_000 })
    attachDiagnostics(page)
    await expect(page.locator('.app-shell')).toBeVisible()
  })
})
