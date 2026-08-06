import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

let app: ElectronApplication
let page: Page
let fixtureRoot = ''
let fixtureSessionFile = ''
let actionableErrors: string[] = []

const attachDiagnostics = (target: Page) => {
  target.on('pageerror', (error) => actionableErrors.push(error.message))
  target.on('console', (message) => {
    if (message.type() === 'error') actionableErrors.push(message.text())
  })
}

function createHermeticFixture(activeSession = false): { userData: string; home: string; project: string; executable: string; sessionFile: string } {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'prime-work-e2e-'))
  const userData = join(fixtureRoot, 'user-data')
  const home = join(fixtureRoot, 'home')
  const project = join(fixtureRoot, 'project')
  const secondary = join(fixtureRoot, 'secondary-project')
  const sessions = join(home, '.prime', 'agent', 'sessions')
  mkdirSync(userData, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(secondary, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  const canonicalProject = realpathSync(project)
  const canonicalSecondary = realpathSync(secondary)
  const initializeRepository = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), 'base\n')
    for (const args of [
      ['init', '-q'],
      ['config', 'user.name', 'Prime Work E2E'],
      ['config', 'user.email', 'e2e@example.com'],
      ['add', file],
      ['commit', '-qm', 'base'],
    ]) {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
    }
  }
  initializeRepository(project, 'primary.txt')
  initializeRepository(secondary, 'secondary-change.txt')
  writeFileSync(join(secondary, 'secondary-change.txt'), 'base\nsecondary workspace change\n')
  writeFileSync(join(project, 'README.md'), '# Hermetic Prime Work fixture\n')
  const sessionFile = join(sessions, 'fixture.jsonl')
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', id: 'fixture-session', cwd: canonicalSecondary, timestamp: '2026-01-01T00:00:00.000Z' }),
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
  writeFileSync(join(sessions, 'primary.jsonl'), [
    JSON.stringify({ type: 'session', id: 'primary-session', cwd: canonicalProject, timestamp: '2025-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'primary-message', parentId: null, message: { role: 'user', content: 'Primary workspace fixture', timestamp: '2025-01-01T00:00:00.000Z' } }),
    '',
  ].join('\n'))
  const identity = (path: string) => {
    const info = lstatSync(path, { bigint: true })
    return { dev: info.dev.toString(), ino: info.ino.toString() }
  }
  writeFileSync(join(userData, 'prime-work-state.json'), JSON.stringify({
    version: 1,
    projects: [{
      id: 'multi-folder-project', name: 'Multi-folder fixture', path: canonicalProject,
      folders: [canonicalProject, canonicalSecondary], primaryFolder: canonicalProject,
      pinned: false, createdAt: '2025-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z',
      folderIdentities: { [canonicalProject]: identity(canonicalProject), [canonicalSecondary]: identity(canonicalSecondary) },
    }],
    settings: { browserHome: 'about:blank', telemetry: true },
    archivedSessions: [],
    dismissedProjectPaths: [],
  }))

  const daemonExecutable = join(fixtureRoot, 'prime-agent-daemon-fixture.cjs')
  writeFileSync(daemonExecutable, `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const socketPath = ${JSON.stringify(join(fixtureRoot, 'daemon.sock'))}
try { fs.unlinkSync(socketPath) } catch {}
const server = net.createServer((socket) => {
  socket.write(JSON.stringify({ type: 'daemon_hello', protocol: { name: 'prime-agent.daemon', version: 7 }, serverCapabilities: ['session_input_admission'] }) + '\\n')
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\\n')) {
      const index = buffer.indexOf('\\n')
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const envelope = JSON.parse(line)
      if (envelope.command?.type === 'ack_result') {
        fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'follow-up-ack.json'))}, JSON.stringify(envelope.command))
        continue
      }
      if (envelope.command?.type !== 'follow_up') continue
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'follow-up-args.json'))}, JSON.stringify(envelope.command))
      const timestamp = new Date().toISOString()
      fs.appendFileSync(${JSON.stringify(sessionFile)}, [
        JSON.stringify({ type: 'message', id: 'fixture-external-user', parentId: 'fixture-goal-summary', timestamp, message: { role: 'user', content: envelope.command.message } }),
        JSON.stringify({ type: 'message', id: 'fixture-external-assistant', parentId: 'fixture-external-user', timestamp, message: { role: 'assistant', content: 'The external Prime Agent received the queued reply.' } }),
      ].join('\\n') + '\\n')
      socket.write(JSON.stringify({ id: envelope.id, type: 'response', command: 'follow_up', success: true, data: {} }) + '\\n')
    }
  })
  socket.on('end', () => server.close())
})
server.listen(socketPath)
setTimeout(() => server.close(), 30_000).unref()
`)
  chmodSync(daemonExecutable, 0o755)

  const executable = join(fixtureRoot, 'prime-agent-fixture.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('prime-agent 0.7.0\\n'); process.exit(0) }
if (args[0] === 'schedule') { process.stdout.write(JSON.stringify({ jobs: [] }) + '\\n'); process.exit(0) }
const resumeIndex = args.indexOf('--resume')
const sessionFile = resumeIndex >= 0 ? args[resumeIndex + 1] : ${JSON.stringify(realpathSync(sessionFile))}
if (args[0] === 'list') {
  const sessions = ${JSON.stringify(activeSession)}
    ? [{ id: 'active-fixture', activeSessionId: 'active-fixture', lifecycle: 'live', isSessionActive: true, activity: 'working', isStreaming: true, sessionFile, modified: new Date().toISOString() }]
    : []
  process.stdout.write(JSON.stringify({ sessions }) + '\\n')
  process.exit(0)
}
if (args[0] === 'status') {
  const { spawn } = require('node:child_process')
  if (!fs.existsSync(${JSON.stringify(join(fixtureRoot, 'daemon.sock'))})) {
    const child = spawn(process.execPath, [${JSON.stringify(join(fixtureRoot, 'prime-agent-daemon-fixture.cjs'))}], { detached: true, stdio: 'ignore' })
    child.unref()
    const wait = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 3_000
    while (!fs.existsSync(${JSON.stringify(join(fixtureRoot, 'daemon.sock'))}) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20)
  }
  if (!fs.existsSync(${JSON.stringify(join(fixtureRoot, 'daemon.sock'))})) process.exit(2)
  process.stdout.write(JSON.stringify([{ isDefault: true, status: 'current', socketPath: ${JSON.stringify(join(fixtureRoot, 'daemon.sock'))} }]) + '\\n')
  process.exit(0)
}
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
  return { userData, home, project, executable, sessionFile: realpathSync(sessionFile) }
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
  test.beforeEach(async ({}, testInfo) => {
    actionableErrors = []
    const activeSession = testInfo.title === 'queues a reply to a session that is active outside Prime Work'
      || testInfo.title === 'reflects an external JSONL append without reselecting the live session'
    const fixture = createHermeticFixture(activeSession)
    fixtureSessionFile = fixture.sessionFile
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
    fixtureSessionFile = ''
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

  test('queues a reply to a session that is active outside Prime Work', async () => {
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Queue this follow-up from Prime Work')
    await composer.press('Enter')

    const marker = join(fixtureRoot, 'follow-up-args.json')
    await expect.poll(() => existsSync(marker)).toBe(true)
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({
      type: 'follow_up',
      activeSessionId: 'active-fixture',
      message: 'Queue this follow-up from Prime Work',
    })
    const ackMarker = join(fixtureRoot, 'follow-up-ack.json')
    await expect.poll(() => existsSync(ackMarker)).toBe(true)
    expect(JSON.parse(readFileSync(ackMarker, 'utf8'))).toMatchObject({ type: 'ack_result' })
    await expect(page.locator('.transcript').getByText('The external Prime Agent received the queued reply.')).toBeVisible()
    await expect(page.getByText(/Prime Agent RPC exited|Request failed/)).toHaveCount(0)
  })

  test('reflects an external JSONL append without reselecting the live session', async () => {
    await expect(page.locator('.transcript').getByText('Hermetic desktop fixture', { exact: true })).toBeVisible()
    const selectedSession = page.locator('.session-row-wrap.is-selected')
    await expect(selectedSession).toHaveCount(1)

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const reasoning = `External live reasoning ${nonce}`
    const answer = `External live answer ${nonce}`
    const timestamp = new Date().toISOString()
    appendFileSync(fixtureSessionFile, `${JSON.stringify({
      type: 'message',
      id: `fixture-external-${nonce}`,
      parentId: 'fixture-goal-summary',
      timestamp,
      message: {
        role: 'assistant',
        timestamp,
        content: [
          { type: 'thinking', thinking: reasoning },
          { type: 'toolCall', id: `fixture-tool-${nonce}`, name: 'fixture_external_tool', arguments: { nonce } },
          { type: 'text', text: answer },
        ],
      },
    })}
`)

    await expect(page.locator('.transcript').getByText(reasoning, { exact: true })).toHaveCount(1)
    await expect(page.locator('.transcript').getByText(answer, { exact: true })).toHaveCount(1)
    await expect(page.locator('.activity-line--tool')).toContainText('fixture_external_tool')
    await expect(page.locator('.work-disclosure__button')).toHaveCount(0)
    await expect(selectedSession).toHaveCount(1)
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

  test('disables a persisted diagnostics preference', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Privacy', exact: true }).click()
    const diagnostics = page.getByRole('checkbox', { name: 'Share optional diagnostics' })
    await expect(diagnostics).toBeChecked()
    await diagnostics.focus()
    await diagnostics.press('Space')
    await expect(diagnostics).not.toBeChecked()
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).telemetry)).toBe(false)
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
    await expect(completedRow).toHaveClass(/is-selected/)
    await expect(completedRow).not.toHaveClass(/has-attention/)
    await expect(page.locator('.unread-dot')).toHaveCount(0)
  })

  test('preserves a rejected settings draft with an actionable error', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    const shell = page.locator('.settings-content input.mono')
    await expect(shell).toHaveValue('/bin/zsh')
    await shell.fill('/definitely/not-an-executable')
    await shell.press('Enter')
    await expect(page.getByRole('alert')).toContainText(/could not be saved/i)
    await expect(page.locator('.toast')).toContainText(/shell is not executable/i)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).terminalShell)).toBe('/bin/zsh')
    await expect(shell).toHaveValue('/definitely/not-an-executable')

    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    await expect(page.locator('.settings-content input.mono')).toHaveValue('/bin/zsh')
  })

  test('uses overlay panels at the compact desktop breakpoint', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.setViewportSize({ width: 960, height: 700 })
    await expect.poll(() => page.locator('.sidebar').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect(page.locator('.panel-scrim--sidebar')).toBeVisible()
    await page.locator('.panel-scrim--sidebar').click({ position: { x: 900, y: 300 } })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).sidebarOpen)).toBe(false)
    // Panel reconciliation may restore a confirmed inspector preference after
    // the sidebar closes. Normalize either valid state before testing the toggle.
    await page.waitForTimeout(250)
    if (await page.locator('.inspector').count()) {
      await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
      await expect(page.locator('.inspector')).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Toggle inspector' }).click()
    await expect.poll(() => page.locator('.inspector').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
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

  test('binds Git to a secondary workspace and clears stale paths during a folder switch', async () => {
    await page.getByRole('tab', { name: 'Changes' }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await expect(page.getByRole('button', { name: /Stage$/ }).last()).toBeVisible()

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.file-changes')).not.toContainText('secondary-change.txt')
    await expect(page.locator('.file-changes')).toContainText('README.md')

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await page.getByRole('button', { name: /Stage$/ }).last().click()
    await page.getByRole('button', { name: 'Staged', exact: true }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await page.getByRole('button', { name: /Unstage$/ }).last().click()
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

  test('recreates the terminal in the active secondary-folder cwd', async () => {
    await page.getByLabel(/Toggle terminal/).click()
    const input = page.locator('.terminal-drawer .xterm-helper-textarea')
    await expect(input).toBeVisible()
    await input.click()
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-drawer .xterm-rows')).toContainText(/secondary-project/, { timeout: 8_000 })

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    const restartedInput = page.locator('.terminal-drawer .xterm-helper-textarea')
    await expect(restartedInput).toBeVisible()
    await restartedInput.click()
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-drawer .xterm-rows')).toContainText(/prime-work-e2e-[^/]+\/project/, { timeout: 8_000 })
    await expect(page.locator('.terminal-drawer .xterm-rows')).not.toContainText('secondary-project')
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
