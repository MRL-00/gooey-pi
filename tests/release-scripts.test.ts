import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  artifactArchitectures,
  assertArchitectureCoverage,
  assertAsarLayout,
  assertExactArchitectures,
  assertSupportedNode,
  assertUnpackedNativeLayout,
  expectedUnpackedNativeLayout,
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

const FIXTURE_ZEROMQ_DIRECTORIES = new Map([
  ['arm64', 'arm64'],
  ['x86_64', 'x64'],
])

function fixtureAddonPath(architecture: string, runtime = 'libc-115-Release') {
  return `node_modules/zeromq/build/darwin/${FIXTURE_ZEROMQ_DIRECTORIES.get(architecture)}/node/${runtime}/addon.node`
}

function createUnpackedFixture(architectures = new Set(['arm64'])) {
  const directory = mkdtempSync(join(tmpdir(), 'prime-work-unpacked-'))
  const relativePaths = [...expectedUnpackedNativeLayout(architectures).files, ...[...architectures].map((architecture) => fixtureAddonPath(architecture))]
  for (const relativePath of relativePaths) {
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
  test('package.mjs --dry-run says nothing executed instead of claiming success', () => {
    const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
    const result = spawnSync(process.execPath, ['scripts/release/package.mjs', '--qa', '--platform', platform, '--dry-run'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DRY RUN — nothing executed.')
    expect(result.stdout).not.toContain('pipeline passed')
  })

  test('verify-package runs when invoked as a script and fails closed on a missing entrypoint', async () => {
    const { invokedAsScript } = await import('../scripts/release/verify-package.mjs')
    const original = process.argv[1]
    try {
      process.argv[1] = fileURLToPath(new URL('../scripts/release/verify-package.mjs', import.meta.url))
      expect(invokedAsScript()).toBe(true)
      process.argv[1] = join(tmpdir(), 'another-entrypoint.mjs')
      expect(invokedAsScript()).toBe(false)
      process.argv[1] = undefined as unknown as string
      expect(invokedAsScript()).toBe(true)
    } finally {
      process.argv[1] = original
    }
  })

  test('binds the requested target architecture to the produced mac artifacts', async () => {
    const { assertRequestedArchitecture } = await import('../scripts/release/verify-package.mjs')
    const artifacts = { dmg: 'release/mac/arm64/Prime Work-1.0.0-arm64.dmg', zip: 'release/mac/arm64/Prime Work-1.0.0-arm64.zip' }
    expect(() => assertRequestedArchitecture(artifacts, 'arm64')).not.toThrow()
    expect(() => assertRequestedArchitecture(artifacts, undefined)).not.toThrow()
    expect(() => assertRequestedArchitecture(artifacts, 'x64')).toThrow(/declares architecture arm64, but --arch x64 was requested/)
    expect(() => assertRequestedArchitecture({ ...artifacts, zip: 'release/mac/x64/Prime Work-1.0.0-x64.zip' }, 'arm64')).toThrow(/declares architecture x64/)
    expect(() => assertRequestedArchitecture(artifacts, 'universal')).toThrow(/must be arm64 or x64/)
    expect(() => assertRequestedArchitecture(artifacts, '')).toThrow(/must be arm64 or x64/)
    // package.mjs forwards the authoritative arch into mac post-package verification.
    expect(readFileSync('scripts/release/package.mjs', 'utf8')).toContain("'--arch', arch, '--release-directory'")
  })

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

  interface WorkflowStep {
    job: string
    name: string | undefined
    uses: string | undefined
    secretLines: string[]
    lines: string[]
  }

  /** Minimal structural read of a GitHub workflow: jobs and their step blocks. */
  function parseWorkflowSteps(source: string): WorkflowStep[] {
    const steps: WorkflowStep[] = []
    let job = ''
    let inJobs = false
    let current: WorkflowStep | undefined
    for (const line of source.split('\n')) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true
        continue
      }
      if (!inJobs) continue
      const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
      if (jobMatch) {
        job = jobMatch[1]
        current = undefined
        continue
      }
      if (/^ {6}- /.test(line)) {
        current = { job, name: undefined, uses: undefined, secretLines: [], lines: [] }
        steps.push(current)
      }
      if (!current) continue
      current.lines.push(line)
      const name = line.match(/^\s*(?:- )?name:\s*(.+?)\s*$/)
      if (name && current.name === undefined) current.name = name[1]
      const uses = line.match(/^\s*(?:- )?uses:\s*(\S+)/)
      if (uses && current.uses === undefined) current.uses = uses[1]
      if (line.includes('secrets.')) current.secretLines.push(line)
    }
    return steps
  }

  test('pins every workflow action, including third-party owners, to a full commit SHA', () => {
    for (const path of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) {
      const steps = parseWorkflowSteps(readFileSync(path, 'utf8'))
      expect(steps.length).toBeGreaterThan(0)
      for (const step of steps) {
        if (step.uses === undefined) continue
        // Every `uses:` reference must be `owner/repo[/path]@<40-hex sha>`,
        // regardless of owner - tags and branches are movable for actions/*
        // and third-party owners alike.
        expect(step.uses, `${path} ${step.job}: ${step.uses}`).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/)
      }
    }
  })

  test('confines workflow secrets to the signing and notarization release steps', () => {
    const releaseSteps = parseWorkflowSteps(readFileSync('.github/workflows/release.yml', 'utf8'))
    const secretSteps = releaseSteps.filter((step) => step.secretLines.length > 0)
    expect(secretSteps.map((step) => `${step.job}: ${step.name}`).sort()).toEqual([
      'package: Build, sign, notarize, and verify release packages',
      'package: Fail closed unless every release credential is configured',
    ])
    for (const step of secretSteps) {
      // Secrets may only be consumed as env-var assignments inside the step's
      // env block - never interpolated into run commands or action inputs.
      expect(step.lines.some((line) => /^\s*env:\s*$/.test(line))).toBe(true)
      for (const line of step.secretLines) {
        expect(line).toMatch(/^\s+[A-Z][A-Z0-9_]*: \$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}$/)
      }
      expect(step.lines.join('\n')).not.toMatch(/run:.*secrets\./)
    }

    const ciSteps = parseWorkflowSteps(readFileSync('.github/workflows/ci.yml', 'utf8'))
    expect(ciSteps.filter((step) => step.secretLines.length > 0)).toEqual([])
  })

  test('gates packaging regressions on every pull request', () => {
    const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    expect(ciWorkflow).toMatch(/on:\n {2}push:\n {4}branches:\n {6}- main/)
    expect(ciWorkflow).toContain('cancel-in-progress: true')
    expect(ciWorkflow).toMatch(/packaging-smoke:\n {4}if: github\.event_name == 'pull_request'/)
    for (const runner of ['macos-14', 'ubuntu-22.04', 'windows-2022']) expect(ciWorkflow).toContain(`runner: ${runner}`)
    expect(ciWorkflow).toContain('electron-builder --dir')
    expect(ciWorkflow).toContain('verify-cross-platform-package.mjs --platform ${{ matrix.target }} --arch ${{ matrix.arch }} --unpacked-only')
  })

  test('reads the Node version from .nvmrc and hard-fails empty artifact uploads', () => {
    const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    for (const workflow of [releaseWorkflow, ciWorkflow]) {
      expect(workflow).not.toMatch(/node-version:/)
      expect(workflow.match(/node-version-file: \.nvmrc/g)?.length).toBeGreaterThan(0)
      const uploads = workflow.match(/uses: actions\/upload-artifact@/g) ?? []
      expect(workflow.match(/if-no-files-found: error/g)).toHaveLength(uploads.length)
      expect(workflow).toContain('actions/cache@')
    }
    // Release jobs skip the CI-duplicated verification suite and never upload
    // an unpacked application directory; every platform publishes its update feed.
    expect(releaseWorkflow.match(/-- --skip-verify/g)).toHaveLength(3)
    expect(releaseWorkflow).toContain('release/mac/${{ matrix.arch }}/latest*.yml')
    expect(releaseWorkflow).toContain('release/linux/**/latest*.yml')
    expect(releaseWorkflow).toContain('release/win/**/latest*.yml')
    expect(releaseWorkflow).toMatch(/needs: \[package, package-linux, package-windows\]/)
    expect(ciWorkflow).not.toMatch(/path: release\/(mac|linux|win)\/\s*$/m)
  })

  test('ships both mac architectures as separate builds from native-arch runners', () => {
    const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')
    // Two matrix legs, each on a runner whose native architecture matches the
    // target (arm64 on macos-14, x64 on macos-13) so node-pty/zeromq never
    // cross-compile, and one leg's failure never cancels the other's build.
    expect(releaseWorkflow).toContain('fail-fast: false')
    expect(releaseWorkflow).toMatch(/- arch: arm64\n {12}runner: macos-14/)
    expect(releaseWorkflow).toMatch(/- arch: x64\n {12}runner: macos-13/)
    expect(releaseWorkflow).toContain('runs-on: ${{ matrix.runner }}')
    // The explicit target arch drives packaging, and each leg uploads only its
    // own arch directory under a per-arch artifact name and cache key.
    expect(releaseWorkflow).toContain('npm run package:mac -- --skip-verify --arch ${{ matrix.arch }}')
    expect(releaseWorkflow).toContain('name: prime-work-public-macos-${{ matrix.arch }}')
    expect(releaseWorkflow).toContain('release/mac/${{ matrix.arch }}/*.dmg')
    expect(releaseWorkflow).toContain('release/mac/${{ matrix.arch }}/*.zip')
    expect(releaseWorkflow).toContain('electron-${{ runner.os }}-${{ matrix.arch }}-${{ hashFiles(')
    // Universal binaries are excluded by design: the release ships two builds.
    expect(releaseWorkflow).not.toContain('--universal')
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
      '**/node_modules/zeromq/build/darwin/${arch}/node/*-Release/addon.node',
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

  test('excludes other platform ZeroMQ build trees and declares zeromq directly', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageJson.build.mac.files).toEqual(['!**/node_modules/zeromq/build/linux/**', '!**/node_modules/zeromq/build/win32/**'])
    expect(packageJson.build.linux.files).toEqual(['!**/node_modules/zeromq/build/darwin/**', '!**/node_modules/zeromq/build/win32/**'])
    expect(packageJson.build.win.files).toEqual(['!**/node_modules/zeromq/build/darwin/**', '!**/node_modules/zeromq/build/linux/**'])
    // Pin the app to the zeromq range prime-agent uses so the packaged addon
    // and the agent's runtime expectations cannot drift apart silently.
    const primeAgent = JSON.parse(readFileSync(new URL('../node_modules/prime-agent/package.json', import.meta.url), 'utf8'))
    expect(packageJson.dependencies.zeromq).toBe(primeAgent.dependencies.zeromq)
  })

  test('requires exactly one ZeroMQ addon per architecture regardless of runtime-library name', () => {
    const architectures = new Set(['arm64'])
    const duplicatedDirectory = createUnpackedFixture(architectures)
    const duplicate = join(duplicatedDirectory, fixtureAddonPath('arm64', 'libc-999-Release'))
    mkdirSync(dirname(duplicate), { recursive: true })
    writeFileSync(duplicate, 'fixture')
    try {
      // Two runtime-library directories for one architecture must fail.
      expect(() => assertUnpackedNativeLayout(duplicatedDirectory, architectures, () => architectures)).toThrow(/exactly one.*ZeroMQ/i)
    } finally {
      rmSync(duplicatedDirectory, { recursive: true, force: true })
    }

    const futureDirectory = mkdtempSync(join(tmpdir(), 'prime-work-unpacked-'))
    for (const relativePath of [...expectedUnpackedNativeLayout(architectures).files, fixtureAddonPath('arm64', 'libc-999-Release')]) {
      const path = join(futureDirectory, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'fixture')
    }
    try {
      // A future runtime-library name still matches the wildcard exactly once.
      expect(() => assertUnpackedNativeLayout(futureDirectory, architectures, () => architectures)).not.toThrow()
    } finally {
      rmSync(futureDirectory, { recursive: true, force: true })
    }
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
    rmSync(join(missingDirectory, expectedUnpackedNativeLayout(architectures).files.at(-1)!))
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
      expect(() => assertUnpackedNativeLayout(directory, architectures, (path: string) => (path.endsWith('addon.node') ? new Set(['x86_64']) : new Set(['arm64'])))).toThrow(
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
    if (head.includes('*')) {
      const pattern = new RegExp(
        `^${head
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*')}$`,
      )
      const entries = readdirSync(directory, { withFileTypes: true })
      if (rest.length === 0) return entries.some((entry) => entry.isFile() && pattern.test(entry.name))
      return entries.filter((entry) => entry.isDirectory() && pattern.test(entry.name)).some((entry) => globMatchExists(join(directory, entry.name), rest))
    }
    const next = join(directory, head)
    if (rest.length === 0) return existsSync(next) && statSync(next).isFile()
    return globMatchExists(next, rest)
  }

  test('every asarUnpack glob matches at least one real file for platforms present in node_modules', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const root = new URL('..', import.meta.url).pathname
    const localArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64'
    const localTarget = process.platform === 'darwin' ? 'mac' : process.platform
    const architecturesFor = (glob: string) => (glob.includes('node-pty/build/Release') ? [localArchitecture] : ['arm64', 'x64'])
    for (const target of ['mac', 'linux', 'win']) {
      for (const glob of packageJson.build[target].asarUnpack as string[]) {
        if (glob.includes('node-pty/build/Release') && target !== localTarget) continue
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

describe('DMG verification cleanup', () => {
  test('detach failures are logged instead of masking the original error and cleanup always runs', () => {
    const source = readFileSync('scripts/release/verify-package.mjs', 'utf8')
    const verifyDmg = source.slice(source.indexOf('async function verifyDmg'), source.indexOf('export async function verifyPackage'))
    // hdiutil detach runs inside its own try/catch that only logs.
    expect(verifyDmg).toMatch(/try\s*\{\s*run\('hdiutil', \['detach', mountPoint\]\)\s*\}\s*catch \(detachError\)\s*\{\s*console\.error/)
    // The rmSync cleanup is attempted unconditionally after the detach attempt.
    const finallyIndex = verifyDmg.indexOf('} finally {')
    const cleanupIndex = verifyDmg.indexOf('rmSync(mountPoint, { recursive: true, force: true })')
    expect(finallyIndex).toBeGreaterThan(-1)
    expect(cleanupIndex).toBeGreaterThan(finallyIndex)
    expect(verifyDmg.slice(cleanupIndex)).not.toContain('detach')
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

describe('non-registry dependency pins', () => {
  test('every non-registry dependency in the lockfile matches its recorded pin exactly', () => {
    const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8'))
    const pins = JSON.parse(readFileSync('scripts/release/dependency-pins.json', 'utf8')).packages
    const nonRegistry = (Object.entries(lockfile.packages ?? {}) as Array<[string, { resolved?: string; integrity?: string }]>).filter(
      ([, entry]) => typeof entry.resolved === 'string' && entry.resolved.length > 0 && !entry.resolved.startsWith('https://registry.npmjs.org'),
    )

    // The lockfile sha512 hashes are the supply-chain integrity boundary for
    // the vendored Prime Agent tarballs. A regenerated lockfile silently
    // re-anchors them to whatever bytes are present; this pin file makes that
    // a deliberate, reviewed change. To upgrade Prime Agent on purpose:
    // verify the new tarballs, replace them in vendor/, update the lockfile,
    // then mirror the new resolved/integrity values here in the same commit.
    expect(nonRegistry.length).toBeGreaterThan(0)
    for (const [name, entry] of nonRegistry) {
      const pin = pins[name]
      expect(pin, `unpinned non-registry dependency: ${name}`).toBeDefined()
      expect(entry.resolved, `resolved location drifted for ${name}`).toBe(pin.resolved)
      expect(entry.integrity, `integrity drifted for ${name}`).toBe(pin.integrity)
      expect(entry.integrity, `weak integrity algorithm for ${name}`).toMatch(/^sha512-/)
    }
    for (const name of Object.keys(pins)) {
      expect(
        nonRegistry.some(([lockName]) => lockName === name),
        `stale pin for removed dependency: ${name}`,
      ).toBe(true)
    }
  })

  test('the vendored tarballs on disk hash to their pinned integrity', () => {
    const pins = JSON.parse(readFileSync('scripts/release/dependency-pins.json', 'utf8')).packages as Record<string, { resolved: string; integrity: string }>
    const vendored = [
      ...new Set(
        Object.values(pins)
          .filter((pin) => pin.resolved.startsWith('file:vendor/'))
          .map((pin) => ({ path: pin.resolved.slice('file:'.length), integrity: pin.integrity }))
          .map((entry) => JSON.stringify(entry)),
      ),
    ].map((entry) => JSON.parse(entry) as { path: string; integrity: string })

    expect(vendored.length).toBeGreaterThan(0)
    for (const { path, integrity } of vendored) {
      const digest = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
      expect(digest, `vendored tarball bytes drifted from pin: ${path}`).toBe(integrity)
    }
  })
})
