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

  it('confirms before disabling the universal ask_user capability', async () => {
    const setEnabled = vi.fn(async () => undefined)
    const refresh = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<PluginsPage
        harness="pi" skills={[askUser]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={setEnabled}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={refresh} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })}
        onSetMcpSupport={async () => ({ ok: true, output: '' })} onRunMcpCommand={async () => undefined}
        onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })} onConnectBundledMcp={async () => undefined} onDisconnectBundledMcp={async () => undefined}
      />)
    })

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Disable Ask user"]')
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { toggle!.click(); await Promise.resolve(); await Promise.resolve() })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('Disable Ask user?')
    expect(dialog.textContent).toContain('Are you sure?')
    expect(setEnabled).not.toHaveBeenCalled()
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Yes, disable')!.click(); await Promise.resolve(); await Promise.resolve() })

    expect(setEnabled).toHaveBeenCalledWith(false)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('enables Browser directly and confirms before disabling it', async () => {
    const setBrowserEnabled = vi.fn(async () => undefined)
    const browser: SkillRecord = { id: 'prime-work-browser', name: 'Browser', description: 'In-app browser.', kind: 'skill', location: 'system', enabled: false }
    const render = async (enabled: boolean) => act(async () => {
      root.render(<PluginsPage
        harness="prime" skills={[browser]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={enabled} onSetBrowserEnabled={setBrowserEnabled}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })} onSetMcpSupport={async () => ({ ok: true, output: '' })}
        onConnectMcp={async () => ({ ok: true, output: '' })} onSetMcpEnabled={async () => ({ ok: true, output: '' })}
        onConnectBundledMcp={async () => undefined} onDisconnectBundledMcp={async () => undefined} onRunMcpCommand={async () => undefined}
      />)
    })
    await render(false)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Enable Browser"]')!.click(); await Promise.resolve() })
    expect(setBrowserEnabled).toHaveBeenCalledWith(true)

    await render(true)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Disable Browser"]')!.click() })
    expect(setBrowserEnabled).not.toHaveBeenCalledWith(false)
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Yes, disable')!.click(); await Promise.resolve() })
    expect(setBrowserEnabled).toHaveBeenCalledWith(false)
  })

  it('connects bundled MCPs from plus and confirms before disconnecting them', async () => {
    const connectBundled = vi.fn(async () => undefined)
    const disconnectBundled = vi.fn(async () => undefined)
    const mutateCapability = vi.fn(async () => ({ ok: true, output: '' }))
    const notion: SkillRecord = { id: 'prime-mcp-notion', name: 'Notion', description: 'Official MCP.', kind: 'mcp', location: 'bundled', enabled: false }
    const render = async (enabled: boolean) => act(async () => {
      root.render(<PluginsPage
        harness="prime" skills={[{ ...notion, enabled }]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })} onSetMcpSupport={async () => ({ ok: true, output: '' })}
        onConnectMcp={async () => ({ ok: true, output: '' })} onSetMcpEnabled={async () => ({ ok: true, output: '' })}
        onMutateCapability={mutateCapability}
        onConnectBundledMcp={connectBundled} onDisconnectBundledMcp={disconnectBundled} onRunMcpCommand={async () => undefined}
      />)
    })
    await render(false)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Enable Notion"]')!.click(); await Promise.resolve() })
    expect(mutateCapability).toHaveBeenCalledWith({ kind: 'mcp', action: 'enable', name: 'notion', scope: 'user' })

    await render(true)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Disable Notion"]')!.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('saved authorization are kept')
    expect(container.querySelector('button[aria-label="Remove Notion"]')).toBeNull()
    expect(disconnectBundled).not.toHaveBeenCalled()
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Yes, disable')!.click(); await Promise.resolve() })
    expect(mutateCapability).toHaveBeenLastCalledWith({ kind: 'mcp', action: 'disable', name: 'notion', scope: 'user' })
    expect(disconnectBundled).not.toHaveBeenCalled()
  })

  it('confirms before disabling configured MCPs and re-enables them from plus', async () => {
    const setMcpEnabled = vi.fn(async () => ({ ok: true, output: '' }))
    const docs: SkillRecord = { id: 'mcp:user:docs', name: 'docs', description: 'HTTP MCP.', kind: 'mcp', location: 'user', enabled: true }
    const render = async (enabled: boolean) => act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[{ ...docs, enabled }]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })} onSetMcpSupport={async () => ({ ok: true, output: '' })}
        onConnectMcp={async () => ({ ok: true, output: '' })} onSetMcpEnabled={setMcpEnabled}
        onConnectBundledMcp={async () => undefined} onDisconnectBundledMcp={async () => undefined} onRunMcpCommand={async () => undefined}
      />)
    })
    await render(true)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Disable docs"]')!.click() })
    expect(setMcpEnabled).not.toHaveBeenCalled()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Yes, disable')!.click(); await Promise.resolve() })
    expect(setMcpEnabled).toHaveBeenCalledWith({ name: 'docs', scope: 'user', projectPath: undefined, enabled: false })

    await render(false)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Enable docs"]')!.click(); await Promise.resolve() })
    expect(setMcpEnabled).toHaveBeenLastCalledWith({ name: 'docs', scope: 'user', projectPath: undefined, enabled: true })
  })

  it('offers complete removal for user MCPs but not protected capabilities', async () => {
    const mutateCapability = vi.fn(async () => ({ ok: true, output: '' }))
    const docs: SkillRecord = { id: 'mcp:user:docs', name: 'docs', description: 'HTTP MCP.', kind: 'mcp', location: 'user', enabled: true, associatedPackageSource: 'npm:prime-docs' }
    await act(async () => {
      root.render(<PluginsPage
        harness="prime" skills={[docs]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })} onSetMcpSupport={async () => ({ ok: true, output: '' })}
        onConnectMcp={async () => ({ ok: true, output: '' })} onSetMcpEnabled={async () => ({ ok: true, output: '' })}
        onMutateCapability={mutateCapability} onConnectBundledMcp={async () => undefined} onDisconnectBundledMcp={async () => undefined} onRunMcpCommand={async () => undefined}
      />)
    })

    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Remove docs"]')!.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('Other packages and MCP entries will be kept')
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Yes, remove completely')!.click(); await Promise.resolve() })
    expect(mutateCapability).toHaveBeenCalledWith({ kind: 'mcp', action: 'remove', name: 'docs', source: 'npm:prime-docs', scope: 'user', projectPath: undefined })
  })

  it('opens the TryCUA installer instead of enabling when the driver is missing', async () => {
    const setEnabled = vi.fn(async () => undefined)
    const openExternal = vi.fn()
    await act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[computerUse]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={setEnabled} onOpenExternal={openExternal}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })}
        onSetMcpSupport={async () => ({ ok: true, output: '' })} onRunMcpCommand={async () => undefined}
        onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })} onConnectBundledMcp={async () => undefined} onDisconnectBundledMcp={async () => undefined}
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
    const startMcpOAuth = vi.fn(async () => undefined)
    const openExternal = vi.fn()
    await act(async () => {
      root.render(<PluginsPage
        harness="prime" skills={[]} warnings={[]} loading={false} activeProjectPath="/repo"
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={openExternal}
        onRefresh={async () => undefined} onInstall={install}
        onInstallExtension={async () => ({ ok: true, output: '' })}
        onSetMcpSupport={async () => ({ ok: true, output: '' })} onRunMcpCommand={login}
        onConnectMcp={connect}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })} onConnectBundledMcp={startMcpOAuth} onDisconnectBundledMcp={async () => undefined}
      />)
    })
    expect(container.textContent).not.toContain('Prime MCP integrations require a matching Python skill package')
    await act(async () => { container.querySelector<HTMLButtonElement>('.button--primary')!.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('Add MCP')
    expect(dialog?.textContent).toContain('Add Package')
    expect(dialog?.textContent).toContain('Add Extension')
    expect(dialog?.textContent).not.toContain('Prime MCP integrations require a matching Python skill package')
    await act(async () => { [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Add MCP'))!.click() })
    expect(dialog?.textContent).toContain('Prime MCP integrations require a matching Python skill package and an HTTP server definition. GooeyPi installs both through one guided flow.')
    expect(dialog?.textContent).toContain('Integration package source')
    expect(dialog?.textContent).toContain('Enter a Prime package source such as an npm package, Git URL, or local path—not the MCP server URL.')
    await act(async () => { [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'How Prime MCP integrations work')!.click() })
    expect(openExternal).toHaveBeenCalledWith('https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/mcp-integrations.md')
    expect(dialog?.textContent).not.toContain('Local command')
    const inputs = dialog!.querySelectorAll<HTMLInputElement>('input')
    await act(async () => {
      for (const [input, value] of [[inputs[0], 'npm:prime-acme'], [inputs[1], 'acme'], [inputs[2], 'https://acme.example/mcp']] as const) {
        changeInput(input, value)
      }
      const auth = dialog!.querySelector<HTMLSelectElement>('select')!
      auth.value = 'oauth'; auth.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(dialog?.textContent).toContain('OAuth — save and log in')
    const save = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save and log in')!
    await act(async () => { save.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(install).toHaveBeenCalledWith('npm:prime-acme')
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ name: 'acme', type: 'http', auth: 'oauth' }))
    expect(startMcpOAuth).toHaveBeenCalledWith('acme')
    expect(login).not.toHaveBeenCalled()
    expect(dialog?.textContent).toContain('/mcp login acme')
    const signIn = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Try sign in again')!
    await act(async () => { signIn.click(); await Promise.resolve() })
    expect(startMcpOAuth).toHaveBeenCalledTimes(2)
  })

  it('toggles Pi MCP support through the supported adapter lifecycle', async () => {
    const setMcpSupport = vi.fn(async () => ({ ok: true, output: 'installed' }))
    const refresh = vi.fn(async () => undefined)
    const piMcp: SkillRecord = {
      id: 'gooeypi-pi-mcp', name: 'Pi MCP Adapter', description: 'Install the adapter.',
      kind: 'extension', location: 'system', enabled: false, source: 'npm:pi-mcp-adapter',
    }
    await act(async () => {
      root.render(<PluginsPage
        harness="pi" skills={[piMcp]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={refresh} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })}
        onSetMcpSupport={setMcpSupport} onRunMcpCommand={async () => undefined}
        onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })} onConnectBundledMcp={async () => undefined} onDisconnectBundledMcp={async () => undefined}
      />)
    })
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Enable Pi MCP Adapter"]')!
    await act(async () => { toggle.click(); await Promise.resolve(); await Promise.resolve() })
    expect(setMcpSupport).toHaveBeenCalledWith(true)
    expect(refresh).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Pi MCP Adapter installed.')

    await act(async () => {
      root.render(<PluginsPage
        harness="prime" skills={[]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={refresh} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })}
        onSetMcpSupport={setMcpSupport} onRunMcpCommand={async () => undefined}
        onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })} onConnectBundledMcp={async () => undefined} onDisconnectBundledMcp={async () => undefined}
      />)
    })
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.textContent).not.toContain('Pi MCP Adapter installed.')
  })

  it('greys out Pi MCP until its adapter is enabled and opens the extension form separately', async () => {
    const installExtension = vi.fn(async () => ({ ok: true, output: 'installed extension' }))
    const openExternal = vi.fn()
    await act(async () => {
      root.render(<PluginsPage
        harness="pi" skills={[]} warnings={[]} loading={false} activeProjectPath="/repo"
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={openExternal}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={installExtension}
        onSetMcpSupport={async () => ({ ok: true, output: '' })} onRunMcpCommand={async () => undefined}
        onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })} onConnectBundledMcp={async () => undefined} onDisconnectBundledMcp={async () => undefined}
      />)
    })

    await act(async () => { container.querySelector<HTMLButtonElement>('.button--primary')!.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const addMcp = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Add MCP'))!
    expect(addMcp.disabled).toBe(true)
    expect(addMcp.textContent).toContain('Enable Pi MCP Adapter first')
    expect(dialog.textContent).toContain('Not every third-party package, plugin, or extension will work in GooeyPi')
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'create a GitHub issue')!.click() })
    expect(openExternal).toHaveBeenCalledWith('https://github.com/am-will/gooey-pi/issues/new')

    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Add Package'))!.click() })
    expect(dialog.textContent).not.toContain('Not every third-party')
    await act(async () => { dialog.querySelector<HTMLButtonElement>('.modal__footer .button')!.click() })
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Add Extension'))!.click() })
    expect(dialog.textContent).toContain('Extension file')
    expect(dialog.textContent).toContain('native package manager')
    expect(dialog.textContent).not.toContain('Not every third-party')
    changeInput(dialog.querySelector<HTMLInputElement>('input')!, '/tmp/example.ts')
    const install = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Install extension')!
    await act(async () => { install.click(); await Promise.resolve(); await Promise.resolve() })
    expect(installExtension).toHaveBeenCalledWith({ source: '/tmp/example.ts', scope: 'user', projectPath: undefined })
  })
})
