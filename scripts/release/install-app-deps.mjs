#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const env = { ...process.env }
if (process.platform === 'darwin' && !env.PYTHON) env.PYTHON = '/usr/bin/python3'

const executable = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
const result = spawnSync(executable, ['install-app-deps'], { stdio: 'inherit', env, shell: false })
if (result.error) throw result.error
if (result.status !== 0) process.exitCode = result.status ?? 1
