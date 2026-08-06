#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { listPackage } from '@electron/asar'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { artifactArchitectures, assertArchitectureCoverage, assertAsarLayout, assertExactArchitectures, parseArchitectures, parseTeamIdentifier, requireReleaseArtifacts } from './lib.mjs'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function findFiles(directory, predicate, found = []) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      if (predicate(path, stat)) found.push(path)
      else findFiles(path, predicate, found)
    } else if (predicate(path, stat)) found.push(path)
  }
  return found
}

function findSingleApp(directory, label) {
  const apps = findFiles(directory, (path, stat) => stat.isDirectory() && path.endsWith('.app'))
  if (apps.length !== 1) throw new Error(`Expected exactly one packaged .app in ${label}, found ${apps.length}`)
  return apps[0]
}

function assertFuses(wire) {
  const expected = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
  ])
  for (const [option, state] of expected) {
    if (wire[option] !== state) throw new Error(`Electron fuse ${FuseV1Options[option]} has unsafe state ${wire[option]}`)
  }
}

async function verifyApp({ app, artifact, mode, expectedTeam }) {
  const productName = basename(app, '.app')
  const resources = join(app, 'Contents', 'Resources')
  const executable = join(app, 'Contents', 'MacOS', productName)
  const asar = join(resources, 'app.asar')
  const looseApp = join(resources, 'app')
  if (!existsSync(asar)) throw new Error(`${basename(artifact)} application must contain Resources/app.asar`)
  if (existsSync(looseApp)) throw new Error(`${basename(artifact)} contains forbidden loose Resources/app`)
  assertAsarLayout(listPackage(asar))

  const appArchitectures = parseArchitectures(run('lipo', ['-archs', executable]))
  assertExactArchitectures(appArchitectures, artifactArchitectures(artifact), basename(artifact))
  const unpacked = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release')
  const nativeFiles = [join(unpacked, 'pty.node'), join(unpacked, 'spawn-helper')]
  for (const path of nativeFiles) {
    if (!existsSync(path)) throw new Error(`Missing unpacked node-pty runtime in ${basename(artifact)}: ${path}`)
    assertArchitectureCoverage(appArchitectures, parseArchitectures(run('lipo', ['-archs', path])), basename(path))
  }
  assertFuses(await getCurrentFuseWire(executable))

  if (mode === 'public') {
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', app])
    const signature = run('codesign', ['-dv', '--verbose=4', app])
    const actualTeam = parseTeamIdentifier(signature)
    if (actualTeam !== expectedTeam) throw new Error(`Signature Team ID ${actualTeam ?? '<missing>'} does not match ${expectedTeam}`)
    run('xcrun', ['stapler', 'validate', app])
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
  }
}

async function verifyZip(zip, options) {
  run('unzip', ['-t', zip])
  const extractionDirectory = mkdtempSync(join(tmpdir(), 'prime-work-zip-'))
  try {
    run('ditto', ['-x', '-k', zip, extractionDirectory])
    await verifyApp({ ...options, app: findSingleApp(extractionDirectory, basename(zip)), artifact: zip })
  } finally {
    rmSync(extractionDirectory, { recursive: true, force: true })
  }
}

async function verifyDmg(dmg, options) {
  run('hdiutil', ['verify', dmg])
  const mountPoint = mkdtempSync(join(tmpdir(), 'prime-work-dmg-'))
  let mounted = false
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, dmg])
    mounted = true
    await verifyApp({ ...options, app: findSingleApp(mountPoint, basename(dmg)), artifact: dmg })
  } finally {
    if (mounted) run('hdiutil', ['detach', mountPoint])
    rmSync(mountPoint, { recursive: true, force: true })
  }
}

export async function verifyPackage({ mode, releaseDirectory = resolve('release'), env = process.env }) {
  if (mode !== 'public' && mode !== 'qa') throw new Error('Verification mode must be public or qa')
  if (!existsSync(releaseDirectory)) throw new Error(`Release directory does not exist: ${releaseDirectory}`)
  const expectedTeam = env.RELEASE_SIGNING_TEAM_ID?.trim()
  if (mode === 'public' && !expectedTeam) throw new Error('RELEASE_SIGNING_TEAM_ID is required for public verification')

  const artifactFiles = findFiles(releaseDirectory, (path, stat) => stat.isFile() && (path.endsWith('.dmg') || path.endsWith('.zip')))
  const artifacts = requireReleaseArtifacts(artifactFiles)
  await verifyDmg(artifacts.dmg, { mode, expectedTeam })
  await verifyZip(artifacts.zip, { mode, expectedTeam })

  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  console.log(
    `Verified ${mode} DMG and ZIP for Prime Work ${packageJson.version}: archive integrity, contained application, exact architectures, ASAR, node-pty architectures, and Electron fuses${mode === 'public' ? ', signatures, notarization staples, and Gatekeeper' : ''}.`,
  )
}

const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : undefined
verifyPackage({ mode }).catch((error) => {
  console.error(`Package verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
