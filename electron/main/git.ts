import type { GitDiff, GitFileChange, GitStatus } from '../../src/types/api'
import { runProcess } from './process-utils'
import { errorMessage, requireGitPath, requireString, stripAnsi } from './validation'

interface Numstat { additions: number; deletions: number }

function parseNumstat(output: string): Map<string, Numstat> {
  const fields = output.split('\0')
  const result = new Map<string, Numstat>()
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    if (!field) continue
    const firstTab = field.indexOf('\t')
    const secondTab = field.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additions = Number.parseInt(field.slice(0, firstTab), 10)
    const deletions = Number.parseInt(field.slice(firstTab + 1, secondTab), 10)
    let path = field.slice(secondTab + 1)
    if (!path) {
      // With -z, renames are: numstat header, old path, new path.
      index += 2
      path = fields[index] ?? fields[index - 1] ?? ''
    }
    if (path) result.set(path, { additions: Number.isFinite(additions) ? additions : 0, deletions: Number.isFinite(deletions) ? deletions : 0 })
  }
  return result
}

function parseBranch(header: string, status: GitStatus): void {
  let value = header.slice(3)
  if (value.startsWith('No commits yet on ')) value = value.slice('No commits yet on '.length)
  if (value.startsWith('Initial commit on ')) value = value.slice('Initial commit on '.length)
  const detailIndex = value.indexOf(' [')
  const details = detailIndex >= 0 ? value.slice(detailIndex + 2, -1) : ''
  const name = detailIndex >= 0 ? value.slice(0, detailIndex) : value
  const upstreamIndex = name.indexOf('...')
  status.branch = upstreamIndex >= 0 ? name.slice(0, upstreamIndex) : name
  if (upstreamIndex >= 0) status.upstream = name.slice(upstreamIndex + 3)
  const ahead = details.match(/ahead (\d+)/)
  const behind = details.match(/behind (\d+)/)
  if (ahead) status.ahead = Number(ahead[1])
  if (behind) status.behind = Number(behind[1])
}

export class GitService {
  constructor(private readonly authorizeCwd: (cwd: string) => Promise<string>) {}

  async branch(cwd: string): Promise<string | undefined> {
    try {
      const safeCwd = await this.authorizeCwd(cwd)
      const result = await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: safeCwd, timeoutMs: 5_000, maxBytes: 64 * 1024 })
      if (result.code === 0) return result.stdout.trim() || undefined
      const detached = await runProcess('git', ['rev-parse', '--verify', '--short', 'HEAD'], { cwd: safeCwd, timeoutMs: 5_000, maxBytes: 64 * 1024 })
      return detached.code === 0 ? `HEAD (${detached.stdout.trim()})` : undefined
    } catch { return undefined }
  }

  async status(cwdValue: unknown): Promise<GitStatus> {
    try {
      const cwd = await this.authorizeCwd(requireString(cwdValue, 'cwd', { min: 1, max: 4096 }))
      const [statusResult, unstagedResult, stagedResult] = await Promise.all([
        runProcess('git', ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '-z'], { cwd, timeoutMs: 15_000 }),
        runProcess('git', ['diff', '--numstat', '-z'], { cwd, timeoutMs: 15_000 }),
        runProcess('git', ['diff', '--cached', '--numstat', '-z'], { cwd, timeoutMs: 15_000 }),
      ])
      if (statusResult.code !== 0) return { isRepo: false, files: [], error: stripAnsi(statusResult.stderr || statusResult.stdout).trim().slice(0, 2_000) || 'Not a Git repository' }
      const status: GitStatus = { isRepo: true, files: [] }
      const unstaged = parseNumstat(unstagedResult.stdout)
      const staged = parseNumstat(stagedResult.stdout)
      const records = statusResult.stdout.split('\0')
      for (let index = 0; index < records.length; index++) {
        const record = records[index]
        if (!record) continue
        if (record.startsWith('## ')) { parseBranch(record, status); continue }
        if (record.length < 4) continue
        const code = record.slice(0, 2)
        const path = record.slice(3)
        if (!path) continue
        const stagedChange = code[0] !== ' ' && code[0] !== '?'
        const stats = (stagedChange ? staged : unstaged).get(path) ?? { additions: 0, deletions: 0 }
        const change: GitFileChange = { path, status: code.trim() || code, staged: stagedChange, ...stats }
        status.files.push(change)
        if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') index++
      }
      return status
    } catch (error) {
      return { isRepo: false, files: [], error: errorMessage(error).slice(0, 2_000) }
    }
  }

  async diff(cwdValue: unknown, pathValue?: unknown, stagedValue?: unknown): Promise<GitDiff> {
    const cwd = await this.authorizeCwd(requireString(cwdValue, 'cwd', { min: 1, max: 4096 }))
    const path = pathValue === undefined ? undefined : requireGitPath(pathValue)
    if (stagedValue !== undefined && typeof stagedValue !== 'boolean') throw new TypeError('staged must be a boolean')
    const staged = stagedValue === true
    const args = ['diff', '--no-ext-diff', '--no-color']
    if (staged) args.push('--cached')
    if (path) args.push('--', path)
    const result = await runProcess('git', args, { cwd, timeoutMs: 30_000, maxBytes: 24 * 1024 * 1024 })
    const text = result.code === 0 ? result.stdout : stripAnsi(result.stderr || result.stdout)
    return { path, staged, text }
  }

  async stage(cwd: unknown, paths: unknown): Promise<boolean> {
    return this.mutate(cwd, paths, ['add'])
  }

  async unstage(cwdValue: unknown, pathsValue: unknown): Promise<boolean> {
    const cwd = await this.validCwd(cwdValue)
    const paths = this.validPaths(pathsValue)
    let result = await runProcess('git', ['restore', '--staged', '--', ...paths], { cwd, timeoutMs: 30_000 })
    if (result.code !== 0) result = await runProcess('git', ['reset', '--quiet', '--', ...paths], { cwd, timeoutMs: 30_000 })
    return result.code === 0
  }

  async restore(cwd: unknown, paths: unknown): Promise<boolean> {
    return this.mutate(cwd, paths, ['restore', '--worktree'])
  }

  async commit(cwdValue: unknown, messageValue: unknown): Promise<{ ok: boolean; output: string }> {
    const cwd = await this.validCwd(cwdValue)
    const message = requireString(messageValue, 'commit message', { min: 1, max: 20_000, trim: true })
    const result = await runProcess('git', ['commit', '-m', message], { cwd, timeoutMs: 2 * 60_000, maxBytes: 4 * 1024 * 1024 })
    return { ok: result.code === 0, output: stripAnsi(`${result.stdout}${result.stderr}`).trim() }
  }

  private async validCwd(value: unknown): Promise<string> {
    return this.authorizeCwd(requireString(value, 'cwd', { min: 1, max: 4096 }))
  }

  private validPaths(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new TypeError('paths must be a non-empty array of at most 500 paths')
    return value.map((path, index) => requireGitPath(path, `paths[${index}]`))
  }

  private async mutate(cwdValue: unknown, pathsValue: unknown, command: string[]): Promise<boolean> {
    const cwd = await this.validCwd(cwdValue)
    const paths = this.validPaths(pathsValue)
    const result = await runProcess('git', [...command, '--', ...paths], { cwd, timeoutMs: 30_000 })
    return result.code === 0
  }
}
