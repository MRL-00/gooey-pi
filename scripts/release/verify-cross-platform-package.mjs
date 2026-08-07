#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { listPackage } from '@electron/asar'
import { assertAsarLayout } from './lib.mjs'

const platformIndex = process.argv.indexOf('--platform')
const platform = platformIndex === -1 ? undefined : process.argv[platformIndex + 1]
const archIndex = process.argv.indexOf('--arch')
const arch = archIndex === -1 ? undefined : process.argv[archIndex + 1]

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

function assertExpectedArtifacts(outputDirectory, target) {
  const files = readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  const extensions = target === 'linux' ? ['.AppImage', '.deb', '.rpm'] : ['.exe', '.zip']
  for (const extension of extensions) {
    const matches = files.filter((name) => name.endsWith(extension))
    if (matches.length !== 1) throw new Error(`Expected exactly one ${extension} artifact, found ${matches.length}`)
  }
}

function assertUnpackedNativeLayout(directory, target, architecture) {
  const files = listFiles(directory)
    .map((path) => relative(directory, path).replaceAll('\\', '/'))
    .sort()
  const required =
    target === 'linux'
      ? ['node_modules/node-pty/build/Release/pty.node']
      : [
          `node_modules/node-pty/prebuilds/win32/${architecture}/pty.node`,
          `node_modules/node-pty/prebuilds/win32/${architecture}/conpty.node`,
          `node_modules/node-pty/prebuilds/win32/${architecture}/conpty_console_list.node`,
          `node_modules/node-pty/prebuilds/win32/${architecture}/winpty-agent.exe`,
          `node_modules/node-pty/prebuilds/win32/${architecture}/winpty.dll`,
          `node_modules/node-pty/prebuilds/win32/${architecture}/conpty/OpenConsole.exe`,
          `node_modules/node-pty/prebuilds/win32/${architecture}/conpty/conpty.dll`,
        ]
  const zeroMqPattern = new RegExp(`^node_modules/zeromq/build/${target}/${architecture}/node/[^/]+-Release/addon\\.node$`)
  const allowed = target === 'linux' ? new Set([...required]) : new Set([...required])
  const unexpected = files.filter((path) => !allowed.has(path) && !zeroMqPattern.test(path))
  const missing = required.filter((path) => !files.includes(path))
  const zeroMq = files.filter((path) => zeroMqPattern.test(path))
  if (missing.length || !zeroMq.length || unexpected.length) {
    throw new Error(`Unexpected native unpack layout (missing: ${missing.join(', ') || 'none'}; ZeroMQ: ${zeroMq.length}; extra: ${unexpected.join(', ') || 'none'})`)
  }
}

function verifyPackage(target, architecture) {
  const outputDirectory = resolve('release', target, architecture)
  if (!existsSync(outputDirectory)) throw new Error(`Release directory does not exist: ${outputDirectory}`)
  assertExpectedArtifacts(outputDirectory, target)
  const app = findUnpackedDirectory(outputDirectory, target)
  const resources = join(app, 'resources')
  const asar = join(resources, 'app.asar')
  const unpacked = join(resources, 'app.asar.unpacked')
  if (!existsSync(asar) || !lstatSync(asar).isFile()) throw new Error('Packaged application must contain resources/app.asar')
  if (existsSync(join(resources, 'app'))) throw new Error('Packaged application contains forbidden loose resources/app')
  if (!existsSync(unpacked)) throw new Error('Packaged application must contain resources/app.asar.unpacked')
  assertAsarLayout(listPackage(asar))
  assertUnpackedNativeLayout(unpacked, target, architecture)
  console.log(`Verified ${target}/${architecture} package: installable artifacts, ASAR runtime layout, and exact native unpack allowlist.`)
}

try {
  verifyPackage(requireOption(platform, 'platform', ['linux', 'win']), requireOption(arch, 'arch', ['arm64', 'x64']))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
