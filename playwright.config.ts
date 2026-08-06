import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 75_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  // Electron can occasionally fail to create its first macOS window even after
  // the child launches. A retry gets a fresh Playwright worker/process while
  // deterministic product failures still fail twice.
  retries: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
