import type { PrimeThinkingLevel, RuntimeInfo, ScheduleExecution, AutomationScheduleRecord, AutomationScheduleRecord as ScheduleRecord, ScheduleTarget } from '../../../src/types/api'
import type { AgentRpcManager } from '../agent-rpc'
import type { PrimeProviderService } from '../providers'
import type { ProjectService } from '../projects'
import type { SessionService } from '../sessions'
import { ScheduleBlockedError, type ScheduleRunResult } from './service'

interface ResolvedTarget {
  cwd: string
  sessionPath?: string
}

export class ScheduledRunExecutor {
  constructor(
    private readonly projects: ProjectService,
    private readonly sessions: SessionService,
    private readonly agents: AgentRpcManager,
    private readonly providers: PrimeProviderService,
    private readonly disabledProviders: () => ReadonlySet<string>,
  ) {}

  async validateTarget(target: ScheduleTarget): Promise<void> { await this.resolveTarget(target) }

  async validateExecution(execution: ScheduleExecution): Promise<void> {
    if (execution.model === 'auto') return
    const model = await this.providers.requireAvailableModel(execution.model, this.disabledProviders())
    if (execution.thinking !== 'auto' && !model.availableThinkingLevels.includes(execution.thinking)) {
      throw new ScheduleBlockedError(`${model.name} does not support ${execution.thinking} reasoning`)
    }
    if (execution.speed === 'fast' && !model.fastModeSupported) throw new ScheduleBlockedError(`${model.name} does not support Fast mode`)
  }

  async run(task: AutomationScheduleRecord): Promise<ScheduleRunResult> {
    const target = await this.resolveTarget(task.target)
    await this.validateExecution(task.execution)
    return target.sessionPath
      ? this.runInSession(task, target.cwd, target.sessionPath)
      : this.runInNewSession(task, target.cwd)
  }

  private async resolveTarget(target: ScheduleTarget): Promise<ResolvedTarget> {
    const project = (await this.projects.list()).find((candidate) => candidate.id === target.projectId)
    if (!project) throw new ScheduleBlockedError('The scheduled project is no longer available')
    if (project.inferred) throw new ScheduleBlockedError('Grant this inferred project before running scheduled work')
    if (target.kind === 'project') return { cwd: await this.projects.authorizeCwd(project.primaryFolder) }

    const session = (await this.sessions.list(undefined, true)).find((candidate) => candidate.id === target.sessionId)
    if (!session) throw new ScheduleBlockedError('The scheduled thread is no longer available')
    if (session.archived) throw new ScheduleBlockedError('Restore the archived thread before running this task')
    if (session.projectPath !== project.path && !project.folders.includes(session.projectPath)) {
      throw new ScheduleBlockedError('The scheduled thread no longer belongs to the selected project')
    }
    const cwd = await this.projects.authorizeCwd(session.projectPath)
    const sessionPath = await this.sessions.requireSessionPath(session.filePath)
    return { cwd, sessionPath }
  }

  private startOptions(cwd: string, execution: ScheduleExecution, sessionPath?: string): {
    cwd: string
    sessionPath?: string
    model?: string
    thinking?: string
    fast?: boolean
  } {
    return {
      cwd,
      sessionPath,
      model: execution.model === 'auto' ? undefined : execution.model,
      thinking: execution.thinking === 'auto' ? undefined : execution.thinking,
      fast: execution.speed === 'fast',
    }
  }

  private async runInNewSession(task: AutomationScheduleRecord, cwd: string): Promise<ScheduleRunResult> {
    let runtime: RuntimeInfo | undefined
    try {
      runtime = await this.agents.start(this.startOptions(cwd, task.execution))
      this.requireStrictExecution(runtime, task.execution)
      const completed = await this.agents.runPromptToCompletion(runtime.runtimeId, task.prompt)
      const title = `${task.title} · ${new Date().toLocaleDateString()}`.slice(0, 200)
      try { await this.agents.command(runtime.runtimeId, { type: 'set_session_name', name: title }) } catch { /* the run result remains usable */ }
      return { sessionId: completed.sessionId, sessionFile: completed.sessionFile }
    } catch (error) {
      if (error instanceof ScheduleBlockedError) throw error
      throw new Error(error instanceof Error ? error.message : String(error))
    } finally {
      if (runtime) await this.agents.stop(runtime.runtimeId)
    }
  }

  private async runInSession(task: AutomationScheduleRecord, cwd: string, sessionPath: string): Promise<ScheduleRunResult> {
    const existing = this.agents.getForSession(sessionPath)
    if (!existing) return this.runWithResumedSession(task, cwd, sessionPath)
    await this.waitUntilIdle(existing.runtimeId)
    const before = this.agents.list().find((candidate) => candidate.runtimeId === existing.runtimeId)
    if (!before) return this.runWithResumedSession(task, cwd, sessionPath)
    try {
      await this.applyExecution(existing.runtimeId, task.execution)
      const configured = this.agents.list().find((candidate) => candidate.runtimeId === existing.runtimeId)
      if (configured) this.requireStrictExecution(configured, task.execution)
      const completed = await this.agents.runPromptToCompletion(existing.runtimeId, task.prompt)
      return { sessionId: completed.sessionId, sessionFile: completed.sessionFile }
    } finally {
      await this.restoreExecution(existing.runtimeId, before)
    }
  }

  private async runWithResumedSession(task: AutomationScheduleRecord, cwd: string, sessionPath: string): Promise<ScheduleRunResult> {
    let runtime: RuntimeInfo | undefined
    try {
      runtime = await this.agents.start(this.startOptions(cwd, task.execution, sessionPath))
      this.requireStrictExecution(runtime, task.execution)
      const completed = await this.agents.runPromptToCompletion(runtime.runtimeId, task.prompt)
      return { sessionId: completed.sessionId, sessionFile: completed.sessionFile }
    } catch (error) {
      if (error instanceof ScheduleBlockedError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/lease|already active|already.*open|in use/i.test(message)) throw new ScheduleBlockedError('The thread is active in another client. Close it there or use inherited thread settings.')
      throw new Error(message)
    } finally {
      if (runtime) await this.agents.stop(runtime.runtimeId)
    }
  }

  private async waitUntilIdle(runtimeId: string): Promise<void> {
    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline) {
      const runtime = this.agents.list().find((candidate) => candidate.runtimeId === runtimeId)
      if (!runtime) return
      if (!runtime.isStreaming && !runtime.isCompacting) return
      await new Promise<void>((resolveDelay) => {
        const timer = setTimeout(resolveDelay, 500)
        timer.unref()
      })
    }
    throw new Error('The scheduled thread remained busy for 15 minutes')
  }

  private async applyExecution(runtimeId: string, execution: ScheduleExecution): Promise<void> {
    if (execution.model !== 'auto') {
      const model = await this.providers.requireAvailableModel(execution.model, this.disabledProviders())
      await this.agents.command(runtimeId, { type: 'set_model', provider: model.provider, modelId: model.id })
    }
    if (execution.thinking !== 'auto') await this.agents.command(runtimeId, { type: 'set_thinking_level', level: execution.thinking })
    await this.agents.command(runtimeId, { type: 'set_service_tier', serviceTier: execution.speed === 'fast' ? 'priority' : 'default' })
  }

  private async restoreExecution(runtimeId: string, before: RuntimeInfo): Promise<void> {
    try {
      if (before.model?.provider && before.model.id) {
        await this.agents.command(runtimeId, { type: 'set_model', provider: before.model.provider, modelId: before.model.id })
      }
      if (before.thinkingLevel) await this.agents.command(runtimeId, { type: 'set_thinking_level', level: before.thinkingLevel })
      if (before.serviceTier === 'priority' || before.serviceTier === 'default') {
        await this.agents.command(runtimeId, { type: 'set_service_tier', serviceTier: before.serviceTier })
      }
    } catch { /* a user/runtime change wins over best-effort restoration */ }
  }

  private requireStrictExecution(runtime: RuntimeInfo, execution: ScheduleExecution): void {
    if (execution.speed === 'fast' && runtime.serviceTier !== 'priority') throw new ScheduleBlockedError('Fast mode is unavailable for this scheduled run')
    if (execution.thinking !== 'auto' && runtime.thinkingLevel && runtime.thinkingLevel !== execution.thinking) {
      throw new ScheduleBlockedError(`The scheduled reasoning level ${execution.thinking} could not be applied`)
    }
  }
}
