import { describe, expect, it, vi } from 'vitest'
import {
  CodexRuntimeClient,
  normalizeCodexApprovalRequest,
  normalizeCodexNotification,
  type CodexTurnEvent,
  type JsonRpcMessage,
  type JsonRpcTransport,
} from '../src/index.js'

class MockTransport implements JsonRpcTransport {
  readonly sent: JsonRpcMessage[] = []
  private readonly msgListeners = new Set<(m: JsonRpcMessage) => void>()
  private readonly closeListeners = new Set<(e?: Error) => void>()
  closed = false

  constructor(private readonly onSend?: (msg: JsonRpcMessage, transport: MockTransport) => void) {}

  send(message: JsonRpcMessage): void {
    this.sent.push(message)
    this.onSend?.(message, this)
  }

  emit(message: JsonRpcMessage): void {
    for (const l of this.msgListeners) l(message)
  }

  emitClose(error?: Error): void {
    this.closed = true
    for (const l of this.closeListeners) l(error)
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.msgListeners.add(listener)
    return () => this.msgListeners.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

describe('CodexRuntimeClient', () => {
  it('streams reasoning, tool execution, usage, and text in a normal turn', async () => {
    const transport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'codex' } } })
      } else if (msg.method === 'thread/start') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_1' } } })
      } else if (msg.method === 'turn/start') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn_1' } } })
        queueMicrotask(() => {
          t.emit({ jsonrpc: '2.0', method: 'item/reasoning/summaryTextDelta', params: { delta: 'thinking...' } })
          t.emit({
            jsonrpc: '2.0',
            method: 'item/started',
            params: { item: { type: 'commandExecution', id: 'cmd_1', command: 'echo hi', cwd: '/repo' } },
          })
          t.emit({
            jsonrpc: '2.0',
            method: 'item/commandExecution/outputDelta',
            params: { itemId: 'cmd_1', delta: 'hi\n' },
          })
          t.emit({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              item: {
                type: 'commandExecution',
                id: 'cmd_1',
                command: 'echo hi',
                status: 'completed',
                exitCode: 0,
                aggregatedOutput: 'hi\n',
              },
            },
          })
          t.emit({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'Done: hi' } })
          t.emit({
            jsonrpc: '2.0',
            method: 'thread/tokenUsage/updated',
            params: {
              tokenUsage: {
                last: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40 },
              },
            },
          })
          t.emit({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { turn: { id: 'turn_1', status: 'completed' } },
          })
        })
      }
    })

    const client = new CodexRuntimeClient({ cwd: '/tmp', transportFactory: () => transport })
    const threadId = await client.startOrResume({ model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' })
    expect(threadId).toBe('thr_1')

    const events: CodexTurnEvent[] = []
    const result = await client.runTurn(
      { text: 'run echo hi' },
      { onEvent: (ev) => events.push(ev) },
    )

    expect(result.status).toBe('completed')
    expect(result.text).toBe('Done: hi')
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 40,
    })
    expect(events.map((e) => e.type)).toEqual([
      'reasoning-delta',
      'tool-start',
      'tool-output-delta',
      'tool-complete',
      'text-delta',
      'usage',
    ])
    await client.close()
  })

  it('omits model overrides on cold thread/resume unless forceModelOverride is set', async () => {
    const resumeParams: unknown[] = []
    const transport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'thread/resume') {
        resumeParams.push(msg.params)
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_existing' } } })
      }
    })

    const client = new CodexRuntimeClient({ cwd: '/tmp', transportFactory: () => transport })
    await client.startOrResume({ threadId: 'thr_existing', model: 'gpt-6.1-sol', reasoningEffort: 'high' })
    expect((resumeParams[0] as Record<string, unknown>).config).toBeUndefined()

    await client.startOrResume({
      threadId: 'thr_existing',
      model: 'gpt-6.2-sol',
      reasoningEffort: 'xhigh',
      forceModelOverride: true,
    })
    expect((resumeParams[1] as Record<string, unknown>).config).toEqual({
      model: 'gpt-6.2-sol',
      model_reasoning_effort: 'xhigh',
    })
    await client.close()
  })

  it('recovers from missing rollout/thread on thread/resume by starting a fresh thread, while rethrowing auth/config errors', async () => {
    const logs: string[] = []
    const transport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'thread/resume') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32600, message: 'no rollout found for thread id thr_stale' },
        })
      } else if (msg.method === 'thread/start') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_fresh' } } })
      }
    })

    const client = new CodexRuntimeClient({
      cwd: '/tmp',
      logger: (m) => logs.push(m),
      transportFactory: () => transport,
    })
    const threadId = await client.startOrResume({
      threadId: 'thr_stale',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
    })
    expect(threadId).toBe('thr_fresh')
    expect(transport.sent.map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'thread/start',
    ])
    expect(logs.some((m) => m.includes('thr_stale'))).toBe(true)
    await client.close()

    const authErrorTransport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      else if (msg.method === 'thread/resume') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'No auth token available' },
        })
      }
    })
    const authClient = new CodexRuntimeClient({ cwd: '/tmp', transportFactory: () => authErrorTransport })
    await expect(authClient.startOrResume({ threadId: 'thr_existing' })).rejects.toThrow(
      'No auth token available',
    )
    expect(authErrorTransport.sent.map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
    ])
    await authClient.close()
  })

  it('applies changed model/effort on the first turn/start after cold thread/resume without mutating thread/resume config', async () => {
    const turnParams: Array<Record<string, unknown>> = []
    let turnSeq = 0
    const transport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'thread/resume') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            thread: { id: 'thr_existing', model: 'gpt-6.1-sol' },
            model: 'gpt-6.1-sol',
            modelProvider: 'custom_proxy',
            reasoningEffort: 'low',
          },
        })
      } else if (msg.method === 'turn/start') {
        turnSeq += 1
        turnParams.push(msg.params as Record<string, unknown>)
        const turnId = `turn_${turnSeq}`
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: turnId } } })
        queueMicrotask(() => {
          t.emit({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'ok' } })
          t.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } })
        })
      }
    })

    const client = new CodexRuntimeClient({ cwd: '/tmp', transportFactory: () => transport })
    await client.startOrResume({
      threadId: 'thr_existing',
      model: 'gpt-6.2-sol',
      reasoningEffort: 'high',
    })
    const resumeReq = transport.sent.find((m) => m.method === 'thread/resume')
    expect((resumeReq?.params as Record<string, unknown>).config).toBeUndefined()

    await client.runTurn({ text: 'turn 1 after cold resume' })
    expect(turnParams[0]).toMatchObject({ model: 'gpt-6.2-sol', effort: 'high' })

    // Consumed once; next turn without model change omits redundant overrides.
    await client.runTurn({ text: 'turn 2 same model' })
    expect(turnParams[1]?.model).toBeUndefined()
    expect(turnParams[1]?.effort).toBeUndefined()
    await client.close()
  })

  it('bridges approvals, user input, and interrupts turn when user input fails', async () => {
    const serverResponses: JsonRpcMessage[] = []
    let interruptCalled = false
    const transport = new MockTransport((msg, t) => {
      if (msg.id !== undefined && !msg.method) {
        serverResponses.push(msg)
        return
      }
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'thread/start') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_2' } } })
      } else if (msg.method === 'turn/start') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn_2' } } })
        queueMicrotask(() => {
          t.emit({
            jsonrpc: '2.0',
            id: 901,
            method: 'item/commandExecution/requestApproval',
            params: { itemId: 'c1', command: 'rm -rf build' },
          })
          t.emit({
            jsonrpc: '2.0',
            id: 902,
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thr_2',
              turnId: 'turn_2',
              questions: [{ id: 'q1', question: 'Continue?' }],
            },
          })
        })
      } else if (msg.method === 'turn/interrupt') {
        interruptCalled = true
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
        t.emit({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { turn: { id: 'turn_2', status: 'interrupted' } },
        })
      }
    })

    const client = new CodexRuntimeClient({ cwd: '/tmp', transportFactory: () => transport })
    await client.startOrResume()

    const onApproval = vi.fn().mockResolvedValue('reject')
    const onUserInput = vi.fn().mockRejectedValue(new Error('user dismissed'))
    const result = await client.runTurn({ text: 'dangerous op' }, { onApproval, onUserInput })

    expect(onApproval).toHaveBeenCalledTimes(1)
    expect(serverResponses).toContainEqual({
      jsonrpc: '2.0',
      id: 901,
      result: { decision: 'decline' },
    })
    expect(interruptCalled).toBe(true)
    expect(result.status).toBe('interrupted')
    await client.close()
  })

  it('rejects active turn explicitly when transport crashes unexpectedly', async () => {
    const transport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      else if (msg.method === 'thread/start') t.emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_3' } } })
      else if (msg.method === 'turn/start') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn_3' } } })
        queueMicrotask(() => t.emitClose(new Error('SIGSEGV')))
      }
    })

    const client = new CodexRuntimeClient({ cwd: '/tmp', transportFactory: () => transport })
    await client.startOrResume()
    await expect(client.runTurn({ text: 'hello' })).rejects.toThrow('SIGSEGV')
  })

  it('parses model/list catalog cleanly', async () => {
    const transport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      else if (msg.method === 'model/list') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            data: [
              {
                id: 'gpt-6.1-sol',
                displayName: 'GPT-6.1 Sol',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }],
                defaultReasoningEffort: 'xhigh',
              },
            ],
          },
        })
      }
    })

    const models = await CodexRuntimeClient.probeModels({ cwd: '/tmp', transportFactory: () => transport })
    expect(models).toEqual([
      {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol',
        supportedReasoningEfforts: ['low', 'xhigh'],
        reasoningEffortsDeclared: true,
        defaultReasoningEffort: 'xhigh',
      },
    ])
    expect(transport.closed).toBe(true)
  })

  it('paginates model/list, filters hidden models, and preserves Trae snake_case & fixed-effort metadata', async () => {
    const transport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'model/list') {
        const cursor = (msg.params as { cursor?: string } | undefined)?.cursor
        if (!cursor) {
          t.emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              data: [
                {
                  id: 'Doubao-Seed-2.0-Code',
                  displayName: 'Doubao-Seed-2.0-Code',
                  supportedReasoningEfforts: [],
                  context_window: 256_000,
                  isDefault: true,
                },
                {
                  id: 'internal-hidden-model',
                  hidden: true,
                  supportedReasoningEfforts: ['high'],
                },
              ],
              nextCursor: 'page_2',
            },
          })
        } else if (cursor === 'page_2') {
          t.emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              data: [
                {
                  slug: 'DeepSeek-V4-Pro',
                  name: 'DeepSeek-V4-Pro',
                  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
                  default_reasoning_level: 'medium',
                  context_window: 128_000,
                },
                {
                  slug: 'hidden-by-visibility',
                  visibility: 'hidden',
                },
              ],
              nextCursor: null,
            },
          })
        }
      }
    })

    const models = await CodexRuntimeClient.probeModels({
      cwd: '/tmp',
      cliBin: 'traecli',
      args: ['app-server', '--listen', 'stdio://'],
      transportFactory: () => transport,
    })

    expect(models).toEqual([
      {
        id: 'Doubao-Seed-2.0-Code',
        name: 'Doubao-Seed-2.0-Code',
        supportedReasoningEfforts: [],
        reasoningEffortsDeclared: true,
        contextWindow: 256_000,
        isDefault: true,
      },
      {
        id: 'DeepSeek-V4-Pro',
        name: 'DeepSeek-V4-Pro',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        reasoningEffortsDeclared: true,
        defaultReasoningEffort: 'medium',
        contextWindow: 128_000,
      },
    ])
  })

  it('maps Codex tool items to native DSH tool names, schemas, and presentation meta', () => {
    // 1. Shell command execution: unwraps /bin/zsh -lc and formats non-zero exit marker
    const cmdStart = normalizeCodexNotification('item/started', {
      item: {
        type: 'commandExecution',
        id: 'cmd_42',
        command: "/bin/zsh -lc 'git status --short'",
        cwd: '/repo/app',
      },
    })
    expect(cmdStart).toEqual([
      {
        type: 'tool-start',
        callId: 'cmd_42',
        name: 'bash',
        arguments: JSON.stringify({
          command: 'git status --short',
          description: 'git status --short',
          workdir: '/repo/app',
        }),
      },
    ])

    const cmdDone = normalizeCodexNotification('item/completed', {
      item: {
        type: 'commandExecution',
        id: 'cmd_42',
        command: "/bin/zsh -lc 'git status --short'",
        cwd: '/repo/app',
        status: 'failed',
        exitCode: 128,
        aggregatedOutput: 'fatal: not a git repository\n',
      },
    })
    expect(cmdDone).toEqual([
      {
        type: 'tool-complete',
        callId: 'cmd_42',
        name: 'bash',
        output: 'fatal: not a git repository\n[exit code: 128]',
        isError: false,
        meta: { cwd: '/repo/app' },
      },
    ])

    // 2. Single file update -> native `edit` + contextual DiffHunk meta
    const editStart = normalizeCodexNotification('item/started', {
      item: {
        type: 'fileChange',
        id: 'fc_edit',
        changes: [
          {
            path: '/repo/src/index.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1,2 +1,2 @@\n const x = 1\n-export default x\n+export default x + 1',
          },
        ],
      },
    })
    expect(editStart).toEqual([
      {
        type: 'tool-start',
        callId: 'fc_edit',
        name: 'edit',
        arguments: JSON.stringify({
          file_path: '/repo/src/index.ts',
          old_string: 'const x = 1\nexport default x',
          new_string: 'const x = 1\nexport default x + 1',
        }),
      },
    ])

    const editDone = normalizeCodexNotification('item/completed', {
      item: {
        type: 'fileChange',
        id: 'fc_edit',
        status: 'completed',
        changes: [
          {
            path: '/repo/src/index.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1,2 +1,2 @@\n const x = 1\n-export default x\n+export default x + 1',
          },
        ],
      },
    })
    expect(editDone).toEqual([
      {
        type: 'tool-complete',
        callId: 'fc_edit',
        name: 'edit',
        output: '/repo/src/index.ts',
        isError: false,
        meta: {
          path: '/repo/src/index.ts',
          diffs: [
            {
              path: '/repo/src/index.ts',
              oldText: 'const x = 1\nexport default x',
              newText: 'const x = 1\nexport default x + 1',
            },
          ],
        },
      },
    ])

    // 3. Multi-file / move patch -> native `apply_patch` with valid DSH patch envelope + diffs meta
    const patchStart = normalizeCodexNotification('item/started', {
      item: {
        type: 'fileChange',
        id: 'fc_multi',
        changes: [
          { path: '/repo/a.ts', kind: { type: 'add' }, diff: '+export const a = 1' },
          {
            path: '/repo/old.ts',
            kind: { type: 'update', move_path: '/repo/new.ts' },
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      },
    })
    expect(patchStart[0]).toMatchObject({
      type: 'tool-start',
      callId: 'fc_multi',
      name: 'apply_patch',
    })
    const parsedPatchArgs = JSON.parse((patchStart[0] as { arguments: string }).arguments) as { input: string }
    expect(parsedPatchArgs.input).toContain('*** Begin Patch')
    expect(parsedPatchArgs.input).toContain('*** Add File: /repo/a.ts')
    expect(parsedPatchArgs.input).toContain('*** Update File: /repo/old.ts\n*** Move to: /repo/new.ts')
    expect(parsedPatchArgs.input).toContain('*** End Patch')

    // 4. Web search & open_page -> native `web_search` and `web_fetch`
    const searchDone = normalizeCodexNotification('item/completed', {
      item: {
        type: 'webSearch',
        id: 'ws_1',
        query: 'dsh tool cards',
        action: { type: 'search', queries: ['dsh tool cards'] },
        results: [{ url: 'https://example.com/docs', title: 'Docs', snippet: 'Tool cards guide' }],
      },
    })
    expect(searchDone).toEqual([
      {
        type: 'tool-complete',
        callId: 'ws_1',
        name: 'web_search',
        output: JSON.stringify([{ url: 'https://example.com/docs', title: 'Docs', snippet: 'Tool cards guide' }]),
        isError: false,
        meta: {
          sources: [{ url: 'https://example.com/docs', title: 'Docs', snippet: 'Tool cards guide' }],
          truncated: false,
        },
      },
    ])

    const fetchStart = normalizeCodexNotification('item/started', {
      item: {
        type: 'webSearch',
        id: 'ws_2',
        query: '',
        action: { type: 'open_page', url: 'https://example.com/docs' },
      },
    })
    expect(fetchStart).toEqual([
      {
        type: 'tool-start',
        callId: 'ws_2',
        name: 'web_fetch',
        arguments: JSON.stringify({ url: 'https://example.com/docs' }),
      },
    ])

    // 5. Approval requests use native tool names instead of synthetic codex_* names
    expect(
      normalizeCodexApprovalRequest('item/commandExecution/requestApproval', {
        itemId: 'cmd_42',
        command: ['/bin/zsh', '-lc', 'pnpm test'],
      }),
    ).toMatchObject({
      toolName: 'bash',
      reason: 'Run command: pnpm test',
    })
    expect(
      normalizeCodexApprovalRequest('item/fileChange/requestApproval', { itemId: 'fc_1' }),
    ).toMatchObject({
      toolName: 'apply_patch',
    })
  })

  it('CodexStdioTransport converts async stdin EPIPE errors into controlled onClose without crashing host', async () => {
    const { CodexStdioTransport } = await import('../src/stdio-transport.js')
    const transport = new CodexStdioTransport({
      cliBin: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: process.cwd(),
      env: process.env,
    })

    const closedErrors: Array<Error | undefined> = []
    transport.onClose((err) => closedErrors.push(err))

    const child = (transport as unknown as { child: { stdin: { emit: (ev: string, err: Error) => void } } }).child
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    child.stdin.emit('error', epipe)

    expect(closedErrors).toHaveLength(1)
    expect(closedErrors[0]?.message).toContain('stdin error: write EPIPE')
    expect(() => transport.send({ jsonrpc: '2.0', method: 'ping' })).toThrow(/transport is closed/)
    await transport.close()
  })

  it('conservatively forwards model/effort on next turn when thread/resume omits model echo', async () => {
    const turnStarts: Array<Record<string, unknown>> = []
    const transport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'thread/resume') {
        // Response omits `model` and `reasoningEffort`
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_silent' } } })
      } else if (msg.method === 'turn/start') {
        turnStarts.push((msg.params ?? {}) as Record<string, unknown>)
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn_silent_1' } } })
        queueMicrotask(() => {
          t.emit({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { turn: { id: 'turn_silent_1', status: 'completed' } },
          })
        })
      }
    })

    const client = new CodexRuntimeClient({ cwd: '/tmp', transportFactory: () => transport })
    await client.startOrResume({
      threadId: 'thr_silent',
      model: 'gpt-5.4-pro',
      reasoningEffort: 'xhigh',
    })
    await client.runTurn({ text: 'continue' })

    expect(turnStarts[0]).toMatchObject({
      threadId: 'thr_silent',
      model: 'gpt-5.4-pro',
      effort: 'xhigh',
    })
    await client.close()
  })

  it('sends turn/interrupt when abort fires before turn/start resolves, and closes transport on initialize failure', async () => {
    // 1. initialize() failure closes transport and stale close cannot clobber next transport
    const failedTransport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boot fail' } })
      }
    })
    let turnStartResolve: (() => void) | undefined
    const interrupts: Array<Record<string, unknown>> = []
    const goodTransport = new MockTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'thread/start') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_race' } } })
      } else if (msg.method === 'turn/start') {
        turnStartResolve = () => {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn_late_id' } } })
        }
      } else if (msg.method === 'turn/interrupt') {
        interrupts.push((msg.params ?? {}) as Record<string, unknown>)
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
        t.emit({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { turn: { id: 'turn_late_id', status: 'interrupted' } },
        })
      }
    })

    let attempt = 0
    const client = new CodexRuntimeClient({
      cwd: '/tmp',
      transportFactory: () => (attempt++ === 0 ? failedTransport : goodTransport),
    })

    await expect(client.initialize()).rejects.toThrow(/boot fail/)
    expect(failedTransport.closed).toBe(true)

    // Next init succeeds; stale close from failedTransport must not reset goodTransport
    await client.startOrResume()
    failedTransport.emitClose(new Error('stale close'))

    // 2. Abort before turn/start resolves -> interrupt fires once nativeTurnId arrives
    const ac = new AbortController()
    const runPromise = client.runTurn({ text: 'slow start' }, {}, ac.signal)
    ac.abort('user-cancel')
    expect(interrupts).toHaveLength(0)

    turnStartResolve?.()
    const res = await runPromise
    expect(res.status).toBe('interrupted')
    expect(interrupts).toEqual([{ threadId: 'thr_race', turnId: 'turn_late_id' }])
    await client.close()
  })
})
