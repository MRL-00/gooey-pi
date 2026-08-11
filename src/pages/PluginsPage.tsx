import { AlertTriangle, BookOpen, Check, FileText, Github, Globe2, Package, Palette, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, WandSparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { HarnessId, McpConnectionInput, PluginWarning, SkillRecord } from '@/types/api'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { EmptyState, Modal, Segmented } from '@/components/ui'

const MCP_HTTP_HELP: Record<HarnessId, string> = {
  omp: 'OMP loads this MCP endpoint directly when a new session starts.',
  prime: 'Use the MCP endpoint shown by your local Studio or server. Prime Agent also needs a matching MCP integration skill to expose its tools.',
  pi: 'Pi loads this MCP endpoint through the pi-mcp-adapter extension (pi install npm:pi-mcp-adapter) when a new session starts.',
}

const MCP_STDIO_HELP: Record<HarnessId, string> = {
  omp: 'OMP starts this stdio MCP server directly in each new session.',
  prime: 'Local command definitions are saved for package-specific bridges; Prime Agent 0.7 does not expose arbitrary stdio servers by itself.',
  pi: 'Pi starts this stdio MCP server through the pi-mcp-adapter extension (pi install npm:pi-mcp-adapter) in each new session.',
}

type DirectoryTab = 'plugins' | 'skills'
type AddKind = 'mcp' | 'repository'
type McpTransport = 'http' | 'stdio'
type McpScope = 'user' | 'project'

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
  onInstall(source: string): Promise<{ ok: boolean; output: string }>
  onConnectMcp(input: McpConnectionInput): Promise<{ ok: boolean; output: string }>
}

export function PluginsPage({ harness, skills, warnings, loading, activeProjectPath, onRefresh, onInstall, onConnectMcp }: PluginsPageProps) {
  const [tab, setTab] = useState<DirectoryTab>('plugins')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [addOpen, setAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<AddKind>('mcp')
  const [source, setSource] = useState('')
  const [mcpName, setMcpName] = useState('')
  const [mcpTransport, setMcpTransport] = useState<McpTransport>('http')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpScope, setMcpScope] = useState<McpScope>('user')
  const [result, setResult] = useState('')
  const [adding, setAdding] = useState(false)

  const visible = useMemo(() => skills.filter((skill) =>
    (tab === 'skills' ? skill.kind === 'skill' || skill.kind === 'prompt' : skill.kind !== 'skill' && skill.kind !== 'prompt')
    && (filter === 'all' || filter === 'installed' && skill.enabled || filter === skill.location)
    && `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())
  ), [skills, tab, filter, query])

  const canAdd = addKind === 'repository'
    ? Boolean(source.trim())
    : Boolean(mcpName.trim() && (mcpTransport === 'http' ? mcpUrl.trim() : mcpCommand.trim()) && (mcpScope !== 'project' || activeProjectPath))

  const add = async () => {
    if (!canAdd) return
    setAdding(true)
    setResult('')
    try {
      const response = addKind === 'repository'
        ? await onInstall(source.trim())
        : await onConnectMcp(mcpTransport === 'http'
          ? { name: mcpName.trim(), scope: mcpScope, projectPath: mcpScope === 'project' ? activeProjectPath : undefined, type: 'http', url: mcpUrl.trim() }
          : { name: mcpName.trim(), scope: mcpScope, projectPath: mcpScope === 'project' ? activeProjectPath : undefined, type: 'stdio', command: mcpCommand.trim(), args: mcpArgs.split('\n').map((arg) => arg.trim()).filter(Boolean) })
      setResult(response.output)
      if (response.ok) {
        setSource('')
        setMcpName('')
        setMcpUrl('')
        setMcpCommand('')
        setMcpArgs('')
        if (addKind === 'repository') await onRefresh()
      }
    } finally {
      setAdding(false)
    }
  }

  const selectAddKind = (value: AddKind) => { setAddKind(value); setResult('') }
  const openAdd = () => { setResult(''); setAddOpen(true) }

  return (
    <div className="page plugin-page scroll-area">
      <div className="page-container plugin-container">
        <header className="plugin-header">
          <div><span className="eyebrow">{HARNESS_SHORT_NAMES[harness]} directory</span><h1>Make {HARNESS_SHORT_NAMES[harness]} work your way</h1><p>Add focused tools and repeatable workflows to every project.</p></div>
          <div>
            <button type="button" className="button" onClick={() => void onRefresh()}><RefreshCw className={loading ? 'spin' : ''} size={13}/> Refresh</button>
            <button type="button" className="button" onClick={() => setFilter('installed')}><Settings2 size={13}/> Manage</button>
            <button type="button" className="button button--primary" onClick={openAdd}><Plus size={14}/> Add</button>
          </div>
        </header>
        <div className="directory-tabs">
          <button type="button" className={tab === 'plugins' ? 'is-active' : ''} onClick={() => setTab('plugins')}>Plugins</button>
          <button type="button" className={tab === 'skills' ? 'is-active' : ''} onClick={() => setTab('skills')}>Skills</button>
        </div>
        <div className="directory-tools">
          <label className="page-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab}`}/></label>
          <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Directory filter">
            <option value="all">All sources</option><option value="installed">Installed</option><option value="bundled">Bundled</option><option value="user">Personal</option><option value="project">Project</option><option value="system">System</option>
          </select>
        </div>
        {warnings.map((warning) => (
          <p key={`${warning.scope}:${warning.path}`} className="page-inline-error" role="alert">
            <AlertTriangle size={13} /> {warning.scope === 'project' ? 'Project' : 'Personal'} {warning.message} ({warning.path})
          </p>
        ))}
        <div className="directory-heading"><h2>{filter === 'installed' ? 'Installed' : tab === 'plugins' ? 'Plugins' : 'Skills'}</h2><span>{visible.length} available</span></div>
        {visible.length ? (
          <div className="directory-list">{visible.map((skill) => (
            <article key={skill.id}>
              <span className={`directory-icon directory-icon--${skill.kind}`}><SkillIcon skill={skill}/></span>
              <div><div><h3>{skill.name}</h3><span>{skill.location}</span></div><p>{skill.description}</p></div>
              <span className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'} aria-label={`${skill.enabled ? 'Enabled' : 'Unavailable'} ${skill.name}`}>{skill.enabled ? <Check size={14}/> : <Plus size={14}/>}</span>
            </article>
          ))}</div>
        ) : <EmptyState icon={<Sparkles size={23}/>} title="Nothing here yet">Try another filter, connect an MCP server, or add a repository package.</EmptyState>}

        {addOpen ? (
          <Modal
            title={`Add tools to ${HARNESS_SHORT_NAMES[harness]}`}
            onClose={() => setAddOpen(false)}
            footer={<><button type="button" className="button" onClick={() => setAddOpen(false)}>Cancel</button><button type="button" className="button button--primary" disabled={!canAdd || adding} onClick={() => void add()}>{adding ? (addKind === 'mcp' ? 'Saving…' : 'Installing…') : (addKind === 'mcp' ? 'Save server configuration' : 'Install package')}</button></>}
          >
            <Segmented value={addKind} options={[{ value: 'mcp', label: 'MCP server' }, { value: 'repository', label: 'Repository package' }]} onChange={selectAddKind} label="What to add"/>
            {addKind === 'repository' ? (
              <div className="add-tool-form">
                <p className="modal-intro">Install a capability package from a trusted Git repository, npm source, or local package folder. This installs code; it does not connect to a running MCP server.</p>
                <label className="field"><span>Repository or package source</span><input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder="https://github.com/owner/agent-plugin"/></label>
                <small className="field-help">Examples: a Git URL, <code>npm:@scope/package</code>, or an absolute local folder path.</small>
              </div>
            ) : (
              <div className="add-tool-form">
                <p className="modal-intro">Save the endpoint or command that an MCP integration package will use. This does not install an integration or test the server.</p>
                <label className="field"><span>Server name</span><input autoFocus value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="my-local-tools"/></label>
                <div className="field"><span>Connection</span><Segmented value={mcpTransport} options={[{ value: 'http', label: 'Server / Studio URL' }, { value: 'stdio', label: 'Local command' }]} onChange={(value) => setMcpTransport(value as McpTransport)} label="MCP connection type"/></div>
                {mcpTransport === 'http' ? (
                  <><label className="field"><span>Server URL</span><input value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} inputMode="url" placeholder="http://127.0.0.1:3000/mcp"/></label><small className="field-help">{MCP_HTTP_HELP[harness]}</small></>
                ) : (
                  <><p className="field-help">{MCP_STDIO_HELP[harness]}</p><label className="field"><span>Executable</span><input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="npx"/></label><label className="field"><span>Arguments <small>(one per line)</small></span><textarea value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} rows={3} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/project'}/></label></>
                )}
                <label className="field"><span>Available in</span><select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpScope)}><option value="user">All projects (personal)</option><option value="project" disabled={!activeProjectPath}>Current project</option></select></label>
                <p className="connection-warning"><ShieldCheck size={13}/> Only connect servers you trust. MCP tools can read data or run actions with your user permissions.</p>
              </div>
            )}
            {result ? <pre className="install-output" role="status">{result}</pre> : null}
          </Modal>
        ) : null}
      </div>
    </div>
  )
}
