import type { Context } from '@deepseek-ai/cordis'
import {
  AgentModel,
  agentEvents,
  type Agent,
  type AgentCancelCause,
  type AgentOptions,
  type AgentStatus,
  type CancelOptions,
  type InboxState,
  type InboxTarget,
  type ModelSelectionProjectionState,
} from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId, ReasoningEffortId, UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, scopeTarget, type Scope } from '@deepseek-ai/dsh-scope'
import {
  appendPluginRecord,
  pluginRecordOf,
  type Session,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { CatalogModelEntry } from './catalog-adapter.js'
import { ExternalAgentInbox } from './inbox.js'
import type { ExternalRuntimeDefinition } from './runtime/definition.js'
import { resolveRuntimeModelSelection } from './runtime/profile-resolver.js'
import { ExternalStepRecorder } from './step-recorder.js'
import {
  EXTERNAL_BINDING_RECORD_TYPE,
  EXTERNAL_LAUNCH_RECORD_TYPE,
  type ExternalBindingRecord,
  type ExternalDriverKind,
  type ExternalLaunchRecord,
  type ExternalRuntimeDriver,
  type ExternalRuntimeProfile,
} from './types.js'

export interface ExternalAgentProjections {
  readonly modelSelection: () => Readonly<ModelSelectionProjectionState>
  readonly inbox: () => Readonly<InboxState>
}

export interface ExternalAgentDeps {
  readonly rootCtx: Context
  readonly id: SessionId
  readonly runtime: ExternalRuntimeDefinition
  readonly resolveRuntime?: (session: Session) => ExternalRuntimeDefinition | undefined
  readonly resolveProfile?: (runtimeId: string, profileId: string) => ExternalRuntimeProfile | undefined
  readonly idleEvictMs: number
  readonly options: AgentOptions
  readonly session: Session
  readonly projections: ExternalAgentProjections
  readonly lastTurn: number
  readonly resolveCatalogModels?: (
    providerId: string,
    runtimeId?: string,
    profileId?: string,
  ) => Promise<readonly CatalogModelEntry[] | undefined>
  readonly onExternalBinding?: (externalId: string, sessionId: SessionId) => void
}

function readPersistedExternalId(session: Session, driver: ExternalDriverKind): string | undefined {
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const rec = pluginRecordOf(events[i]!)
    if (rec?.type !== EXTERNAL_BINDING_RECORD_TYPE) continue
    const data = rec.data as Partial<ExternalBindingRecord> | undefined
    if (data?.driver === driver && typeof data.externalId === 'string' && data.externalId.length > 0) {
      return data.externalId
    }
  }
  return undefined
}

function readPersistedLaunchProfileId(session: Session, runtimeId: string): string | undefined {
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const rec = pluginRecordOf(events[i]!)
    if (rec?.type !== EXTERNAL_LAUNCH_RECORD_TYPE) continue
    const data = rec.data as Partial<ExternalLaunchRecord> | undefined
    if (
      data?.runtimeId === runtimeId &&
      typeof data.profileId === 'string' &&
      data.profileId.trim().length > 0
    ) {
      return data.profileId.trim()
    }
  }
  return undefined
}

export class ExternalAgent implements Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly scope: Scope
  readonly ctx: Context
  readonly model: AgentModel
  readonly inbox: ExternalAgentInbox

  status: AgentStatus = 'idle'

  private readonly rootCtx: Context
  private readonly initialRuntime: ExternalRuntimeDefinition
  private readonly resolveRuntimeFn?: (session: Session) => ExternalRuntimeDefinition | undefined
  private readonly resolveProfileFn?: (
    runtimeId: string,
    profileId: string,
  ) => ExternalRuntimeProfile | undefined
  private readonly idleEvictMs: number
  private readonly dispatch: ReturnType<typeof agentEvents>
  private readonly resolveCatalogModels?: (
    providerId: string,
    runtimeId?: string,
    profileId?: string,
  ) => Promise<readonly CatalogModelEntry[] | undefined>
  private readonly onExternalBinding?: (externalId: string, sessionId: SessionId) => void

  private lastTurn: number
  private attemptSeq = 0
  private frameRevision = 0
  private running: Promise<void> | null = null
  private activeAbort: AbortController | null = null
  private activeCancelCause: AgentCancelCause = { kind: 'user' }
  private driver: ExternalRuntimeDriver | null = null
  private driverRuntimeKey?: string
  private appliedSelectionKey?: string
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(deps: ExternalAgentDeps) {
    this.rootCtx = deps.rootCtx
    this.id = deps.id
    this.initialRuntime = deps.runtime
    this.resolveRuntimeFn = deps.resolveRuntime
    this.resolveProfileFn = deps.resolveProfile
    this.idleEvictMs = deps.idleEvictMs
    this.options = deps.options
    this.session = deps.session
    this.lastTurn = deps.lastTurn
    this.resolveCatalogModels = deps.resolveCatalogModels
    this.onExternalBinding = deps.onExternalBinding

    this.scope = createScope(this.rootCtx, this)
    this.ctx = this.scope.ctx
    this.dispatch = agentEvents(this.rootCtx, this)
    this.model = new AgentModel(deps.projections.modelSelection, deps.session, deps.options)
    this.inbox = new ExternalAgentInbox(deps.projections.inbox, deps.session, this.dispatch)

    const initialExternalId =
      readPersistedExternalId(this.session, this.initialRuntime.id) ??
      (this.initialRuntime.parentRuntimeId
        ? readPersistedExternalId(this.session, this.initialRuntime.parentRuntimeId)
        : undefined)
    if (initialExternalId) {
      this.onExternalBinding?.(initialExternalId, this.id)
    }
  }

  /** Active external runtime for this session, following blank-session preset switches. */
  get runtime(): ExternalRuntimeDefinition {
    return this.resolveRuntimeFn?.(this.session) ?? this.initialRuntime
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.inbox.append(target, message)
    if (wakeup) this.wake()
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, opts?: CancelOptions): void {
    this.activeCancelCause = cause
    if (cause.kind === 'disposed') {
      this.disposed = true
      this.clearIdleTimer()
    }
    if (!opts?.keepInbox) {
      this.inbox.clear()
    }
    this.activeAbort?.abort(cause)
  }

  async whenIdle(): Promise<void> {
    while (this.running) {
      await this.running
    }
  }

  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController()
    return await task(abort.signal)
  }

  async disposeExternal(): Promise<void> {
    this.disposed = true
    this.clearIdleTimer()
    const drv = this.driver
    this.driver = null
    this.appliedSelectionKey = undefined
    if (drv) {
      await drv.close()
    }
  }

  private wake(): void {
    if (this.disposed || this.running) return
    this.clearIdleTimer()
    this.running = this.drain().finally(() => {
      this.running = null
      if (!this.disposed && this.inbox.hasPending) {
        this.wake()
      } else if (!this.disposed) {
        this.armIdleEviction()
      }
    })
  }

  private resolveActiveProfile(activeRuntime: ExternalRuntimeDefinition): ExternalRuntimeProfile | undefined {
    const baseRuntimeId = activeRuntime.parentRuntimeId ?? activeRuntime.id
    if (activeRuntime.profileId) {
      return this.resolveProfileFn?.(baseRuntimeId, activeRuntime.profileId) ?? activeRuntime.boundProfile
    }
    const persistedProfileId = readPersistedLaunchProfileId(this.session, baseRuntimeId)
    if (!persistedProfileId) return undefined
    return this.resolveProfileFn?.(baseRuntimeId, persistedProfileId)
  }

  /**
   * The session's current selection applies only when it targets this runtime's
   * provider; when unset, resolves profile-inferred defaults and the live catalog's
   * default model before falling back to the base runtime's static default id.
   */
  private async resolveSelection(
    activeRuntime: ExternalRuntimeDefinition,
    activeProfile?: ExternalRuntimeProfile,
  ): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
    const current = this.model.current()
    const provider = activeRuntime.providerId
    const matched = current?.provider === provider ? current : undefined
    const catalog = matched?.model
      ? undefined
      : await this.resolveCatalogModels
          ?.(provider, activeRuntime.parentRuntimeId ?? activeRuntime.id, activeProfile?.id)
          .catch(() => undefined)
    const profileDefaults = activeProfile
      ? activeRuntime.resolveProfileDefaults?.(activeProfile) ?? {
          ...(activeProfile.defaultModel ? { defaultModel: activeProfile.defaultModel } : {}),
          ...(activeProfile.defaultReasoningEffort
            ? { defaultReasoningEffort: activeProfile.defaultReasoningEffort }
            : {}),
        }
      : undefined
    return (
      resolveRuntimeModelSelection({
        provider,
        runtimeDefaultModel: activeRuntime.defaultModel,
        ...(activeRuntime.defaultReasoningEffort
          ? { runtimeDefaultReasoningEffort: activeRuntime.defaultReasoningEffort }
          : {}),
        hasProfile: Boolean(activeProfile),
        ...(profileDefaults ? { profileDefaults } : {}),
        ...(matched ? { matched } : {}),
        ...(catalog ? { catalog } : {}),
      }) ?? {
        provider,
        model: activeRuntime.defaultModel,
      }
    )
  }

  /**
   * Persist the effective model selection to the session log so cold resumes
   * (after host restart or driver eviction) recover the exact model/effort
   * instead of losing in-memory `AgentOptions` and falling back to defaults.
   */
  private persistSelection(selection: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): void {
    if (!selection.provider || !selection.model) return
    this.model.select({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort
        ? { reasoningEffort: brandString<ReasoningEffortId>(selection.reasoningEffort) }
        : {}),
    })
  }

  private async drain(): Promise<void> {
    this.status = 'running'
    this.dispatch.emit('agent/status', { status: 'running' })
    try {
      while (!this.disposed && this.inbox.hasPending) {
        await this.runSingleTurn()
      }
    } finally {
      this.activeAbort = null
      this.status = 'idle'
      this.dispatch.emit('agent/status', { status: 'idle' })
    }
  }

  private async runSingleTurn(): Promise<void> {
    const turn = ++this.lastTurn
    const abort = new AbortController()
    this.activeAbort = abort
    this.activeCancelCause = { kind: 'user' }

    this.session.append('turn/start', { turn })
    const claimed = this.inbox.claim('next-turn', turn)
    if (claimed.length === 0) {
      this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return
    }

    const activeRuntime = this.runtime
    const activeProfile = this.resolveActiveProfile(activeRuntime)
    const selection = await this.resolveSelection(activeRuntime, activeProfile)
    this.persistSelection(selection)
    const recorder = new ExternalStepRecorder({
      agentId: this.id,
      session: this.session,
      emitter: {
        emitStream: (frame) => this.dispatch.emit('agent/assistant-stream', { frame }),
      },
      turn,
      provider: selection.provider,
      model: selection.model,
      nextAttemptId: () => brandString<LlmAttemptId>(`${this.id}:${++this.attemptSeq}`),
      nextFrameRevision: () => ++this.frameRevision,
    })

    recorder.startInitialStep()
    for (const msg of claimed) {
      this.session.append('user/message', msg, { surfaceOp: 'append' })
    }

    const selectionKey = `${selection.provider}/${selection.model}/${selection.reasoningEffort ?? ''}`

    try {
      const { driver, freshlyConnected } = await this.ensureDriver(
        activeRuntime,
        activeProfile,
        selection.model,
        selection.reasoningEffort,
      )
      const modelChangedSinceStart =
        !freshlyConnected && this.appliedSelectionKey !== selectionKey
      if (freshlyConnected) {
        this.appliedSelectionKey = selectionKey
      }

      const runResult = await driver.runTurn(
        {
          messages: claimed,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          modelChangedSinceStart,
        },
        (event) => {
          if (event.type === 'title') {
            this.maybeSetSessionTitle(event.title)
            return
          }
          recorder.handleEvent(event)
        },
        abort.signal,
      )

      const interrupted = abort.signal.aborted || runResult.status === 'interrupted'
      if (!interrupted && runResult.status === 'completed') {
        this.appliedSelectionKey = selectionKey
      } else if (modelChangedSinceStart) {
        // Remote runtime may have switched models before the turn was interrupted/failed;
        // clear tracked state so the next turn re-applies the requested model even when switching back.
        this.appliedSelectionKey = undefined
      }
      recorder.finish(interrupted, runResult.errorMessage)

      if (!interrupted && runResult.status === 'completed') {
        await this.rootCtx.serial(scopeTarget(this, this), 'agent/turn-stopping', {
          agent: this,
          turn,
          signal: abort.signal,
        })
      }

      if (interrupted) {
        this.session.append('turn/end', {
          turn,
          reason: { kind: 'aborted', reason: this.activeCancelCause },
        })
      } else if (runResult.status === 'failed') {
        await this.evictDriver()
        this.session.append('turn/end', {
          turn,
          reason: {
            kind: 'error',
            error: { message: runResult.errorMessage ?? 'external agent turn failed', code: 'UNKNOWN' },
          },
        })
      } else {
        this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      await this.rootCtx.parallel(scopeTarget(this.session, this.session), 'session/flush', this.session)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      recorder.finish(true, message)
      // Drop potentially broken driver so next turn cleanly reconnects/resumes.
      await this.evictDriver()
      this.session.append('turn/end', {
        turn,
        reason: abort.signal.aborted
          ? { kind: 'aborted', reason: this.activeCancelCause }
          : { kind: 'error', error: { message, code: 'UNKNOWN' } },
      })
      await this.rootCtx.parallel(scopeTarget(this.session, this.session), 'session/flush', this.session)
    } finally {
      if (this.activeAbort === abort) {
        this.activeAbort = null
      }
    }
  }

  private async ensureDriver(
    activeRuntime: ExternalRuntimeDefinition,
    activeProfile: ExternalRuntimeProfile | undefined,
    model: string,
    reasoningEffort?: string,
  ): Promise<{ readonly driver: ExternalRuntimeDriver; readonly freshlyConnected: boolean }> {
    const runtimeKey = activeProfile ? `${activeRuntime.id}#${activeProfile.id}` : activeRuntime.id
    let freshlyConnected = false
    if (!this.driver || this.driverRuntimeKey !== runtimeKey) {
      if (this.driver) {
        await this.driver.close().catch(() => {})
      }
      this.appliedSelectionKey = undefined
      this.driver = activeRuntime.createDriver({
        ctx: this.rootCtx,
        agent: this,
        ...(activeProfile ? { profile: activeProfile } : {}),
      })
      this.driverRuntimeKey = runtimeKey
      freshlyConnected = true
    }
    const bindingDriverKey = activeRuntime.parentRuntimeId ?? activeRuntime.id
    const persistedId =
      readPersistedExternalId(this.session, activeRuntime.id) ??
      (bindingDriverKey !== activeRuntime.id
        ? readPersistedExternalId(this.session, bindingDriverKey)
        : undefined)
    const externalId = await this.driver.ensureConnected(persistedId, model, reasoningEffort)
    if (externalId) {
      this.onExternalBinding?.(externalId, this.id)
    }
    if (externalId && externalId !== persistedId) {
      appendPluginRecord(this.session, EXTERNAL_BINDING_RECORD_TYPE, {
        driver: activeRuntime.id,
        externalId,
      })
    }
    return { driver: this.driver, freshlyConnected }
  }

  private maybeSetSessionTitle(title: string): void {
    const trimmed = title.trim()
    if (!trimmed) return
    const sessionTitleService = this.rootCtx.get('sessionTitle' as never) as
      | { rename?: (session: Session, title: string) => unknown }
      | undefined
    try {
      sessionTitleService?.rename?.(this.session, trimmed)
    } catch {
      // Ignore empty/disposed title rejection.
    }
  }

  private armIdleEviction(): void {
    this.clearIdleTimer()
    if (this.idleEvictMs <= 0 || !this.driver) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.status === 'idle' && !this.running) {
        void this.evictDriver()
      }
    }, this.idleEvictMs)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private async evictDriver(): Promise<void> {
    this.clearIdleTimer()
    const drv = this.driver
    this.driver = null
    this.appliedSelectionKey = undefined
    if (drv) {
      await drv.close().catch(() => {})
    }
  }
}
