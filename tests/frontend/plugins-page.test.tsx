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

const cuaMcp: SkillRecord = {
  id: 'gooeypi-cua-driver-mcp', name: 'CUA Driver MCP', description: 'Connect the CUA runtime.',
  kind: 'extension', location: 'system', enabled: false,
  availability: { available: true, detail: 'Cua Driver 0.19.0 is ready.', actionUrl: 'https://cua.ai/driver' },
}

const computerUse: SkillRecord = {
  id: 'gooeypi-computer-use', name: 'Computer Use', description: 'Control native apps.',
  kind: 'extension', location: 'system', enabled: false,
  availability: { available: false, detail: 'Enable the CUA Driver MCP extension first.' },
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
        cuaDriverMcpEnabled={false} onSetCuaDriverMcpEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined}
        onOpenExternal={() => undefined}
        onRefresh={refresh} onInstall={async () => ({ ok: true, output: '' })}
        onConnectMcp={async () => ({ ok: true, output: '' })}
      />)
    })

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Disable Ask user"]')
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { toggle!.click(); await Promise.resolve(); await Promise.resolve() })

    expect(setEnabled).toHaveBeenCalledWith(false)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('keeps the CUA MCP adapter and Computer Use as separate toggles', async () => {
    const setMcpEnabled = vi.fn(async () => undefined)
    const setComputerUseEnabled = vi.fn(async () => undefined)
    const refresh = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<PluginsPage
        harness="prime" skills={[cuaMcp, { ...computerUse, availability: { available: true, detail: 'Ready.' } }]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        cuaDriverMcpEnabled={false} onSetCuaDriverMcpEnabled={setMcpEnabled}
        computerUseEnabled={false} onSetComputerUseEnabled={setComputerUseEnabled}
        onOpenExternal={() => undefined} onRefresh={refresh}
        onInstall={async () => ({ ok: true, output: '' })} onConnectMcp={async () => ({ ok: true, output: '' })}
      />)
    })

    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Enable CUA Driver MCP"]')!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(setMcpEnabled).toHaveBeenCalledWith(true)
    expect(setComputerUseEnabled).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('alerts with the install action when the driver runtime is missing', async () => {
    const openExternal = vi.fn()
    const setMcpEnabled = vi.fn(async () => undefined)
    const missing = { ...cuaMcp, availability: { available: false, detail: 'Cua Driver was not detected.', actionUrl: 'https://cua.ai/driver' } }
    await act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[missing, computerUse]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        cuaDriverMcpEnabled={false} onSetCuaDriverMcpEnabled={setMcpEnabled}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined}
        onOpenExternal={openExternal} onRefresh={async () => undefined}
        onInstall={async () => ({ ok: true, output: '' })} onConnectMcp={async () => ({ ok: true, output: '' })}
      />)
    })

    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Enable CUA Driver MCP"]')!.click() })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Cua Driver was not detected.')
    expect(setMcpEnabled).not.toHaveBeenCalled()
    await act(async () => { container.querySelector<HTMLButtonElement>('button')?.focus(); container.querySelector<HTMLButtonElement>('.page-inline-error button')!.click() })
    expect(openExternal).toHaveBeenCalledWith('https://cua.ai/driver')
  })

  it('explains the MCP dependency before enabling Computer Use', async () => {
    const setComputerUseEnabled = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<PluginsPage
        harness="pi" skills={[cuaMcp, computerUse]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        cuaDriverMcpEnabled={false} onSetCuaDriverMcpEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={setComputerUseEnabled}
        onOpenExternal={() => undefined} onRefresh={async () => undefined}
        onInstall={async () => ({ ok: true, output: '' })} onConnectMcp={async () => ({ ok: true, output: '' })}
      />)
    })

    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Enable Computer Use"]')!.click() })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Enable the CUA Driver MCP extension first.')
    expect(setComputerUseEnabled).not.toHaveBeenCalled()
  })
})
