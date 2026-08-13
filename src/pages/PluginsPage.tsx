import { AlertTriangle, ArrowLeft, BookOpen, Check, ChevronRight, FileCode2, FileText, Github, Globe2, Package, Palette, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, WandSparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ExtensionInstallInput, HarnessId, McpConnectionInput, PluginWarning, SkillRecord } from '@/types/api'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { EmptyState, Modal, Segmented } from '@/components/ui'

const MCP_HTTP_HELP: Record<HarnessId, string> = {
  omp: 'OMP loads this MCP endpoint directly when a new session starts.',
  prime: 'Prime Agent loads this HTTP endpoint through the matching Python integration skill installed above.',
  pi: 'Pi loads this MCP endpoint through the pi-mcp-adapter extension (pi install npm:pi-mcp-adapter) when a new session starts.',
}

const MCP_STDIO_HELP: Record<HarnessId, string> = {
  omp: 'OMP starts this stdio MCP server directly in each new session.',
  prime: 'Prime Agent does not expose arbitrary stdio MCP servers.',
  pi: 'Pi starts this stdio MCP server through the pi-mcp-adapter extension (pi install npm:pi-mcp-adapter) in each new session.',
}

type DirectoryTab = 'plugins' | 'skills'
type AddKind = 'mcp' | 'bundle' | 'extension'
type McpTransport = 'http' | 'stdio'
type McpScope = 'user' | 'project'
type McpAuth = 'none' | 'oauth' | 'bearer'

const PACKAGE_LABELS: Record<HarnessId, string> = { prime: 'Prime package', omp: 'OMP plugin', pi: 'Pi package' }
const PACKAGE_HELP: Record<HarnessId, string> = {
  prime: 'Install a Prime package containing extensions, skills, prompts, or themes with Prime Agent’s package manager.',
  omp: 'Install an OMP plugin bundle with OMP’s native plugin manager. Marketplace targets use name@marketplace.',
  pi: 'Install a Pi package containing extensions, skills, prompts, or themes with Pi’s package manager.',
}
const GITHUB_ISSUES_URL = 'https://github.com/am-will/gooey-pi/issues/new'

function SkillIcon({ skill }: { skill: SkillRecord }) {
  const common = { size: 16 }
  if (skill.icon === 'github') return <Github {...common}/>
  if (skill.icon === 'palette') return <Palette {...common}/>
  if (skill.icon === 'book-open') return <BookOpen {...common}/>
  if (skill.kind === 'mcp') return <Globe2 {...common}/>
  if (skill.kind === 'prompt') return <FileText {...common}/>
  if (skill.kind === 'skill') return <WandSparkles {...common}/>
  return <Package {...common}/>
}

interface PluginsPageProps {
  harness: HarnessId
  skills: SkillRecord[]
  warnings: PluginWarning[]
  loading: boolean
  activeProjectPath?: string
  onRefresh(): Promise<void>
  askUserEnabled: boolean
  onSetAskUserEnabled(enabled: boolean): Promise<void>
  computerUseEnabled: boolean
  onSetComputerUseEnabled(enabled: boolean): Promise<void>
  onOpenExternal(url: string): void
  onInstall(source: string): Promise<{ ok: boolean; output: string }>
  onInstallExtension(input: ExtensionInstallInput): Promise<{ ok: boolean; output: string }>
  onSetMcpSupport(enabled: boolean): Promise<{ ok: boolean; output: string }>
  onConnectMcp(input: McpConnectionInput): Promise<{ ok: boolean; output: string }>
  onRunMcpCommand(command: string): Promise<void>
}

export function PluginsPage({ harness, skills, warnings, loading, activeProjectPath, askUserEnabled, onSetAskUserEnabled, computerUseEnabled, onSetComputerUseEnabled, onOpenExternal, onRefresh, onInstall, onInstallExtension, onSetMcpSupport, onConnectMcp, onRunMcpCommand }: PluginsPageProps) {
  const [tab, setTab] = useState<DirectoryTab>('plugins')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [addOpen, setAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<AddKind | null>(null)
  const [source, setSource] = useState('')
  const [mcpName, setMcpName] = useState('')
  const [mcpTransport, setMcpTransport] = useState<McpTransport>('http')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpScope, setMcpScope] = useState<McpScope>('user')
  const [mcpAuth, setMcpAuth] = useState<McpAuth>('none')
  const [mcpBearerEnv, setMcpBearerEnv] = useState('')
  const [result, setResult] = useState('')
  const [loginCommand, setLoginCommand] = useState('')
  const [adding, setAdding] = useState(false)
  const [askUserUpdating, setAskUserUpdating] = useState(false)
  const [computerUseUpdating, setComputerUseUpdating] = useState(false)
  const [computerUseAlert, setComputerUseAlert] = useState('')
  const [mcpSupportUpdating, setMcpSupportUpdating] = useState(false)
  const [mcpSupportAlert, setMcpSupportAlert] = useState('')
  const piMcpAdapterInstalled = skills.some((skill) => skill.id === 'gooeypi-pi-mcp' && skill.enabled)
  const canConfigureMcp = harness === 'omp' || harness === 'pi' && piMcpAdapterInstalled

  const visible = useMemo(() => skills.map((skill) => skill.id === 'gooeypi-ask-user'
    ? { ...skill, enabled: askUserEnabled }
    : skill.id === 'gooeypi-computer-use' ? { ...skill, enabled: computerUseEnabled } : skill).filter((skill) =>
    (tab === 'skills' ? skill.kind === 'skill' || skill.kind === 'prompt' : skill.kind !== 'skill' && skill.kind !== 'prompt')
    && (filter === 'all' || filter === 'installed' && skill.enabled || filter === skill.location)
    && `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())
  ), [askUserEnabled, computerUseEnabled, skills, tab, filter, query])

  const canAdd = addKind === 'bundle'
    ? Boolean(source.trim())
    : addKind === 'extension'
      ? Boolean(source.trim() && (mcpScope !== 'project' || activeProjectPath))
    : addKind === 'mcp' && (canConfigureMcp || harness === 'prime') && Boolean(
      mcpName.trim()
      && (mcpTransport === 'http' ? mcpUrl.trim() && (mcpAuth !== 'bearer' || mcpBearerEnv.trim()) : mcpCommand.trim())
      && (harness !== 'prime' || source.trim())
      && (mcpScope !== 'project' || activeProjectPath),
    )

  const add = async () => {
    if (!canAdd) return
    setAdding(true)
    setResult('')
    setLoginCommand('')
    try {
      if (addKind === 'mcp' && harness === 'prime') {
        const installed = await onInstall(source.trim())
        if (!installed.ok) { setResult(installed.output); return }
        await onRefresh()
      }
      const response = addKind === 'bundle'
        ? await onInstall(source.trim())
        : addKind === 'extension'
          ? await onInstallExtension({ source: source.trim(), scope: mcpScope, projectPath: mcpScope === 'project' ? activeProjectPath : undefined })
          : await onConnectMcp(mcpTransport === 'http'
          ? { name: mcpName.trim(), scope: mcpScope, projectPath: mcpScope === 'project' ? activeProjectPath : undefined, type: 'http', url: mcpUrl.trim(), auth: mcpAuth, bearerTokenEnvVar: mcpAuth === 'bearer' ? mcpBearerEnv.trim() : undefined }
          : { name: mcpName.trim(), scope: mcpScope, projectPath: mcpScope === 'project' ? activeProjectPath : undefined, type: 'stdio', command: mcpCommand.trim(), args: mcpArgs.split('\n').map((arg) => arg.trim()).filter(Boolean) })
      setResult(response.output)
      if (response.ok) {
        setSource('')
        setMcpName('')
        setMcpUrl('')
        setMcpCommand('')
        setMcpArgs('')
        setMcpBearerEnv('')
        if (addKind === 'mcp' && mcpAuth === 'oauth') setLoginCommand(harness === 'prime' ? `/mcp login ${mcpName.trim()}` : harness === 'omp' ? `/mcp reauth ${mcpName.trim()}` : `/mcp-auth ${mcpName.trim()}`)
        if (addKind === 'bundle') await onRefresh()
      }
    } finally {
      setAdding(false)
    }
  }

  const selectAddKind = (value: AddKind | null) => { setAddKind(value); setSource(''); setResult(''); setLoginCommand('') }
  const openAdd = () => { setResult(''); setLoginCommand(''); setAddKind(null); setMcpTransport('http'); setAddOpen(true) }
  const toggleAskUser = async () => {
    if (askUserUpdating) return
    setAskUserUpdating(true)
    try {
      await onSetAskUserEnabled(!askUserEnabled)
      await onRefresh()
    } finally {
      setAskUserUpdating(false)
    }
  }
  const toggleComputerUse = async (skill: SkillRecord) => {
    if (computerUseUpdating) return
    if (!computerUseEnabled && skill.availability?.available === false) {
      setComputerUseAlert(skill.availability.detail)
      if (skill.availability.actionUrl) onOpenExternal(skill.availability.actionUrl)
      return
    }
    setComputerUseAlert('')
    setComputerUseUpdating(true)
    try {
      await onSetComputerUseEnabled(!computerUseEnabled)
      await onRefresh()
    } finally {
      setComputerUseUpdating(false)
    }
  }
  const toggleMcpSupport = async (skill: SkillRecord) => {
    if (mcpSupportUpdating) return
    setMcpSupportUpdating(true)
    setMcpSupportAlert('')
    try {
      const response = await onSetMcpSupport(!skill.enabled)
      if (!response.ok) setMcpSupportAlert(response.output)
      await onRefresh()
    } finally {
      setMcpSupportUpdating(false)
    }
  }

  return (
    <div className="page plugin-page scroll-area">
      <div className="page-container plugin-container">
        <header className="plugin-header">
          <div><span className="eyebrow">{HARNESS_SHORT_NAMES[harness]} capabilities</span><h1>Extend {HARNESS_SHORT_NAMES[harness]}</h1><p>Manage packages, extensions, MCP servers, and reusable skills for this harness.</p></div>
          <div>
            <button type="button" className="button" onClick={() => void onRefresh()}><RefreshCw className={loading ? 'spin' : ''} size={13}/> Refresh</button>
            <button type="button" className="button" onClick={() => setFilter('installed')}><Settings2 size={13}/> Manage</button>
            <button type="button" className="button button--primary" onClick={openAdd}><Plus size={14}/> Add</button>
          </div>
        </header>
        <div className="directory-tabs">
          <button type="button" className={tab === 'plugins' ? 'is-active' : ''} onClick={() => setTab('plugins')}>Capabilities</button>
          <button type="button" className={tab === 'skills' ? 'is-active' : ''} onClick={() => setTab('skills')}>Skills</button>
        </div>
        <div className="directory-tools">
          <label className="page-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab === 'plugins' ? 'capabilities' : 'skills'}`}/></label>
          <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Directory filter">
            <option value="all">All sources</option><option value="installed">Installed</option><option value="bundled">Bundled</option><option value="user">Personal</option><option value="project">Project</option><option value="system">System</option>
          </select>
        </div>
        {warnings.map((warning) => (
          <p key={`${warning.scope}:${warning.path}`} className="page-inline-error" role="alert">
            <AlertTriangle size={13} /> {warning.scope === 'project' ? 'Project' : 'Personal'} {warning.message} ({warning.path})
          </p>
        ))}
        {computerUseAlert ? <p className="page-inline-error" role="alert"><AlertTriangle size={13}/> {computerUseAlert}</p> : null}
        {mcpSupportAlert ? <p className="page-inline-error" role="alert"><AlertTriangle size={13}/> {mcpSupportAlert}</p> : null}
        {harness === 'prime' ? <p className="connection-warning"><ShieldCheck size={13}/> Prime MCP integrations require a matching Python skill package and an HTTP server definition. GooeyPi installs both through one guided flow.</p> : null}
        {harness === 'pi' && !piMcpAdapterInstalled ? <p className="connection-warning"><ShieldCheck size={13}/> Pi core has no MCP client. Enable Pi MCP Adapter below before adding servers.</p> : null}
        <div className="directory-heading"><h2>{filter === 'installed' ? 'Installed' : tab === 'plugins' ? 'Capabilities' : 'Skills'}</h2><span>{visible.length} available</span></div>
        {visible.length ? (
          <div className="directory-list">{visible.map((skill) => (
            <article key={skill.id}>
              <span className={`directory-icon directory-icon--${skill.kind}`}><SkillIcon skill={skill}/></span>
              <div><div><h3>{skill.name}</h3><span>{skill.location}</span></div><p>{skill.description}</p></div>
              {skill.id === 'gooeypi-ask-user' ? (
                <button
                  type="button"
                  className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'}
                  aria-label={`${skill.enabled ? 'Disable' : 'Enable'} Ask user`}
                  aria-pressed={skill.enabled}
                  disabled={askUserUpdating}
                  onClick={() => void toggleAskUser()}
                >{skill.enabled ? <Check size={14}/> : <Plus size={14}/>}</button>
              ) : skill.id === 'gooeypi-computer-use' ? (
                <button
                  type="button"
                  className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'}
                  aria-label={`${skill.enabled ? 'Disable' : 'Enable'} Computer Use | TryCUA`}
                  aria-pressed={skill.enabled}
                  disabled={computerUseUpdating}
                  title={skill.availability?.detail}
                  onClick={() => void toggleComputerUse(skill)}
                >{skill.enabled ? <Check size={14}/> : <Plus size={14}/>}</button>
              ) : skill.id === 'gooeypi-pi-mcp' ? (
                <button
                  type="button"
                  className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'}
                  aria-label={`${skill.enabled ? 'Disable' : 'Enable'} Pi MCP Adapter`}
                  aria-pressed={skill.enabled}
                  disabled={mcpSupportUpdating}
                  title={skill.enabled ? 'Disabling removes the adapter package but keeps server definitions and credentials.' : 'Enabling installs npm:pi-mcp-adapter through Pi.'}
                  onClick={() => void toggleMcpSupport(skill)}
                >{skill.enabled ? <Check size={14}/> : <Plus size={14}/>}</button>
              ) : (
                <span className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'} aria-label={`${skill.enabled ? 'Enabled' : 'Unavailable'} ${skill.name}`}>{skill.enabled ? <Check size={14}/> : <Plus size={14}/>}</span>
              )}
            </article>
          ))}</div>
        ) : <EmptyState icon={<Sparkles size={23}/>} title="Nothing here yet">Try another filter or add a capability package supported by {HARNESS_SHORT_NAMES[harness]}.</EmptyState>}

        {addOpen ? (
          <Modal
            title={addKind ? `Add ${addKind === 'mcp' ? 'MCP server' : addKind === 'extension' ? 'extension' : PACKAGE_LABELS[harness].toLowerCase()}` : `Add a ${HARNESS_SHORT_NAMES[harness]} capability`}
            onClose={() => setAddOpen(false)}
            footer={addKind
              ? <><button type="button" className="button" onClick={() => selectAddKind(null)}><ArrowLeft size={13}/> Back</button><button type="button" className="button button--primary" disabled={!canAdd || adding} onClick={() => void add()}>{adding ? (addKind === 'mcp' ? 'Saving…' : 'Installing…') : (addKind === 'mcp' ? 'Save server configuration' : addKind === 'extension' ? 'Install extension' : `Install ${harness === 'omp' ? 'plugin' : 'package'}`)}</button></>
              : <button type="button" className="button" onClick={() => setAddOpen(false)}>Cancel</button>}
          >
            {addKind === null ? (
              <div className="capability-choice-list">
                <button type="button" disabled={harness === 'pi' && !piMcpAdapterInstalled} onClick={() => selectAddKind('mcp')}>
                  <span><Globe2 size={17}/></span><span><strong>Add MCP</strong><small>{harness === 'pi' && !piMcpAdapterInstalled ? 'Enable Pi MCP Adapter first' : harness === 'prime' ? 'Install the matching integration and add its server' : 'Connect a server using this harness’s MCP format'}</small></span><ChevronRight size={15}/>
                </button>
                <button type="button" onClick={() => selectAddKind('bundle')}>
                  <span><Package size={17}/></span><span><strong>Add {harness === 'omp' ? 'Plugin' : 'Package'}</strong><small>{PACKAGE_HELP[harness]}</small></span><ChevronRight size={15}/>
                </button>
                <button type="button" onClick={() => selectAddKind('extension')}>
                  <span><FileCode2 size={17}/></span><span><strong>Add Extension</strong><small>Install one local JavaScript or TypeScript extension module for {HARNESS_SHORT_NAMES[harness]}.</small></span><ChevronRight size={15}/>
                </button>
              </div>
            ) : addKind === 'bundle' ? (
              <div className="add-tool-form">
                <p className="modal-intro">{PACKAGE_HELP[harness]} This installs executable code; it does not connect to an arbitrary MCP endpoint.</p>
                <label className="field"><span>{PACKAGE_LABELS[harness]} source</span><input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder={harness === 'omp' ? 'plugin-name@marketplace' : 'npm:@scope/package'}/></label>
                <small className="field-help">{harness === 'omp' ? <>Examples: <code>name@marketplace</code>, a Git URL, or an absolute local folder path.</> : <>Examples: a Git URL, <code>npm:@scope/package</code>, or an absolute local folder path.</>}</small>
              </div>
            ) : addKind === 'extension' ? (
              <div className="add-tool-form">
                <p className="modal-intro">{harness === 'omp'
                  ? 'OMP installs standalone modules into its native extensions directory. Use Add Plugin instead when the source is a bundle with a package.json manifest.'
                  : `${HARNESS_SHORT_NAMES[harness]} records a standalone local extension file through its native package manager. The original file remains the source of truth.`}</p>
                <label className="field"><span>Extension file</span><input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder="/absolute/path/to/my-extension.ts"/></label>
                <small className="field-help">Choose an absolute local <code>.ts</code>, <code>.js</code>, <code>.mjs</code>, or <code>.cjs</code> file. Extensions run with your user permissions.</small>
                <label className="field"><span>Available in</span><select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpScope)}><option value="user">All projects (personal)</option><option value="project" disabled={!activeProjectPath}>Current project</option></select></label>
                <p className="connection-warning"><ShieldCheck size={13}/> Extension APIs differ between harnesses. GooeyPi installs the file correctly, but CLI-specific UI may not render in the desktop app.</p>
              </div>
            ) : (
              <div className="add-tool-form">
                <p className="modal-intro">{harness === 'prime'
                  ? 'Install a trusted Prime package containing the matching Python-backed integration skill, then save its HTTP server definition.'
                  : harness === 'omp'
                  ? 'Add a basic server to OMP’s native MCP configuration. Advanced OAuth, headers, and environment settings remain available through OMP’s own MCP commands and config.'
                  : 'Add a server to pi-mcp-adapter’s configuration. This does not start or test the server.'}</p>
                {harness === 'prime' ? <><label className="field"><span>Integration package source</span><input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder="npm:@scope/prime-integration"/></label><small className="field-help">The package must provide a Python-backed skill whose integration name matches the server name.</small></> : null}
                <label className="field"><span>Server name</span><input autoFocus value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="my-local-tools"/></label>
                {harness === 'prime' ? null : <div className="field"><span>Connection</span><Segmented value={mcpTransport} options={[{ value: 'http', label: 'Server / Studio URL' }, { value: 'stdio', label: 'Local command' }]} onChange={(value) => setMcpTransport(value as McpTransport)} label="MCP connection type"/></div>}
                {mcpTransport === 'http' ? (
                  <><label className="field"><span>Server URL</span><input value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} inputMode="url" placeholder="https://example.com/mcp"/></label><small className="field-help">{MCP_HTTP_HELP[harness]}</small><label className="field"><span>Authentication</span><select value={mcpAuth} onChange={(event) => setMcpAuth(event.target.value as McpAuth)}><option value="none">None / configured by server</option><option value="oauth">OAuth — sign in after saving</option><option value="bearer">Bearer token from environment</option></select></label>{mcpAuth === 'bearer' ? <><label className="field"><span>Token environment variable</span><input value={mcpBearerEnv} onChange={(event) => setMcpBearerEnv(event.target.value)} placeholder="MY_MCP_TOKEN"/></label><small className="field-help">GooeyPi stores only this variable name. Set the token in the environment that launches the app.</small></> : null}</>
                ) : (
                  <><p className="field-help">{MCP_STDIO_HELP[harness]}</p><label className="field"><span>Executable</span><input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="npx"/></label><label className="field"><span>Arguments <small>(one per line)</small></span><textarea value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} rows={3} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/project'}/></label></>
                )}
                <label className="field"><span>Available in</span><select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpScope)}><option value="user">All projects (personal)</option><option value="project" disabled={!activeProjectPath}>Current project</option></select></label>
                <p className="connection-warning"><ShieldCheck size={13}/> Only connect servers you trust. MCP tools can read data or run actions with your user permissions.</p>
              </div>
            )}
            {addKind === 'bundle' || addKind === 'extension' ? <p className="capability-compatibility-note"><AlertTriangle size={13}/><span>Not every third-party {addKind === 'bundle' ? (harness === 'omp' ? 'plugin' : 'package') : 'extension'} will work in GooeyPi. If something fails, <button type="button" onClick={() => onOpenExternal(GITHUB_ISSUES_URL)}>create a GitHub issue</button>.</span></p> : null}
            {result ? <pre className="install-output" role="status">{result}</pre> : null}
            {loginCommand ? <div className="add-tool-form"><button type="button" className="button button--primary" disabled={!activeProjectPath} onClick={() => void onRunMcpCommand(loginCommand)}>Open session and sign in</button>{!activeProjectPath ? <small className="field-help">Open a project first, then run <code>{loginCommand}</code> in its session.</small> : <small className="field-help">Runs <code>{loginCommand}</code> through {HARNESS_SHORT_NAMES[harness]} so it owns the OAuth flow and credentials.</small>}</div> : null}
          </Modal>
        ) : null}
      </div>
    </div>
  )
}
