import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = '/Users/am.will/Applications/prime'
const userData = mkdtempSync(join(tmpdir(), 'prime-work-icon-qa-'))
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  cwd: root,
  env: { ...process.env, PRIME_WORK_E2E: '1' },
})

try {
  const page = await app.firstWindow()
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await page.setViewportSize({ width: 1440, height: 920 })
  await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'dark'))
  const clearance = await page.locator('.sidebar__titlebar .traffic-light-clearance').boundingBox()
  const brand = await page.locator('.sidebar__brand').boundingBox()
  const browser = await page.getByLabel('Open browser (⌘⇧B)').boundingBox()
  console.log(JSON.stringify({ clearance, brand, browser }))
  await page.screenshot({ path: join(root, 'research/icon-visual-qa.png') })
} finally {
  await app.close()
}
