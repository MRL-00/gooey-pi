import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ProcessOutcome } from '../../../src/types/api'
import { processOutcome, runProcess } from '../process-utils'
import { requireString, stripAnsi } from '../validation'

export function validatePackageSource(value: unknown, options: { allowOmpMarketplaceTarget?: boolean } = {}): string {
  const source = requireString(value, 'package source', { min: 1, max: 2_048, trim: true })
  if (source.startsWith('-') || /[\r\n\u2028\u2029]/.test(source)) throw new TypeError('Invalid package source')
  if (options.allowOmpMarketplaceTarget && /^[a-z0-9][a-z0-9.-]{0,63}@[a-z0-9][a-z0-9.-]{0,63}$/i.test(source)) return source
  if (source.startsWith('npm:')) {
    if (!/^npm:(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:@[^\s]+)?$/i.test(source)) throw new TypeError('Invalid npm package source')
    return source
  }
  if (source.startsWith('git:')) {
    const spec = source.slice(4)
    const protocolUrl = /^(?:https?|ssh|git):\/\//i.test(spec)
    const sshShorthand = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+(?:@[A-Za-z0-9._/-]+)?$/.test(spec)
    const hostShorthand = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._~/-]+(?:@[A-Za-z0-9._/-]+)?$/.test(spec)
    if (!protocolUrl && !sshShorthand && !hostShorthand) throw new TypeError('Invalid git package source')
    if (protocolUrl) {
      try {
        const url = new URL(spec)
        if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) throw new TypeError('Package URL credentials are not allowed')
      } catch (error) {
        if (error instanceof TypeError && error.message === 'Package URL credentials are not allowed') throw error
        throw new TypeError('Invalid git package URL')
      }
    }
    return source
  }
  if (/^(https?|ssh|git):\/\//i.test(source)) {
    let url: URL
    try { url = new URL(source.replace(/@([^/@]+)$/, '%40$1')) } catch { throw new TypeError('Invalid package URL') }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) throw new TypeError('Package URL credentials are not allowed')
    return source
  }
  if (isAbsolute(source)) {
    if (!existsSync(source)) throw new TypeError('Local package path does not exist')
    return realpathSync(source)
  }
  throw new TypeError('Package source must be npm:, git:, a protocol URL, or an existing absolute path')
}

export async function executePackageInstall(primeAgentPath: string, source: string): Promise<ProcessOutcome> {
  const result = await runProcess(primeAgentPath, ['package', 'install', source], { timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
  return processOutcome(result, stripAnsi(`${result.stdout}${result.stderr}`).trim())
}

export async function executeOmpPluginInstall(ompPath: string, source: string): Promise<ProcessOutcome> {
  const target = source.startsWith('npm:') || source.startsWith('git:') ? source.slice(4) : source
  const result = await runProcess(ompPath, ['plugin', 'install', target, '--json'], { timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
  return processOutcome(result, stripAnsi(`${result.stdout}${result.stderr}`).trim())
}

// Pi has no --json output for install/remove; stdout is untrusted, bounded by
// maxBytes, and ANSI-stripped before it reaches the renderer. The source is
// passed verbatim like Prime's `package install` (pi is Prime's ancestor CLI).
export async function executePiPluginInstall(piPath: string, source: string): Promise<ProcessOutcome> {
  const result = await runProcess(piPath, ['install', source], { timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
  return processOutcome(result, stripAnsi(`${result.stdout}${result.stderr}`).trim())
}

export async function executePiPluginRemove(piPath: string, source: string): Promise<ProcessOutcome> {
  const result = await runProcess(piPath, ['remove', source], { timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
  return processOutcome(result, stripAnsi(`${result.stdout}${result.stderr}`).trim())
}
