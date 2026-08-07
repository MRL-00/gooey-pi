import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  artifactArchitectures,
  assertArchitectureCoverage,
  assertAsarLayout,
  assertExactArchitectures,
  assertSupportedNode,
  assertUnpackedNativeLayout,
  expectedUnpackedNativeFiles,
  parseArchitectures,
  parseTeamIdentifier,
  requireReleaseArtifacts,
  resolveCommandInvocation,
  validateReleaseCredentials,
  withoutReleaseCredentials,
} from '../scripts/release/lib.mjs'
import { assertBundleSizeBudgets, assertPackageSizeBudgets, BUNDLE_SIZE_BUDGETS, collectBundleSizeMetrics, collectPackageSizeMetrics, PACKAGE_SIZE_BUDGETS } from '../scripts/release/size-budgets.mjs'
// after-pack.cjs is CommonJS; the interop layer exposes module.exports properties as named exports.
import { executablePath } from '../scripts/release/after-pack.cjs'
import { expectedNativeFiles, nativeRuntimeDirectory, zeroMqAddonPattern } from '../scripts/release/verify-cross-platform-package.mjs'

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

  test('keeps contributor instructions aligned with the enforced engines', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(packageJson.engines).toEqual({ node: '>=22.12.0', npm: '>=10.9.0' })
    expect(readFileSync('.nvmrc', 'utf8').trim()).toBe('22.12.0')
    expect(readFileSync('README.md', 'utf8')).toContain('Node.js 22.12.0 or newer and npm 10.9.0 or newer')
    expect(readFileSync('AGENTS.md', 'utf8')).toContain('Node 22.12.0+, npm 10.9.0+')
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

  test('removes release credentials from untrusted verification commands', () => {
    const environment = { PATH: '/usr/bin', ...baseEnvironment, APPLE_API_KEY: '/tmp/private-key' }
    expect(withoutReleaseCredentials(environment)).toEqual({ PATH: '/usr/bin' })
    expect(withoutReleaseCredentials(environment, ['RELEASE_SIGNING_TEAM_ID'])).toEqual({
      PATH: '/usr/bin',
      RELEASE_SIGNING_TEAM_ID: 'TEAM123',
    })
  })

  test('pins actions and limits workflow secrets to release steps', () => {
    const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    for (const workflow of [releaseWorkflow, ciWorkflow]) {
      expect(workflow).not.toMatch(/uses: actions\/[^@\s]+@v\d/)
      expect(workflow).not.toMatch(/uses: actions\/[^@\s]+@(main|master)/)
    }
    expect(releaseWorkflow).not.toMatch(/^    env:/m)
    expect(releaseWorkflow.match(/secrets\./g)).toHaveLength(12)
    expect(releaseWorkflow.match(/^        env:$/gm)).toHaveLength(2)
  })

  test('gates packaging regressions on every pull request', () => {
    const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    expect(ciWorkflow).toMatch(/on:\n  push:\n    branches:\n      - main/)
    expect(ciWorkflow).toContain('cancel-in-progress: true')
    expect(ciWorkflow).toMatch(/packaging-smoke:\n    if: github\.event_name == 'pull_request'/)
    for (const runner of ['macos-14', 'ubuntu-22.04', 'windows-2022']) expect(ciWorkflow).toContain(`runner: ${runner}`)
    expect(ciWorkflow).toContain('electron-builder --dir')
    expect(ciWorkflow).toContain('verify-cross-platform-package.mjs --platform ${{ matrix.target }} --arch ${{ matrix.arch }} --unpacked-only')
  })
})

describe('fuse hardening configuration', () => {
  test('uses only the configured canonical afterPack hook', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(packageJson.build.afterPack).toBe('scripts/release/after-pack.cjs')
    expect(() => readFileSync('scripts/afterPack.cjs', 'utf8')).toThrow()
    expect(readFileSync(packageJson.build.afterPack, 'utf8')).toContain('FuseV1Options.OnlyLoadAppFromAsar')
  })
})

describe('coverage configuration', () => {
  test('includes every extracted plugin module without weakening thresholds', () => {
    const config = readFileSync('vitest.config.ts', 'utf8')
    expect(config).toContain("'electron/main/plugins/**/*.ts'")
    expect(config).toContain('statements: 65')
    expect(config).toContain('branches: 50')
    expect(config).toContain('functions: 70')
    expect(config).toContain('lines: 75')
  })
})

describe('post-package verification helpers', () => {
  test('parses Team IDs and architecture lists', () => {
    expect(parseTeamIdentifier('Authority=Developer ID\nTeamIdentifier=TEAM123\n')).toBe('TEAM123')
    expect(parseArchitectures('arm64 x86_64\n')).toEqual(new Set(['arm64', 'x86_64']))
  })

  test('requires exactly one DMG and ZIP and binds their declared architecture', () => {
    expect(requireReleaseArtifacts(['/release/Prime Work-0.1.0-arm64.dmg', '/release/Prime Work-0.1.0-arm64.zip'])).toEqual({
      dmg: '/release/Prime Work-0.1.0-arm64.dmg',
      zip: '/release/Prime Work-0.1.0-arm64.zip',
    })
    expect(() => requireReleaseArtifacts(['/release/Prime Work-0.1.0-arm64.dmg'])).toThrow(/ZIP/)
    expect(artifactArchitectures('Prime Work-0.1.0-universal.zip')).toEqual(new Set(['arm64', 'x86_64']))
    expect(() => assertExactArchitectures(new Set(['arm64']), artifactArchitectures('Prime Work-0.1.0-arm64.dmg'), 'DMG')).not.toThrow()
    expect(() => assertExactArchitectures(new Set(['x86_64']), artifactArchitectures('Prime Work-0.1.0-arm64.dmg'), 'DMG')).toThrow(/do not match/)
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

  test('keeps every platform native unpack allowlist exact and architecture-specific', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageJson.build.asarUnpack).toBeUndefined()
    expect(packageJson.build.mac.asarUnpack).toEqual([
      '**/node_modules/node-pty/build/Release/pty.node',
      '**/node_modules/node-pty/build/Release/spawn-helper',
      '**/node_modules/zeromq/build/darwin/${arch}/node/libc-115-Release/addon.node',
    ])
    expect(packageJson.build.linux.asarUnpack).toEqual(['**/node_modules/node-pty/build/Release/pty.node', '**/node_modules/zeromq/build/linux/${arch}/node/**/addon.node'])
    expect(packageJson.build.win.asarUnpack).toEqual([
      '**/node_modules/node-pty/prebuilds/win32-${arch}/pty.node',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/conpty.node',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/conpty_console_list.node',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/winpty-agent.exe',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/winpty.dll',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/conpty/OpenConsole.exe',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/conpty/conpty.dll',
      '**/node_modules/zeromq/build/win32/${arch}/node/**/addon.node',
    ])
    expect(packageJson.build.linux.target).toEqual(['AppImage', 'deb', 'rpm'])
    expect(packageJson.build.win.target).toEqual(['nsis', 'zip'])
    expect(packageJson.build.directories.output).toBe('release')
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

describe('cross-platform packaging repair', () => {
  const fixtureContext = {
    appOutDir: join('/tmp', 'app-out'),
    packager: { appInfo: { productFilename: 'Prime Work', sanitizedName: 'Prime-Work' } },
  }

  test('computes the hardened executable path per platform', () => {
    expect(executablePath(fixtureContext, 'darwin')).toBe(join('/tmp', 'app-out', 'Prime Work.app', 'Contents', 'MacOS', 'Prime Work'))
    expect(executablePath(fixtureContext, 'win32')).toBe(join('/tmp', 'app-out', 'Prime Work.exe'))
    expect(executablePath(fixtureContext, 'linux')).toBe(join('/tmp', 'app-out', 'prime-work'))
  })

  function globMatchExists(directory: string, segments: string[]): boolean {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return false
    const [head, ...rest] = segments
    if (head === undefined) return false
    if (head === '**') {
      if (globMatchExists(directory, rest)) return true
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .some((entry) => globMatchExists(join(directory, entry.name), segments))
    }
    const next = join(directory, head)
    if (rest.length === 0) return existsSync(next) && statSync(next).isFile()
    return globMatchExists(next, rest)
  }

  test('every asarUnpack glob matches at least one real file for platforms present in node_modules', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const root = new URL('..', import.meta.url).pathname
    const localArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64'
    const architecturesFor = (glob: string) => (glob.includes('node-pty/build/Release') ? [localArchitecture] : ['arm64', 'x64'])
    for (const target of ['mac', 'linux', 'win']) {
      for (const glob of packageJson.build[target].asarUnpack as string[]) {
        const covered = architecturesFor(glob).some((architecture) => {
          const relativeGlob = glob.replace(/^\*\*\//, '').replaceAll('${arch}', architecture)
          const platformRoot = relativeGlob.split('/').slice(0, 4).join('/')
          if (!existsSync(join(root, platformRoot))) return false
          return globMatchExists(root, relativeGlob.split('/'))
        })
        expect(covered, `asarUnpack glob matches no file in node_modules: ${glob}`).toBe(true)
      }
    }
  })

  test('the verifier and package.json agree on native directory naming', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    for (const [target, architecture] of [
      ['win', 'x64'],
      ['win', 'arm64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
    ] as const) {
      const globs = (packageJson.build[target].asarUnpack as string[]).map((glob) => glob.replace(/^\*\*\//, '').replaceAll('${arch}', architecture))
      for (const file of expectedNativeFiles(target, architecture)) {
        expect(globs, `verifier requires ${file} but no ${target} asarUnpack glob produces it`).toContain(file)
      }
      const zeroMqGlob = globs.find((glob) => glob.includes('zeromq'))
      expect(zeroMqGlob).toBe(`node_modules/zeromq/build/${nativeRuntimeDirectory(target)}/${architecture}/node/**/addon.node`)
      const sampleAddon = `node_modules/zeromq/build/${nativeRuntimeDirectory(target)}/${architecture}/node/glibc-x64-115-Release/addon.node`
      expect(zeroMqAddonPattern(target, architecture).test(sampleAddon)).toBe(true)
    }
    expect(nativeRuntimeDirectory('win')).toBe('win32')
    expect(nativeRuntimeDirectory('linux')).toBe('linux')
  })

  test('resolves release-script commands to Windows-safe spawns', () => {
    expect(resolveCommandInvocation('node', ['scripts/release/verify.mjs'])).toEqual({ file: process.execPath, args: ['scripts/release/verify.mjs'], shell: false })
    const builder = resolveCommandInvocation('electron-builder', ['install-app-deps'])
    expect(builder.file).toBe(process.execPath)
    expect(builder.shell).toBe(false)
    expect(builder.args[0]).toMatch(/electron-builder[\\/]cli\.js$/)
    expect(builder.args.at(-1)).toBe('install-app-deps')
    const npmViaLifecycle = resolveCommandInvocation('npm', ['run', 'release:verify'], 'win32', { npm_execpath: 'C:/npm/npm-cli.js' })
    expect(npmViaLifecycle).toEqual({ file: process.execPath, args: ['C:/npm/npm-cli.js', 'run', 'release:verify'], shell: false })
    expect(resolveCommandInvocation('npm', ['ci'], 'win32', {})).toEqual({ file: 'npm.cmd', args: ['ci'], shell: true })
    expect(resolveCommandInvocation('npm', ['ci'], 'darwin', {})).toEqual({ file: 'npm', args: ['ci'], shell: false })
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
