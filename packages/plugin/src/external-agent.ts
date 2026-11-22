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
import type { LlmAttemptId, UserMessage } from '@deepseek-ai/dsh-llm'
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
import { ExternalStepRecorder } from './step-recorder.js'
import {
  EXTERNAL_BINDING_RECORD_TYPE,
  type ExternalBindingRecord,
  type ExternalDriverKind,
  type ExternalRuntimeDriver,
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
  readonly idleEvictMs: number
  readonly options: AgentOptions
  readonly session: Session
  readonly projections: ExternalAgentProjections
  readonly lastTurn: number
  readonly resolveCatalogModels?: (providerId: string) => Promise<readonly CatalogModelEntry[] | undefined>
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
  private readonly idleEvictMs: number
  private readonly dispatch: ReturnType<typeof agentEvents>
  private readonly resolveCatalogModels?: (providerId: string) => Promise<readonly CatalogModelEntry[] | undefined>

  private lastTurn: number
  private attemptSeq = 0
  private frameRevision = 0
  private running: Promise<void> | null = null
  private activeAbort: AbortController | null = null
  private activeCancelCause: AgentCancelCause = { kind: 'user' }
  private driver: ExternalRuntimeDriver | null = null
  private driverRuntimeId?: string
  private initialSelectionKey?: string
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(deps: ExternalAgentDeps) {
    this.rootCtx = deps.rootCtx
    this.id = deps.id
    this.initialRuntime = deps.runtime
    this.resolveRuntimeFn = deps.resolveRuntime
    this.idleEvictMs = deps.idleEvictMs
    this.options = deps.options
    this.session = deps.session
    this.lastTurn = deps.lastTurn
    this.resolveCatalogModels = deps.resolveCatalogModels

    this.scope = createScope(this.rootCtx, this)
    this.ctx = this.scope.ctx
    this.dispatch = agentEvents(this.rootCtx, this)
    this.model = new AgentModel(deps.projections.modelSelection, deps.session, deps.options)
    this.inbox = new ExternalAgentInbox(deps.projections.inbox, deps.session, this.dispatch)
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

  /**
   * The session's current selection applies only when it targets this runtime's
   * provider; when unset, resolves the live catalog's default model so multi-region
   * CLIs (e.g. TRAE CN vs TRAE International) never pass a non-existent static default id.
   */
  private async resolveSelection(): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
    const current = this.model.current()
    const provider = this.runtime.providerId
    const matched = current?.provider === provider ? current : undefined
    let model = matched?.model
    let catalog: readonly CatalogModelEntry[] | undefined
    if (!model) {
      catalog = await this.resolveCatalogModels?.(provider).catch(() => undefined)
      const configured = this.runtime.defaultModel
      if (configured && (!catalog || catalog.length === 0 || catalog.some((m) => m.id === configured))) {
        model = configured
      } else {
        model = catalog?.find((m) => m.isDefault)?.id ?? catalog?.[0]?.id ?? configured
      }
    }
    const entry = catalog?.find((m) => m.id === model)
    let reasoningEffort = matched?.reasoningEffort ?? this.runtime.defaultReasoningEffort
    if (entry?.reasoningEfforts !== undefined && entry.reasoningEfforts.length === 0) {
      reasoningEffort = undefined
    }
    return {
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
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

    const selection = await this.resolveSelection()
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
    const modelChangedSinceStart =
      this.initialSelectionKey !== undefined && this.initialSelectionKey !== selectionKey

    try {
      const driver = await this.ensureDriver(selection.model, selection.reasoningEffort)
      this.initialSelectionKey ??= selectionKey

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

  private async ensureDriver(model: string, reasoningEffort?: string): Promise<ExternalRuntimeDriver> {
    const activeRuntime = this.runtime
    if (!this.driver || this.driverRuntimeId !== activeRuntime.id) {
      if (this.driver) {
        await this.driver.close().catch(() => {})
      }
      this.driver = activeRuntime.createDriver({ ctx: this.rootCtx, agent: this })
      this.driverRuntimeId = activeRuntime.id
    }
    const persistedId = readPersistedExternalId(this.session, activeRuntime.id)
    const externalId = await this.driver.ensureConnected(persistedId, model, reasoningEffort)
    if (externalId && externalId !== persistedId) {
      appendPluginRecord(this.session, EXTERNAL_BINDING_RECORD_TYPE, {
        driver: activeRuntime.id,
        externalId,
      })
    }
    return this.driver
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
    if (drv) {
      await drv.close().catch(() => {})
    }
  }
}
