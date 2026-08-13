#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateReleaseTag } from './validate-release-tag.mjs'

const RELEASE_PLATFORMS = ['mac', 'linux', 'win']

export function parseReleasePlatforms(value = RELEASE_PLATFORMS.join(',')) {
  const platforms = value
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean)
  if (!platforms.length) throw new Error('At least one release platform is required')
  if (new Set(platforms).size !== platforms.length) throw new Error(`Release platforms contain duplicates: ${value}`)
  const unsupported = platforms.filter((platform) => !RELEASE_PLATFORMS.includes(platform))
  if (unsupported.length) throw new Error(`Unsupported release platforms: ${unsupported.join(', ')}`)
  return platforms
}

export function expectedGitHubReleaseAssets(version, platforms = RELEASE_PLATFORMS) {
  const assets = {
    mac: [`GooeyPi-${version}-arm64.dmg`, `GooeyPi-${version}-arm64.zip`, `GooeyPi-${version}-x64.dmg`, `GooeyPi-${version}-x64.zip`],
    linux: [`GooeyPi-${version}-linux-x86_64.AppImage`, `GooeyPi-${version}-linux-amd64.deb`, `GooeyPi-${version}-linux-x64.pacman`, `GooeyPi-${version}-linux-x86_64.rpm`],
    win: [`GooeyPi-${version}-win-x64.exe`, `GooeyPi-${version}-win-x64.zip`],
  }
  return platforms.flatMap((platform) => assets[platform]).sort()
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

export async function prepareGitHubRelease({ inputDirectory, outputDirectory, tag, platforms = RELEASE_PLATFORMS, projectDirectory = process.cwd() }) {
  const release = validateReleaseTag(tag, projectDirectory)
  if (!existsSync(inputDirectory) || !lstatSync(inputDirectory).isDirectory()) throw new Error(`Downloaded release artifact directory does not exist: ${inputDirectory}`)
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length) throw new Error(`GitHub Release output directory must be empty: ${outputDirectory}`)
  mkdirSync(outputDirectory, { recursive: true })

  const expected = expectedGitHubReleaseAssets(release.version, platforms)
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
    const platforms = parseReleasePlatforms(option('--platforms'))
    if (!inputDirectory || !outputDirectory) throw new Error('Provide --input and --output directories')
    const release = await prepareGitHubRelease({ inputDirectory: resolve(inputDirectory), outputDirectory: resolve(outputDirectory), tag, platforms })
    console.log(`Prepared ${release.assets.length} assets and ${release.checksumFile} for ${release.tag}.`)
  } catch (error) {
    console.error(`GitHub Release preparation failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
