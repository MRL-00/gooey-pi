import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PrimeProviderService } from '../../electron/main/providers'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function service(): PrimeProviderService {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-providers-'))
  dirs.push(dir)
  return new PrimeProviderService({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json') })
}

describe('Prime provider adapter', () => {
  it('returns the Prime catalog with model-specific capability metadata', async () => {
    const catalog = await service().catalog(true)
    const gpt54 = catalog.models.find((model) => model.provider === 'openai-codex' && model.id === 'gpt-5.4')
    const gpt56 = catalog.models.find((model) => model.provider === 'openai-codex' && model.id === 'gpt-5.6-sol')

    expect(catalog.models.length).toBeGreaterThan(100)
    expect(catalog.providers.length).toBeGreaterThan(10)
    expect(gpt54?.fastModeSupported).toBe(true)
    expect(gpt54?.availableThinkingLevels).not.toContain('max')
    expect(gpt56?.availableThinkingLevels).toContain('max')
    expect(gpt56?.availableThinkingLevels).not.toContain('minimal')
  })

  it('keeps provider enablement as a desktop policy separate from authentication', async () => {
    const catalog = await service().catalog(true, new Set(['anthropic']))
    const anthropic = catalog.providers.find((provider) => provider.id === 'anthropic')

    expect(anthropic?.enabled).toBe(false)
    expect(typeof anthropic?.configured).toBe('boolean')
  })
})
