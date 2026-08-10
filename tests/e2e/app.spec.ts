import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

let app: ElectronApplication | undefined
let page: Page
let fixtureRoot = ''
let fixtureSessionFile = ''
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

function createHermeticFixture(activeSession = false): { userData: string; home: string; project: string; executable: string; ompExecutable: string; sessionFile: string } {
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
  const ompSessions = join(home, '.omp', 'agent', 'sessions', '-omp-project')
  mkdirSync(ompSessions, { recursive: true })
  const ompTitleUnpadded = JSON.stringify({ type: 'title', v: 1, title: 'OMP hermetic fixture', updatedAt: '2026-02-01T00:00:00.000Z', pad: '' })
  const ompTitleSlot = JSON.stringify({ type: 'title', v: 1, title: 'OMP hermetic fixture', updatedAt: '2026-02-01T00:00:00.000Z', pad: ' '.repeat(256 - 1 - Buffer.byteLength(ompTitleUnpadded, 'utf8')) })
  writeFileSync(join(ompSessions, '2026-02-01T00-00-00-000Z_019fdf24-aaaa-7000-8000-000000000001.jsonl'), [
    ompTitleSlot,
    JSON.stringify({ type: 'session', version: 3, id: '019fdf24-aaaa-7000-8000-000000000001', timestamp: '2026-02-01T00:00:00.000Z', cwd: canonicalProject }),
    JSON.stringify({ type: 'message', id: 'omp-user', parentId: null, timestamp: '2026-02-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'OMP hermetic fixture' }], timestamp: 1774915201000 } }),
    JSON.stringify({ type: 'message', id: 'omp-assistant', parentId: 'omp-user', timestamp: '2026-02-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'OMP fixture reply.' }] } }),
    '',
  ].join('\n'))
  const sessionFile = join(sessions, 'fixture.jsonl')
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', id: 'fixture-session', cwd: canonicalSecondary, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'fixture-message', parentId: null, message: { role: 'user', content: [
      { type: 'text', text: 'Hermetic desktop fixture' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
    ], timestamp: '2026-01-01T00:00:00.000Z' } }),
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
    return {
      dev: info.dev.toString(),
      ino: info.ino.toString(),
      birthtimeNs: info.birthtimeNs > 0n ? info.birthtimeNs.toString() : undefined,
    }
  }
  writeFileSync(join(userData, 'prime-work-state.json'), JSON.stringify({
    version: 1,
    projects: [{
      id: 'multi-folder-project', name: 'Multi-folder fixture', path: canonicalProject,
      folders: [canonicalProject, canonicalSecondary], primaryFolder: canonicalProject,
      pinned: false, createdAt: '2025-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z',
      folderIdentities: { [canonicalProject]: identity(canonicalProject), [canonicalSecondary]: identity(canonicalSecondary) },
    }],
    settings: { activeHarness: 'prime', browserHome: 'about:blank', telemetry: true },
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
let pendingQuestionnaire
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { sessionId: 'fixture-session', sessionFile, isStreaming: false, thinkingLevel: 'medium', model: { provider: 'fixture', id: 'fixture-model', name: 'Fixture Model' } } })
  } else if (command.type === 'get_session_stats') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { contextUsage: { tokens: 12000, contextWindow: 100000, percent: 12 } } })
  } else if (command.type === 'list_schedules') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { jobs: [] } })
  } else if (command.type === 'steer') {
    fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'steer-args.json'))}, JSON.stringify(command))
    setTimeout(() => send({ type: 'response', id: command.id, command: command.type, success: true, data: {} }), 500)
  } else if (command.type === 'prompt' || command.type === 'follow_up') {
    pendingPrompt = command
    if (typeof command.message === 'string' && command.message.includes('stay busy')) {
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'prompt-args.json'))}, JSON.stringify(command))
      send({ type: 'agent_start' })
      send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
      return
    }
    const isQuestionnaire = typeof command.message === 'string' && command.message.includes('two questions')
    pendingQuestionnaire = isQuestionnaire ? { expected: 2, values: {} } : undefined
    fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'prompt-args.json'))}, JSON.stringify(command))
    send({ type: 'agent_start' })
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '**Reviewing the available release channels before asking for input.**' } })
    if (isQuestionnaire) {
      send({ type: 'tool_execution_start', toolCallId: 'ask-2', toolName: 'ask_user', args: { questions: [
        { question: 'Which release channel?', options: ['Stable', 'Beta'] },
        { question: 'What should I optimize for?', options: ['Speed', 'Safety'] },
      ] } })
      send({ type: 'extension_ui_request', id: 'fixture-question-1', method: 'select', title: 'Which release channel?', options: ['__prime_ask_user__fixture-group:0:2', 'Stable', 'Beta', 'Other (type your own answer)'] })
      send({ type: 'extension_ui_request', id: 'fixture-question-2', method: 'select', title: 'What should I optimize for?', options: ['__prime_ask_user__fixture-group:1:2', 'Speed', 'Safety', 'Other (type your own answer)'] })
    } else {
      send({ type: 'tool_execution_start', toolCallId: 'ask-1', toolName: 'ask_user', args: { question: 'Which release channel?', options: ['Stable', 'Beta'] } })
      send({ type: 'extension_ui_request', id: 'fixture-question', method: 'select', title: 'Choose a release channel', options: ['Stable', 'Beta', 'Other (type your own answer)'] })
    }
  } else if (command.type === 'extension_ui_response' && pendingPrompt) {
    if (pendingQuestionnaire) {
      pendingQuestionnaire.values[command.id] = command.value
      if (Object.keys(pendingQuestionnaire.values).length < pendingQuestionnaire.expected) return
      const prompt = pendingPrompt
      const values = pendingQuestionnaire.values
      pendingPrompt = undefined
      pendingQuestionnaire = undefined
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'questionnaire-values.json'))}, JSON.stringify(values))
      send({ type: 'tool_execution_end', toolCallId: 'ask-2', toolName: 'ask_user', result: { values } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The questionnaire answers are ready.' } })
      const completedAt = new Date().toISOString()
      fs.appendFileSync(sessionFile, [
        JSON.stringify({ type: 'message', id: 'fixture-live-assistant-multi', parentId: 'fixture-goal-summary', message: { role: 'assistant', timestamp: completedAt, content: [{ type: 'toolCall', id: 'ask-2', name: 'ask_user', arguments: { questions: [{ question: 'Which release channel?', options: ['Stable', 'Beta'] }, { question: 'What should I optimize for?', options: ['Speed', 'Safety'] }] } }] } }),
        JSON.stringify({ type: 'message', id: 'fixture-live-result-multi', parentId: 'fixture-live-assistant-multi', message: { role: 'toolResult', timestamp: completedAt, toolCallId: 'ask-2', toolName: 'ask_user', content: JSON.stringify({ values }) } }),
        JSON.stringify({ type: 'message', id: 'fixture-live-final-multi', parentId: 'fixture-live-result-multi', message: { role: 'assistant', timestamp: completedAt, content: 'The questionnaire answers are ready.' } }),
      ].join('\\n') + '\\n')
      send({ type: 'agent_end' })
      send({ type: 'response', id: prompt.id, command: prompt.type, success: true, data: {} })
      return
    }
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
  const ompExecutable = join(fixtureRoot, 'omp-fixture.cjs')
  writeFileSync(ompExecutable, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('omp/17.2.11\\n'); process.exit(0) }
if (args[0] === 'models' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ models: [
    { provider: 'anthropic', id: 'claude-fixture', name: 'Claude Fixture', contextWindow: 200000, maxTokens: 8192, reasoning: true, thinking: ['low', 'high'], input: ['text'] },
    { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture', contextWindow: 200000, maxTokens: 8192, reasoning: true, thinking: ['low', 'high'], input: ['text'] },
  ] })); process.exit(0)
}
process.exit(2)
`)
  chmodSync(ompExecutable, 0o755)
  return { userData, home, project, executable, ompExecutable, sessionFile: realpathSync(sessionFile) }
}

function hermeticEnvironment(home: string, executable: string, ompExecutable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: fixtureRoot,
    SHELL: '/bin/zsh',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    PRIME_AGENT_BINARY: executable,
    OMP_BINARY: ompExecutable,
  }
  for (const key of ['USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING']) if (process.env[key]) env[key] = process.env[key]
  return env
}


test.describe('Prime Work desktop smoke', () => {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright derives fixture usage from this destructuring pattern
  test.beforeEach(async ({}, testInfo) => {
    actionableErrors = []
    app = undefined
    const activeSession = testInfo.title === 'defers a reply to a session that is active outside Prime Work'
      || testInfo.title === 'reflects an external JSONL append without reselecting the live session'
    let startupError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fixture = createHermeticFixture(activeSession)
      fixtureSessionFile = fixture.sessionFile
      try {
        app = await electron.launch({
          args: ['.', `--user-data-dir=${fixture.userData}`],
          cwd: process.cwd(),
          env: hermeticEnvironment(fixture.home, fixture.executable, fixture.ompExecutable) as Record<string, string>,
          timeout: 20_000,
        })
        app.context().on('page', attachDiagnostics)
        for (const target of app.windows()) attachDiagnostics(target)
        page = await app.firstWindow({ timeout: 15_000 })
        attachDiagnostics(page)
        await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
        return
      } catch (error) {
        startupError = error
        await closeHermeticApp(app)
        app = undefined
        if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
        fixtureRoot = ''
        fixtureSessionFile = ''
      }
    }
    throw startupError ?? new Error('Prime Work did not create its initial window')
  })

  test.afterEach(async () => {
    await closeHermeticApp(app)
    app = undefined
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
    fixtureSessionFile = ''
  })

  test('steers the active turn with Ctrl+Enter', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('stay busy while I steer')
    await composer.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop Prime' })).toBeVisible()

    await composer.fill('send this queued task now')
    await composer.press('Enter')
    const queuedTray = page.getByRole('region', { name: 'Queued messages' })
    await queuedTray.locator('.composer-queue__item').hover()
    await expect(queuedTray.locator('.composer-queue__actions')).toHaveCSS('opacity', '1')
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(1)
    const sendImmediately = queuedTray.getByRole('button', { name: /^Send queued message immediately:/ })
    await expect(sendImmediately).toHaveAttribute('title', 'Send queued message immediately')
    await sendImmediately.click()
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(0)
    const queuedSteerMarker = join(fixtureRoot, 'steer-args.json')
    await expect.poll(() => existsSync(queuedSteerMarker)).toBe(true)
    expect(JSON.parse(readFileSync(queuedSteerMarker, 'utf8'))).toMatchObject({ type: 'steer', message: 'send this queued task now' })
    await composer.fill('change direction now')
    await composer.press('Control+Enter')
    await expect(page.locator('.message--user').filter({ hasText: 'change direction now' })).toBeVisible()
    const marker = join(fixtureRoot, 'steer-args.json')
    await expect.poll(() => {
      if (!existsSync(marker)) return ''
      return JSON.parse(readFileSync(marker, 'utf8')).message
    }).toBe('change direction now')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ type: 'steer', message: 'change direction now' })
    await expect(composer).toHaveValue('')
  })

  test('centers the compact context-usage dial', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const dial = page.locator('.context-usage-dial')
    await expect(dial).toBeVisible()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Refresh context usage')
    await composer.press('Enter')
    await page.getByRole('dialog').getByRole('option', { name: 'Stable' }).click()
    await expect(dial).toHaveText('12')
    const offset = await dial.evaluate((node) => {
      const textNode = node.querySelector('span')?.firstChild
      if (!textNode) throw new Error('Missing context dial text')
      const dialRect = node.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(textNode)
      const textRect = range.getBoundingClientRect()
      return {
        x: (textRect.left + textRect.right - dialRect.left - dialRect.right) / 2,
        y: (textRect.top + textRect.bottom - dialRect.top - dialRect.bottom) / 2,
        size: dialRect.width,
      }
    })
    expect(offset.size).toBeCloseTo(26.4, 1)
    expect(Math.abs(offset.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(offset.y)).toBeLessThanOrEqual(0.5)
  })

  test('collapses composer selectors and keeps the checkout menu inside a narrow conversation pane', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await page.locator('.conversation-column').evaluate((node) => {
      node.style.flex = '0 0 560px'
      const pane = node.querySelector<HTMLElement>('.conversation-pane')
      if (pane) pane.style.minWidth = '0'
    })

    const model = page.locator('.select-control').filter({ has: page.getByRole('combobox', { name: 'Model' }) })
    const reasoning = page.locator('.select-control').filter({ has: page.getByRole('combobox', { name: 'Reasoning effort' }) })
    await expect(model.locator('.select-control__chevron')).toHaveCSS('display', 'none')
    await expect(reasoning.locator('.select-control__chevron')).toHaveCSS('display', 'none')
    await expect(model.getByRole('combobox')).toHaveCSS('opacity', '1')
    await expect(reasoning.getByRole('combobox')).toHaveCSS('opacity', '1')

    await page.locator('.conversation-column').evaluate((node) => { node.style.flex = '0 0 300px' })
    await expect(model.getByRole('combobox')).toHaveCSS('opacity', '0')
    await expect(reasoning.getByRole('combobox')).toHaveCSS('opacity', '0')
    await expect(model.locator('.select-control__icon')).not.toHaveCSS('display', 'none')
    await expect(reasoning.locator('.select-control__icon')).not.toHaveCSS('display', 'none')

    const controlBounds = await page.locator('.composer__footer').evaluate((footer) => {
      const controls = footer.querySelector<HTMLElement>('.composer__controls')!
      const actions = footer.querySelector<HTMLElement>('.composer__actions')!
      const controlsRect = controls.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      return { controlsRight: controlsRect.right, actionsLeft: actionsRect.left }
    })
    expect(controlBounds.controlsRight).toBeLessThanOrEqual(controlBounds.actionsLeft)

    await page.getByRole('button', { name: /^Checkout:/ }).click()
    const menuBounds = await page.getByRole('menu', { name: 'Git worktrees' }).evaluate((menu) => {
      const menuRect = menu.getBoundingClientRect()
      const footerRect = menu.closest('.composer__footer')!.getBoundingClientRect()
      return { menuLeft: menuRect.left, menuRight: menuRect.right, footerLeft: footerRect.left, footerRight: footerRect.right }
    })
    expect(menuBounds.menuLeft).toBeGreaterThanOrEqual(menuBounds.footerLeft - 0.5)
    expect(menuBounds.menuRight).toBeLessThanOrEqual(menuBounds.footerRight + 0.5)
  })

  test('loads the sandboxed preload bridge and hermetic service data', async () => {
    const bridge = await page.evaluate(() => {
      const prime = (window as typeof window & { prime?: Record<string, unknown> }).prime
      return { type: typeof prime, groups: prime ? Object.keys(prime).sort() : [] }
    })
    expect(bridge.type).toBe('object')
    expect(bridge.groups).toEqual(['agent', 'app', 'browser', 'git', 'heartbeats', 'pets', 'plugins', 'projects', 'providers', 'schedules', 'sessions', 'settings', 'terminal', 'voice'])
    await expect(page.getByRole('button', { name: 'Prime Work — switch harness' })).toBeVisible()
    await expect(page.locator('.sidebar__brand small')).toHaveText('Work')
    await expect(page.locator('.sidebar__brand .prime-mark svg path')).toHaveCount(2)
    await expect(page.locator('.prime-mark img')).toHaveCount(0)
  })

  test('opens the harness switcher with both harnesses and dismisses on Escape', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: /Prime Work/ })).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: /OMP Work/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  test('shows the bundled GooeyPi pet and exposes Orb and Codex Pets settings', async () => {
    const desktopPet = page.getByRole('button', { name: /GooeyPi, draggable GooeyPi pet/ })
    await expect(desktopPet).toBeVisible()
    await expect(desktopPet.locator('.pet-sprite img')).toBeVisible()
    const petSurface = page.locator('.desktop-pet')
    await expect(petSurface.getByRole('button', { name: 'Open realtime voice' })).toBeVisible()
    await petSurface.getByRole('button', { name: 'Open realtime voice' }).click()
    const muteVoice = petSurface.getByRole('button', { name: 'Mute realtime voice' })
    await expect(muteVoice).toBeVisible()
    await expect(muteVoice).toBeFocused()
    await expect(page.getByRole('complementary', { name: 'Realtime voice session' })).toBeVisible()
    await expect(petSurface.getByRole('button', { name: 'Close realtime voice' })).toBeVisible()
    await expect(page.locator('.voice-orb')).toHaveCount(0)
    await petSurface.getByRole('button', { name: 'Close realtime voice' }).click()
    const reopenVoice = petSurface.getByRole('button', { name: 'Open realtime voice' })
    await expect(reopenVoice).toBeVisible()
    await expect(reopenVoice).toBeFocused()
    const toolbarOpenVoice = page.locator('.title-toolbar').getByRole('button', { name: 'Open realtime voice' })
    await toolbarOpenVoice.click()
    await expect(petSurface.getByRole('button', { name: 'Mute realtime voice' })).toBeFocused()
    await page.locator('.title-toolbar').getByRole('button', { name: 'Close realtime voice' }).click()
    await expect(toolbarOpenVoice).toBeFocused()
    await expect(reopenVoice).not.toBeFocused()
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Pets', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Pets', exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: /^GooeyPi Built/ })).toBeChecked()
    await expect(page.getByRole('radio', { name: /^Orb Built/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Codex Pets' })).toBeVisible()
    const petSize = page.getByRole('slider', { name: 'Pet size' })
    await expect(petSize).toHaveValue('75')
    await petSize.fill('55')
    await expect(page.locator('.desktop-pet__avatar > *').first()).toHaveCSS('width', '53px')
    await page.locator('.desktop-pet').getByRole('button', { name: 'Open realtime voice' }).click()
    await expect(page.locator('.desktop-pet').getByRole('button', { name: 'Mute realtime voice' })).toBeFocused()
    const showPet = page.getByRole('checkbox', { name: 'Show desktop pet' })
    await showPet.focus()
    await showPet.press('Space')
    await expect(showPet).not.toBeChecked()
    await expect(page.locator('.voice-orb')).toBeVisible()
    await showPet.press('Space')
    await expect(showPet).toBeChecked()
    await expect(showPet).toBeFocused()
    await expect(page.getByRole('complementary', { name: 'Realtime voice session' })).toBeVisible()
    await expect(page.locator('.desktop-pet').getByRole('button', { name: 'Unmute realtime voice' })).toBeVisible()
    await page.locator('.desktop-pet').getByRole('button', { name: 'Close realtime voice' }).click()

    const dragTarget = page.getByRole('button', { name: /GooeyPi, draggable GooeyPi pet/ })
    const dragBounds = await dragTarget.boundingBox()
    expect(dragBounds).not.toBeNull()
    await page.mouse.move(dragBounds!.x + dragBounds!.width / 2, dragBounds!.y + dragBounds!.height / 2)
    await page.mouse.down()
    const dismissDrawer = page.getByRole('status', { name: 'Drag here to hide desktop pet' })
    await expect(dismissDrawer).toBeVisible()
    const dismissTarget = page.locator('.pet-dismiss-drawer__hitbox')
    const dismissBounds = await dismissTarget.boundingBox()
    expect(dismissBounds).not.toBeNull()
    await page.mouse.move(dismissBounds!.x + dismissBounds!.width / 2, dismissBounds!.y + dismissBounds!.height / 2, { steps: 8 })
    await expect(page.getByRole('status', { name: 'Release to hide desktop pet' })).toBeVisible()
    await page.mouse.up()
    await expect(showPet).not.toBeChecked()
    await expect(page.locator('.desktop-pet')).toHaveCount(0)

    await showPet.check()
    await petSize.fill('75')
    await expect(page.locator('.desktop-pet')).toBeVisible()
  })

  test('exposes Voice settings and places both voice controls in their requested positions', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Voice', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Voice' })).toBeVisible()
    const service = page.getByRole('combobox', { name: 'Dictation service' })
    const dictationModel = page.getByRole('combobox', { name: 'Dictation model' })
    await expect(service).toHaveValue('openai-live')
    await expect(dictationModel).toHaveValue('gpt-live-transcribe')
    const openAiConnection = page.locator('.voice-connection-card').filter({ hasText: 'OpenAI' })
    const addOpenAiKey = openAiConnection.getByRole('button', { name: 'Add key' })
    await expect(addOpenAiKey).toBeEnabled()
    await addOpenAiKey.click()
    const keyDialog = page.getByRole('dialog', { name: 'Connect OpenAI' })
    await expect(keyDialog.getByLabel('API key')).toBeEnabled()
    await keyDialog.getByRole('button', { name: 'Cancel' }).click()
    await service.selectOption('groq')
    await expect(dictationModel).toHaveValue('whisper-large-v3-turbo')
    await expect(page.getByRole('textbox', { name: 'whisper-cli executable' })).toHaveCount(0)
    await page.locator('.session-row').first().click()
    const toolbarLabels = await page.locator('.title-toolbar__actions button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
    expect(toolbarLabels.slice(0, 2)).toEqual(['Open realtime voice', 'Toggle terminal (⌘J)'])
    const composerLabels = await page.locator('.composer__actions > *').evaluateAll((controls) => controls.map((control) => control.getAttribute('aria-label')))
    expect(composerLabels).toEqual(['Context usage', 'Start dictation', 'Send message'])
  })

  test('switches to OMP Work and lists the OMP session catalog, then returns to Prime', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    const ompBrand = page.getByRole('button', { name: 'OMP Work — switch harness' })
    await expect(ompBrand).toBeVisible()
    await expect(page.locator('.sidebar__brand .omp-mark')).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Scheduled' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Plugins & skills' })).toBeVisible()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    await expect(page.getByRole('main').getByText('OMP fixture reply.')).toBeVisible()
    await ompBrand.click()
    await page.getByRole('menuitemradio', { name: /Prime Work/ }).click()
    await expect(page.getByRole('button', { name: 'Prime Work — switch harness' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Scheduled' })).toBeVisible()
  })

  test('closes realtime voice before switching harnesses', async () => {
    await page.locator('.title-toolbar').getByRole('button', { name: 'Open realtime voice' }).click()
    const petSurface = page.locator('.desktop-pet')
    await expect(petSurface.getByRole('button', { name: 'Mute realtime voice' })).toBeVisible()
    await expect(page.locator('.voice-orb')).toHaveCount(0)
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await expect(petSurface.getByRole('button', { name: 'Mute realtime voice' })).toHaveCount(0)
    await expect(petSurface.getByRole('button', { name: 'Open realtime voice' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'OMP Work — switch harness' })).toBeVisible()
  })

  test('persists a desktop-only OMP provider toggle and removes its models from the picker', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    const voiceModelsBefore = await page.evaluate(async () => JSON.parse((await window.prime.voice.executeTool({ name: 'list_models', arguments: {} }, 'omp')).output) as { models: Array<{ name: string }> })
    expect(voiceModelsBefore.models.map((model) => model.name).sort()).toEqual(['Claude Fixture', 'GPT Fixture'])
    const anthropic = page.getByRole('checkbox', { name: 'Show anthropic provider' })
    await expect(anthropic).toBeChecked()
    await page.getByTitle('Hide provider in OMP').filter({ has: anthropic }).click()
    await expect(anthropic).not.toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', 'prime-work-state.json'), 'utf8')).settings.ompDisabledProviders).toEqual(['anthropic'])
    const voiceModelsAfter = await page.evaluate(async () => JSON.parse((await window.prime.voice.executeTool({ name: 'list_models', arguments: {} }, 'omp')).output) as { models: Array<{ name: string }> })
    expect(voiceModelsAfter.models.map((model) => model.name)).toEqual(['GPT Fixture'])

    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    const modelPicker = page.getByRole('combobox', { name: 'Model' })
    await expect(modelPicker.locator('option', { hasText: 'GPT Fixture' })).toHaveCount(1)
    await expect(modelPicker.locator('option', { hasText: 'Claude Fixture' })).toHaveCount(0)
  })

  test('keeps thread order stable through agent activity and highlights background attention in purple', async () => {
    const titles = page.locator('.session-row__title')
    await expect(titles.nth(0)).toHaveText('Hermetic desktop fixture')
    await expect(titles.nth(1)).toHaveText('Primary workspace fixture')
    const primaryFile = join(fixtureSessionFile, '..', 'primary.jsonl')
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-background-assistant', parentId: 'primary-message', timestamp: '2027-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: 'Background work finished.' },
    })}\n`)

    const primaryRow = page.locator('.session-row-wrap').filter({ hasText: 'Primary workspace fixture' })
    await expect(primaryRow).toHaveClass(/has-attention/)
    await expect(page.getByRole('status', { name: 'A session turn ended or needs attention' })).toBeVisible()
    await expect(titles.nth(0)).toHaveText('Hermetic desktop fixture')
    const attentionColor = await primaryRow.evaluate((node) => getComputedStyle(node).backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [])
    expect(attentionColor.length).toBeGreaterThanOrEqual(3)
    expect(attentionColor[2]).toBeGreaterThan(attentionColor[1])

    await primaryRow.locator('.session-row').click()
    await expect(primaryRow).not.toHaveClass(/has-attention/)
    await expect(page.getByRole('status', { name: 'A session turn ended or needs attention' })).toHaveCount(0)
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-new-user', parentId: 'primary-background-assistant', timestamp: '2028-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Move this thread now.' },
    })}\n`)
    await expect(titles.nth(0)).toHaveText('Primary workspace fixture')
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

  test('defers a reply to a session that is active outside Prime Work', async () => {
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Queue this follow-up from Prime Work')
    await composer.press('Enter')

    const queuedMessages = page.getByRole('region', { name: 'Queued messages' })
    await expect(queuedMessages.locator('.composer-queue__item')).toHaveCount(1)
    await expect(queuedMessages).toContainText('Queue this follow-up from Prime Work')
    expect(existsSync(join(fixtureRoot, 'follow-up-args.json'))).toBe(false)
    expect(existsSync(join(fixtureRoot, 'follow-up-ack.json'))).toBe(false)
    await expect(page.locator('.transcript').getByText('The external Prime Agent received the queued reply.')).toHaveCount(0)
    await expect(page.getByText(/Prime Agent RPC exited|Request failed/)).toHaveCount(0)

    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.getByRole('region', { name: 'Queued messages' })).toContainText('Queue this follow-up from Prime Work')
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
  test('removes a project from the sidebar through its context menu', async () => {
    const projectRow = page.locator('.project-row').first()
    await expect(projectRow).toBeVisible()
    await expect(page.locator('.sidebar__primary .lucide-notebook-pen')).toHaveCount(1)
    await expect(page.locator('.project-row__new-session .lucide-notebook-pen')).toHaveCount(1)
    await expect(page.locator('.sidebar__section-heading .lucide-folder-plus')).toHaveCount(1)
    await expect(page.getByTitle('New session (⌘N)')).toHaveCount(2)
    await expect(page.getByTitle('Add project')).toHaveCount(1)
    await expect(projectRow.getByTitle('New session in Multi-folder fixture')).toHaveCount(1)
    await expect(page.getByTitle('Archive Hermetic desktop fixture')).toHaveCount(1)

    await projectRow.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Project options for Multi-folder fixture' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Remove project' }).click()

    const dialog = page.getByRole('dialog', { name: 'Remove project' })
    await expect(dialog).toContainText('The folder and saved sessions will not be deleted.')
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.locator('.project-row')).toHaveCount(0)
    expect(existsSync(join(fixtureRoot, 'project'))).toBe(true)
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
      if (destination === 'Plugins & skills') {
        await expect(page.locator('.feature-strip')).toHaveCount(0)
        await expect(page.locator('.directory-tools')).toBeVisible()
      }
    }
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await expect(page.getByLabel('Search providers')).toBeVisible()
    await expect(page.locator('.provider-row')).not.toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Disable all', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Disable all', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Enable all', exact: true })).toBeVisible()
    await expect(page.locator('.provider-row input[type="checkbox"]:checked')).toHaveCount(0)
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
    await page.getByRole('button', { name: 'Toggle inspector' }).click()
    await expect(page.locator('.composer-note')).toBeVisible()
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

  test('pastes an image into the composer and forwards it with the prompt', async () => {
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.evaluate((node) => {
      const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    })
    await expect(page.locator('.composer-attachment')).toContainText('pasted.png')
    await composer.fill('Describe this image')
    await composer.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Choose a release channel' })).toBeVisible()
    await expect(page.locator('.composer-attachment')).toHaveCount(0)

    await expect.poll(() => existsSync(join(fixtureRoot, 'prompt-args.json'))).toBe(true)
    const prompt = JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8')) as { message: string; images: Array<{ type: string; mimeType: string; data: string }> }
    expect(prompt).toMatchObject({
      message: 'Describe this image',
      images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    })
    await page.getByRole('dialog').getByRole('option', { name: 'Stable' }).click()

    const imagePreview = page.getByRole('button', { name: 'Expand pasted image' }).first()
    await imagePreview.click()
    const lightbox = page.getByRole('dialog', { name: 'Expanded pasted image' })
    await expect(lightbox).toBeVisible()
    await expect(lightbox.locator('.image-lightbox__image')).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
    await page.keyboard.press('Escape')
    await expect(lightbox).toHaveCount(0)
    await expect(imagePreview).toBeFocused()
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
    const reasoningEmphasis = liveReasoning.locator('strong')
    await expect(reasoningEmphasis).toHaveCount(1)
    await expect.poll(() => reasoningEmphasis.evaluate((node) => Number.parseInt(getComputedStyle(node).fontWeight, 10))).toBeLessThanOrEqual(500)
    await expect(page.locator('.thinking-dots > span')).toHaveCount(3)
    await expect(page.locator('.work-disclosure__button')).toHaveCount(0)
    const streamingTool = page.locator('.activity-line--question')
    await expect(streamingTool.locator('.activity-tool__summary')).toHaveAttribute('aria-expanded', 'false')
    await expect(streamingTool.locator('.activity-tool__details')).toHaveCount(0)
    await expect(dialog.getByRole('option', { name: 'Stable' })).toBeVisible()
    await expect(dialog.getByRole('option', { name: 'Beta' })).toBeVisible()
    await expect(dialog.getByRole('option', { name: 'Other (type your own answer)' })).toBeVisible()
    await expect(dialog.getByRole('option', { name: 'Stable' })).toHaveClass(/is-selected/)
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => existsSync(join(fixtureRoot, 'prompt-args.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8'))).toMatchObject({
      type: 'prompt',
      message: 'Ask me which release channel to use',
    })
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
    const companionBadge = page.getByRole('status', { name: 'A session turn ended or needs attention' })
    await expect(companionBadge).toBeVisible()
    const badgeBounds = await companionBadge.boundingBox()
    const avatarBounds = await page.locator('.desktop-pet__avatar').boundingBox()
    expect(badgeBounds).not.toBeNull()
    expect(avatarBounds).not.toBeNull()
    expect(badgeBounds!.width).toBeGreaterThanOrEqual(22)
    expect(Math.abs(badgeBounds!.x + badgeBounds!.width / 2 - (avatarBounds!.x + avatarBounds!.width))).toBeLessThanOrEqual(12)
    expect(badgeBounds!.y + badgeBounds!.height / 2).toBeGreaterThanOrEqual(avatarBounds!.y - 2)
    expect(badgeBounds!.y + badgeBounds!.height / 2).toBeLessThanOrEqual(avatarBounds!.y + 16)

    await completedRow.locator('.session-row').click()
    await expect(companionBadge).toHaveCount(0)
  })

  test('answers a grouped ask_user questionnaire with context and back navigation', async () => {
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Ask me two questions')
    await composer.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Answer 2 questions' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Question 1 of 2')
    const context = dialog.getByRole('textbox', { name: 'Additional context' })
    await context.fill('For the pilot')
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await page.keyboard.press('Enter')
    await expect(dialog).toContainText('Question 2 of 2')

    await dialog.getByRole('option', { name: 'Safety' }).click()
    await page.keyboard.press('Control+ArrowLeft')
    await expect(dialog).toContainText('Question 1 of 2')
    await expect(dialog.getByRole('textbox', { name: 'Additional context' })).toHaveValue('For the pilot')
    await page.keyboard.press('Control+ArrowRight')
    await expect(dialog).toContainText('Question 2 of 2')

    await dialog.getByRole('option', { name: 'Other (type your own answer)' }).click()
    await dialog.getByRole('textbox', { name: 'Additional context' }).fill('A custom priority')
    await page.keyboard.press('Enter')
    await expect(dialog).toContainText('Submit answers')
    await dialog.getByRole('button', { name: 'Submit answers', exact: true }).last().click()
    await expect(dialog).toHaveCount(0)
    const worked = page.locator('.work-disclosure__button')
    await expect(worked).toContainText(/^Worked for /)
    await worked.click()
    await expect(page.locator('.activity-line--question')).toContainText('What should I optimize for?')
    await expect(page.locator('.app-shell')).not.toHaveAttribute('data-ready', 'false')
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

    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    await expect(page.locator('.settings-content input.mono')).toHaveValue('/bin/zsh')
  })

  test('uses overlay panels at the compact desktop breakpoint', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.setViewportSize({ width: 960, height: 700 })
    await expect.poll(() => page.locator('.sidebar').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.inspector')).toHaveCount(0)
    const sidebarScrim = page.getByRole('button', { name: 'Close sidebar' })
    await expect(page.locator('.panel-scrim--sidebar')).toBeVisible()
    await expect(sidebarScrim).toBeVisible()
    await sidebarScrim.click({ position: { x: 900, y: 300 } })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).sidebarOpen)).toBe(false)
    // Panel reconciliation may restore a confirmed inspector preference after
    // the sidebar closes. Normalize either valid state before testing the toggle.
    await page.waitForTimeout(250)
    if (await page.locator('.inspector').count()) {
      await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
      await expect(page.locator('.inspector')).toHaveCount(0)
    }
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
  test('dismisses the file changes popup, disables it in settings, and undoes a file', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const changesCard = page.locator('.changes-card')
    await expect(changesCard).toBeVisible()
    await changesCard.getByRole('button', { name: 'Dismiss file changes' }).click()
    await expect(changesCard).toHaveCount(0)

    await page.keyboard.press('Meta+,')
    const popupToggle = page.getByRole('checkbox', { name: 'Show file changes popup' })
    await expect(popupToggle).toBeChecked()
    await popupToggle.focus()
    await popupToggle.press('Space')
    await expect(popupToggle).not.toBeChecked()
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).showFileChangesPopup)).toBe(false)
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.changes-card')).toHaveCount(0)

    await page.getByRole('tab', { name: 'Changes' }).click()
    await page.locator('.file-changes > button').first().click()
    await page.getByRole('button', { name: 'Undo changes', exact: true }).click()
    const undoDialog = page.getByRole('dialog', { name: 'Undo file changes?' })
    await expect(undoDialog).toContainText('staged and unstaged changes')
    await undoDialog.getByRole('button', { name: 'Undo changes', exact: true }).click()
    await expect.poll(() => readFileSync(join(fixtureRoot, 'secondary-project', 'secondary-change.txt'), 'utf8')).toBe('base\n')
    await expect(page.locator('.file-changes')).toContainText('No unstaged changes.')
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
    await page.getByLabel('Close terminal', { exact: true }).click()
  })

  test('restores each session terminal without leaking it into another session', async () => {
    await page.getByLabel(/Toggle terminal/).click()
    const visibleDrawer = page.locator('.terminal-drawer:not([hidden])')
    const input = visibleDrawer.locator('.xterm-helper-textarea')
    await expect(input).toBeVisible()
    await input.click()
    await page.keyboard.type('echo secondary-session-state')
    await page.keyboard.press('Enter')
    await expect(visibleDrawer.locator('.xterm-rows')).toContainText('secondary-session-state', { timeout: 8_000 })

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden])')).toHaveCount(0)
    await page.getByLabel(/Toggle terminal/).click()
    const primaryDrawer = page.locator('.terminal-drawer:not([hidden])')
    const primaryInput = primaryDrawer.locator('.xterm-helper-textarea')
    await expect(primaryInput).toBeVisible()
    await primaryInput.click()
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect(primaryDrawer.locator('.xterm-rows')).toContainText(/prime-work-e2e-[^/]+\/project/, { timeout: 8_000 })
    await expect(primaryDrawer.locator('.xterm-rows')).not.toContainText('secondary-session-state')

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden]) .xterm-rows')).toContainText('secondary-session-state')
    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden]) .xterm-rows')).toContainText(/prime-work-e2e-[^/]+\/project/)
    await page.locator('.terminal-drawer:not([hidden])').getByLabel('Close terminal', { exact: true }).click()
    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await page.locator('.terminal-drawer:not([hidden])').getByLabel('Close terminal', { exact: true }).click()
  })

  test('opens independent terminal tabs inside the conversation column', async () => {
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
    await expect(page.locator('.terminal-live-dot.is-connected')).toBeVisible()
    const firstTerminalLine = () => page.locator('.terminal-surface:not([hidden]) .xterm-rows').evaluate((rows) =>
      [...rows.children].map((row) => row.textContent?.trim() ?? '').find(Boolean) ?? '',
    )
    await expect.poll(firstTerminalLine).toMatch(/\S/)
    expect(await firstTerminalLine()).not.toBe('%')
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(1)
    const activeTerminal = page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')
    await activeTerminal.click()
    await page.keyboard.type('echo first-terminal')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')

    await page.getByLabel('New terminal').click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(2)
    await activeTerminal.click()
    await page.keyboard.type('echo second-terminal')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('second-terminal')

    await page.getByRole('tab', { name: /zsh 1/ }).click()
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).not.toContainText('second-terminal')

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden])')).toHaveCount(0)
    await page.getByLabel(/Toggle terminal/).click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(1)
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).not.toContainText(/first-terminal|second-terminal/)
    await expect(page.getByLabel(/Split terminal/)).toHaveCount(0)

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(2)
    await page.getByRole('tab', { name: /zsh 1/ }).click()
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')

    const geometry = await page.evaluate(() => {
      const session = document.querySelector('.session-workspace')!.getBoundingClientRect()
      const conversation = document.querySelector('.conversation-column')!.getBoundingClientRect()
      const terminal = document.querySelector('.terminal-drawer')!.getBoundingClientRect()
      const inspector = document.querySelector('.inspector')!.getBoundingClientRect()
      return {
        terminalRight: terminal.right,
        conversationRight: conversation.right,
        sessionTop: session.top,
        sessionBottom: session.bottom,
        inspectorTop: inspector.top,
        inspectorBottom: inspector.bottom,
      }
    })
    expect(Math.abs(geometry.terminalRight - geometry.conversationRight)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.inspectorTop - geometry.sessionTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.inspectorBottom - geometry.sessionBottom)).toBeLessThanOrEqual(1)

    const drawer = page.locator('.terminal-drawer:not([hidden])')
    const before = await drawer.evaluate((node) => node.getBoundingClientRect().height)
    await drawer.getByLabel('Maximize terminal').click()
    await expect(drawer).toHaveClass(/is-maximized/)
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(before)
    await drawer.getByLabel('Restore terminal').click()
    await drawer.getByLabel('Close terminal', { exact: true }).click()
  })

  test('attaches and removes active terminal selection context', async () => {
    await page.getByRole('tab', { name: 'Summary' }).click()
    await page.getByLabel(/Toggle terminal/).click()
    const input = page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')
    await input.click()
    await page.keyboard.type("printf 'terminal-selection-marker\\n'")
    await page.keyboard.press('Enter')
    const outputLine = page.locator('.terminal-surface:not([hidden]) .xterm-rows > div').filter({ hasText: 'terminal-selection-marker' }).last()
    await expect(outputLine).toBeVisible()
    await expect(page.locator('.composer-attachment--terminal')).toHaveCount(0)

    const selectOutput = async () => {
      const box = await outputLine.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(Math.min(box!.x + box!.width - 2, box!.x + 190), box!.y + box!.height / 2, { steps: 5 })
      await page.mouse.up()
      await expect(page.getByLabel(/Inspect selected text from/)).toBeVisible()
    }

    await selectOutput()
    const clearBox = await outputLine.boundingBox()
    expect(clearBox).not.toBeNull()
    await page.mouse.click(clearBox!.x + 2, clearBox!.y + clearBox!.height / 2)
    await expect(page.getByLabel(/Inspect selected text from/)).toHaveCount(0)
    await selectOutput()

    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Explain the terminal output')
    await composer.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Choose a release channel' })).toBeVisible()
    await expect.poll(() => existsSync(join(fixtureRoot, 'prompt-args.json'))).toBe(true)
    const prompt = JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8')) as { message: string }
    expect(prompt.message).toContain('Explain the terminal output\n\n===== BEGIN TERMINAL SELECTION CONTEXT =====')
    expect(prompt.message).toContain('--- Selected text ---')
    expect(prompt.message).toContain('terminal-selection-marker')
    expect(prompt.message).not.toContain('Terminal buffer')
    await page.getByRole('dialog').getByRole('option', { name: 'Stable' }).click()
  })

  test('closes and recreates the last macOS window cleanly', async () => {
    await page.close()
    await app!.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
    page = await app!.firstWindow({ timeout: 45_000 })
    attachDiagnostics(page)
    await expect(page.locator('.app-shell')).toBeVisible()
  })
})
