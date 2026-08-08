import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validatePackageSource } from '../../electron/main/plugins/package-execution'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('validatePackageSource', () => {
  it('accepts well-formed npm, git, and URL sources', () => {
    expect(validatePackageSource('npm:example-package')).toBe('npm:example-package')
    expect(validatePackageSource('npm:@scope/pkg@1.2.3')).toBe('npm:@scope/pkg@1.2.3')
    expect(validatePackageSource('git:github.com/owner/repo')).toBe('git:github.com/owner/repo')
    expect(validatePackageSource('git:git@github.com:owner/repo')).toBe('git:git@github.com:owner/repo')
    expect(validatePackageSource('git:https://github.com/owner/repo.git')).toBe('git:https://github.com/owner/repo.git')
    expect(validatePackageSource('https://example.test/pkg.tgz')).toBe('https://example.test/pkg.tgz')
  })

  it('rejects argv injection via a leading dash or embedded newlines', () => {
    expect(() => validatePackageSource('--registry=https://evil.test')).toThrow(/Invalid package source/)
    expect(() => validatePackageSource('-rf')).toThrow(/Invalid package source/)
    expect(() => validatePackageSource('npm:pkg\n--evil')).toThrow(/Invalid package source/)
    expect(() => validatePackageSource('npm:pkg\r--evil')).toThrow(/Invalid package source/)
    expect(() => validatePackageSource('npm:pkg x')).toThrow(/Invalid package source/)
  })

  it('rejects credentialed URLs and malformed specs', () => {
    expect(() => validatePackageSource('https://user:pass@evil.test/pkg.tgz')).toThrow(/credentials/)
    expect(() => validatePackageSource('git:https://user:pass@evil.test/repo')).toThrow(/credentials/)
    expect(() => validatePackageSource('npm:UPPER CASE')).toThrow(/Invalid npm package source/)
    expect(() => validatePackageSource('npm:../escape')).toThrow(/Invalid npm package source/)
    expect(() => validatePackageSource('git:;rm -rf /')).toThrow(/Invalid git package source/)
    expect(() => validatePackageSource('relative/path')).toThrow(/must be npm:/)
    expect(() => validatePackageSource('')).toThrow(/too short/)
  })

  it('resolves existing absolute paths and rejects missing ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-package-'))
    dirs.push(dir)
    expect(validatePackageSource(dir)).toBe(realpathSync(dir))
    expect(() => validatePackageSource(join(dir, 'missing'))).toThrow(/does not exist/)
  })
})
