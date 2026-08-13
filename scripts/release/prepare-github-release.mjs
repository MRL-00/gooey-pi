#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'
import { validateReleaseTag } from './validate-release-tag.mjs'

const RELEASE_PLATFORMS = ['mac', 'linux', 'win']
const UPDATE_METADATA = { mac: 'latest-mac.yml', linux: 'latest-linux.yml', win: 'latest.yml' }

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
    mac: [`GooeyPi-${version}-m-chip.dmg`, `GooeyPi-${version}-arm64.zip`, `GooeyPi-${version}-intel-chip.dmg`, `GooeyPi-${version}-x64.zip`],
    linux: [`GooeyPi-${version}-linux-x86_64.AppImage`, `GooeyPi-${version}-linux-amd64.deb`, `GooeyPi-${version}-linux-x64.pacman`, `GooeyPi-${version}-linux-x86_64.rpm`],
    win: [`GooeyPi-${version}-win-x64.exe`, `GooeyPi-${version}-win-x64.zip`],
  }
  return platforms.flatMap((platform) => [...assets[platform], UPDATE_METADATA[platform]]).sort()
}

function parseUpdateMetadata(path, expectedVersion) {
  const value = load(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Update metadata is not an object: ${path}`)
  if (value.version !== expectedVersion) throw new Error(`Update metadata version does not match ${expectedVersion}: ${path}`)
  if (!Array.isArray(value.files) || !value.files.length) throw new Error(`Update metadata has no files: ${path}`)
  for (const file of value.files) {
    if (!file || typeof file !== 'object' || typeof file.url !== 'string' || !file.url || typeof file.sha512 !== 'string' || !file.sha512) {
      throw new Error(`Update metadata contains an invalid file: ${path}`)
    }
  }
  return value
}

export function mergeUpdateMetadata(paths, expectedVersion) {
  if (!paths.length) throw new Error('Update metadata is missing')
  const manifests = paths
    .slice()
    .sort()
    .map((path) => parseUpdateMetadata(path, expectedVersion))
  const files = new Map()
  for (const manifest of manifests)
    for (const file of manifest.files) {
      const previous = files.get(file.url)
      if (previous && (previous.sha512 !== file.sha512 || previous.size !== file.size)) throw new Error(`Update metadata disagrees for ${file.url}`)
      files.set(file.url, file)
    }
  const mergedFiles = [...files.values()].sort((left, right) => left.url.localeCompare(right.url))
  const preferredUrl = manifests.map((manifest) => manifest.path).find((path) => files.has(path))
  const primary = files.get(preferredUrl) ?? mergedFiles[0]
  return {
    ...manifests[0],
    files: mergedFiles,
    path: primary.url,
    sha512: primary.sha512,
  }
}

export function expectedDownloadedReleaseAssets(version, platforms = RELEASE_PLATFORMS) {
  return expectedGitHubReleaseAssets(version, platforms).map((name) =>
    name.replace(`GooeyPi-${version}-m-chip.dmg`, `GooeyPi-${version}-arm64.dmg`).replace(`GooeyPi-${version}-intel-chip.dmg`, `GooeyPi-${version}-x64.dmg`),
  )
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
  const downloaded = expectedDownloadedReleaseAssets(release.version, platforms)
  const expectedSet = new Set(downloaded)
  const selected = new Map()
  const metadata = new Map()
  for (const path of listFiles(inputDirectory)) {
    const name = basename(path)
    if (!expectedSet.has(name)) continue
    if (Object.values(UPDATE_METADATA).includes(name)) {
      const candidates = metadata.get(name) ?? []
      candidates.push(path)
      metadata.set(name, candidates)
      continue
    }
    if (selected.has(name)) throw new Error(`Downloaded release artifacts contain duplicate files named ${name}`)
    selected.set(name, path)
  }
  const missing = expected.filter((name, index) => !selected.has(downloaded[index]) && !metadata.has(name))
  if (missing.length) throw new Error(`Downloaded release artifacts are incomplete; missing ${missing.join(', ')}`)

  const checksumLines = []
  for (const [index, name] of expected.entries()) {
    const destination = join(outputDirectory, name)
    const metadataPaths = metadata.get(name)
    if (metadataPaths) {
      const manifest = mergeUpdateMetadata(metadataPaths, release.version)
      for (const file of manifest.files) {
        if (file.url !== basename(file.url) || !expectedSet.has(file.url) || Object.values(UPDATE_METADATA).includes(file.url)) {
          throw new Error(`Update metadata references an unpublished release asset: ${file.url}`)
        }
      }
      writeFileSync(destination, dump(manifest, { lineWidth: -1, noRefs: true, sortKeys: false }))
    } else copyFileSync(selected.get(downloaded[index]), destination)
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
