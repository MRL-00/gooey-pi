#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateReleaseTag } from './validate-release-tag.mjs'

export function expectedGitHubReleaseAssets(version) {
  return [
    `GooeyPi-${version}-arm64.dmg`,
    `GooeyPi-${version}-arm64.zip`,
    `GooeyPi-${version}-x64.dmg`,
    `GooeyPi-${version}-x64.zip`,
    `GooeyPi-${version}-linux-x64.AppImage`,
    `GooeyPi-${version}-linux-x64.deb`,
    `GooeyPi-${version}-linux-x64.pacman`,
    `GooeyPi-${version}-linux-x64.rpm`,
    `GooeyPi-${version}-win-x64.exe`,
    `GooeyPi-${version}-win-x64.zip`,
  ].sort()
}

function listFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) listFiles(path, found)
    else if (entry.isFile()) found.push(path)
    else throw new Error(`Downloaded release artifacts contain a forbidden non-file entry: ${path}`)
  }
  return found
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function prepareGitHubRelease({ inputDirectory, outputDirectory, tag, projectDirectory = process.cwd() }) {
  const release = validateReleaseTag(tag, projectDirectory)
  if (!existsSync(inputDirectory) || !lstatSync(inputDirectory).isDirectory()) throw new Error(`Downloaded release artifact directory does not exist: ${inputDirectory}`)
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length) throw new Error(`GitHub Release output directory must be empty: ${outputDirectory}`)
  mkdirSync(outputDirectory, { recursive: true })

  const expected = expectedGitHubReleaseAssets(release.version)
  const expectedSet = new Set(expected)
  const selected = new Map()
  for (const path of listFiles(inputDirectory)) {
    const name = basename(path)
    if (!expectedSet.has(name)) continue
    if (selected.has(name)) throw new Error(`Downloaded release artifacts contain duplicate files named ${name}`)
    selected.set(name, path)
  }
  const missing = expected.filter((name) => !selected.has(name))
  if (missing.length) throw new Error(`Downloaded release artifacts are incomplete; missing ${missing.join(', ')}`)

  const checksumLines = []
  for (const name of expected) {
    const destination = join(outputDirectory, name)
    copyFileSync(selected.get(name), destination)
    if (lstatSync(destination).size === 0) throw new Error(`Release asset is empty: ${name}`)
    checksumLines.push(`${await sha256(destination)}  ${name}`)
  }
  writeFileSync(join(outputDirectory, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`)
  return { ...release, assets: expected, checksumFile: 'SHA256SUMS.txt' }
}

export function invokedAsScript() {
  if (!process.argv[1]) return true
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (invokedAsScript()) {
  try {
    const inputDirectory = option('--input')
    const outputDirectory = option('--output')
    const tag = option('--tag')
    if (!inputDirectory || !outputDirectory) throw new Error('Provide --input and --output directories')
    const release = await prepareGitHubRelease({ inputDirectory: resolve(inputDirectory), outputDirectory: resolve(outputDirectory), tag })
    console.log(`Prepared ${release.assets.length} assets and ${release.checksumFile} for ${release.tag}.`)
  } catch (error) {
    console.error(`GitHub Release preparation failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
