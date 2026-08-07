#!/usr/bin/env node
import { runCommand } from './lib.mjs'

const env = { ...process.env }
if (process.platform === 'darwin' && !env.PYTHON) env.PYTHON = '/usr/bin/python3'

try {
  runCommand('electron-builder', ['install-app-deps'], { env })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
