import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EXTENSION_INJECTIONS, SHIPPED_EXTENSION_FILENAMES, type ExtensionInjection } from '../../electron/main/extension-manifest'
import { readdirSync } from 'node:fs'

type Registration = { kind: 'tool' | 'command' | 'event'; name: string }

interface Fixture {
  api: object
  registrations: Registration[]
}

function primeHost(): Fixture {
  const registrations: Registration[] = []
  const target = {
    registerTool: (tool: { name: string }) => { registrations.push({ kind: 'tool', name: tool.name }) },
  }
  const api = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then' || property === 'constructor') return Reflect.get(object, property, receiver)
      if (property === 'typebox') return undefined
      if (!(property in object)) throw new Error(`Prime fixture does not inject ${String(property)}`)
      return Reflect.get(object, property, receiver)
    },
  })
  return { api, registrations }
}

function ompHost(): Fixture {
  const registrations: Registration[] = []
  const schema = (kind: string) => (...args: unknown[]) => ({ kind, args })
  const target = {
    typebox: {
      Type: {
        Object: schema('object'),
        String: schema('string'),
        Number: schema('number'),
        Boolean: schema('boolean'),
        Array: schema('array'),
        Enum: schema('enum'),
        Optional: schema('optional'),
      },
    },
    registerTool: (tool: { name: string }) => { registrations.push({ kind: 'tool', name: tool.name }) },
  }
  const api = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then' || property === 'constructor') return Reflect.get(object, property, receiver)
      if (!(property in object)) throw new Error(`OMP fixture does not inject ${String(property)}`)
      return Reflect.get(object, property, receiver)
    },
  })
  return { api, registrations }
}

function piHost(): Fixture {
  const registrations: Registration[] = []
  const target = {
    registerTool: (tool: { name: string }) => { registrations.push({ kind: 'tool', name: tool.name }) },
    registerCommand: (name: string) => { registrations.push({ kind: 'command', name }) },
    on: (event: string) => { registrations.push({ kind: 'event', name: event }) },
  }
  const api = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then' || property === 'constructor') return Reflect.get(object, property, receiver)
      if (property === 'typebox') return undefined
      if (!(property in object)) throw new Error(`Pi fixture does not inject ${String(property)}`)
      return Reflect.get(object, property, receiver)
    },
  })
  return { api, registrations }
}

const fixtureFactories = {
  prime: primeHost,
  omp: ompHost,
  pi: piHost,
}

const expectedRegistrations: Record<string, Registration[]> = {
  'prime-work-browser.ts': [
    ...['terminal_read', 'browser_tabs', 'browser_navigate', 'browser_screenshot', 'browser_read_page', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_evaluate'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'omp-work-browser.ts': [
    ...['terminal_read', 'browser_tabs', 'browser_navigate', 'browser_screenshot', 'browser_read_page', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_evaluate'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'omp-work-ask-user.ts': [{ kind: 'tool', name: 'ask_user' }],
  'omp-work-collaboration.ts': [
    ...['session_list', 'session_models', 'session_create', 'session_read', 'session_send', 'session_wait'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'omp-work-schedules.ts': [
    ...['scheduled_tasks_list', 'scheduled_task_create_once', 'scheduled_task_create_recurring', 'scheduled_task_update', 'scheduled_task_manage'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'pi-work-fast-mode.ts': [
    { kind: 'command', name: 'gooeypi-fast-mode' },
    { kind: 'event', name: 'before_provider_request' },
  ],
}

const brokerVariables: Partial<Record<ExtensionInjection['capability'], readonly [string, string]>> = {
  browser: ['PRIME_WORK_BROWSER_URL', 'PRIME_WORK_BROWSER_TOKEN'],
  schedule: ['PRIME_WORK_SCHEDULE_URL', 'PRIME_WORK_SCHEDULE_TOKEN'],
  collaboration: ['GOOEYPI_COLLABORATION_URL', 'GOOEYPI_COLLABORATION_TOKEN'],
}

let importCounter = 0

async function loadExtension(injection: ExtensionInjection, configured: boolean) {
  vi.resetModules()
  vi.unstubAllEnvs()
  const variables = brokerVariables[injection.capability]
  if (configured && variables) {
    vi.stubEnv(variables[0], 'http://127.0.0.1:1/')
    vi.stubEnv(variables[1], 'inert-test-token')
  }
  const url = pathToFileURL(join(process.cwd(), 'assets', 'extensions', injection.filename)).href
  return (await import(`${url}?contract=${importCounter++}`)).default as (api: object) => void | Promise<void>
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('shipped extension contracts', () => {
  it('initializes every manifest injection against its genuine host surface', async () => {
    for (const [harness, injections] of Object.entries(EXTENSION_INJECTIONS)) {
      for (const injection of injections) {
        for (const configured of [false, true]) {
          const fixture = fixtureFactories[harness as keyof typeof fixtureFactories]()
          const factory = await loadExtension(injection, configured)
          await factory(fixture.api)
          const expected = expectedRegistrations[injection.filename]
          expect(fixture.registrations, `${harness}/${injection.filename} configured=${configured}`).toEqual(
            configured || !brokerVariables[injection.capability] ? expected : [],
          )
        }
      }
    }
  })

  it('rejects an extension that reaches for a capability its host does not inject', () => {
    const fixture = primeHost()
    const badExtension = (api: object) => {
      const unsupported = (api as { typebox: { Type: { Object(): unknown } } }).typebox
      unsupported.Type.Object()
    }
    expect(() => badExtension(fixture.api)).toThrow()
  })

  it('derives the shipped inventory from the actual extension directory', () => {
    const actual = readdirSync(join(process.cwd(), 'assets', 'extensions'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort()
    expect(SHIPPED_EXTENSION_FILENAMES).toEqual(actual)
  })
})
