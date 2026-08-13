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
        onConnectMcp={async () => ({ ok: true, output: '' })}
      />)
    })

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Enable Computer Use | TryCUA"]')
    await act(async () => { toggle!.click(); await Promise.resolve() })
    expect(openExternal).toHaveBeenCalledWith('https://cua.ai/docs/how-to-guides/driver/install')
    expect(setEnabled).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Install Cua Driver before enabling Computer Use.')
  })

  it('does not advertise raw MCP server configuration for Prime Agent', async () => {
    await act(async () => {
      root.render(<PluginsPage
        harness="prime" skills={[]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onConnectMcp={async () => ({ ok: true, output: '' })}
      />)
    })
    expect(container.textContent).toContain('Prime Agent exposes MCP through matching Python integration skills')
    await act(async () => { container.querySelector<HTMLButtonElement>('.button--primary')!.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('Integration package')
    expect(dialog?.textContent).not.toContain('Save server configuration')
  })

  it('offers the supported Pi adapter before allowing MCP configuration', async () => {
    const install = vi.fn(async () => ({ ok: true, output: 'installed' }))
    await act(async () => {
      root.render(<PluginsPage
        harness="pi" skills={[]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={install}
        onConnectMcp={async () => ({ ok: true, output: '' })}
      />)
    })
    await act(async () => { container.querySelector<HTMLButtonElement>('.button--primary')!.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    const adapterButton = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Install Pi MCP Adapter')
    expect(adapterButton).toBeTruthy()
    expect(dialog?.textContent).toContain('Pi intentionally has no built-in MCP client')
    await act(async () => { adapterButton!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(install).toHaveBeenCalledWith('npm:pi-mcp-adapter')
  })
})
