#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listPackage } from '@electron/asar'
import { assertAsarLayout } from './lib.mjs'

function requireOption(value, label, allowed) {
  if (!value || !allowed.includes(value)) throw new Error(`${label} must be one of: ${allowed.join(', ')}`)
  return value
}

function listFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) listFiles(path, found)
    else if (entry.isFile()) found.push(path)
    else throw new Error(`Packaged runtime contains a forbidden non-file entry: ${path}`)
  }
  return found
}

function findUnpackedDirectory(outputDirectory, target) {
  const matches = readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(target) && entry.name.endsWith('-unpacked'))
    .map((entry) => join(outputDirectory, entry.name))
  if (matches.length !== 1) throw new Error(`Expected exactly one ${target} unpacked application, found ${matches.length}`)
  return matches[0]
}

export function expectedArtifactExtensions(target) {
  return target === 'linux' ? ['.AppImage', '.deb', '.rpm', '.pacman'] : ['.exe', '.zip']
}

function assertExpectedArtifacts(outputDirectory, target) {
  const files = readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  for (const extension of expectedArtifactExtensions(target)) {
    const matches = files.filter((name) => name.endsWith(extension))
    if (matches.length !== 1) throw new Error(`Expected exactly one ${extension} artifact, found ${matches.length}`)
  }
}

/** Maps a packaging target (electron-builder CLI naming) to the Node process.platform directory native modules ship under. */
export function nativeRuntimeDirectory(target) {
  return target === 'win' ? 'win32' : target
}

/** The exact non-ZeroMQ native files each target must unpack; mirrors package.json build.<target>.asarUnpack. */
export function expectedNativeFiles(target, architecture) {
  if (target === 'linux') return ['node_modules/node-pty/build/Release/pty.node']
  // node-pty resolves prebuilds from `prebuilds/${process.platform}-${process.arch}` (hyphenated, no nesting).
  const prebuilds = `node_modules/node-pty/prebuilds/win32-${architecture}`
  return [
    `${prebuilds}/pty.node`,
    `${prebuilds}/conpty.node`,
    `${prebuilds}/conpty_console_list.node`,
    `${prebuilds}/winpty-agent.exe`,
    `${prebuilds}/winpty.dll`,
    `${prebuilds}/conpty/OpenConsole.exe`,
    `${prebuilds}/conpty/conpty.dll`,
  ]
}

/** Matches the single unpacked ZeroMQ addon for a target/architecture; agrees with package.json's win32 directory naming. */
export function zeroMqAddonPattern(target, architecture) {
  return new RegExp(`^node_modules/zeromq/build/${nativeRuntimeDirectory(target)}/${architecture}/node/[^/]+-Release/addon\\.node$`)
}

export function assertUnpackedNativeLayout(directory, target, architecture) {
  const files = listFiles(directory)
    .map((path) => relative(directory, path).replaceAll('\\', '/'))
    .sort()
  const required = expectedNativeFiles(target, architecture)
  const zeroMqPattern = zeroMqAddonPattern(target, architecture)
  const allowed = new Set(required)
  const unexpected = files.filter((path) => !allowed.has(path) && !zeroMqPattern.test(path))
  const missing = required.filter((path) => !files.includes(path))
  const zeroMq = files.filter((path) => zeroMqPattern.test(path))
  // ZeroMQ intentionally ships ABI and, on Linux, libc fallbacks. Its loader
  // tries matching platform/architecture candidates from newest to oldest.
  // Keep that bounded fallback set while still rejecting off-target paths.
  if (missing.length || zeroMq.length === 0 || unexpected.length) {
    throw new Error(`Unexpected native unpack layout (missing: ${missing.join(', ') || 'none'}; ZeroMQ addons: ${zeroMq.length}, expected at least 1; extra: ${unexpected.join(', ') || 'none'})`)
  }
}

export function verifyPackage(target, architecture, { unpackedOnly = false } = {}) {
  const outputDirectory = resolve('release', target, architecture)
  if (!existsSync(outputDirectory)) throw new Error(`Release directory does not exist: ${outputDirectory}`)
  if (!unpackedOnly) assertExpectedArtifacts(outputDirectory, target)
  const app = findUnpackedDirectory(outputDirectory, target)
  const resources = join(app, 'resources')
  const asar = join(resources, 'app.asar')
  const unpacked = join(resources, 'app.asar.unpacked')
  if (!existsSync(asar) || !lstatSync(asar).isFile()) throw new Error('Packaged application must contain resources/app.asar')
  if (existsSync(join(resources, 'app'))) throw new Error('Packaged application contains forbidden loose resources/app')
  if (!existsSync(unpacked)) throw new Error('Packaged application must contain resources/app.asar.unpacked')
  assertAsarLayout(listPackage(asar, { isPack: false }))
  assertUnpackedNativeLayout(unpacked, target, architecture)
  const scope = unpackedOnly ? 'unpacked directory build' : 'installable artifacts'
  console.log(`Verified ${target}/${architecture} package: ${scope}, ASAR runtime layout, and exact native unpack allowlist.`)
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  const platformIndex = process.argv.indexOf('--platform')
  const platform = platformIndex === -1 ? undefined : process.argv[platformIndex + 1]
  const archIndex = process.argv.indexOf('--arch')
  const arch = archIndex === -1 ? undefined : process.argv[archIndex + 1]
  const unpackedOnly = process.argv.includes('--unpacked-only')
  try {
    verifyPackage(requireOption(platform, 'platform', ['linux', 'win']), requireOption(arch, 'arch', ['arm64', 'x64']), { unpackedOnly })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
