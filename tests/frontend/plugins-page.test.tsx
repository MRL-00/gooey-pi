// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginsPage } from '../../src/pages/PluginsPage'
import type { SkillRecord } from '../../src/types/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const askUser: SkillRecord = {
  id: 'gooeypi-ask-user', name: 'Ask user', description: 'Ask focused questions.',
  kind: 'extension', location: 'system', enabled: true,
}
const computerUse: SkillRecord = {
  id: 'gooeypi-computer-use', name: 'Computer Use | TryCUA', description: 'Native computer use.',
  kind: 'extension', location: 'system', enabled: false,
  availability: { available: false, detail: 'Install Cua Driver before enabling Computer Use.', actionUrl: 'https://cua.ai/docs/how-to-guides/driver/install' },
}

function changeInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('PluginsPage bundled capability controls', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('toggles the universal ask_user capability and refreshes the catalog', async () => {
    const setEnabled = vi.fn(async () => undefined)
    const refresh = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<PluginsPage
        harness="pi" skills={[askUser]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={setEnabled}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={refresh} onInstall={async () => ({ ok: true, output: '' })}
        onSetMcpSupport={async () => ({ ok: true, output: '' })} onRunMcpCommand={async () => undefined}
        onConnectMcp={async () => ({ ok: true, output: '' })}
      />)
    })

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Disable Ask user"]')
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { toggle!.click(); await Promise.resolve(); await Promise.resolve() })

    expect(setEnabled).toHaveBeenCalledWith(false)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('opens the TryCUA installer instead of enabling when the driver is missing', async () => {
    const setEnabled = vi.fn(async () => undefined)
    const openExternal = vi.fn()
    await act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[computerUse]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={setEnabled} onOpenExternal={openExternal}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onSetMcpSupport={async () => ({ ok: true, output: '' })} onRunMcpCommand={async () => undefined}
        onConnectMcp={async () => ({ ok: true, output: '' })}
      />)
    })

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Enable Computer Use | TryCUA"]')
    await act(async () => { toggle!.click(); await Promise.resolve() })
    expect(openExternal).toHaveBeenCalledWith('https://cua.ai/docs/how-to-guides/driver/install')
    expect(setEnabled).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Install Cua Driver before enabling Computer Use.')
  })

  it('guides Prime Agent MCP through a package, HTTP definition, and native login', async () => {
    const install = vi.fn(async () => ({ ok: true, output: 'installed package' }))
    const connect = vi.fn(async () => ({ ok: true, output: 'saved server' }))
    const login = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<PluginsPage
        harness="prime" skills={[]} warnings={[]} loading={false} activeProjectPath="/repo"
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={install}
        onSetMcpSupport={async () => ({ ok: true, output: '' })} onRunMcpCommand={login}
        onConnectMcp={connect}
      />)
    })
    expect(container.textContent).toContain('matching Python skill package')
    await act(async () => { container.querySelector<HTMLButtonElement>('.button--primary')!.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('MCP integration')
    expect(dialog?.textContent).toContain('Integration package source')
    expect(dialog?.textContent).not.toContain('Local command')
    const inputs = dialog!.querySelectorAll<HTMLInputElement>('input')
    await act(async () => {
      for (const [input, value] of [[inputs[0], 'npm:prime-acme'], [inputs[1], 'acme'], [inputs[2], 'https://acme.example/mcp']] as const) {
        changeInput(input, value)
      }
      const auth = dialog!.querySelector<HTMLSelectElement>('select')!
      auth.value = 'oauth'; auth.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const save = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save server configuration')!
    await act(async () => { save.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(install).toHaveBeenCalledWith('npm:prime-acme')
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ name: 'acme', type: 'http', auth: 'oauth' }))
    const signIn = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Open session and sign in')!
    await act(async () => { signIn.click(); await Promise.resolve() })
    expect(login).toHaveBeenCalledWith('/mcp login acme')
  })

  it('toggles Pi MCP support through the supported adapter lifecycle', async () => {
    const setMcpSupport = vi.fn(async () => ({ ok: true, output: 'installed' }))
    const refresh = vi.fn(async () => undefined)
    const piMcp: SkillRecord = {
      id: 'gooeypi-pi-mcp', name: 'MCP | Pi MCP Adapter', description: 'Install the adapter.',
      kind: 'extension', location: 'system', enabled: false, source: 'npm:pi-mcp-adapter',
    }
    await act(async () => {
      root.render(<PluginsPage
        harness="pi" skills={[piMcp]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={refresh} onInstall={async () => ({ ok: true, output: '' })}
        onSetMcpSupport={setMcpSupport} onRunMcpCommand={async () => undefined}
        onConnectMcp={async () => ({ ok: true, output: '' })}
      />)
    })
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Enable MCP | Pi MCP Adapter"]')!
    await act(async () => { toggle.click(); await Promise.resolve(); await Promise.resolve() })
    expect(setMcpSupport).toHaveBeenCalledWith(true)
    expect(refresh).toHaveBeenCalled()
  })
})
