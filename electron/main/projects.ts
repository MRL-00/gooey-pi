import { createHash, randomUUID } from 'node:crypto'
import { basename, relative, resolve } from 'node:path'
import { lstat, readdir } from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import type { ProjectFileEntry, ProjectRecord, SessionRecord } from '../../src/types/api'
import type { FolderIdentity, JsonStateStore, PersistedProject } from './store'
import { isPathWithin, requireExistingDirectory, requireExistingPath, requireId } from './validation'

function inferredId(path: string): string {
  return `inferred-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`
}

export class ProjectService {
  private readonly authorizedRoots = new Map<string, FolderIdentity>()
  private authorizationRevision = 0
  private sessionProvider: () => Promise<SessionRecord[]> = async () => []
  private branchProvider: (cwd: string) => Promise<string | undefined> = async () => undefined

  constructor(private readonly store: JsonStateStore, private readonly windowProvider: () => BrowserWindow | null) {}

  private async captureFolderIdentity(pathValue: string): Promise<{ path: string; identity: FolderIdentity }> {
    const configured = resolve(pathValue)
    const path = await requireExistingDirectory(configured, 'project folder')
    const info = await lstat(configured, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('Project folder must be a stable directory')
    return { path, identity: { dev: info.dev.toString(), ino: info.ino.toString() } }
  }

  private async verifyFolderIdentity(pathValue: string, expected?: FolderIdentity): Promise<string | undefined> {
    if (!expected) return undefined
    try {
      const current = await this.captureFolderIdentity(pathValue)
      return current.identity.dev === expected.dev && current.identity.ino === expected.ino ? current.path : undefined
    } catch { return undefined }
  }

  bindProviders(providers: { sessions(): Promise<SessionRecord[]>; branch(cwd: string): Promise<string | undefined> }): void {
    this.sessionProvider = providers.sessions
    this.branchProvider = providers.branch
  }

  async list(): Promise<ProjectRecord[]> {
    const authorizationRevision = this.authorizationRevision
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
    if (authorizationRevision === this.authorizationRevision) this.authorizedRoots.clear()

    for (const project of persisted) {
      const folderSet = new Set<string>()
      let primaryGranted = false
      for (const folder of project.folders) {
        const configured = resolve(folder)
        let canonical = configured
        try { canonical = await requireExistingDirectory(configured, 'project folder') } catch { /* Keep stale lexical path visible. */ }
        const expected = project.folderIdentities?.[configured] ?? project.folderIdentities?.[canonical]
        const verified = await this.verifyFolderIdentity(configured, expected)
        folderSet.add(canonical)
        represented.add(configured)
        represented.add(canonical)
        if (verified && expected) {
          if (configured === resolve(project.primaryFolder)) primaryGranted = true
          if (authorizationRevision === this.authorizationRevision) this.authorizedRoots.set(configured, expected)
        }
      }
      records.push({
        id: project.id, name: project.name, path: project.path, folders: project.folders, primaryFolder: project.primaryFolder,
        pinned: project.pinned, createdAt: project.createdAt, lastOpenedAt: project.lastOpenedAt,
        sessionCount: sessions.filter((session) => folderSet.has(sessionProjectPaths.get(session)!)).length,
        gitBranch: primaryGranted ? await this.branchProvider(project.primaryFolder) : undefined,
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
    const { path, identity } = await this.captureFolderIdentity(result.filePaths[0])
    const now = new Date().toISOString()
    const project = await this.store.update((state): PersistedProject => {
      state.dismissedProjectPaths = state.dismissedProjectPaths.filter((item) => resolve(item) !== path)
      const existing = state.projects.find((item) => resolve(item.path) === path || item.folders.some((folder) => resolve(folder) === path))
      if (existing) {
        existing.lastOpenedAt = now
        existing.folderIdentities = { ...existing.folderIdentities, [path]: identity }
        return existing
      }
      const created: PersistedProject = {
        id: randomUUID(),
        name: basename(path) || path,
        path,
        folders: [path],
        primaryFolder: path,
        pinned: false,
        createdAt: now,
        lastOpenedAt: now,
        folderIdentities: { [path]: identity },
      }
      state.projects.push(created)
      return created
    })
    this.authorizationRevision += 1
    this.authorizedRoots.set(path, identity)
    const sessions = await this.sessionProvider()
    return { ...project, sessionCount: sessions.filter((session) => resolve(session.projectPath) === path).length, gitBranch: await this.branchProvider(path) }
  }

  async grantInferred(pathValue: unknown): Promise<ProjectRecord> {
    const { path, identity } = await this.captureFolderIdentity(String(pathValue))
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
      if (existing) {
        existing.lastOpenedAt = now
        existing.folderIdentities = { ...existing.folderIdentities, [path]: identity }
        return existing
      }
      const created: PersistedProject = { id: randomUUID(), name: basename(path) || path, path, folders: [path], primaryFolder: path, pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: { [path]: identity } }
      state.projects.push(created)
      return created
    })
    this.authorizationRevision += 1
    this.authorizedRoots.set(path, identity)
    return { ...project, sessionCount: sessions.filter((session) => resolve(session.projectPath) === path).length, gitBranch: await this.branchProvider(path) }
  }

  async remove(idValue: unknown): Promise<boolean> {
    const authorizationRevision = ++this.authorizationRevision
    const id = requireId(idValue, 'project id')
    const persisted = this.store.snapshot().projects.find((project) => project.id === id)
    const persistedPaths: string[] = []
    if (persisted) for (const folder of persisted.folders) {
      const configured = resolve(folder)
      persistedPaths.push(configured)
      try {
        const canonical = await requireExistingDirectory(configured, 'project folder')
        if (canonical !== configured) persistedPaths.push(canonical)
      } catch { /* Keep the lexical path dismissed even when it is stale. */ }
    }
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
    if (removed && authorizationRevision === this.authorizationRevision) {
      this.authorizedRoots.clear()
      for (const project of this.store.snapshot().projects) {
        for (const folder of project.folders) {
          if (authorizationRevision !== this.authorizationRevision) break
          const configured = resolve(folder)
          let canonical = configured
          try { canonical = await requireExistingDirectory(configured, 'project folder') } catch { /* stale */ }
          const expected = project.folderIdentities?.[configured] ?? project.folderIdentities?.[canonical]
          const verified = await this.verifyFolderIdentity(configured, expected)
          if (verified && expected) this.authorizedRoots.set(configured, expected)
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
    for (const [configured, expected] of this.authorizedRoots) {
      const verified = await this.verifyFolderIdentity(configured, expected)
      if (verified) roots.push(verified)
      else this.authorizedRoots.delete(configured)
    }
    if (!roots.some((root) => isPathWithin(root, path))) throw new TypeError('path is not inside an added Prime Work project or its folder identity changed')
    return path
  }

  async authorizeCwd(value: string): Promise<string> {
    const cwd = await requireExistingDirectory(value, 'cwd')
    await this.authorizePath(cwd)
    return cwd
  }
}
