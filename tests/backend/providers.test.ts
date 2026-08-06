import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PrimeProviderService, resolveAvailableModelKeys } from '../../electron/main/providers'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function service(): PrimeProviderService {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-providers-'))
  dirs.push(dir)
  return new PrimeProviderService({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json') })
}

function serviceWithAuthPath(): { providerService: PrimeProviderService; authPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-provider-auth-'))
  dirs.push(dir)
  const authPath = join(dir, 'auth.json')
  return { providerService: new PrimeProviderService({ authPath, modelsPath: join(dir, 'models.json') }), authPath }
}

describe('Prime provider adapter', () => {
  it('keeps configured ChatGPT subscription models selectable when discovery returns no models', () => {
    const result = resolveAvailableModelKeys(
      [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }, { provider: 'anthropic', id: 'claude-sonnet-5' }],
      [{ provider: 'anthropic', id: 'claude-sonnet-5' }],
      new Set(['openai-codex', 'anthropic']),
    )

    expect(result.keys).toEqual(new Set(['openai-codex/gpt-5.6-sol', 'anthropic/claude-sonnet-5']))
    expect(result.fallbackProviders).toEqual(['openai-codex'])
  })

  it('keeps configured ChatGPT subscription models selectable when discovery is partial', () => {
    const result = resolveAvailableModelKeys(
      [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }, { provider: 'openai-codex', id: 'gpt-5.6-terra' }],
      [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }],
      new Set(['openai-codex']),
    )

    expect(result.keys).toEqual(new Set(['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-terra']))
    expect(result.fallbackProviders).toEqual(['openai-codex'])
  })

  it('does not warn when configured ChatGPT discovery contains the complete catalogue', () => {
    const models = [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }, { provider: 'openai-codex', id: 'gpt-5.6-terra' }]
    const result = resolveAvailableModelKeys(models, models, new Set(['openai-codex']))

    expect(result.keys).toEqual(new Set(['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-terra']))
    expect(result.fallbackProviders).toEqual([])
  })

  it('does not make subscription models available for an unconfigured provider', () => {
    const result = resolveAvailableModelKeys(
      [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }, { provider: 'anthropic', id: 'claude-sonnet-5' }],
      [{ provider: 'anthropic', id: 'claude-sonnet-5' }],
      new Set(['anthropic']),
    )

    expect(result.keys).toEqual(new Set(['anthropic/claude-sonnet-5']))
    expect(result.fallbackProviders).toEqual([])
  })

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

  it('stores API keys through Prime auth storage without exposing them in the catalog', async () => {
    const { providerService, authPath } = serviceWithAuthPath()
    const secret = 'test-provider-secret-that-must-not-cross-back'

    await providerService.saveApiKey('openai', secret)
    const catalog = await providerService.catalog(true)
    const openai = catalog.providers.find((provider) => provider.id === 'openai')

    expect(openai?.configured).toBe(true)
    expect(openai?.authSource).toBe('stored')
    expect(JSON.stringify(catalog)).not.toContain(secret)
    expect(readFileSync(authPath, 'utf8')).toContain(secret)
    expect(statSync(authPath).mode & 0o777).toBe(0o600)

    await providerService.logout('openai')
    expect((await providerService.catalog(true)).providers.find((provider) => provider.id === 'openai')?.configured).toBe(false)
  })

  it('rejects OAuth for providers that do not own an OAuth flow', async () => {
    await expect(service().startOAuth('openai')).rejects.toThrow('requires api_key authentication')
  })
})
