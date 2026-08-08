import { createHash, randomUUID } from 'node:crypto'
import { basename, relative, resolve } from 'node:path'
import { lstat, readdir, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dialog, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import type { HarnessId, ProjectFileEntry, ProjectFileListing, ProjectRecord, SessionRecord } from '../../src/types/api'
import type { FolderIdentity, JsonStateStore, PersistedProject } from './store'
import { isPathWithin, requireExistingDirectory, requireExistingPath, requireId, requireString } from './validation'

function inferredId(path: string): string {
  return `inferred-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`
}

/**
 * One ProjectService instance exists per harness. Instances share the one
 * desktop state store but each sees, creates, and authorizes only records of
 * its own harness: a grant made for Prime never authorizes an OMP runtime's
 * cwd and vice versa. Dismissed inferred-project paths remain shared, matching
 * the single dismissedProjectPaths list in persisted state.
 */
export class ProjectService {
  // Reassigned wholesale (build-new-map-then-swap) so authorization reads are
  // never served from a partially repopulated map.
  private authorizedRoots = new Map<string, FolderIdentity>()
  private readonly removalRoots = new Set<string>()
  private authorizationRevision = 0
  private sessionProvider: () => Promise<SessionRecord[]> = async () => []
  private branchProvider: (cwd: string) => Promise<string | undefined> = async () => undefined
  private stopProjectProcesses: (roots: string[]) => Promise<void> = async () => undefined

  constructor(
    private readonly store: JsonStateStore,
    private readonly windowProvider: () => BrowserWindow | null,
    private readonly harness: HarnessId = 'prime',
  ) {}

  /** Persisted projects visible to this instance: exactly its own harness's records. */
  private ownProjects(projects: readonly PersistedProject[]): PersistedProject[] {
    return projects.filter((project) => project.harness === this.harness)
  }

  private async captureFolderIdentity(pathValue: string): Promise<{ path: string; identity: FolderIdentity }> {
    const configured = resolve(requireString(pathValue, 'project folder', { min: 1, max: 4096 }))
    // One lstat both validates the folder and captures its identity; the
    // canonical path then needs only the realpath call (not a second stat).
    const info = await lstat(configured, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('Project folder must be a stable directory')
    const path = await realpath(configured)
    return { path, identity: { dev: info.dev.toString(), ino: info.ino.toString() } }
  }

  private async verifyFolderIdentity(pathValue: string, expected?: FolderIdentity): Promise<string | undefined> {
    if (!expected) return undefined
    try {
      const current = await this.captureFolderIdentity(pathValue)
      return current.identity.dev === expected.dev && current.identity.ino === expected.ino ? current.path : undefined
    } catch { return undefined }
  }

  /**
   * The one verify-and-authorize resolution for a persisted project folder:
   * lexical (configured) path, canonical path when it still exists, the
   * recorded identity for either spelling, and the verified canonical path
   * when the on-disk identity still matches the grant.
   */
  private async resolveFolderAuthorization(
    project: Pick<PersistedProject, 'folderIdentities'>,
    folder: string,
  ): Promise<{ configured: string; canonical: string; expected?: FolderIdentity; verified?: string }> {
    const configured = resolve(folder)
    let canonical = configured
    try { canonical = await requireExistingDirectory(configured, 'project folder') } catch { /* Keep stale lexical path visible. */ }
    const expected = project.folderIdentities?.[configured] ?? project.folderIdentities?.[canonical]
    const verified = await this.verifyFolderIdentity(configured, expected)
    return { configured, canonical, expected, verified }
  }

  bindProviders(providers: {
    sessions(): Promise<SessionRecord[]>
    branch(cwd: string): Promise<string | undefined>
    stopProjectProcesses?(roots: string[]): Promise<void>
  }): void {
    this.sessionProvider = providers.sessions
    this.branchProvider = providers.branch
    this.stopProjectProcesses = providers.stopProjectProcesses ?? (async () => undefined)
  }

  private async migrateLegacyFolderIdentities(): Promise<void> {
    const legacyProjects = this.ownProjects(this.store.snapshot().projects).filter((project) => project.folderIdentities === undefined)
    if (!legacyProjects.length) return

    const captured = new Map<string, Record<string, FolderIdentity>>()
    for (const project of legacyProjects) {
      const identities: Record<string, FolderIdentity> = {}
      for (const folder of project.folders) {
        try {
          const current = await this.captureFolderIdentity(folder)
          identities[current.path] = current.identity
        } catch { /* Stale and symlinked legacy grants remain unauthorized. */ }
      }
      if (Object.keys(identities).length) captured.set(project.id, identities)
    }
    if (!captured.size) return

    await this.store.update((state) => {
      for (const project of state.projects) {
        const identities = captured.get(project.id)
        if (identities && project.folderIdentities === undefined) project.folderIdentities = identities
      }
    })
  }

  async list(): Promise<ProjectRecord[]> {
    await this.migrateLegacyFolderIdentities()
    const authorizationRevision = this.authorizationRevision
    const sessions = await this.sessionProvider()
    const canonicalSessionPaths = new Map<string, string>()
    await Promise.all([...new Set(sessions.map((session) => session.projectPath))].map(async (path) => {
      try { canonicalSessionPaths.set(path, await requireExistingDirectory(path, 'session project path')) }
      catch { canonicalSessionPaths.set(path, resolve(path)) }
    }))
    const sessionProjectPaths = new Map(sessions.map((session) => [session, canonicalSessionPaths.get(session.projectPath)!]))
    const snapshot = this.store.snapshot()
    const persisted = this.ownProjects(snapshot.projects)
    const dismissed = new Set(await Promise.all(snapshot.dismissedProjectPaths.map(async (path) => {
      try { return await requireExistingDirectory(path, 'dismissed project path') } catch { return resolve(path) }
    })))
    const records: ProjectRecord[] = []
    const represented = new Set<string>()
    const nextAuthorized = new Map<string, FolderIdentity>()
    const branchTargets: Array<{ record: ProjectRecord; cwd: string }> = []

    for (const project of persisted) {
      const folderSet = new Set<string>()
      let primaryGranted = false
      for (const folder of project.folders) {
        const { configured, canonical, expected, verified } = await this.resolveFolderAuthorization(project, folder)
        folderSet.add(canonical)
        represented.add(configured)
        represented.add(canonical)
        if (verified && expected) {
          if (configured === resolve(project.primaryFolder)) primaryGranted = true
          nextAuthorized.set(configured, expected)
        }
      }
      const record: ProjectRecord = {
        id: project.id, harness: project.harness, name: project.name, path: project.path, folders: project.folders, primaryFolder: project.primaryFolder,
        pinned: project.pinned, createdAt: project.createdAt, lastOpenedAt: project.lastOpenedAt,
        sessionCount: sessions.filter((session) => folderSet.has(sessionProjectPaths.get(session)!)).length,
        gitBranch: undefined,
      }
      records.push(record)
      if (primaryGranted) branchTargets.push({ record, cwd: project.primaryFolder })
    }

    // Swap the fully built map in one step; the previous map keeps serving
    // authorization checks while this refresh was collecting identities.
    if (authorizationRevision === this.authorizationRevision) this.authorizedRoots = nextAuthorized

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
        harness: this.harness,
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
    // Branch enrichment runs after the swap: authorization must never wait on
    // git subprocesses.
    for (const target of branchTargets) target.record.gitBranch = await this.branchProvider(target.cwd)
    return records.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))
  }

  async add(): Promise<ProjectRecord | null> {
    const parent = this.windowProvider()
    const result = parent
      ? await dialog.showOpenDialog(parent, { title: 'Add project folder', properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: 'Add project folder', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length !== 1) return null
    const { path, identity } = await this.captureFolderIdentity(result.filePaths[0])
    this.removalRoots.delete(path)
    const now = new Date().toISOString()
    const project = await this.store.update((state): PersistedProject => {
      state.dismissedProjectPaths = state.dismissedProjectPaths.filter((item) => resolve(item) !== path)
      const existing = this.ownProjects(state.projects).find((item) => resolve(item.path) === path || item.folders.some((folder) => resolve(folder) === path))
      if (existing) {
        existing.lastOpenedAt = now
        existing.folderIdentities = { ...existing.folderIdentities, [path]: identity }
        return existing
      }
      const created: PersistedProject = {
        id: randomUUID(),
        harness: this.harness,
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
    this.removalRoots.delete(path)
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
      const existing = this.ownProjects(state.projects).find((item) => resolve(item.path) === path || item.folders.some((folder) => resolve(folder) === path))
      if (existing) {
        existing.lastOpenedAt = now
        existing.folderIdentities = { ...existing.folderIdentities, [path]: identity }
        return existing
      }
      const created: PersistedProject = { id: randomUUID(), harness: this.harness, name: basename(path) || path, path, folders: [path], primaryFolder: path, pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: { [path]: identity } }
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
    const persisted = this.ownProjects(this.store.snapshot().projects).find((project) => project.id === id)
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
    const roots = persisted ? persistedPaths : inferredPath ? [inferredPath] : []
    try {
      if (roots.length) {
        for (const root of roots) this.removalRoots.add(root)
        for (const configured of persisted?.folders ?? []) this.authorizedRoots.delete(resolve(configured))
        await this.stopProjectProcesses([...new Set(roots)])
      }
      return await this.store.update((state) => {
        const index = state.projects.findIndex((project) => project.id === id && project.harness === this.harness)
        const paths = index >= 0 ? persistedPaths : inferredPath ? [inferredPath] : []
        if (!paths.length) return false
        if (index >= 0) state.projects.splice(index, 1)
        const dismissed = new Set(state.dismissedProjectPaths.map((path) => resolve(path)))
        for (const path of paths) dismissed.add(path)
        state.dismissedProjectPaths = [...dismissed]
        return true
      })
    } finally {
      // Removal blocks are transient: release them whether the store update
      // settled or threw, then rebuild authorization from the store. After a
      // successful removal the authoritative block is absence from
      // authorizedRoots; after a failed one the project keeps working.
      for (const root of roots) this.removalRoots.delete(root)
      if (authorizationRevision === this.authorizationRevision) await this.rebuildAuthorizedRoots(authorizationRevision)
    }
  }

  /** Rebuilds authorization into a fresh map and swaps it in one step. */
  private async rebuildAuthorizedRoots(authorizationRevision: number): Promise<void> {
    const nextAuthorized = new Map<string, FolderIdentity>()
    for (const project of this.ownProjects(this.store.snapshot().projects)) {
      for (const folder of project.folders) {
        if (authorizationRevision !== this.authorizationRevision) return
        const { configured, expected, verified } = await this.resolveFolderAuthorization(project, folder)
        if (verified && expected) nextAuthorized.set(configured, expected)
      }
    }
    if (authorizationRevision === this.authorizationRevision) this.authorizedRoots = nextAuthorized
  }

  async touch(idValue: unknown): Promise<boolean> {
    const id = requireId(idValue, 'project id')
    return this.store.update((state) => {
      const project = state.projects.find((item) => item.id === id && item.harness === this.harness)
      if (!project) return false
      project.lastOpenedAt = new Date().toISOString()
      return true
    })
  }

  async listFiles(rootValue: unknown): Promise<ProjectFileListing> {
    const root = await this.authorizeCwd(rootValue as string)
    const entries: ProjectFileEntry[] = []
    let skipped = 0
    const ignoredDirectories = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'release', 'coverage', '.next', '.venv'])
    const maxEntries = 5_000

    const visit = async (directory: string): Promise<void> => {
      if (entries.length >= maxEntries) return
      let children: Dirent[]
      try {
        children = await readdir(directory, { withFileTypes: true })
      } catch {
        // An unreadable directory (permissions, races) must not fail the whole
        // listing; report it so the UI can note the gap.
        skipped += 1
        return
      }
      children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const child of children) {
        if (entries.length >= maxEntries) break
        if (child.isSymbolicLink()) continue
        if (child.isDirectory() && ignoredDirectories.has(child.name)) continue
        if (!child.isDirectory() && !child.isFile()) continue
        const absolutePath = resolve(directory, child.name)
        const relativePath = relative(root, absolutePath)
        const path = process.platform === 'win32' ? relativePath.split('\\').join('/') : relativePath
        entries.push({ path, type: child.isDirectory() ? 'directory' : 'file' })
        if (child.isDirectory()) await visit(absolutePath)
      }
    }

    await visit(root)
    return { entries, skipped }
  }

  private async authorizedRootFor(path: string): Promise<string> {
    if (!this.authorizedRoots.size) await this.list()
    const authorizationRevision = this.authorizationRevision
    const roots: string[] = []
    // Snapshot the map: a concurrent refresh may swap this.authorizedRoots
    // mid-iteration, and stale-entry eviction must target the map iterated.
    const authorized = this.authorizedRoots
    for (const [configured, expected] of authorized) {
      // An in-flight removal blocks exactly the roots being removed; a nested
      // project registered inside them keeps its own grant.
      if (this.removalRoots.has(configured)) continue
      const verified = await this.verifyFolderIdentity(configured, expected)
      if (!verified) { authorized.delete(configured); continue }
      if (this.removalRoots.has(verified)) continue
      roots.push(verified)
    }
    if (authorizationRevision !== this.authorizationRevision) throw new TypeError('project authorization changed while the request was being checked')
    const authorizedRoot = roots.filter((root) => isPathWithin(root, path)).sort((a, b) => b.length - a.length)[0]
    if (!authorizedRoot) {
      if ([...this.removalRoots].some((root) => isPathWithin(root, path))) throw new TypeError('path is not inside an added Prime Work project because its project is being removed')
      throw new TypeError('path is not inside an added Prime Work project or its folder identity changed')
    }
    return authorizedRoot
  }

  async authorizePath(value: string): Promise<string> {
    const path = await requireExistingPath(value)
    await this.authorizedRootFor(path)
    return path
  }

  async authorizeProjectRoot(value: string): Promise<string> {
    const path = await requireExistingDirectory(value, 'project path')
    return await this.authorizedRootFor(path)
  }

  async authorizeCwd(value: string): Promise<string> {
    const cwd = await requireExistingDirectory(value, 'cwd')
    await this.authorizedRootFor(cwd)
    return cwd
  }
}
