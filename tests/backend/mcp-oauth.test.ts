import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpOAuthProvider } from '@earendil-works/pi-ai/mcp'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('vendored MCP OAuth compatibility', () => {
  it('retains a dynamically registered client secret for token exchange and refresh', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify({
          issuer: 'https://api.supabase.test',
          authorization_endpoint: 'https://api.supabase.test/v1/oauth/authorize',
          token_endpoint: 'https://api.supabase.test/v1/oauth/token',
          registration_endpoint: 'https://api.supabase.test/platform/oauth/apps/register',
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          scopes_supported: ['projects:read'],
        }))
      }
      if (url.endsWith('/platform/oauth/apps/register')) {
        const registration = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(registration.token_endpoint_auth_method).toBe('client_secret_basic')
        return new Response(JSON.stringify({
          client_id: 'gooeypi-client',
          client_secret: 'supabase-secret',
          // The registration response is authoritative even when it differs
          // from the method requested using authorization-server metadata.
          token_endpoint_auth_method: 'client_secret_post',
        }))
      }
      if (url.endsWith('/v1/oauth/token')) {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('client_id')).toBe('gooeypi-client')
        expect(body.get('client_secret')).toBe('supabase-secret')
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        if (body.get('grant_type') === 'refresh_token') {
          expect(body.get('refresh_token')).toBe('refresh-one')
          return new Response(JSON.stringify({ access_token: 'access-two', expires_in: 3_600 }))
        }
        expect(body.get('grant_type')).toBe('authorization_code')
        expect(body.get('code')).toBe('authorization-code')
        expect(body.get('code_verifier')).toBeTruthy()
        return new Response(JSON.stringify({ access_token: 'access-one', refresh_token: 'refresh-one', expires_in: 3_600 }))
      }
      return new Response('missing', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createMcpOAuthProvider({
      server: 'supabase',
      label: 'Supabase',
      url: 'https://api.supabase.test/',
    })
    const authUrls: string[] = []
    const credentials = await provider.login({
      onAuth: ({ url }) => authUrls.push(url),
      onPrompt: async () => '',
      onManualCodeInput: async () => 'authorization-code',
    })

    expect(authUrls).toHaveLength(1)
    expect(new URL(authUrls[0]).searchParams.get('client_id')).toBe('gooeypi-client')
    expect(credentials).toMatchObject({
      access: 'access-one',
      refresh: 'refresh-one',
      clientId: 'gooeypi-client',
      clientSecret: 'supabase-secret',
      tokenEndpointAuthMethod: 'client_secret_post',
    })

    await expect(provider.refreshToken(credentials)).resolves.toMatchObject({
      access: 'access-two',
      refresh: 'refresh-one',
      clientSecret: 'supabase-secret',
      tokenEndpointAuthMethod: 'client_secret_post',
    })
  })

  it('fails closed when confidential registration omits the required secret', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        }))
      }
      return new Response(JSON.stringify({ client_id: 'missing-secret', token_endpoint_auth_method: 'client_secret_basic' }))
    }))

    const provider = createMcpOAuthProvider({ server: 'confidential', url: 'https://auth.example/' })
    await expect(provider.login({ onAuth: () => undefined, onPrompt: async () => '' }))
      .rejects.toThrow(/returned no client_secret/)
  })

  it('uses HTTP Basic when the registration response selects client_secret_basic', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://basic.example/authorize',
          token_endpoint: 'https://basic.example/token',
          registration_endpoint: 'https://basic.example/register',
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        }))
      }
      if (url.endsWith('/register')) {
        return new Response(JSON.stringify({
          client_id: 'basic-client',
          client_secret: 'basic-secret',
          token_endpoint_auth_method: 'client_secret_basic',
        }))
      }
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('basic-client:basic-secret').toString('base64')}`)
      const body = new URLSearchParams(String(init?.body))
      expect(body.has('client_id')).toBe(false)
      expect(body.has('client_secret')).toBe(false)
      return new Response(JSON.stringify({ access_token: 'basic-access', refresh_token: 'basic-refresh' }))
    }))

    const provider = createMcpOAuthProvider({ server: 'basic', url: 'https://basic.example/' })
    await expect(provider.login({
      onAuth: () => undefined,
      onPrompt: async () => '',
      onManualCodeInput: async () => 'basic-code',
    })).resolves.toMatchObject({
      access: 'basic-access',
      clientSecret: 'basic-secret',
      tokenEndpointAuthMethod: 'client_secret_basic',
    })
  })
})
