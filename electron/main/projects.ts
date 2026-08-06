import { createHash, randomUUID } from 'node:crypto'
import { basename, relative, resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import type { ProjectFileEntry, ProjectRecord, SessionRecord } from '../../src/types/api'
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
    const canonicalSessionPaths = new Map<string, string>()
    await Promise.all([...new Set(sessions.map((session) => session.projectPath))].map(async (path) => {
      try { canonicalSessionPaths.set(path, await requireExistingDirectory(path, 'session project path')) }
      catch { canonicalSessionPaths.set(path, resolve(path)) }
    }))
    const sessionProjectPaths = new Map(sessions.map((session) => [session, canonicalSessionPaths.get(session.projectPath)!]))
    const snapshot = this.store.snapshot()
    const persisted = snapshot.projects
    const dismissed = new Set(await Promise.all(snapshot.dismissedProjectPaths.map(async (path) => {
      try { return await requireExistingDirectory(path, 'dismissed project path') } catch { return resolve(path) }
    })))
    const records: ProjectRecord[] = []
    const represented = new Set<string>()
    this.authorizedRoots.clear()

    for (const project of persisted) {
      const folderSet = new Set(await Promise.all(project.folders.map(async (path) => {
        try { return await requireExistingDirectory(path, 'project folder') } catch { return resolve(path) }
      })))
      for (const folder of folderSet) this.authorizedRoots.add(folder)
      for (const folder of folderSet) represented.add(folder)
      records.push({
        ...project,
        sessionCount: sessions.filter((session) => folderSet.has(sessionProjectPaths.get(session)!)).length,
        gitBranch: await this.branchProvider(project.primaryFolder),
      })
    }

    for (const projectPath of [...new Set(sessions.map((session) => session.projectPath).filter(Boolean))]) {
      let canonical: string
      try { canonical = await requireExistingDirectory(projectPath, 'session project path') } catch { continue }
      if (represented.has(canonical) || dismissed.has(canonical)) continue
      if (canonical === resolve('/') || canonical === resolve(homedir())) continue
      represented.add(canonical)
      const projectSessions = sessions.filter((session) => sessionProjectPaths.get(session) === canonical)
      const timestamps = projectSessions.map((session) => session.updatedAt).sort()
      const created = projectSessions.map((session) => session.createdAt).sort()
      records.push({
        id: inferredId(canonical),
        name: basename(canonical) || canonical,
        path: canonical,
        folders: [canonical],
        primaryFolder: canonical,
        pinned: false,
        createdAt: created[0] ?? new Date().toISOString(),
        lastOpenedAt: timestamps.at(-1) ?? new Date().toISOString(),
        sessionCount: projectSessions.length,
        gitBranch: undefined,
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
      state.dismissedProjectPaths = state.dismissedProjectPaths.filter((item) => resolve(item) !== path)
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
    let discovered = false
    for (const session of sessions) {
      try {
        if (await requireExistingDirectory(session.projectPath, 'session project path') === path) { discovered = true; break }
      } catch { /* Ignore stale session project paths. */ }
    }
    if (!discovered) throw new TypeError('Project path was not discovered from a Prime session')
    const now = new Date().toISOString()
    const project = await this.store.update((state): PersistedProject => {
      state.dismissedProjectPaths = state.dismissedProjectPaths.filter((item) => resolve(item) !== path)
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
    const persisted = this.store.snapshot().projects.find((project) => project.id === id)
    const persistedPaths = persisted ? await Promise.all(persisted.folders.map(async (folder) => {
      try { return await requireExistingDirectory(folder, 'project folder') } catch { return resolve(folder) }
    })) : []
    let inferredPath: string | undefined
    if (!persisted) {
      const sessions = await this.sessionProvider()
      for (const pathValue of [...new Set(sessions.map((session) => session.projectPath).filter(Boolean))]) {
        try {
          const path = await requireExistingDirectory(pathValue, 'session project path')
          if (inferredId(path) === id && path !== resolve('/') && path !== resolve(homedir())) { inferredPath = path; break }
        } catch { /* Not a removable inferred project. */ }
      }
    }
    const removed = await this.store.update((state) => {
      const index = state.projects.findIndex((project) => project.id === id)
      const paths = index >= 0 ? persistedPaths : inferredPath ? [inferredPath] : []
      if (!paths.length) return false
      if (index >= 0) state.projects.splice(index, 1)
      const dismissed = new Set(state.dismissedProjectPaths.map((path) => resolve(path)))
      for (const path of paths) dismissed.add(path)
      state.dismissedProjectPaths = [...dismissed]
      return true
    })
    if (removed) {
      this.authorizedRoots.clear()
      for (const project of this.store.snapshot().projects) {
        for (const folder of project.folders) {
          try { this.authorizedRoots.add(await requireExistingDirectory(folder, 'project folder')) } catch { /* Missing projects are not authorized. */ }
        }
      }
    }
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

  async listFiles(rootValue: unknown): Promise<ProjectFileEntry[]> {
    const root = await this.authorizeCwd(rootValue as string)
    const entries: ProjectFileEntry[] = []
    const ignoredDirectories = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'release', 'coverage', '.next', '.venv'])
    const maxEntries = 5_000

    const visit = async (directory: string): Promise<void> => {
      if (entries.length >= maxEntries) return
      const children = await readdir(directory, { withFileTypes: true })
      children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const child of children) {
        if (entries.length >= maxEntries) break
        if (child.isSymbolicLink()) continue
        if (child.isDirectory() && ignoredDirectories.has(child.name)) continue
        if (!child.isDirectory() && !child.isFile()) continue
        const absolutePath = resolve(directory, child.name)
        const path = relative(root, absolutePath).split('\\').join('/')
        entries.push({ path, type: child.isDirectory() ? 'directory' : 'file' })
        if (child.isDirectory()) await visit(absolutePath)
      }
    }

    await visit(root)
    return entries
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
