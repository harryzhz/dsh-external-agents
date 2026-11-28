import type { JsonRpcDispatcher } from '@dsh-external-agents/runtime-shared-stdio'
import {
  extractAcpPromptUsage,
  extractAcpSessionUpdateMeta,
  normalizeAcpPermissionRequest,
  normalizeAcpSessionUpdate,
  pickDefaultAllowOptionId,
} from './event-normalizer.js'
import type {
  AcpActiveToolCall,
  AcpPromptBlock,
  AcpTokenUsage,
  AcpTurnHandlers,
  AcpTurnResult,
} from './types.js'

export interface ActiveTurnContext {
  readonly sessionId: string
  readonly startedAtMs: number
  text: string
  usage?: AcpTokenUsage
  lastContextUsage?: { readonly used: number; readonly size?: number }
  cancelPending: boolean
  updateCount: number
  lastUpdateKind?: string
  readonly activeTools: Map<string, AcpActiveToolCall>
  readonly handlers: AcpTurnHandlers
  readonly abortController: AbortController
  touchActivity?: () => void
  pauseIdleTimer?: () => void
  resumeIdleTimer?: () => void
  beginCancelGrace?: () => void
}

export interface AcpTurnRunnerHost {
  readonly label: string
  readonly promptIdleTimeoutMs: number
  readonly cancelGraceTimeoutMs: number
  readonly dispatcher: JsonRpcDispatcher
  readonly logger: (message: string) => void
  readonly isClosed: () => boolean
  readonly resolveTurnForSession: (sessionId?: string) => ActiveTurnContext | undefined
}

/**
 * Encapsulates single-turn ACP `session/prompt` execution, activity-resetting
 * idle & cancel-grace timers, streaming `session/update` aggregation, and
 * interactive `session/request_permission` mediation.
 */
export class AcpTurnRunner {
  constructor(private readonly host: AcpTurnRunnerHost) {}

  async executeTurn(
    sessionId: string,
    prompt: readonly AcpPromptBlock[],
    handlers: AcpTurnHandlers,
    signal: AbortSignal | undefined,
    bindTurn: (turn: ActiveTurnContext) => () => void,
  ): Promise<AcpTurnResult> {
    if (signal?.aborted) {
      return { text: '', stopReason: 'cancelled' }
    }

    const abortController = new AbortController()
    const turn: ActiveTurnContext = {
      sessionId,
      startedAtMs: Date.now(),
      text: '',
      cancelPending: false,
      updateCount: 0,
      activeTools: new Map(),
      handlers,
      abortController,
    }
    const unbind = bindTurn(turn)

    const onExternalAbort = () => {
      turn.cancelPending = true
      abortController.abort(signal?.reason)
      turn.beginCancelGrace?.()
      this.host.dispatcher.notify('session/cancel', { sessionId })
    }
    signal?.addEventListener('abort', onExternalAbort, { once: true })

    try {
      const res = (await this.sendPromptRequest(sessionId, prompt, turn)) as {
        stopReason?: string
        usage?: unknown
      }
      const promptUsage = extractAcpPromptUsage(res?.usage)
      const fallbackUsage: AcpTokenUsage | undefined =
        !promptUsage && !turn.usage && turn.lastContextUsage
          ? {
              inputTokens: turn.lastContextUsage.used,
              outputTokens: 0,
              contextUsed: turn.lastContextUsage.used,
              ...(turn.lastContextUsage.size !== undefined
                ? { contextSize: turn.lastContextUsage.size }
                : {}),
            }
          : undefined
      const usage = promptUsage ?? turn.usage ?? fallbackUsage
      if (usage) {
        try {
          handlers.onEvent?.({ type: 'usage', usage })
        } catch {
          // Isolate callback errors.
        }
      }
      return {
        text: turn.text,
        stopReason: res?.stopReason ?? 'end_turn',
        ...(usage ? { usage } : {}),
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort)
      abortController.abort()
      unbind()
    }
  }

  async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method !== 'session/request_permission') {
      this.host.dispatcher.respond(id, {})
      return
    }

    const request = normalizeAcpPermissionRequest(params)
    const turn = this.host.resolveTurnForSession(request.sessionId)
    if (!turn || turn.cancelPending) {
      this.host.dispatcher.respond(id, { outcome: { outcome: 'cancelled' } })
      return
    }
    const handler = turn.handlers.onPermission
    if (!handler) {
      turn.touchActivity?.()
      const optionId = pickDefaultAllowOptionId(request.options)
      this.host.dispatcher.respond(
        id,
        optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } },
      )
      return
    }

    turn.pauseIdleTimer?.()
    try {
      const outcome = await handler(request, turn.abortController.signal)
      if (!this.host.isClosed()) {
        this.host.dispatcher.respond(id, { outcome })
      }
    } catch {
      if (!this.host.isClosed()) {
        this.host.dispatcher.respond(id, { outcome: { outcome: 'cancelled' } })
      }
    } finally {
      turn.resumeIdleTimer?.()
    }
  }

  handleSessionUpdate(params: unknown): void {
    const meta = extractAcpSessionUpdateMeta(params)
    const turn = this.host.resolveTurnForSession(meta.sessionId)
    if (!turn) return
    turn.updateCount += 1
    if (meta.updateKind) {
      turn.lastUpdateKind = meta.updateKind
    }
    turn.touchActivity?.()
    const events = normalizeAcpSessionUpdate(params, turn.activeTools)
    for (const event of events) {
      if (event.type === 'text-delta') {
        turn.text += event.text
      } else if (event.type === 'usage') {
        turn.usage = event.usage
      } else if (event.type === 'context-usage') {
        turn.lastContextUsage = {
          used: event.used,
          ...(event.size !== undefined ? { size: event.size } : {}),
        }
      }
      try {
        turn.handlers.onEvent?.(event)
      } catch (err) {
        this.host.logger(
          `${this.host.label} event handler threw: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  private sendPromptRequest(
    sessionId: string,
    prompt: readonly AcpPromptBlock[],
    turn: ActiveTurnContext,
  ): Promise<unknown> {
    if (this.host.isClosed()) {
      return Promise.reject(
        new Error(`cannot send ${this.host.label} RPC "session/prompt": transport closed`),
      )
    }
    const idleTimeoutMs = this.host.promptIdleTimeoutMs
    let pendingPermissions = 0

    return this.host.dispatcher.sendManagedRequest('session/prompt', { sessionId, prompt }, (ctx) => {
      const armIdleTimer = () => {
        ctx.clearTimer()
        if (turn.cancelPending || idleTimeoutMs <= 0 || pendingPermissions > 0 || !ctx.isPending()) {
          return
        }
        const timer = setTimeout(() => {
          const elapsedSec = Math.max(0, Math.round((Date.now() - turn.startedAtMs) / 1000))
          const diag = `session=${sessionId}, elapsed=${elapsedSec}s, updates=${turn.updateCount}, lastUpdate=${turn.lastUpdateKind ?? 'none'}, textChars=${turn.text.length}, openTools=${turn.activeTools.size}`
          const err = new Error(
            `${this.host.label} RPC "session/prompt" idle timed out after ${idleTimeoutMs}ms without updates (${diag})`,
          )
          if (!ctx.fail(err)) return
          this.host.logger(err.message)
          turn.cancelPending = true
          turn.abortController.abort(err)
          this.host.dispatcher.notify('session/cancel', { sessionId })
        }, idleTimeoutMs)
        timer.unref?.()
        ctx.setTimer(timer)
      }

      turn.touchActivity = () => {
        if (turn.cancelPending) return
        armIdleTimer()
      }
      turn.pauseIdleTimer = () => {
        pendingPermissions += 1
        ctx.clearTimer()
      }
      turn.resumeIdleTimer = () => {
        pendingPermissions = Math.max(0, pendingPermissions - 1)
        if (turn.cancelPending) return
        armIdleTimer()
      }
      turn.beginCancelGrace = () => {
        ctx.clearTimer()
        if (!ctx.isPending()) return
        const timer = setTimeout(() => {
          ctx.fail(
            new Error(
              `${this.host.label} RPC "session/prompt" cancel timed out after ${this.host.cancelGraceTimeoutMs}ms`,
            ),
          )
        }, this.host.cancelGraceTimeoutMs)
        timer.unref?.()
        ctx.setTimer(timer)
      }

      if (turn.cancelPending) {
        turn.beginCancelGrace()
      } else {
        armIdleTimer()
      }
    })
  }
}
