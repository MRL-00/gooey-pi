import { mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  assertArchitectureCoverage,
  assertAsarLayout,
  assertSupportedNode,
  assertUnpackedNativeLayout,
  expectedUnpackedNativeFiles,
  parseArchitectures,
  parseTeamIdentifier,
  validateReleaseCredentials,
} from '../scripts/release/lib.mjs'
import { BUNDLE_SIZE_BUDGETS, PACKAGE_SIZE_BUDGETS, assertBundleSizeBudgets, assertPackageSizeBudgets, collectBundleSizeMetrics, collectPackageSizeMetrics } from '../scripts/release/size-budgets.mjs'

const baseEnvironment = {
  RELEASE_SIGNING_TEAM_ID: 'TEAM123',
  CSC_LINK: 'base64-certificate',
  CSC_KEY_PASSWORD: 'certificate-password',
  APPLE_ID: 'release@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
  APPLE_TEAM_ID: 'TEAM123',
}

function createUnpackedFixture(architectures = new Set(['arm64'])) {
  const directory = mkdtempSync(join(tmpdir(), 'prime-work-unpacked-'))
  for (const relativePath of expectedUnpackedNativeFiles(architectures)) {
    const path = join(directory, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'fixture')
  }
  return directory
}

function writeSizedFile(path: string, bytes: number) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  truncateSync(path, bytes)
}

function createBundleSizeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'prime-work-bundle-size-'))
  writeSizedFile(join(directory, 'main/index.js'), 101)
  writeSizedFile(join(directory, 'preload/index.js'), 102)
  writeSizedFile(join(directory, 'renderer/assets/entry.js'), 103)
  writeSizedFile(join(directory, 'renderer/assets/vendor.js'), 104)
  writeSizedFile(join(directory, 'renderer/assets/lazy.js'), 105)
  writeSizedFile(join(directory, 'renderer/assets/app.css'), 106)
  writeFileSync(
    join(directory, 'renderer/index.html'),
    '<script type="module" src="./assets/entry.js"></script><link rel="modulepreload" href="./assets/vendor.js"><link rel="stylesheet" href="./assets/app.css">',
  )
  return directory
}

describe('release preflight', () => {
  test('requires the Electron 43 Node.js baseline', () => {
    expect(() => assertSupportedNode('v22.11.0')).toThrow(/>=22\.12\.0/)
    expect(() => assertSupportedNode('v22.12.0')).not.toThrow()
    expect(() => assertSupportedNode('v24.0.0')).not.toThrow()
  })

  test('fails closed without Developer ID credentials', () => {
    expect(() => validateReleaseCredentials({}, { checkApiKeyFile: false })).toThrow(/RELEASE_SIGNING_TEAM_ID/)
    expect(() => validateReleaseCredentials({ ...baseEnvironment, CSC_LINK: '' }, { checkApiKeyFile: false })).toThrow(/CSC_LINK/)
  })

  test('accepts exactly one complete notarization credential set', () => {
    expect(() => validateReleaseCredentials(baseEnvironment, { checkApiKeyFile: false })).not.toThrow()
    const apiEnvironment = {
      RELEASE_SIGNING_TEAM_ID: 'TEAM123',
      CSC_LINK: 'certificate',
      CSC_KEY_PASSWORD: 'password',
      APPLE_API_KEY: '/tmp/AuthKey.p8',
      APPLE_API_KEY_ID: 'KEY123',
      APPLE_API_ISSUER: 'issuer-id',
    }
    expect(() => validateReleaseCredentials(apiEnvironment, { checkApiKeyFile: false })).not.toThrow()
    expect(() => validateReleaseCredentials({ ...baseEnvironment, ...apiEnvironment }, { checkApiKeyFile: false })).toThrow(/exactly one/)
  })

  test('binds Apple ID notarization to the signing Team ID', () => {
    expect(() => validateReleaseCredentials({ ...baseEnvironment, APPLE_TEAM_ID: 'OTHER' }, { checkApiKeyFile: false })).toThrow(/must match/)
  })
})

describe('post-package verification helpers', () => {
  test('parses Team IDs and architecture lists', () => {
    expect(parseTeamIdentifier('Authority=Developer ID\nTeamIdentifier=TEAM123\n')).toBe('TEAM123')
    expect(parseArchitectures('arm64 x86_64\n')).toEqual(new Set(['arm64', 'x86_64']))
  })

  test('requires native modules to cover every application architecture', () => {
    expect(() => assertArchitectureCoverage(new Set(['arm64']), new Set(['arm64']), 'pty.node')).not.toThrow()
    expect(() => assertArchitectureCoverage(new Set(['arm64', 'x86_64']), new Set(['arm64']), 'pty.node')).toThrow(/x86_64/)
  })

  test('requires the ASAR and rejects duplicated renderer dependencies', () => {
    const entries = [
      '/out/main/index.js',
      '/out/preload/index.js',
      '/out/renderer/index.html',
      '/node_modules/node-pty/lib/index.js',
      '/node_modules/zeromq/lib/index.js',
      '/node_modules/zeromq/build/manifest.json',
    ]
    expect(() => assertAsarLayout(entries)).not.toThrow()
    expect(() => assertAsarLayout([...entries, '/node_modules/react/index.js'])).toThrow(/duplicated/)
    expect(() => assertAsarLayout(entries.filter((entry) => !entry.includes('node-pty')))).toThrow(/missing required/)
  })

  test('keeps the builder native unpack patterns exact and architecture-specific', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageJson.build.asarUnpack).toEqual([
      '**/node_modules/node-pty/build/Release/pty.node',
      '**/node_modules/node-pty/build/Release/spawn-helper',
      '**/node_modules/zeromq/build/darwin/${arch}/node/libc-115-Release/addon.node',
    ])
  })

  test('accepts the exact unpacked native fixture with complete architecture coverage', () => {
    const architectures = new Set(['arm64'])
    const directory = createUnpackedFixture(architectures)
    try {
      expect(() => assertUnpackedNativeLayout(directory, architectures, () => new Set(['arm64']))).not.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects missing and extra unpacked fixture files', () => {
    const architectures = new Set(['arm64'])
    const missingDirectory = createUnpackedFixture(architectures)
    const missingPath = join(missingDirectory, expectedUnpackedNativeFiles(architectures).at(-1)!)
    rmSync(missingPath)
    try {
      expect(() => assertUnpackedNativeLayout(missingDirectory, architectures, () => architectures)).toThrow(/Missing unpacked/)
    } finally {
      rmSync(missingDirectory, { recursive: true, force: true })
    }

    const extraDirectory = createUnpackedFixture(architectures)
    const extraPath = join(extraDirectory, 'node_modules/extra/native.node')
    mkdirSync(dirname(extraPath), { recursive: true })
    writeFileSync(extraPath, 'fixture')
    try {
      expect(() => assertUnpackedNativeLayout(extraDirectory, architectures, () => architectures)).toThrow(/Unexpected unpacked.*extra/)
    } finally {
      rmSync(extraDirectory, { recursive: true, force: true })
    }

    const extraPrefixDirectory = createUnpackedFixture(architectures)
    mkdirSync(join(extraPrefixDirectory, 'empty-prefix'))
    try {
      expect(() => assertUnpackedNativeLayout(extraPrefixDirectory, architectures, () => architectures)).toThrow(/Unexpected unpacked.*empty-prefix/)
    } finally {
      rmSync(extraPrefixDirectory, { recursive: true, force: true })
    }
  })

  test('checks every allowed native fixture file against the application architecture', () => {
    const architectures = new Set(['arm64'])
    const directory = createUnpackedFixture(architectures)
    try {
      expect(() => assertUnpackedNativeLayout(directory, architectures, (path) => (path.endsWith('addon.node') ? new Set(['x86_64']) : new Set(['arm64'])))).toThrow(
        /addon\.node is missing app architecture.*arm64/,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('release size budgets', () => {
  test('measures deterministic build-output fixtures', () => {
    const directory = createBundleSizeFixture()
    try {
      const metrics = collectBundleSizeMetrics(directory)
      expect(metrics).toEqual({
        mainBytes: 101,
        preloadBytes: 102,
        initialRendererBytes: 207,
        largestRendererChunkBytes: 106,
        rendererJsCssBytes: 418,
      })
      expect(() => assertBundleSizeBudgets(metrics)).not.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.each(Object.keys(BUNDLE_SIZE_BUDGETS))('rejects a %s bundle regression above its exact budget', (name) => {
    const metrics = { ...BUNDLE_SIZE_BUDGETS, [name]: BUNDLE_SIZE_BUDGETS[name as keyof typeof BUNDLE_SIZE_BUDGETS] + 1 }
    expect(() => assertBundleSizeBudgets(metrics)).toThrow(/exceeds its size budget/)
    expect(() => assertBundleSizeBudgets(BUNDLE_SIZE_BUDGETS)).not.toThrow()
  })

  test('measures deterministic package fixtures and enforces every artifact budget', () => {
    const directory = mkdtempSync(join(tmpdir(), 'prime-work-package-size-'))
    const paths = {
      app: join(directory, 'Prime Work.app'),
      asar: join(directory, 'Prime Work.app/Contents/Resources/app.asar'),
      dmg: join(directory, 'Prime Work.dmg'),
      zip: join(directory, 'Prime Work.zip'),
    }
    writeSizedFile(paths.asar, 201)
    writeSizedFile(join(paths.app, 'Contents/MacOS/Prime Work'), 202)
    writeSizedFile(paths.dmg, 203)
    writeSizedFile(paths.zip, 204)
    try {
      const metrics = collectPackageSizeMetrics(paths)
      expect(metrics).toEqual({ asarBytes: 201, appBytes: 403, dmgBytes: 203, zipBytes: 204 })
      expect(() => assertPackageSizeBudgets(metrics)).not.toThrow()
      for (const name of Object.keys(PACKAGE_SIZE_BUDGETS)) {
        expect(() =>
          assertPackageSizeBudgets({
            ...PACKAGE_SIZE_BUDGETS,
            [name]: PACKAGE_SIZE_BUDGETS[name as keyof typeof PACKAGE_SIZE_BUDGETS] + 1,
          }),
        ).toThrow(/exceeds its size budget/)
      }
      expect(() => assertPackageSizeBudgets(PACKAGE_SIZE_BUDGETS)).not.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
