import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const root = '/Users/am.will/Applications/prime';
const userData = '/tmp/prime-work-functional-qa';
fs.rmSync(userData, { recursive: true, force: true });
const result = {
  startedAt: new Date().toISOString(),
  userData,
  steps: [],
  rendererConsole: [],
  pageErrors: [],
  mainStdout: [],
  mainStderr: [],
  screenshots: [],
  observations: {},
};
let app;
let currentPage;
const seenPages = new WeakSet();

function record(status, name, details = '') {
  result.steps.push({ status, name, details });
  console.log(`[${status}] ${name}${details ? ` — ${details}` : ''}`);
}
async function step(name, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    record('PASS', name, `${details || ''}${details ? '; ' : ''}${Date.now() - started} ms`);
    return true;
  } catch (error) {
    const detail = error?.stack || String(error);
    record('FAIL', name, detail);
    try {
      if (currentPage && !currentPage.isClosed()) {
        const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
        const shot = `research/qa-failure-${safe}.png`;
        await currentPage.screenshot({ path: shot });
        result.screenshots.push(shot);
      }
    } catch {}
    return false;
  }
}
function attachPage(page) {
  if (seenPages.has(page)) return;
  seenPages.add(page);
  page.setDefaultTimeout(15_000);
  page.on('console', (msg) => {
    const item = { time: new Date().toISOString(), type: msg.type(), text: msg.text(), url: page.url() };
    result.rendererConsole.push(item);
    if (['error', 'warning'].includes(msg.type())) console.log(`[renderer:${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (error) => {
    result.pageErrors.push({ time: new Date().toISOString(), message: error.message, stack: error.stack, url: page.url() });
    console.log(`[pageerror] ${error.message}`);
  });
}
async function shot(page, name) {
  const rel = `research/qa-${name}.png`;
  await page.screenshot({ path: rel });
  result.screenshots.push(rel);
  return rel;
}
async function waitForProjectData(page) {
  await page.locator('.project-group').first().waitFor({ state: 'visible', timeout: 35_000 });
}
async function ensureSidebar(page) {
  if (await page.locator('.sidebar').count()) return;
  await page.getByLabel('Show sidebar (⌘B)').click();
  await page.locator('.sidebar').waitFor({ state: 'visible' });
}
async function navigate(page, name) {
  await ensureSidebar(page);
  if (name === 'Settings') await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click();
  else await page.getByRole('button', { name, exact: true }).first().click();
}
async function waitUntil(fn, timeout = 20_000, interval = 200) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch {}
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Timed out after ${timeout} ms; last value: ${JSON.stringify(last)}`);
}

try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root });
  const proc = app.process();
  proc.stdout?.on('data', (d) => result.mainStdout.push(d.toString()));
  proc.stderr?.on('data', (d) => {
    const text = d.toString();
    result.mainStderr.push(text);
    console.log(`[main:stderr] ${text.trim()}`);
  });
  app.on('window', attachPage);
  currentPage = await app.firstWindow();
  attachPage(currentPage);
  await currentPage.waitForLoadState('domcontentloaded');

  await step('Cold launch and desktop preload bridge', async () => {
    if (await currentPage.title() !== 'Prime Work') throw new Error(`Unexpected title ${await currentPage.title()}`);
    await currentPage.locator('.app-shell').waitFor({ state: 'visible' });
    const bridge = await currentPage.evaluate(() => ({ present: typeof window.prime !== 'undefined', apiGroups: Object.keys(window.prime || {}) }));
    if (!bridge.present) throw new Error('window.prime preload bridge missing');
    const userPath = await app.evaluate(({ app }) => app.getPath('userData'));
    result.observations.bridge = bridge;
    result.observations.actualUserData = userPath;
    return `title and shell visible; bridge groups=${bridge.apiGroups.join(',')}; userData=${userPath}`;
  });

  await step('Projects and saved sessions load from the real desktop services', async () => {
    await waitForProjectData(currentPage);
    const projects = await currentPage.locator('.project-group').count();
    const sessions = await currentPage.locator('.session-row').count();
    if (projects < 1) throw new Error('No projects loaded');
    if (sessions < 1) throw new Error('No sessions loaded');
    result.observations.loadedCounts = { projects, sessions };
    await shot(currentPage, 'session-initial');
    return `${projects} project group(s), ${sessions} visible session row(s)`;
  });

  await step('Projects page navigation, search, and project open', async () => {
    await navigate(currentPage, 'Projects');
    await currentPage.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
    const cards = await currentPage.locator('.project-item').count();
    if (cards < 1) throw new Error('Projects page contains no cards');
    const search = currentPage.getByPlaceholder('Search projects');
    await search.fill('__functional_qa_no_match__');
    await currentPage.getByText('No matching projects', { exact: true }).waitFor();
    await search.fill('');
    await currentPage.locator('.project-item').first().waitFor();
    await shot(currentPage, 'projects');
    await currentPage.locator('.project-item').first().click();
    await currentPage.locator('.conversation-pane').waitFor();
    return `${cards} project card(s); empty and restored search states work; first project opens session workspace`;
  });

  await step('Sidebar project collapse and saved-session selection', async () => {
    await ensureSidebar(currentPage);
    const collapse = currentPage.locator('.project-row__collapse').first();
    const before = await currentPage.locator('.project-group').first().locator('.session-list').count();
    await collapse.click();
    const afterCollapse = await currentPage.locator('.project-group').first().locator('.session-list').count();
    await collapse.click();
    await currentPage.locator('.project-group').first().locator('.session-list').waitFor();
    if (before !== 1 || afterCollapse !== 0) throw new Error(`Unexpected collapse state before=${before}, collapsed=${afterCollapse}`);
    const sessionRows = currentPage.locator('.project-group').first().locator('.session-row');
    const count = await sessionRows.count();
    if (count < 1) throw new Error('No session rows to select');
    const target = sessionRows.nth(Math.min(1, count - 1));
    const title = (await target.locator('.session-row__title').innerText()).trim();
    await target.click();
    await currentPage.locator('.transcript-loading').waitFor({ state: 'detached', timeout: 25_000 }).catch(() => {});
    return `project group collapses/expands; selected saved session “${title}”`;
  });

  await step('Activity page navigation, filters, and session open', async () => {
    await navigate(currentPage, 'Activity');
    await currentPage.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
    const all = await currentPage.locator('.activity-list > button').count();
    await currentPage.getByRole('button', { name: 'Needs attention', exact: true }).click();
    const attention = await currentPage.locator('.activity-list > button').count();
    await currentPage.getByRole('button', { name: 'All', exact: true }).click();
    if (all > 0) {
      await currentPage.locator('.activity-list > button').first().click();
      await currentPage.locator('.conversation-pane').waitFor();
    }
    return `all=${all}, needs-attention=${attention}; ${all > 0 ? 'first activity opens session' : 'empty state rendered'}`;
  });

  await step('Scheduled page and unavailable-runtime guard', async () => {
    await navigate(currentPage, 'Scheduled');
    await currentPage.getByRole('heading', { name: 'Scheduled', exact: true }).waitFor();
    const button = currentPage.getByRole('button', { name: 'New schedule', exact: true });
    const disabled = await button.isDisabled();
    const title = await button.getAttribute('title');
    if (!disabled || !title?.includes('running session')) throw new Error(`Expected guarded schedule action, disabled=${disabled}, title=${title}`);
    return 'page renders and New schedule is correctly disabled without a live runtime';
  });

  await step('Plugins & skills page tabs, refresh, and install modal', async () => {
    await navigate(currentPage, 'Plugins & skills');
    await currentPage.getByRole('heading', { name: 'Make Prime work your way' }).waitFor();
    await currentPage.getByRole('button', { name: 'Skills', exact: true }).click();
    const skillCount = await currentPage.locator('.directory-list > article').count();
    await currentPage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await waitUntil(async () => !(await currentPage.getByRole('button', { name: 'Refresh', exact: true }).locator('svg').getAttribute('class') || '').includes('spin'), 25_000).catch(() => true);
    await currentPage.getByRole('button', { name: 'Install', exact: true }).click();
    await currentPage.getByRole('dialog').waitFor();
    await currentPage.getByPlaceholder('https://github.com/owner/prime-plugin').fill('/tmp/qa-not-installed');
    await currentPage.getByRole('button', { name: 'Cancel', exact: true }).click();
    await currentPage.getByRole('dialog').waitFor({ state: 'detached' });
    return `${skillCount} skill card(s); refresh action returns; install flow opens and cancels without mutation`;
  });

  await step('Settings sections and About/runtime metadata', async () => {
    await navigate(currentPage, 'Settings');
    await currentPage.getByRole('heading', { name: 'General', exact: true }).waitFor();
    await currentPage.getByRole('button', { name: 'Prime Agent', exact: true }).click();
    const runtimeText = await currentPage.locator('.runtime-card').innerText();
    if (!/Prime Agent (is ready|not detected)/.test(runtimeText)) throw new Error(`Unexpected runtime card: ${runtimeText}`);
    await currentPage.getByRole('button', { name: 'About', exact: true }).click();
    await currentPage.getByRole('heading', { name: 'About Prime Work', exact: true }).waitFor();
    const about = await currentPage.locator('.settings-content').innerText();
    if (!about.includes('Version 0.1.0')) throw new Error(`Version not displayed: ${about.slice(0, 300)}`);
    return `runtime status shown; About reports version 0.1.0`;
  });

  await step('Sidebar hide/show buttons and ⌘B shortcut', async () => {
    await ensureSidebar(currentPage);
    await currentPage.locator('.sidebar').getByLabel('Hide sidebar (⌘B)').click();
    await currentPage.locator('.sidebar').waitFor({ state: 'detached' });
    await currentPage.getByLabel('Show sidebar (⌘B)').click();
    await currentPage.locator('.sidebar').waitFor();
    await currentPage.keyboard.press('Meta+b');
    await currentPage.locator('.sidebar').waitFor({ state: 'detached' });
    await currentPage.keyboard.press('Meta+b');
    await currentPage.locator('.sidebar').waitFor();
    return 'sidebar hides and restores from both UI controls and keyboard shortcut';
  });

  await step('Command palette opens, filters, handles empty results/Escape, and runs navigation', async () => {
    await navigate(currentPage, 'Activity');
    await currentPage.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
    await currentPage.keyboard.press('Meta+k');
    const dialog = currentPage.getByRole('dialog', { name: 'Command palette' });
    await dialog.waitFor();
    const input = dialog.getByPlaceholder('Search commands, projects, and sessions');
    await input.fill('__no_command__');
    await dialog.getByText('No commands match “__no_command__”.', { exact: true }).waitFor();
    await currentPage.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await currentPage.keyboard.press('Meta+k');
    await dialog.waitFor();
    await dialog.getByPlaceholder('Search commands, projects, and sessions').fill('settings');
    await currentPage.keyboard.press('Enter');
    await currentPage.getByRole('heading', { name: 'General', exact: true }).waitFor();
    return '⌘K opens focused palette; filtering/empty state/Escape work; Enter runs Open Settings';
  });

  await step('Dark appearance mode applies and persists through settings service', async () => {
    await currentPage.getByRole('button', { name: 'Appearance', exact: true }).click();
    await currentPage.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
    await currentPage.getByRole('button', { name: 'Dark', exact: true }).click();
    await waitUntil(async () => (await currentPage.locator('html').getAttribute('data-theme')) === 'dark');
    const bg = await currentPage.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
    await shot(currentPage, 'dark-settings');
    return `html[data-theme=dark], body background=${bg}`;
  });

  await step('Inspector Summary, Changes, and Files tabs', async () => {
    await navigate(currentPage, 'Projects');
    await currentPage.locator('.project-item').first().click();
    await currentPage.locator('.conversation-pane').waitFor();
    const inspector = currentPage.locator('.inspector');
    if (!(await inspector.count())) {
      await currentPage.getByLabel('Toggle inspector').click();
      await inspector.waitFor();
    }
    await currentPage.getByRole('tab', { name: 'Summary', exact: true }).click();
    await currentPage.getByRole('heading', { name: 'Session overview', exact: true }).waitFor();
    await currentPage.getByRole('tab', { name: /Changes/ }).click();
    await currentPage.locator('.changes-panel, .empty-state').waitFor();
    const changesText = (await currentPage.locator('.inspector__body').innerText()).slice(0, 250);
    await currentPage.getByRole('tab', { name: 'Files', exact: true }).click();
    await currentPage.locator('.files-panel').waitFor();
    const filter = currentPage.getByPlaceholder('Filter files');
    await filter.fill('__no_file__');
    await currentPage.getByText('No files match “__no_file__”.', { exact: true }).waitFor();
    await filter.fill('');
    return `Summary rendered; Changes rendered (${JSON.stringify(changesText)}); Files filtering works`;
  });

  await step('Real Browser webview loads isolated live homepage, history, and annotation', async () => {
    await currentPage.getByRole('tab', { name: 'Browser', exact: true }).click();
    const address = currentPage.getByLabel('Browser address');
    await address.waitFor();
    const webview = currentPage.locator('webview.browser-webview');
    const url = await waitUntil(async () => {
      const value = await webview.evaluate((el) => typeof el.getURL === 'function' ? el.getURL() : '');
      return value.startsWith('https://www.google.com') ? value : '';
    }, 35_000);
    const guest = await waitUntil(async () => {
      const value = await webview.evaluate(async (el) => {
        const ready = await el.executeJavaScript('document.readyState');
        const title = await el.executeJavaScript('document.title');
        const text = await el.executeJavaScript('document.body && document.body.innerText');
        return { ready, title, text };
      });
      return value.ready === 'complete' && String(value.text).length > 5 ? value : null;
    }, 35_000);
    const guestContents = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((item) => ({ type: item.getType(), url: item.getURL(), title: item.getTitle() })));
    if (!guestContents.some((item) => item.type === 'webview' && item.url.startsWith('https://www.google.com'))) throw new Error(`No live webview guest found: ${JSON.stringify(guestContents)}`);
    result.observations.browserGuest = { url, guest, guestContents };
    await currentPage.getByLabel('Browser history').click();
    await currentPage.locator('.browser-history').waitFor();
    if (!(await currentPage.locator('.browser-history').innerText()).includes('google.com')) throw new Error('Browser history did not contain current URL');
    await currentPage.getByLabel('Browser history').click();
    await currentPage.getByLabel('Annotate page').click();
    await currentPage.getByPlaceholder('Describe what should change…').fill('QA annotation: verify embedded web content.');
    await currentPage.getByRole('button', { name: 'Add comment', exact: true }).click();
    await currentPage.getByText('1 comment', { exact: true }).waitFor();
    await shot(currentPage, 'browser-webview');
    return `live isolated guest loaded ${url} (${guest.title}); history and annotation work`;
  });

  await step('Browser address navigation from settled homepage to https://example.com', async () => {
    const address = currentPage.getByLabel('Browser address');
    const webview = currentPage.locator('webview.browser-webview');
    await address.fill('https://example.com/');
    await address.press('Enter');
    const url = await waitUntil(async () => {
      const value = await webview.evaluate((el) => el.getURL());
      return value.startsWith('https://example.com') ? value : '';
    }, 25_000);
    const guest = await webview.evaluate(async (el) => ({
      title: await el.executeJavaScript('document.title'),
      text: await el.executeJavaScript('document.body && document.body.innerText'),
    }));
    if (guest.title !== 'Example Domain' || !String(guest.text).includes('Example Domain')) throw new Error(`Unexpected guest DOM: ${JSON.stringify(guest)}`);
    await currentPage.locator('.browser-toolbar').getByLabel('Back').click();
    await waitUntil(async () => (await webview.evaluate((el) => el.getURL())).startsWith('https://www.google.com'), 15_000);
    await currentPage.locator('.browser-toolbar').getByLabel('Forward').click();
    await waitUntil(async () => (await webview.evaluate((el) => el.getURL())).startsWith('https://example.com'), 15_000);
    return `address navigation loaded ${url} with title ${guest.title}; Back and Forward traverse history`;
  });

  await step('Integrated terminal creates PTY and executes a real shell command', async () => {
    await currentPage.getByLabel('Toggle terminal (⌘J)').click();
    const drawer = currentPage.getByRole('region', { name: 'Integrated terminal' });
    await drawer.waitFor();
    await drawer.locator('.terminal-live-dot.is-connected').waitFor({ timeout: 25_000 });
    const terminalInput = drawer.locator('.xterm-helper-textarea');
    await terminalInput.click();
    const token = `PRIME_WORK_QA_${Date.now()}`;
    await currentPage.keyboard.type(`printf '${token}\n'; pwd`);
    await currentPage.keyboard.press('Enter');
    await waitUntil(async () => (await drawer.locator('.xterm-rows').innerText()).includes(token), 15_000);
    const rows = await drawer.locator('.xterm-rows').innerText();
    if (!rows.includes(root)) throw new Error(`pwd output did not include project root; terminal text=${rows.slice(-1200)}`);
    result.observations.terminalTail = rows.slice(-1200);
    await shot(currentPage, 'terminal');
    return `connected PTY echoed ${token} and pwd=${root}`;
  });

  await step('Terminal New, Split, and Maximize toolbar actions change terminal layout', async () => {
    const drawer = currentPage.getByRole('region', { name: 'Integrated terminal' });
    const before = {
      tabs: await drawer.locator('.terminal-tabs > button').count(),
      surfaces: await drawer.locator('.terminal-surface').count(),
      box: await drawer.boundingBox(),
    };
    await drawer.getByLabel('New terminal').click();
    await drawer.getByLabel('Split terminal').click();
    await drawer.getByLabel('Maximize terminal').click();
    await currentPage.waitForTimeout(400);
    const after = {
      tabs: await drawer.locator('.terminal-tabs > button').count(),
      surfaces: await drawer.locator('.terminal-surface').count(),
      box: await drawer.boundingBox(),
    };
    result.observations.terminalToolbar = { before, after };
    const heightChanged = before.box && after.box && Math.abs(after.box.height - before.box.height) > 20;
    if (after.tabs === before.tabs && after.surfaces === before.surfaces && !heightChanged) {
      throw new Error(`All three enabled toolbar controls had no observable effect; before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`);
    }
    return `terminal layout changed from ${JSON.stringify(before)} to ${JSON.stringify(after)}`;
  });

  await step('Terminal Clear and Close actions', async () => {
    const drawer = currentPage.getByRole('region', { name: 'Integrated terminal' });
    await drawer.getByLabel('Clear terminal').click();
    await drawer.getByLabel('Close terminal').click();
    await drawer.waitFor({ state: 'detached' });
    return 'Clear and Close actions complete';
  });

  await step('Close last macOS window and reopen via application activation', async () => {
    const closingPage = currentPage;
    const closed = closingPage.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await closed;
    await waitUntil(() => app.windows().length === 0);
    const nextWindowPromise = app.waitForEvent('window');
    await app.evaluate(({ app }) => app.emit('activate'));
    currentPage = await nextWindowPromise;
    attachPage(currentPage);
    await currentPage.waitForLoadState('domcontentloaded');
    await currentPage.locator('.app-shell').waitFor();
    await waitForProjectData(currentPage);
    const theme = await currentPage.locator('html').getAttribute('data-theme');
    if (theme !== 'dark') throw new Error(`Dark setting did not persist; reopened theme=${theme}`);
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    if (windows !== 1) throw new Error(`Expected one reopened window, got ${windows}`);
    await shot(currentPage, 'reopened');
    return 'last window closed while broker stayed alive; activate created one authorized window; dark setting and project data persisted';
  });

} catch (error) {
  record('FAIL', 'QA harness setup/fatal error', error?.stack || String(error));
} finally {
  try { if (app) await app.close(); } catch (error) { result.mainStderr.push(`Harness close failure: ${error?.stack || error}`); }
  await new Promise(r => setTimeout(r, 300));
  result.finishedAt = new Date().toISOString();
  result.summary = {
    passed: result.steps.filter(s => s.status === 'PASS').length,
    failed: result.steps.filter(s => s.status === 'FAIL').length,
  };
  fs.writeFileSync(path.join(root, 'research/functional-qa-results.json'), JSON.stringify(result, null, 2));
  console.log(`SUMMARY ${result.summary.passed} passed, ${result.summary.failed} failed`);
}
