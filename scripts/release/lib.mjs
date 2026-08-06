import { accessSync, constants, existsSync } from 'node:fs'

export const MINIMUM_NODE = [22, 12, 0]

export const RELEASE_CREDENTIAL_NAMES = [
  'RELEASE_SIGNING_TEAM_ID',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
]

export function withoutReleaseCredentials(env = process.env, allowed = []) {
  const allowedNames = new Set(allowed)
  return Object.fromEntries(Object.entries(env).filter(([name]) => !RELEASE_CREDENTIAL_NAMES.includes(name) || allowedNames.has(name)))
}

export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) throw new Error(`Cannot parse Node.js version: ${version}`)
  return match.slice(1).map(Number)
}

export function assertSupportedNode(version = process.version) {
  const parsed = parseVersion(version)
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parsed[index] > MINIMUM_NODE[index]) return
    if (parsed[index] < MINIMUM_NODE[index]) {
      throw new Error(`Node.js >=${MINIMUM_NODE.join('.')} is required (found ${version})`)
    }
  }
}

function requireNonEmpty(env, names, label) {
  const missing = names.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`${label} credentials are incomplete; missing ${missing.join(', ')}`)
}

export function validateReleaseCredentials(env = process.env, options = {}) {
  const { checkApiKeyFile = true } = options
  requireNonEmpty(env, ['RELEASE_SIGNING_TEAM_ID'], 'Developer ID signing')
  requireNonEmpty(env, ['CSC_LINK', 'CSC_KEY_PASSWORD'], 'Developer ID signing')

  const appleIdNames = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  const apiKeyNames = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
  const hasAppleIdValue = appleIdNames.some((name) => env[name]?.trim())
  const hasApiKeyValue = apiKeyNames.some((name) => env[name]?.trim())
  if (hasAppleIdValue === hasApiKeyValue) {
    throw new Error('Provide exactly one complete notarization credential set: Apple ID or App Store Connect API key')
  }
  const selected = hasAppleIdValue ? appleIdNames : apiKeyNames
  requireNonEmpty(env, selected, 'Notarization')
  if (hasAppleIdValue && env.APPLE_TEAM_ID !== env.RELEASE_SIGNING_TEAM_ID) {
    throw new Error('APPLE_TEAM_ID must match RELEASE_SIGNING_TEAM_ID')
  }
  if (hasApiKeyValue && checkApiKeyFile && !existsSync(env.APPLE_API_KEY)) {
    throw new Error(`APPLE_API_KEY does not exist: ${env.APPLE_API_KEY}`)
  }
  if (hasApiKeyValue && checkApiKeyFile) accessSync(env.APPLE_API_KEY, constants.R_OK)
}

export function requireReleaseArtifacts(paths) {
  const artifacts = { dmg: [], zip: [] }
  for (const path of paths) {
    if (path.endsWith('.dmg')) artifacts.dmg.push(path)
    if (path.endsWith('.zip')) artifacts.zip.push(path)
  }
  for (const [extension, matches] of Object.entries(artifacts)) {
    if (matches.length !== 1) throw new Error(`Expected exactly one ${extension.toUpperCase()} artifact, found ${matches.length}`)
  }
  return { dmg: artifacts.dmg[0], zip: artifacts.zip[0] }
}

export function artifactArchitectures(path) {
  const architecture = /-(arm64|x64|universal)\.(?:dmg|zip)$/.exec(path)?.[1]
  if (!architecture) throw new Error(`Artifact name does not declare a supported architecture: ${path}`)
  if (architecture === 'arm64') return new Set(['arm64'])
  if (architecture === 'x64') return new Set(['x86_64'])
  return new Set(['arm64', 'x86_64'])
}

export function assertExactArchitectures(actual, expected, label) {
  const missing = [...expected].filter((architecture) => !actual.has(architecture))
  const unexpected = [...actual].filter((architecture) => !expected.has(architecture))
  if (missing.length || unexpected.length) {
    throw new Error(`${label} architectures do not match its artifact name (expected ${[...expected].join(', ')}, found ${[...actual].join(', ')})`)
  }
}

export function parseTeamIdentifier(output) {
  return /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim()
}

export function parseArchitectures(output) {
  return new Set(output.trim().split(/\s+/).filter(Boolean))
}

export function assertArchitectureCoverage(appArchitectures, nativeArchitectures, label) {
  const missing = [...appArchitectures].filter((architecture) => !nativeArchitectures.has(architecture))
  if (missing.length) throw new Error(`${label} is missing app architecture(s): ${missing.join(', ')}`)
}

export function assertAsarLayout(entries) {
  const normalized = new Set(entries.map((entry) => entry.replace(/^\//, '')))
  const required = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'node_modules/node-pty/lib/index.js']
  const missing = required.filter((entry) => !normalized.has(entry))
  if (missing.length) throw new Error(`ASAR is missing required runtime entries: ${missing.join(', ')}`)
  const forbiddenPrefixes = ['node_modules/@xterm/', 'node_modules/lucide-react/', 'node_modules/react/', 'node_modules/react-dom/', 'node_modules/react-markdown/', 'node_modules/remark-gfm/']
  const forbidden = [...normalized].find((entry) => forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)))
  if (forbidden) throw new Error(`Renderer-only dependency was duplicated into the ASAR: ${forbidden}`)
}
