import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let page: Page
let fixtureRoot = ''
let actionableErrors: string[] = []

const attachDiagnostics = (target: Page) => {
  target.on('pageerror', (error) => actionableErrors.push(error.message))
  target.on('console', (message) => {
    if (message.type() === 'error') actionableErrors.push(message.text())
  })
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
  writeFileSync(join(project, 'README.md'), '# Hermetic Prime Work fixture\n')
  const sessionFile = join(sessions, 'fixture.jsonl')
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', id: 'fixture-session', cwd: project, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'fixture-message', parentId: null, message: { role: 'user', content: 'Hermetic desktop fixture', timestamp: '2026-01-01T00:00:00.000Z' } }),
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
    send({ type: 'extension_ui_request', id: 'fixture-question', method: 'select', title: 'Choose a release channel', options: ['Stable', 'Beta'] })
  } else if (command.type === 'extension_ui_response' && pendingPrompt) {
    const prompt = pendingPrompt
    pendingPrompt = undefined
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
    const fixture = createHermeticFixture()
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture.userData}`], cwd: process.cwd(), env: hermeticEnvironment(fixture.home, fixture.executable) })
    page = await app.firstWindow()
    attachDiagnostics(page)
    await page.locator('.app-shell').waitFor()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
  })

  test.afterEach(async () => {
    await app?.close().catch(() => undefined)
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('loads the sandboxed preload bridge and hermetic service data', async () => {
    const bridge = await page.evaluate(() => {
      const prime = (window as typeof window & { prime?: Record<string, unknown> }).prime
      return { type: typeof prime, groups: prime ? Object.keys(prime).sort() : [] }
    })
    expect(bridge.type).toBe('object')
    expect(bridge.groups).toEqual(['agent', 'app', 'git', 'plugins', 'projects', 'schedules', 'sessions', 'settings', 'terminal'])
    await expect(page.getByLabel('Prime Work by Prime Intellect')).toBeVisible()
    await expect(page.locator('.sidebar__brand .prime-mark svg path')).toHaveCount(2)
    await expect(page.locator('.prime-mark img')).toHaveCount(0)
  })

  test('navigates all primary workspace pages and command palette', async () => {
    for (const destination of ['Projects', 'Activity', 'Scheduled', 'Plugins & skills']) {
      await page.getByRole('button', { name: destination, exact: true }).click()
      await expect(page.locator('.page')).toBeVisible()
    }
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
    await page.keyboard.press('Meta+K')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.keyboard.press('Escape')
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
    await expect(dialog.getByRole('option', { name: 'Stable' })).toBeVisible()
    await expect(dialog.getByRole('option', { name: 'Beta' })).toBeVisible()
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.message--assistant .message-actions')).toBeVisible()
  })

  test('rolls back a rejected optimistic setting', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    const shell = page.locator('.settings-content input.mono')
    await expect(shell).toHaveValue('/bin/zsh')
    await shell.fill('/definitely/not-an-executable')
    await expect(page.locator('.toast')).toContainText(/shell is not executable/i)
    await expect(shell).toHaveValue('/bin/zsh')
  })

  test('uses overlay panels at the compact desktop breakpoint', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.setViewportSize({ width: 960, height: 700 })
    await expect.poll(() => page.locator('.sidebar').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect(page.locator('.panel-scrim--sidebar')).toBeVisible()
    await page.locator('.panel-scrim--sidebar').click({ position: { x: 900, y: 300 } })
    await page.getByRole('button', { name: 'Toggle inspector' }).click()
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
    const terminalHandleBox = await terminalHandle.boundingBox()
    expect(terminalBefore).not.toBeNull()
    expect(terminalHandleBox).not.toBeNull()
    await page.mouse.move(terminalHandleBox!.x + 120, terminalHandleBox!.y + terminalHandleBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(terminalHandleBox!.x + 120, terminalHandleBox!.y - 64, { steps: 5 })
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
    await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
    page = await app.firstWindow()
    attachDiagnostics(page)
    await expect(page.locator('.app-shell')).toBeVisible()
  })
})
