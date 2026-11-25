import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
  type LlmAttemptId,
  type StreamChunk,
  type TokenUsage,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { MarkdownFileLinkNormalizer } from './markdown-file-links.js'
import type { ExternalTurnEvent } from './types.js'

export interface StreamEmitter {
  emitStream(event: AssistantStreamFrame): void
}

interface ActiveAttempt {
  readonly attemptId: LlmAttemptId
  readonly accumulator: AssistantStreamAccumulator
  readonly assembler: BlockAssembler
  chunkIndex: number
  nextBlockIndex: number
  openBlock?: {
    readonly index: number
    readonly kind: 'text' | 'reasoning'
    buffer: string
    readonly normalizer: MarkdownFileLinkNormalizer
  }
}

interface PendingTool {
  readonly callId: ToolCallId
  readonly name: string
  readonly arguments: string
}

export interface StepRecorderOptions {
  readonly agentId: string
  readonly session: Session
  readonly emitter: StreamEmitter
  readonly turn: number
  readonly provider: string
  readonly model: string
  readonly nextAttemptId: () => LlmAttemptId
  readonly nextFrameRevision: () => number
}

/**
 * Translates an external agent's event stream into a strictly valid DSH v4
 * step/assistant/tool event sequence so persisted logs always pass cold-resume
 * relationship validation.
 */
export class ExternalStepRecorder {
  private step = 0
  private stepOpen = false
  private attempt?: ActiveAttempt
  private latestUsage?: TokenUsage
  private readonly openTools = new Map<string, PendingTool>()

  constructor(private readonly opts: StepRecorderOptions) {}

  get currentStep(): number {
    return this.step
  }

  get usage(): TokenUsage | undefined {
    return this.latestUsage
  }

  startInitialStep(): number {
    if (this.stepOpen) return this.step
    this.step += 1
    this.stepOpen = true
    this.opts.session.append('step/start', { turn: this.opts.turn, step: this.step })
    return this.step
  }

  handleEvent(event: ExternalTurnEvent): void {
    if (event.type === 'usage') {
      this.latestUsage = event.usage
      return
    }
    if (event.type === 'title') {
      return
    }
    if (event.type === 'tool-output-delta') {
      return
    }
    if (event.type === 'message-start') {
      if (this.attempt?.openBlock?.kind === 'text') {
        this.closeOpenTextualBlock(this.attempt)
      }
      return
    }

    this.ensureOpenStep()

    if (event.type === 'reasoning-delta') {
      this.appendTextualDelta('reasoning', event.text)
      return
    }
    if (event.type === 'text-delta') {
      this.appendTextualDelta('text', event.text)
      return
    }
    if (event.type === 'tool-start') {
      this.handleToolStart(event.callId, event.name, event.arguments)
      return
    }
    if (event.type === 'tool-complete') {
      this.handleToolComplete(event.callId, event.name, event.output, event.isError, event.meta)
    }
  }

  /**
   * Finalize any pending assistant content, close any dangling tool lifecycles
   * (synthesizing error results if interrupted), and close the open step.
   */
  finish(interrupted: boolean, fallbackErrorMessage?: string): void {
    if (!this.stepOpen) return

    if (this.attempt) {
      this.commitAttempt(interrupted ? 'abort' : 'stop', interrupted)
    }

    if (this.openTools.size > 0) {
      const reason = fallbackErrorMessage ?? (interrupted ? 'Tool interrupted' : 'Tool did not return a result')
      for (const tool of [...this.openTools.values()]) {
        this.appendToolResult(tool.callId, reason, true)
      }
      this.openTools.clear()
    }

    this.opts.session.append('step/end', { turn: this.opts.turn, step: this.step })
    this.stepOpen = false
  }

  private ensureOpenStep(): void {
    if (!this.stepOpen) {
      this.startInitialStep()
    }
  }

  private ensureAttempt(): ActiveAttempt {
    if (this.attempt) return this.attempt
    const attemptId = this.opts.nextAttemptId()
    const attempt: ActiveAttempt = {
      attemptId,
      accumulator: new AssistantStreamAccumulator(),
      assembler: new BlockAssembler(),
      chunkIndex: 0,
      nextBlockIndex: 0,
    }
    this.attempt = attempt
    this.opts.emitter.emitStream({
      type: 'start',
      attemptId,
      revision: this.opts.nextFrameRevision(),
      turn: this.opts.turn,
      step: this.step,
    })
    return attempt
  }

  private pushChunk(attempt: ActiveAttempt, chunk: StreamChunk): void {
    const timed = attempt.accumulator.push({ time: Date.now(), chunk })
    attempt.assembler.push(timed.chunk)
    this.opts.emitter.emitStream({
      type: 'chunk',
      attemptId: attempt.attemptId,
      revision: this.opts.nextFrameRevision(),
      index: attempt.chunkIndex++,
      time: timed.time,
      chunk: timed.chunk,
    })
  }

  private emitNormalizedTextChunk(
    attempt: ActiveAttempt,
    open: NonNullable<ActiveAttempt['openBlock']>,
    normalized: string,
  ): void {
    if (!normalized) return
    open.buffer += normalized
    if (open.kind === 'text') {
      this.pushChunk(attempt, { type: 'text-delta', index: open.index, text: normalized })
    } else {
      this.pushChunk(attempt, { type: 'reasoning-delta', index: open.index, text: normalized })
    }
  }

  private closeOpenTextualBlock(attempt: ActiveAttempt): void {
    const open = attempt.openBlock
    if (!open) return
    attempt.openBlock = undefined
    const tail = open.normalizer.flush()
    if (tail) {
      this.emitNormalizedTextChunk(attempt, open, tail)
    }
    if (open.kind === 'text') {
      this.pushChunk(attempt, {
        type: 'block-end',
        index: open.index,
        block: { type: 'text', text: open.buffer },
      })
    } else {
      this.pushChunk(attempt, {
        type: 'block-end',
        index: open.index,
        block: { type: 'reasoning', text: open.buffer },
      })
    }
  }

  private appendTextualDelta(kind: 'text' | 'reasoning', text: string): void {
    if (!text) return
    const attempt = this.ensureAttempt()
    if (attempt.openBlock && attempt.openBlock.kind !== kind) {
      this.closeOpenTextualBlock(attempt)
    }
    if (!attempt.openBlock) {
      const index = attempt.nextBlockIndex++
      attempt.openBlock = { index, kind, buffer: '', normalizer: new MarkdownFileLinkNormalizer() }
      this.pushChunk(attempt, { type: 'block-start', index, blockType: kind })
    }
    const normalized = attempt.openBlock.normalizer.push(text)
    this.emitNormalizedTextChunk(attempt, attempt.openBlock, normalized)
  }

  private handleToolStart(rawCallId: string, name: string, args: string): void {
    if (this.openTools.has(rawCallId)) return
    const callId = brandString<ToolCallId>(rawCallId)
    const attempt = this.ensureAttempt()
    this.closeOpenTextualBlock(attempt)

    const index = attempt.nextBlockIndex++
    this.pushChunk(attempt, { type: 'block-start', index, blockType: 'tool-call' })
    this.pushChunk(attempt, {
      type: 'tool-call-delta',
      index,
      id: callId,
      name,
      argumentsDelta: args,
    })
    this.pushChunk(attempt, {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: callId, name, arguments: args },
    })

    // Commit assistant/message immediately so the tool call is advertised before tool/call.
    this.commitAttempt('tool-calls', false)
    this.opts.session.append('tool/call', {
      turn: this.opts.turn,
      step: this.step,
      callId,
      name,
      arguments: args,
    })
    this.openTools.set(rawCallId, { callId, name, arguments: args })
  }

  private handleToolComplete(
    rawCallId: string,
    name: string,
    output: string,
    isError: boolean,
    meta?: Record<string, unknown>,
  ): void {
    let tool = this.openTools.get(rawCallId)
    if (!tool) {
      // Synthesize advertisement + tool/call if an external runtime emits completion without start.
      this.handleToolStart(rawCallId, name, '{}')
      tool = this.openTools.get(rawCallId)
    }
    if (!tool) return

    this.appendToolResult(tool.callId, output, isError, meta)
    this.openTools.delete(rawCallId)

    // Close the step once all in-flight tools for this step are settled so subsequent
    // assistant output starts cleanly on step + 1 (matching native AgentLoop layout).
    if (this.openTools.size === 0 && !this.attempt) {
      this.opts.session.append('step/end', { turn: this.opts.turn, step: this.step })
      this.stepOpen = false
    }
  }

  private sanitizeJsonMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!meta || Object.keys(meta).length === 0) return undefined
    try {
      const cleaned = JSON.parse(JSON.stringify(meta)) as unknown
      if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length > 0) {
        return cleaned as Record<string, unknown>
      }
    } catch {
      return undefined
    }
    return undefined
  }

  private appendToolResult(
    callId: ToolCallId,
    output: string,
    isError: boolean,
    meta?: Record<string, unknown>,
  ): void {
    const safeMeta = this.sanitizeJsonMeta(meta)
    this.opts.session.append(
      'tool/result',
      {
        turn: this.opts.turn,
        step: this.step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: output }],
          isError,
        }),
        ...(isError ? { error: { name: 'ExternalToolError', code: 'EXECUTION_FAILED' } } : {}),
        ...(safeMeta ? { meta: safeMeta as never } : {}),
      },
      { surfaceOp: 'append' },
    )
  }

  private commitAttempt(finishReason: 'stop' | 'tool-calls' | 'abort', interrupted: boolean): void {
    const attempt = this.attempt
    if (!attempt) return
    this.attempt = undefined

    this.closeOpenTextualBlock(attempt)
    if (this.latestUsage) {
      this.pushChunk(attempt, { type: 'usage', usage: this.latestUsage })
    }
    this.pushChunk(attempt, {
      type: 'finish',
      reason: finishReason === 'tool-calls' ? { kind: 'tool-calls' } : { kind: 'stop' },
    })

    const blocks = attempt.assembler.blocks()
    if (blocks.length === 0) {
      this.opts.emitter.emitStream({
        type: 'end',
        attemptId: attempt.attemptId,
        revision: this.opts.nextFrameRevision(),
        index: attempt.chunkIndex,
        outcome: { kind: 'abandoned' },
      })
      return
    }

    const message = createAssistantMessage({
      content: blocks,
      source: {
        provider: this.opts.provider,
        model: this.opts.model,
      },
    })
    const committed = this.opts.session.append(
      'assistant/message',
      {
        turn: this.opts.turn,
        step: this.step,
        message,
        ...(this.latestUsage ? { usage: this.latestUsage } : {}),
        ...(interrupted ? { interrupted: true } : {}),
        stream: [...attempt.accumulator.snapshot()],
      },
      { surfaceOp: 'append' },
    )
    this.opts.emitter.emitStream({
      type: 'end',
      attemptId: attempt.attemptId,
      revision: this.opts.nextFrameRevision(),
      index: attempt.chunkIndex,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: committed.seq },
    })
  }
}
