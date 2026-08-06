import { createHash, randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'
import type { JsonStateStore, PersistedProject } from './store'
import { isPathWithin, requireExistingDirectory, requireExistingPath, requireId } from './validation'

function inferredId(path: string): string {
  return `inferred-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`
}

export class ProjectService {
  private readonly authorizedRoots = new Set<string>()
  private sessionProvider: () => Promise<SessionRecord[]> = async () => []
  private branchProvider: (cwd: string) => Promise<string | undefined> = async () => undefined

  constructor(private readonly store: JsonStateStore, private readonly windowProvider: () => BrowserWindow | null) {}

  bindProviders(providers: { sessions(): Promise<SessionRecord[]>; branch(cwd: string): Promise<string | undefined> }): void {
    this.sessionProvider = providers.sessions
    this.branchProvider = providers.branch
  }

  async list(): Promise<ProjectRecord[]> {
    const sessions = await this.sessionProvider()
    const persisted = this.store.snapshot().projects
    const records: ProjectRecord[] = []
    const represented = new Set<string>()
    this.authorizedRoots.clear()

    for (const project of persisted) {
      const folderSet = new Set(project.folders.map((path) => resolve(path)))
      for (const folder of folderSet) this.authorizedRoots.add(folder)
      represented.add(resolve(project.path))
      records.push({
        ...project,
        sessionCount: sessions.filter((session) => folderSet.has(resolve(session.projectPath))).length,
        gitBranch: await this.branchProvider(project.primaryFolder),
      })
    }

    for (const projectPath of [...new Set(sessions.map((session) => session.projectPath).filter(Boolean))]) {
      const canonical = resolve(projectPath)
      if (represented.has(canonical)) continue
      try { await requireExistingDirectory(canonical, 'session project path') } catch { continue }
      if (canonical === resolve('/') || canonical === resolve(homedir())) continue
      represented.add(canonical)
      const timestamps = sessions.filter((session) => resolve(session.projectPath) === canonical).map((session) => session.updatedAt).sort()
      const created = sessions.filter((session) => resolve(session.projectPath) === canonical).map((session) => session.createdAt).sort()
      records.push({
        id: inferredId(canonical),
        name: basename(canonical) || canonical,
        path: canonical,
        folders: [canonical],
        primaryFolder: canonical,
        pinned: false,
        createdAt: created[0] ?? new Date().toISOString(),
        lastOpenedAt: timestamps.at(-1) ?? new Date().toISOString(),
        sessionCount: sessions.filter((session) => resolve(session.projectPath) === canonical).length,
        gitBranch: await this.branchProvider(canonical),
        inferred: true,
      })
    }
    return records.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))
  }

  async add(): Promise<ProjectRecord | null> {
    const parent = this.windowProvider()
    const result = parent
      ? await dialog.showOpenDialog(parent, { title: 'Add project folder', properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: 'Add project folder', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length !== 1) return null
    const path = await requireExistingDirectory(result.filePaths[0], 'selected folder')
    const now = new Date().toISOString()
    const project = await this.store.update((state): PersistedProject => {
      const existing = state.projects.find((item) => resolve(item.path) === path || item.folders.some((folder) => resolve(folder) === path))
      if (existing) { existing.lastOpenedAt = now; return existing }
      const created: PersistedProject = {
        id: randomUUID(),
        name: basename(path) || path,
        path,
        folders: [path],
        primaryFolder: path,
        pinned: false,
        createdAt: now,
        lastOpenedAt: now,
      }
      state.projects.push(created)
      return created
    })
    this.authorizedRoots.add(path)
    const sessions = await this.sessionProvider()
    return { ...project, sessionCount: sessions.filter((session) => resolve(session.projectPath) === path).length, gitBranch: await this.branchProvider(path) }
  }

  async grantInferred(pathValue: unknown): Promise<ProjectRecord> {
    const path = await requireExistingDirectory(pathValue, 'session project path')
    if (path === resolve('/') || path === resolve(homedir())) throw new TypeError('Broad filesystem roots cannot be inferred as projects')
    const sessions = await this.sessionProvider()
    if (!sessions.some((session) => resolve(session.projectPath) === path)) throw new TypeError('Project path was not discovered from a Prime session')
    const now = new Date().toISOString()
    const project = await this.store.update((state): PersistedProject => {
      const existing = state.projects.find((item) => resolve(item.path) === path || item.folders.some((folder) => resolve(folder) === path))
      if (existing) { existing.lastOpenedAt = now; return existing }
      const created: PersistedProject = { id: randomUUID(), name: basename(path) || path, path, folders: [path], primaryFolder: path, pinned: false, createdAt: now, lastOpenedAt: now }
      state.projects.push(created)
      return created
    })
    this.authorizedRoots.add(path)
    return { ...project, sessionCount: sessions.filter((session) => resolve(session.projectPath) === path).length, gitBranch: await this.branchProvider(path) }
  }

  async remove(idValue: unknown): Promise<boolean> {
    const id = requireId(idValue, 'project id')
    let removedFolders: string[] = []
    const removed = await this.store.update((state) => {
      const index = state.projects.findIndex((project) => project.id === id)
      if (index < 0) return false
      removedFolders = state.projects[index].folders.map((folder) => resolve(folder))
      state.projects.splice(index, 1)
      return true
    })
    if (removed) for (const folder of removedFolders) this.authorizedRoots.delete(folder)
    return removed
  }

  async touch(idValue: unknown): Promise<boolean> {
    const id = requireId(idValue, 'project id')
    return this.store.update((state) => {
      const project = state.projects.find((item) => item.id === id)
      if (!project) return false
      project.lastOpenedAt = new Date().toISOString()
      return true
    })
  }

  async authorizePath(value: string): Promise<string> {
    const path = await requireExistingPath(value)
    if (!this.authorizedRoots.size) await this.list()
    const roots: string[] = []
    for (const configured of this.authorizedRoots) {
      try { roots.push(await requireExistingDirectory(configured, 'project folder')) } catch { /* missing project */ }
    }
    if (!roots.some((root) => isPathWithin(root, path))) throw new TypeError('path is not inside an added Prime Work project')
    return path
  }

  async authorizeCwd(value: string): Promise<string> {
    const cwd = await requireExistingDirectory(value, 'cwd')
    await this.authorizePath(cwd)
    return cwd
  }
}
