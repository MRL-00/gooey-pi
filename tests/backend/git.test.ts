import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../../electron/main/git'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

describe('GitService', () => {
  it('reports, diffs, stages, unstages, restores, and commits through argv-only commands', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-git-')); dirs.push(cwd)
    git(cwd, 'init', '-q'); git(cwd, 'config', 'user.name', 'Prime Work Test'); git(cwd, 'config', 'user.email', 'test@example.com')
    writeFileSync(join(cwd, 'file.txt'), 'base\n'); git(cwd, 'add', 'file.txt'); git(cwd, 'commit', '-qm', 'base')
    const service = new GitService(async () => cwd)

    writeFileSync(join(cwd, 'file.txt'), 'base\nchanged\n')
    let status = await service.status(cwd)
    expect(status.isRepo).toBe(true)
    expect(status.files.find((file) => file.path === 'file.txt')?.staged).toBe(false)
    expect((await service.diff(cwd, 'file.txt', false)).text).toContain('+changed')

    expect(await service.stage(cwd, ['file.txt'])).toBe(true)
    status = await service.status(cwd)
    expect(status.files.find((file) => file.path === 'file.txt')?.staged).toBe(true)
    expect(await service.unstage(cwd, ['file.txt'])).toBe(true)
    expect(await service.restore(cwd, ['file.txt'])).toBe(true)
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('base\n')

    writeFileSync(join(cwd, 'file.txt'), 'base\ncommitted\n')
    await service.stage(cwd, ['file.txt'])
    const committed = await service.commit(cwd, 'test commit')
    expect(committed.ok).toBe(true)
    expect(committed.output).toContain('test commit')
  }, 15_000)

  it('identifies a detached HEAD as a repository branch label', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-git-detached-')); dirs.push(cwd)
    git(cwd, 'init', '-q'); git(cwd, 'config', 'user.name', 'Prime Work Test'); git(cwd, 'config', 'user.email', 'test@example.com')
    writeFileSync(join(cwd, 'file.txt'), 'base\n'); git(cwd, 'add', 'file.txt'); git(cwd, 'commit', '-qm', 'base'); git(cwd, 'checkout', '-q', '--detach')
    const service = new GitService(async () => cwd)

    expect(await service.branch(cwd)).toMatch(/^HEAD \([0-9a-f]+\)$/)
    expect((await service.status(cwd)).isRepo).toBe(true)
  })

})
