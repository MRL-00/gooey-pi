#!/usr/bin/env node
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertSupportedNode, validateReleaseCredentials } from './lib.mjs'

const args = new Set(process.argv.slice(2))
const isPublic = args.has('--public')
const isQa = args.has('--qa')
const dryRun = args.has('--dry-run')
if (isPublic === isQa) {
  console.error('Choose exactly one release mode: --public or --qa')
  process.exit(2)
}

function run(command, commandArgs, env = process.env) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`)
  if (dryRun) return
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`)
}

try {
  assertSupportedNode()
  if (process.platform !== 'darwin') throw new Error('macOS packaging must run on macOS')
  if (isPublic) validateReleaseCredentials(process.env)
  run('npm', ['run', 'release:verify'])
  if (!dryRun) rmSync(resolve('release'), { recursive: true, force: true })

  const builderArgs = ['exec', '--', 'electron-builder', '--mac', '--publish', 'never']
  const builderEnv = isQa ? { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : process.env
  if (isQa) builderArgs.push('-c.mac.identity=null', '-c.mac.notarize=false')
  run('npm', builderArgs, builderEnv)
  run('node', ['scripts/release/verify-package.mjs', '--mode', isPublic ? 'public' : 'qa'])
  console.log(`\n${isPublic ? 'Public' : 'Local QA'} package pipeline passed.`)
} catch (error) {
  console.error(`\nPackaging failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
