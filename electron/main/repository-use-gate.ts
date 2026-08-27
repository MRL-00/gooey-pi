import { resolve, sep } from 'node:path'
import type { HarnessId } from '../../src/types/api'

export type WorkspaceUseOwner =
  | { kind: 'agent'; harness: HarnessId; runtimeId: string }
  | { kind: 'terminal'; terminalId: string }

export interface WorkspaceUseLease {
  release(): void
}

export class RepositoryUseError extends Error {
  readonly code = 'active-work'

  constructor(readonly owners: readonly WorkspaceUseOwner[]) {
    super('Branch checkout is unavailable while an agent or terminal is using this folder.')
    this.name = 'RepositoryUseError'
  }
}

interface WorkspaceUse {
  path: string
  owner: WorkspaceUseOwner
  retireIfIdle?: () => Promise<boolean>
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

export class RepositoryUseGate {
  private readonly workspaceUses = new Set<WorkspaceUse>()
  private readonly activeCheckouts = new Set<string>()
  private changed: Promise<void> = Promise.resolve()
  private signalChanged: () => void = () => undefined
  private readonly admissions = new Map<string, Promise<void>>()

  constructor() {
    this.resetChangedSignal()
  }

  async beginWorkspaceUse(
    pathValue: string,
    owner: WorkspaceUseOwner,
    retireIfIdle?: () => Promise<boolean>,
  ): Promise<WorkspaceUseLease> {
    const path = resolve(pathValue)
    while ([...this.activeCheckouts].some((root) => contains(root, path))) await this.changed
    const use = { path, owner, retireIfIdle }
    this.workspaceUses.add(use)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.workspaceUses.delete(use)
        this.notifyChanged()
      },
    }
  }

  async runBranchCheckout<T>(rootValue: string, action: () => Promise<T>): Promise<T> {
    const root = resolve(rootValue)
    let releaseAdmission!: () => void
    const previousAdmission = this.admissions.get(root) ?? Promise.resolve()
    const admission = new Promise<void>((release) => { releaseAdmission = release })
    this.admissions.set(root, admission)
    await previousAdmission
    try {
      this.activeCheckouts.add(root)
      try {
        const owners: WorkspaceUseOwner[] = []
        for (const use of [...this.workspaceUses].filter((candidate) => contains(root, candidate.path))) {
          if (!use.retireIfIdle || !await use.retireIfIdle()) owners.push(use.owner)
        }
        if (owners.length) throw new RepositoryUseError(owners)
        return await action()
      } finally {
        this.activeCheckouts.delete(root)
        this.notifyChanged()
      }
    } finally {
      releaseAdmission()
      if (this.admissions.get(root) === admission) this.admissions.delete(root)
    }
  }

  private resetChangedSignal(): void {
    this.changed = new Promise<void>((resolveChanged) => { this.signalChanged = resolveChanged })
  }

  private notifyChanged(): void {
    this.signalChanged()
    this.resetChangedSignal()
  }
}
