import { BookOpen, Bot, Check, Code2, FileText, Github, Globe2, Package, Palette, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, WandSparkles, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { SkillRecord } from '@/types/api'
import { EmptyState, IconButton, Modal, Segmented } from '@/components/ui'

type DirectoryTab = 'plugins' | 'skills'

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

export function PluginsPage({ skills, loading, onRefresh, onInstall}: { skills: SkillRecord[]; loading: boolean; onRefresh(): Promise<void>; onInstall(source: string): Promise<{ ok: boolean; output: string }> }) {
  const [tab, setTab] = useState<DirectoryTab>('plugins')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [installOpen, setInstallOpen] = useState(false)
  const [source, setSource] = useState('')
  const [result, setResult] = useState('')
  const [installing, setInstalling] = useState(false)
  const visible = useMemo(() => skills.filter((skill) => (tab === 'skills' ? skill.kind === 'skill' || skill.kind === 'prompt' : skill.kind !== 'skill' && skill.kind !== 'prompt') && (filter === 'all' || filter === 'installed' && skill.enabled || filter === skill.location) && `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())), [skills, tab, filter, query])
  const install = async () => { if (!source.trim()) return; setInstalling(true); const response = await onInstall(source.trim()); setResult(response.output); setInstalling(false); if (response.ok) { setSource(''); await onRefresh() } }
  return <div className="page plugin-page scroll-area"><div className="page-container plugin-container"><header className="plugin-header"><div><span className="eyebrow">Prime directory</span><h1>Make Prime work your way</h1><p>Add focused tools and repeatable workflows to every project.</p></div><div><button type="button" className="button" onClick={()=>void onRefresh()}><RefreshCw className={loading?'spin':''} size={13}/> Refresh</button><button type="button" className="button" onClick={()=>setFilter('installed')}><Settings2 size={13}/> Manage</button><button type="button" className="button button--primary" onClick={()=>setInstallOpen(true)}><Plus size={14}/> Install</button></div></header><div className="directory-tabs"><button type="button" className={tab==='plugins'?'is-active':''} onClick={()=>setTab('plugins')}>Plugins</button><button type="button" className={tab==='skills'?'is-active':''} onClick={()=>setTab('skills')}>Skills</button></div><section className="feature-strip"><span className="feature-strip__mark"><ShieldCheck size={20}/></span><div><span>Featured for local work</span><h2>Browser preview & review</h2><p>Preview local apps, leave precise page comments, and bring visual feedback back into the session.</p></div><div className="feature-strip__steps"><span><i>1</i>Open a local route</span><span><i>2</i>Annotate the UI</span><span><i>3</i>Ask Prime to fix it</span></div></section><div className="directory-tools"><label className="page-search"><Search size={14}/><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder={`Search ${tab}`}/></label><select value={filter} onChange={(event)=>setFilter(event.target.value)} aria-label="Directory filter"><option value="all">All sources</option><option value="installed">Installed</option><option value="bundled">Bundled</option><option value="user">Personal</option><option value="project">Project</option><option value="system">System</option></select></div><div className="directory-heading"><h2>{filter==='installed'?'Installed':tab==='plugins'?'Plugins':'Skills'}</h2><span>{visible.length} available</span></div>{visible.length ? <div className="directory-list">{visible.map((skill)=><article key={skill.id}><span className={`directory-icon directory-icon--${skill.kind}`}><SkillIcon skill={skill}/></span><div><div><h3>{skill.name}</h3><span>{skill.location}</span></div><p>{skill.description}</p></div><span className={skill.enabled?'plugin-toggle is-enabled':'plugin-toggle'} aria-label={`${skill.enabled?'Enabled':'Unavailable'} ${skill.name}`}>{skill.enabled?<Check size={14}/>:<Plus size={14}/>}</span></article>)}</div> : <EmptyState icon={<Sparkles size={23}/>} title="Nothing here yet">Try another filter or install from a Git URL or local path.</EmptyState>}{installOpen?<Modal title="Install a plugin or skill" onClose={()=>setInstallOpen(false)} footer={<><button type="button" className="button" onClick={()=>setInstallOpen(false)}>Cancel</button><button type="button" className="button button--primary" disabled={!source.trim()||installing} onClick={()=>void install()}>{installing?'Installing…':'Install'}</button></>}><p className="modal-intro">Enter a trusted Git URL, package source, or local path. Installed extensions can execute code with your user permissions.</p><label className="field"><span>Source</span><input autoFocus value={source} onChange={(event)=>setSource(event.target.value)} placeholder="https://github.com/owner/prime-plugin"/></label>{result?<pre className="install-output">{result}</pre>:null}</Modal>:null}</div></div>
}
