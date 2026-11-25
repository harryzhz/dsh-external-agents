import { brandString } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { ExternalStepRecorder } from '../src/step-recorder.js'

interface RecordedEvent {
  readonly seq: number
  readonly type: string
  readonly data: Record<string, unknown>
  readonly options?: Record<string, unknown>
}

function createFakeSession(): { session: Session; events: RecordedEvent[] } {
  const events: RecordedEvent[] = []
  const session = {
    append(type: string, data: Record<string, unknown>, options?: Record<string, unknown>) {
      const rec: RecordedEvent = { seq: events.length, type, data, options }
      events.push(rec)
      return rec
    },
  } as unknown as Session
  return { session, events }
}

describe('ExternalStepRecorder', () => {
  it('emits strictly paired step/assistant/tool/result/step_end events across multi-step tool flow', () => {
    const { session, events } = createFakeSession()
    const streamTypes: string[] = []
    let attemptSeq = 0
    let rev = 0

    const recorder = new ExternalStepRecorder({
      agentId: 'a1',
      session,
      emitter: { emitStream: (ev) => streamTypes.push(ev.type) },
      turn: 1,
      provider: 'codex-cli',
      model: 'gpt-6.1-sol',
      nextAttemptId: () => brandString<LlmAttemptId>(`att_${++attemptSeq}`),
      nextFrameRevision: () => ++rev,
    })

    recorder.startInitialStep()
    recorder.handleEvent({ type: 'reasoning-delta', text: 'Plan: run echo' })
    recorder.handleEvent({ type: 'text-delta', text: 'Running command...' })
    recorder.handleEvent({
      type: 'tool-start',
      callId: 'call_1',
      name: 'bash',
      arguments: '{"command":"echo ok","description":"echo ok"}',
    })
    recorder.handleEvent({
      type: 'tool-complete',
      callId: 'call_1',
      name: 'bash',
      output: 'ok',
      isError: false,
      meta: { cwd: '/repo', ignoredUndefined: undefined },
    })
    recorder.handleEvent({ type: 'usage', usage: { inputTokens: 50, outputTokens: 15, totalTokens: 65 } })
    recorder.handleEvent({ type: 'text-delta', text: 'Output was ok.' })
    recorder.finish(false)

    expect(events.map((e) => e.type)).toEqual([
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
    ])

    // Verify assistant/message carries model source (required by DSH v4 cold-read validator)
    const msg1 = events[1]!.data.message as { source: Record<string, unknown>; content: unknown[] }
    expect(msg1.source).toEqual({ kind: 'model', provider: 'codex-cli', model: 'gpt-6.1-sol' })
    expect(msg1.content.map((b) => (b as { type: string }).type)).toEqual([
      'reasoning',
      'text',
      'tool-call',
    ])

    // Verify tool/call arguments match advertised tool-call block identically
    const toolCallBlock = msg1.content[2] as { id: string; name: string; arguments: string }
    expect(events[2]!.data).toMatchObject({
      turn: 1,
      step: 1,
      callId: toolCallBlock.id,
      name: toolCallBlock.name,
      arguments: toolCallBlock.arguments,
    })

    // Verify tool/result preserves JSON-sanitized presentation metadata
    expect(events[3]!.data.meta).toEqual({ cwd: '/repo' })

    // Verify step 2 final assistant message has usage attached
    expect(events[5]!.data).toEqual({ turn: 1, step: 2 })
    expect(events[6]!.data.usage).toEqual({ inputTokens: 50, outputTokens: 15, totalTokens: 65 })
    expect(streamTypes).toContain('start')
    expect(streamTypes).toContain('chunk')
    expect(streamTypes).toContain('end')
  })

  it('closes dangling tools with error tool/result when interrupted mid-execution', () => {
    const { session, events } = createFakeSession()
    let attemptSeq = 0
    let rev = 0

    const recorder = new ExternalStepRecorder({
      agentId: 'a2',
      session,
      emitter: { emitStream: () => {} },
      turn: 1,
      provider: 'agy-cli',
      model: 'gemini-4-neon-xhigh',
      nextAttemptId: () => brandString<LlmAttemptId>(`att_${++attemptSeq}`),
      nextFrameRevision: () => ++rev,
    })

    recorder.startInitialStep()
    recorder.handleEvent({
      type: 'tool-start',
      callId: 'tc_orphan',
      name: 'run_command',
      arguments: '{"cmd":"sleep 999"}',
    })
    recorder.finish(true, 'User cancelled')

    expect(events.map((e) => e.type)).toEqual([
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
    ])
    expect(events[3]!.data.error).toEqual({ name: 'ExternalToolError', code: 'EXECUTION_FAILED' })
  })

  it('splits consecutive agentMessage items into distinct text blocks on message-start', () => {
    const { session, events } = createFakeSession()
    let attemptSeq = 0
    let rev = 0

    const recorder = new ExternalStepRecorder({
      agentId: 'a3',
      session,
      emitter: { emitStream: () => {} },
      turn: 1,
      provider: 'codex-cli',
      model: 'gpt-6.1-sol',
      nextAttemptId: () => brandString<LlmAttemptId>(`att_${++attemptSeq}`),
      nextFrameRevision: () => ++rev,
    })

    recorder.startInitialStep()
    recorder.handleEvent({ type: 'message-start', itemId: 'msg_1', phase: 'commentary' })
    recorder.handleEvent({ type: 'text-delta', text: '先整理一下结论。' })
    recorder.handleEvent({ type: 'message-start', itemId: 'msg_2', phase: 'final_answer' })
    recorder.handleEvent({ type: 'text-delta', text: '最终答复。' })
    recorder.finish(false)

    const assistantEvent = events.find((e) => e.type === 'assistant/message')!
    const msg = assistantEvent.data.message as { content: Array<{ type: string; text: string }> }
    expect(msg.content).toEqual([
      { type: 'text', text: '先整理一下结论。' },
      { type: 'text', text: '最终答复。' },
    ])
  })

  it('normalizes local file:// markdown links across streaming chunks so stream deltas match persisted blocks', () => {
    const { session, events } = createFakeSession()
    const streamedText: string[] = []
    const streamedReasoning: string[] = []
    let attemptSeq = 0
    let rev = 0

    const recorder = new ExternalStepRecorder({
      agentId: 'a4',
      session,
      emitter: {
        emitStream: (ev) => {
          if (ev.type !== 'chunk') return
          if (ev.chunk.type === 'text-delta') streamedText.push(ev.chunk.text)
          if (ev.chunk.type === 'reasoning-delta') streamedReasoning.push(ev.chunk.text)
        },
      },
      turn: 1,
      provider: 'agy-cli',
      model: 'gemini-4-neon',
      nextAttemptId: () => brandString<LlmAttemptId>(`att_${++attemptSeq}`),
      nextFrameRevision: () => ++rev,
    })

    recorder.startInitialStep()
    for (const piece of ['Check [plan.md](fi', 'le:///Users/demo/plan.md#L3)']) {
      recorder.handleEvent({ type: 'reasoning-delta', text: piece })
    }
    const rawReply =
      'Updated [MemoryView.tsx](file:///Users/demo/repo/MemoryView.tsx#L10-L20) and kept `[raw](file:///Users/demo/raw.ts)`.'
    for (let i = 0; i < rawReply.length; i += 4) {
      recorder.handleEvent({ type: 'text-delta', text: rawReply.slice(i, i + 4) })
    }
    recorder.finish(false)

    const expectedReasoning = 'Check [plan.md](/Users/demo/plan.md#L3)'
    const expectedText =
      'Updated [MemoryView.tsx](/Users/demo/repo/MemoryView.tsx#L10-L20) and kept `[raw](file:///Users/demo/raw.ts)`.'

    expect(streamedReasoning.join('')).toBe(expectedReasoning)
    expect(streamedText.join('')).toBe(expectedText)

    const assistantEvent = events.find((e) => e.type === 'assistant/message')!
    const msg = assistantEvent.data.message as { content: Array<{ type: string; text: string }> }
    expect(msg.content).toEqual([
      { type: 'reasoning', text: expectedReasoning },
      { type: 'text', text: expectedText },
    ])
  })

  it('flushes buffered incomplete link tail cleanly when aborted mid-stream', () => {
    const { session, events } = createFakeSession()
    const streamedText: string[] = []
    let attemptSeq = 0
    let rev = 0

    const recorder = new ExternalStepRecorder({
      agentId: 'a5',
      session,
      emitter: {
        emitStream: (ev) => {
          if (ev.type === 'chunk' && ev.chunk.type === 'text-delta') {
            streamedText.push(ev.chunk.text)
          }
        },
      },
      turn: 1,
      provider: 'agy-cli',
      model: 'gemini-4-neon',
      nextAttemptId: () => brandString<LlmAttemptId>(`att_${++attemptSeq}`),
      nextFrameRevision: () => ++rev,
    })

    recorder.startInitialStep()
    recorder.handleEvent({ type: 'text-delta', text: 'Inspect [MemoryView.tsx](file:///Users/demo/Mem' })
    recorder.finish(true, 'Aborted by user')

    const expectedText = 'Inspect [MemoryView.tsx](file:///Users/demo/Mem'
    expect(streamedText.join('')).toBe(expectedText)
    const assistantEvent = events.find((e) => e.type === 'assistant/message')!
    const msg = assistantEvent.data.message as { content: Array<{ type: string; text: string }> }
    expect(msg.content).toEqual([{ type: 'text', text: expectedText }])
  })
})
