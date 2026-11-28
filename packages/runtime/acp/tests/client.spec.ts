import { describe, expect, it, vi } from 'vitest'
import {
  AcpRpcError,
  AcpRuntimeClient,
  normalizeAcpPermissionRequest,
  normalizeAcpSessionUpdate,
  parseAcpCatalog,
  stripSshSessionEnv,
  type AcpActiveToolCall,
  type AcpJsonRpcMessage,
  type AcpJsonRpcTransport,
  type AcpTurnEvent,
} from '../src/index.js'

class MockAcpTransport implements AcpJsonRpcTransport {
  readonly sent: AcpJsonRpcMessage[] = []
  private readonly msgListeners = new Set<(m: AcpJsonRpcMessage) => void>()
  private readonly closeListeners = new Set<(e?: Error) => void>()
  closed = false

  constructor(private readonly onSend?: (msg: AcpJsonRpcMessage, transport: MockAcpTransport) => void) {}

  send(message: AcpJsonRpcMessage): void {
    this.sent.push(message)
    this.onSend?.(message, this)
  }

  emit(message: AcpJsonRpcMessage): void {
    for (const l of this.msgListeners) l(message)
  }

  emitClose(error?: Error): void {
    this.closed = true
    for (const l of this.closeListeners) l(error)
  }

  onMessage(listener: (message: AcpJsonRpcMessage) => void): () => void {
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

describe('stripSshSessionEnv', () => {
  it('strips SSH session variables while preserving SSH_AUTH_SOCK', () => {
    const env = stripSshSessionEnv({
      PATH: '/usr/bin',
      SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0',
      SSH_CLIENT: '127.0.0.1 0 22',
      SSH_TTY: '/dev/ttys001',
      SSH_AUTH_SOCK: '/private/tmp/auth.sock',
    })
    expect(env.SSH_CONNECTION).toBeUndefined()
    expect(env.SSH_CLIENT).toBeUndefined()
    expect(env.SSH_TTY).toBeUndefined()
    expect(env.SSH_AUTH_SOCK).toBe('/private/tmp/auth.sock')
    expect(env.PATH).toBe('/usr/bin')
  })
})

describe('AcpRuntimeClient', () => {
  it('handles session/new, streaming thought/tool/text, permission request, and final usage', async () => {
    const serverResponses: AcpJsonRpcMessage[] = []
    let capturedEnv: NodeJS.ProcessEnv | undefined

    const transport = new MockAcpTransport((msg, t) => {
      if (msg.id !== undefined && !msg.method) {
        serverResponses.push(msg)
        return
      }
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
      } else if (msg.method === 'session/new') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'acp_s1',
            models: {
              currentModelId: 'gemini-4-neon-high',
              availableModels: [
                { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
                { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
              ],
            },
            modes: {
              currentModeId: 'default',
              availableModes: [{ id: 'default', name: 'Default' }, { id: 'auto', name: 'Auto' }],
            },
          },
        })
      } else if (msg.method === 'session/set_model') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'session/prompt') {
        queueMicrotask(() => {
          t.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp_s1',
              update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'checking' } },
            },
          })
          t.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp_s1',
              update: { sessionUpdate: 'tool_call', toolCallId: 'tc_1', name: 'run_command', args: { cmd: 'ls' } },
            },
          })
          t.emit({
            jsonrpc: '2.0',
            id: 77,
            method: 'session/request_permission',
            params: {
              sessionId: 'acp_s1',
              toolCall: { toolCallId: 'tc_1', name: 'run_command', title: 'Run ls' },
              options: [
                { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
              ],
            },
          })
          setTimeout(() => {
            t.emit({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp_s1',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tc_1',
                  status: 'completed',
                  rawOutput: 'file.ts',
                },
              },
            })
            t.emit({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp_s1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Found file.ts' } },
              },
            })
            t.emit({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                stopReason: 'end_turn',
                usage: { inputTokens: 200, outputTokens: 30, thoughtTokens: 12, totalTokens: 230 },
              },
            })
          }, 10)
        })
      }
    })

    let capturedLaunch: { command: string; args: readonly string[] } | undefined
    const client = new AcpRuntimeClient({
      command: 'agent-cli',
      args: ['acp', '--stdio'],
      cwd: '/repo',
      env: { SSH_AUTH_SOCK: '/sock' },
      transportFactory: (opts) => {
        capturedEnv = opts.env
        capturedLaunch = { command: opts.command, args: opts.args }
        return transport
      },
    })

    const sid = await client.startOrResume({ modelId: 'gemini-4-neon-xhigh' })
    expect(sid).toBe('acp_s1')
    expect(capturedLaunch).toEqual({ command: 'agent-cli', args: ['acp', '--stdio'] })
    expect(capturedEnv).toEqual({ SSH_AUTH_SOCK: '/sock' })
    expect(client.catalog?.models).toHaveLength(2)
    expect(transport.sent.find((m) => m.method === 'session/set_model')?.params).toEqual({
      sessionId: 'acp_s1',
      modelId: 'gemini-4-neon-xhigh',
    })

    const events: AcpTurnEvent[] = []
    const onPermission = vi.fn().mockResolvedValue({ outcome: 'selected', optionId: 'allow_once' })
    const res = await client.runTurn(
      [{ type: 'text', text: 'list files' }],
      { onEvent: (ev) => events.push(ev), onPermission },
    )

    expect(onPermission).toHaveBeenCalledTimes(1)
    expect(serverResponses).toContainEqual({
      jsonrpc: '2.0',
      id: 77,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    expect(res.text).toBe('Found file.ts')
    expect(res.usage).toEqual({
      inputTokens: 200,
      outputTokens: 30,
      reasoningTokens: 12,
      totalTokens: 230,
    })
    expect(events.map((e) => e.type)).toEqual([
      'reasoning-delta',
      'tool-start',
      'tool-complete',
      'text-delta',
      'usage',
    ])
    await client.close()
  })

  it('sends session/cancel when AbortSignal fires and surfaces RPC errors explicitly', async () => {
    let cancelSent = false
    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      else if (msg.method === 'session/resume') t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      else if (msg.method === 'session/cancel') {
        cancelSent = true
      } else if (msg.method === 'session/prompt') {
        setTimeout(() => {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'cancelled' } })
        }, 20)
      }
    })

    const client = new AcpRuntimeClient({ cwd: '/repo', command: 'agent', args: [], transportFactory: () => transport })
    await client.startOrResume({ sessionId: 'acp_existing' })

    const ac = new AbortController()
    const promise = client.runTurn([{ type: 'text', text: 'long task' }], {}, ac.signal)
    ac.abort()
    const res = await promise
    expect(cancelSent).toBe(true)
    expect(res.stopReason).toBe('cancelled')
    await client.close()
  })
})

describe('AcpRuntimeClient session recovery', () => {
  type Reply = { result: unknown } | { error: { code: number; message: string } }

  function recoveryTransport(
    agentCapabilities: Record<string, unknown>,
    replies: Partial<Record<'session/resume' | 'session/load' | 'session/new', Reply>>,
    onLoad?: (t: MockAcpTransport) => void,
  ): MockAcpTransport {
    return new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities } })
        return
      }
      const reply = replies[msg.method as keyof typeof replies]
      if (!reply) return
      if (msg.method === 'session/load') onLoad?.(t)
      t.emit({ jsonrpc: '2.0', id: msg.id, ...reply })
    })
  }

  function methodsSent(transport: MockAcpTransport): string[] {
    return transport.sent.map((m) => m.method).filter((m): m is string => Boolean(m))
  }

  it('falls back from session/resume to session/load on method-not-found and ignores replayed history', async () => {
    const transport = recoveryTransport(
      { loadSession: true },
      {
        'session/resume': { error: { code: -32601, message: 'Method not found' } },
        'session/load': {
          result: { models: { currentModelId: 'opus', availableModels: [{ modelId: 'opus', name: 'Opus' }] } },
        },
      },
      (t) => {
        // History replay emitted during session/load must not leak into a later turn.
        t.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'acp_old',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } },
          },
        })
      },
    )
    const logs: string[] = []
    const client = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agent',
      args: [],
      logger: (m) => logs.push(m),
      transportFactory: () => transport,
    })

    const sid = await client.startOrResume({ sessionId: 'acp_old' })

    expect(sid).toBe('acp_old')
    expect(methodsSent(transport)).toEqual(['initialize', 'session/resume', 'session/load'])
    expect(transport.sent.find((m) => m.method === 'session/load')?.params).toEqual({
      sessionId: 'acp_old',
      cwd: '/repo',
      mcpServers: [],
    })
    expect(client.catalog?.currentModelId).toBe('opus')
    expect(client.initializeResult?.agentCapabilities).toEqual({
      loadSession: true,
      resume: 'unknown',
      promptImage: false,
    })
    expect(logs.some((m) => m.includes('session/resume'))).toBe(true)
    await client.close()
  })

  it('skips session/resume when capabilities declare it unsupported and starts a new session without loadSession', async () => {
    const transport = recoveryTransport(
      { loadSession: false, sessionCapabilities: { list: {} } },
      { 'session/new': { result: { sessionId: 'acp_fresh' } } },
    )
    const client = new AcpRuntimeClient({ cwd: '/repo', command: 'agent', args: [], transportFactory: () => transport })

    const sid = await client.startOrResume({ sessionId: 'acp_old' })

    expect(sid).toBe('acp_fresh')
    expect(client.sessionId).toBe('acp_fresh')
    expect(methodsSent(transport)).toEqual(['initialize', 'session/new'])
    await client.close()
  })

  it('starts a new session when the agent reports the session as not found', async () => {
    const transport = recoveryTransport(
      { loadSession: true, sessionCapabilities: { resume: {} } },
      {
        'session/resume': { error: { code: -32002, message: 'Resource not found' } },
        'session/new': { result: { sessionId: 'acp_new' } },
      },
    )
    const client = new AcpRuntimeClient({ cwd: '/repo', command: 'agent', args: [], transportFactory: () => transport })

    const sid = await client.startOrResume({ sessionId: 'acp_gone' })

    expect(sid).toBe('acp_new')
    expect(methodsSent(transport)).toEqual(['initialize', 'session/resume', 'session/new'])
    await client.close()
  })

  it('propagates other resume errors with their JSON-RPC code instead of silently falling back', async () => {
    const transport = recoveryTransport(
      { loadSession: true, sessionCapabilities: { resume: {} } },
      { 'session/resume': { error: { code: -32603, message: 'Internal error' } } },
    )
    const client = new AcpRuntimeClient({ cwd: '/repo', command: 'agent', args: [], transportFactory: () => transport })

    const err = await client.startOrResume({ sessionId: 'acp_old' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AcpRpcError)
    expect(err).toMatchObject({ code: -32603, method: 'session/resume', message: 'Internal error' })
    expect(methodsSent(transport)).toEqual(['initialize', 'session/resume'])
    await client.close()
  })

  it('falls back from session/resume to session/load when resume error suggests session/load', async () => {
    const transport = recoveryTransport(
      { loadSession: true, sessionCapabilities: { resume: {} } },
      {
        'session/resume': {
          error: {
            code: -32603,
            message: 'Failed to read session acp_legacy; retry, or load it with session/load',
          },
        },
        'session/load': {
          result: { models: { currentModelId: 'gemini-4-neon', availableModels: [{ modelId: 'gemini-4-neon', name: 'Neon' }] } },
        },
      },
    )
    const logs: string[] = []
    const client = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agy',
      args: ['acp', '--stdio'],
      logger: (m) => logs.push(m),
      transportFactory: () => transport,
    })

    const sid = await client.startOrResume({ sessionId: 'acp_legacy' })

    expect(sid).toBe('acp_legacy')
    expect(methodsSent(transport)).toEqual(['initialize', 'session/resume', 'session/load'])
    expect(logs.some((m) => m.includes('session/load'))).toBe(true)
    await client.close()
  })

  it('recovers with session/new when session/resume suggests session/load and session/load returns -32002', async () => {
    const transport = recoveryTransport(
      { loadSession: true, sessionCapabilities: { resume: {} } },
      {
        'session/resume': {
          error: {
            code: -32603,
            message: 'Failed to read session acp_missing; retry, or load it with session/load',
          },
        },
        'session/load': {
          error: { code: -32002, message: 'Session not found: acp_missing' },
        },
        'session/new': {
          result: { sessionId: 'acp_fresh_after_load_404' },
        },
      },
    )
    const client = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agy',
      args: ['acp', '--stdio'],
      transportFactory: () => transport,
    })

    const sid = await client.startOrResume({ sessionId: 'acp_missing' })

    expect(sid).toBe('acp_fresh_after_load_404')
    expect(methodsSent(transport)).toEqual(['initialize', 'session/resume', 'session/load', 'session/new'])
    await client.close()
  })

  it('propagates session/resume load-fallback hint error when loadSession capability is false', async () => {
    const transport = recoveryTransport(
      { loadSession: false, sessionCapabilities: { resume: {} } },
      {
        'session/resume': {
          error: {
            code: -32603,
            message: 'Failed to read session acp_old; retry, or load it with session/load',
          },
        },
      },
    )
    const client = new AcpRuntimeClient({ cwd: '/repo', command: 'agy', args: [], transportFactory: () => transport })

    const err = await client.startOrResume({ sessionId: 'acp_old' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AcpRpcError)
    expect(err).toMatchObject({ code: -32603, method: 'session/resume' })
    expect(methodsSent(transport)).toEqual(['initialize', 'session/resume'])
    await client.close()
  })
})

describe('AcpRuntimeClient model config options', () => {
  it('reads models from configOptions and switches them via session/set_config_option', async () => {
    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
      } else if (msg.method === 'session/new') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'acp_cfg',
            modes: { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }] },
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: 'default',
                options: [
                  { value: 'default', name: 'Default (recommended)' },
                  { group: 'more', name: 'More', options: [{ value: 'sonnet', name: 'Sonnet' }] },
                ],
              },
            ],
          },
        })
      } else if (msg.method === 'session/set_config_option') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } })
      }
    })
    const client = new AcpRuntimeClient({ cwd: '/repo', command: 'agent', args: [], transportFactory: () => transport })

    await client.startOrResume({ modelId: 'sonnet' })

    expect(client.catalog?.models.map((m) => m.id)).toEqual(['default', 'sonnet'])
    expect(client.catalog?.modes.map((m) => m.id)).toEqual(['auto'])
    expect(client.catalog?.currentModelId).toBe('sonnet')
    expect(transport.sent.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
      sessionId: 'acp_cfg',
      configId: 'model',
      value: 'sonnet',
    })
    expect(transport.sent.some((m) => m.method === 'session/set_model')).toBe(false)
    await client.close()
  })

  it('extracts per-model thought_level options (Antigravity / ClaudeCode), normalizes legacy model slugs, and sets thought_level', async () => {
    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
      } else if (msg.method === 'session/new') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'acp_agy',
            models: {
              currentModelId: 'gemini-4-neon-high',
              availableModels: [
                { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
                { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
                { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
                { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
                { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
              ],
            },
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: 'gemini-4-neon',
                options: [
                  { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
                  { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
                  { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
                ],
              },
              {
                id: 'thought_level',
                name: 'Thinking Level',
                category: 'thought_level',
                type: 'select',
                currentValue: 'high',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                  { value: 'xhigh', name: 'Extra' },
                ],
              },
            ],
          },
        })
      } else if (msg.method === 'session/set_config_option') {
        const p = msg.params as { configId: string; value: string }
        if (p.configId === 'model' && p.value === 'gemini-pro-orchestrator-neon') {
          t.emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              configOptions: [
                { id: 'model', category: 'model', type: 'select', currentValue: p.value, options: [] },
              ],
            },
          })
        } else {
          t.emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              configOptions: [
                { id: 'model', category: 'model', type: 'select', currentValue: 'gemini-4-carbon', options: [] },
                {
                  id: 'thought_level',
                  category: 'thought_level',
                  type: 'select',
                  currentValue: p.configId === 'thought_level' ? p.value : 'medium',
                  options: [
                    { value: 'low', name: 'Low' },
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High' },
                  ],
                },
              ],
            },
          })
        }
      }
    })

    const client = new AcpRuntimeClient({ cwd: '/repo', command: 'agy', args: ['acp', '--stdio'], transportFactory: () => transport })
    // Legacy combined slug `gemini-4-carbon-high` auto-splits into base model + thought_level
    await client.startOrResume({ modelId: 'gemini-4-carbon-high' })

    expect(client.catalog?.models).toEqual([
      {
        id: 'gemini-4-neon',
        name: 'Gemini 4 Neon',
        thoughtLevels: [
          { id: 'high', name: 'High' },
          { id: 'xhigh', name: 'Extra' },
        ],
        defaultThoughtLevel: 'high',
      },
      {
        id: 'gemini-4-carbon',
        name: 'Gemini 4 Carbon',
        thoughtLevels: [
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
        defaultThoughtLevel: 'medium',
      },
      {
        id: 'gemini-pro-orchestrator-neon',
        name: 'Orchestrator (Neon)',
        thoughtLevels: [],
      },
    ])

    const setCalls = transport.sent
      .filter((m) => m.method === 'session/set_config_option')
      .map((m) => m.params)
    expect(setCalls).toEqual([
      { sessionId: 'acp_agy', configId: 'model', value: 'gemini-4-carbon' },
      { sessionId: 'acp_agy', configId: 'thought_level', value: 'high' },
    ])

    // Switching to Orchestrator (no thought_level option) silently skips setThoughtLevel
    await client.setModel('gemini-pro-orchestrator-neon')
    await client.setThoughtLevel('high')
    expect(
      transport.sent.filter((m) => m.method === 'session/set_config_option').length,
    ).toBe(3)
    await client.close()
  })

  it('preserves full per-model thoughtLevels even when session/new starts on a model with fewer levels', async () => {
    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
      } else if (msg.method === 'session/new') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'acp_narrow_default',
            models: {
              currentModelId: 'gemini-3.1-pro-low',
              availableModels: [
                { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
                { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
                { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
                { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
                { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
                { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
                { modelId: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
                { modelId: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
                { modelId: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
                { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator' },
                { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
              ],
            },
            configOptions: [
              {
                id: 'model',
                category: 'model',
                type: 'select',
                currentValue: 'gemini-3.1-pro',
                options: [
                  { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
                  { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
                  { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
                  { value: 'gemini-pro-orchestrator', name: 'Orchestrator' },
                  { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
                ],
              },
              {
                id: 'thought_level',
                category: 'thought_level',
                type: 'select',
                currentValue: 'low',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'high', name: 'High' },
                ],
              },
            ],
          },
        })
      }
    })

    const snap = await AcpRuntimeClient.probeCatalog({
      cwd: '/repo',
      command: 'agy',
      args: ['acp', '--stdio'],
      transportFactory: () => transport,
    })

    const byId = new Map(snap.models.map((m) => [m.id, m]))
    expect(byId.get('gemini-4-neon')?.thoughtLevels?.map((t) => t.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(byId.get('gemini-4-carbon')?.thoughtLevels?.map((t) => t.id)).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(byId.get('gemini-3.1-pro')?.thoughtLevels?.map((t) => t.id)).toEqual(['low', 'high'])
    expect(byId.get('gemini-pro-orchestrator')?.thoughtLevels).toEqual([])
    expect(byId.get('gemini-pro-orchestrator-neon')?.thoughtLevels).toEqual([])
  })

  it('normalizes ClaudeCode and Antigravity ACP tool updates into native DSH tools and diffs', () => {
    const activeTools = new Map<string, AcpActiveToolCall>()

    // 1. ClaudeCode streaming Edit: initial empty tool_call defers tool-start until input/diff arrives
    expect(
      normalizeAcpSessionUpdate(
        {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'cc_edit_1',
            name: 'Edit',
            kind: 'edit',
            rawInput: {},
          },
        },
        activeTools,
      ),
    ).toEqual([])

    const refinedEdit = normalizeAcpSessionUpdate(
      {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'cc_edit_1',
          rawInput: { file_path: '/repo/src/app.ts' },
          locations: [{ path: '/repo/src/app.ts' }],
          content: [
            {
              type: 'diff',
              path: '/repo/src/app.ts',
              oldText: 'const oldVal = 1',
              newText: 'const newVal = 2',
            },
          ],
        },
      },
      activeTools,
    )
    expect(refinedEdit).toEqual([
      {
        type: 'tool-start',
        callId: 'cc_edit_1',
        name: 'edit',
        arguments: JSON.stringify({
          file_path: '/repo/src/app.ts',
          old_string: 'const oldVal = 1',
          new_string: 'const newVal = 2',
        }),
      },
    ])

    const completedEdit = normalizeAcpSessionUpdate(
      {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'cc_edit_1',
          status: 'completed',
          _meta: { claudeCode: { toolName: 'Edit' } },
        },
      },
      activeTools,
    )
    expect(completedEdit).toEqual([
      {
        type: 'tool-complete',
        callId: 'cc_edit_1',
        name: 'edit',
        output: '/repo/src/app.ts',
        isError: false,
        meta: {
          path: '/repo/src/app.ts',
          diffs: [
            {
              path: '/repo/src/app.ts',
              oldText: 'const oldVal = 1',
              newText: 'const newVal = 2',
            },
          ],
        },
      },
    ])

    // 2. ClaudeCode Bash with console fence and failing exit code -> native `bash` + `[exit code: N]`
    const bashStart = normalizeAcpSessionUpdate(
      {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'cc_bash_1',
          name: 'Bash',
          kind: 'execute',
          rawInput: { command: 'pnpm typecheck', description: 'Run typecheck' },
        },
      },
      activeTools,
    )
    expect(bashStart).toEqual([
      {
        type: 'tool-start',
        callId: 'cc_bash_1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'pnpm typecheck', description: 'Run typecheck' }),
      },
    ])

    const bashDone = normalizeAcpSessionUpdate(
      {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'cc_bash_1',
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: '```console\nExit code 2\nTS2322 error\n```' } }],
        },
      },
      activeTools,
    )
    expect(bashDone).toEqual([
      {
        type: 'tool-complete',
        callId: 'cc_bash_1',
        name: 'bash',
        output: 'TS2322 error\n[exit code: 2]',
        isError: false,
      },
    ])

    // 3. Antigravity tools: read_file (Path/StartLine/EndLine), grep_search, search_web, TodoWrite, MCP
    const agyRead = normalizeAcpSessionUpdate(
      {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'agy_read_1',
          name: 'read_file',
          rawInput: { Path: '/repo/README.md', StartLine: 10, EndLine: 29 },
        },
      },
      activeTools,
    )
    expect(agyRead).toEqual([
      {
        type: 'tool-start',
        callId: 'agy_read_1',
        name: 'read',
        arguments: JSON.stringify({ file_path: '/repo/README.md', offset: 10, limit: 20 }),
      },
    ])

    const agyGrep = normalizeAcpSessionUpdate(
      {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'agy_grep_1',
          name: 'grep_search',
          rawInput: { Query: 'RuntimeCatalog', SearchPath: '/repo/packages' },
        },
      },
      activeTools,
    )
    expect(agyGrep).toEqual([
      {
        type: 'tool-start',
        callId: 'agy_grep_1',
        name: 'grep',
        arguments: JSON.stringify({ pattern: 'RuntimeCatalog', path: '/repo/packages' }),
      },
    ])

    const todoStart = normalizeAcpSessionUpdate(
      {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'cc_todo_1',
          name: 'TodoWrite',
          rawInput: { todos: [{ content: 'Ship native tools', status: 'in_progress' }] },
        },
      },
      activeTools,
    )
    expect(todoStart).toEqual([
      {
        type: 'tool-start',
        callId: 'cc_todo_1',
        name: 'todo_write',
        arguments: JSON.stringify({ todos: [{ content: 'Ship native tools', status: 'in_progress' }] }),
      },
    ])

    const mcpStart = normalizeAcpSessionUpdate(
      {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'cc_mcp_1',
          name: 'mcp__github__get_pull_request',
          rawInput: { pullNumber: 12 },
        },
      },
      activeTools,
    )
    expect(mcpStart).toEqual([
      {
        type: 'tool-start',
        callId: 'cc_mcp_1',
        name: 'github.get_pull_request',
        arguments: JSON.stringify({ pullNumber: 12 }),
      },
    ])

    expect(
      normalizeAcpPermissionRequest({
        sessionId: 'acp_s1',
        toolCall: { toolCallId: 'p1', name: 'run_command', rawInput: { CommandLine: 'ls' }, title: 'List files' },
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
      }),
    ).toMatchObject({
      toolName: 'bash',
      reason: 'List files',
    })
  })

  it('invokes ACP authenticate before session/new when authMethodId is configured and rejects unsupported methods', async () => {
    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            authMethods: [
              { id: 'oauth-personal', name: 'Google Account' },
              { id: 'gemini-api-key', name: 'Gemini API Key' },
            ],
          },
        })
      } else if (msg.method === 'authenticate') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'session/new') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'acp_auth_1',
            models: {
              currentModelId: 'gemini-4-carbon-medium',
              availableModels: [{ modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' }],
            },
          },
        })
      }
    })

    const client = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agy',
      args: ['--settings', '/Users/demo/.config/proxy/settings.json', 'acp', '--stdio'],
      authMethodId: 'gemini-api-key',
      transportFactory: () => transport,
    })

    const sid = await client.startOrResume()
    expect(sid).toBe('acp_auth_1')
    expect(transport.sent.map((m) => m.method)).toEqual(['initialize', 'authenticate', 'session/new'])
    expect(transport.sent.find((m) => m.method === 'authenticate')?.params).toEqual({
      methodId: 'gemini-api-key',
    })
    expect(client.catalog?.authMethods).toEqual([
      { id: 'oauth-personal', name: 'Google Account' },
      { id: 'gemini-api-key', name: 'Gemini API Key' },
    ])
    await client.close()

    const badClient = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agy',
      args: ['acp', '--stdio'],
      authMethodId: 'nonexistent-method',
      transportFactory: () =>
        new MockAcpTransport((msg, t) => {
          if (msg.method === 'initialize') {
            t.emit({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Google' }] },
            })
          }
        }),
    })
    await expect(badClient.startOrResume()).rejects.toThrow(/unsupported authMethod "nonexistent-method"/)
    await badClient.close()
  })

  it('auto-authenticates with the first advertised authMethod when session open fails with ACP -32000', async () => {
    let authed = false
    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
            authMethods: [
              { id: 'oauth-personal', name: 'Log in with Google' },
              { id: 'gemini-api-key', name: 'Gemini API key' },
            ],
          },
        })
      } else if (msg.method === 'authenticate') {
        authed = true
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'session/new' || msg.method === 'session/resume') {
        if (!authed) {
          t.emit({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'Authentication required' },
          })
          return
        }
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: msg.method === 'session/resume' ? 'acp_resumed' : 'acp_default_auth',
            models: {
              currentModelId: 'gemini-4-neon-high',
              availableModels: [{ modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }],
            },
          },
        })
      }
    })

    const logs: string[] = []
    const client = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agy',
      args: ['acp', '--stdio'],
      logger: (m) => logs.push(m),
      transportFactory: () => transport,
    })

    const sid = await client.startOrResume()
    expect(sid).toBe('acp_default_auth')
    expect(transport.sent.map((m) => m.method)).toEqual([
      'initialize',
      'session/new',
      'authenticate',
      'session/new',
    ])
    expect(transport.sent.find((m) => m.method === 'authenticate')?.params).toEqual({
      methodId: 'oauth-personal',
    })
    expect(logs.some((m) => m.includes('oauth-personal'))).toBe(true)
    await client.close()

    // Also covers session/resume failing with -32000 before default auth
    authed = false
    const resumeTransport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: { resume: {} } },
            authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
          },
        })
      } else if (msg.method === 'authenticate') {
        authed = true
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'session/resume') {
        if (!authed) {
          t.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } })
          return
        }
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      }
    })
    const resumeClient = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agy',
      args: ['acp', '--stdio'],
      transportFactory: () => resumeTransport,
    })
    expect(await resumeClient.startOrResume({ sessionId: 'acp_existing' })).toBe('acp_existing')
    expect(resumeTransport.sent.map((m) => m.method)).toEqual([
      'initialize',
      'session/resume',
      'authenticate',
      'session/resume',
    ])
    await resumeClient.close()
  })

  it('does not auto-authenticate on -32000 when authMethods is empty, message is unrelated, or explicit auth already ran', async () => {
    // 1. Empty authMethods -> surfaces original -32000 error
    const noMethodsClient = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agent',
      args: [],
      transportFactory: () =>
        new MockAcpTransport((msg, t) => {
          if (msg.method === 'initialize') t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
          else if (msg.method === 'session/new') {
            t.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } })
          }
        }),
    })
    await expect(noMethodsClient.startOrResume()).rejects.toMatchObject({ code: -32000 })
    await noMethodsClient.close()

    // 2. Unrelated -32000 error -> does not invoke authenticate
    const unrelatedTransport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] },
        })
      } else if (msg.method === 'session/new') {
        t.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Workspace locked' } })
      }
    })
    const unrelatedClient = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agent',
      args: [],
      transportFactory: () => unrelatedTransport,
    })
    await expect(unrelatedClient.startOrResume()).rejects.toThrow('Workspace locked')
    expect(unrelatedTransport.sent.map((m) => m.method)).toEqual(['initialize', 'session/new'])
    await unrelatedClient.close()

    // 3. Explicit authMethodId already ran and session/new still returns -32000 -> no silent retry
    const explicitTransport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            authMethods: [{ id: 'oauth-personal' }, { id: 'gemini-api-key' }],
          },
        })
      } else if (msg.method === 'authenticate') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'session/new') {
        t.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } })
      }
    })
    const explicitClient = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agent',
      args: [],
      authMethodId: 'gemini-api-key',
      transportFactory: () => explicitTransport,
    })
    await expect(explicitClient.startOrResume()).rejects.toMatchObject({ code: -32000 })
    expect(explicitTransport.sent.map((m) => m.method)).toEqual(['initialize', 'authenticate', 'session/new'])
    await explicitClient.close()
  })

  it('forwards sessionMeta as _meta on session/new, session/resume, and session/load', async () => {
    const sentMeta: Array<{ method: string; meta: unknown }> = []
    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
          },
        })
      } else if (msg.method === 'session/resume') {
        sentMeta.push({ method: msg.method, meta: (msg.params as Record<string, unknown>)?._meta })
        t.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'Session not found' } })
      } else if (msg.method === 'session/new') {
        sentMeta.push({ method: msg.method, meta: (msg.params as Record<string, unknown>)?._meta })
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp_meta_1' } })
      }
    })

    const sessionMeta = {
      customAgent: { options: { settings: { env: { EXAMPLE_BASE_URL: 'http://127.0.0.1:9000' } } } },
    }
    const client = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agent',
      args: [],
      sessionMeta,
      transportFactory: () => transport,
    })

    const sid = await client.startOrResume({ sessionId: 'stale_id' })
    expect(sid).toBe('acp_meta_1')
    expect(sentMeta).toEqual([
      { method: 'session/resume', meta: sessionMeta },
      { method: 'session/new', meta: sessionMeta },
    ])
    await client.close()
  })

  it('preserves configOptions thoughtLevels when legacy models.availableModels has no pre-multiplied suffixes', () => {
    const snap = parseAcpCatalog({
      models: {
        currentModelId: 'default',
        availableModels: [
          { modelId: 'default', name: 'Default' },
          { modelId: 'sonnet', name: 'Sonnet' },
        ],
      },
      configOptions: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'sonnet', name: 'Sonnet' },
          ],
        },
        {
          id: 'effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    })
    expect(snap.models).toEqual([
      {
        id: 'default',
        name: 'Default',
        thoughtLevels: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
        defaultThoughtLevel: 'medium',
      },
      {
        id: 'sonnet',
        name: 'Sonnet',
        thoughtLevels: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
        defaultThoughtLevel: 'medium',
      },
    ])
  })
})

describe('AcpRuntimeClient prompt idle timeout', () => {
  it('keeps an active turn alive past promptIdleTimeoutMs as long as session/update events keep arriving', async () => {
    vi.useFakeTimers()
    try {
      let promptMsgId: number | string | undefined
      const transport = new MockAcpTransport((msg, t) => {
        if (msg.method === 'initialize') {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
        } else if (msg.method === 'session/new') {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp_long' } })
        } else if (msg.method === 'session/prompt') {
          promptMsgId = msg.id
        }
      })

      const client = new AcpRuntimeClient({
        cwd: '/repo',
        command: 'agent',
        args: [],
        promptIdleTimeoutMs: 100,
        transportFactory: () => transport,
      })
      await client.startOrResume()

      const turnPromise = client.runTurn([{ type: 'text', text: 'long running task' }])

      // Advance 240ms (> 2x promptIdleTimeoutMs) while emitting progress every 60ms.
      for (let i = 1; i <= 4; i += 1) {
        await vi.advanceTimersByTimeAsync(60)
        transport.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'acp_long',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `part-${i} ` } },
          },
        })
      }

      transport.emit({ jsonrpc: '2.0', id: promptMsgId, result: { stopReason: 'end_turn' } })
      const res = await turnPromise
      expect(res.stopReason).toBe('end_turn')
      expect(res.text).toBe('part-1 part-2 part-3 part-4 ')
      expect(transport.sent.some((m) => m.method === 'session/cancel')).toBe(false)
      await client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects with idle timeout, sends session/cancel, and allows subsequent turns when stalled', async () => {
    vi.useFakeTimers()
    try {
      let promptCount = 0
      const transport = new MockAcpTransport((msg, t) => {
        if (msg.method === 'initialize') {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
        } else if (msg.method === 'session/new') {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp_stall' } })
        } else if (msg.method === 'session/prompt') {
          promptCount += 1
          if (promptCount === 2) {
            t.emit({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp_stall',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered' } },
              },
            })
            t.emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
          }
        }
      })

      const client = new AcpRuntimeClient({
        cwd: '/repo',
        command: 'agent',
        args: [],
        promptIdleTimeoutMs: 100,
        transportFactory: () => transport,
      })
      await client.startOrResume()

      const turnPromise = client.runTurn([{ type: 'text', text: 'stalled task' }])
      const expectation = expect(turnPromise).rejects.toThrow(/idle timed out after 100ms/)
      await vi.advanceTimersByTimeAsync(110)
      await expectation

      expect(transport.sent).toContainEqual({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'acp_stall' },
      })

      // Client must release activeTurn so a follow-up turn succeeds cleanly.
      const nextRes = await client.runTurn([{ type: 'text', text: 'next task' }])
      expect(nextRes.text).toBe('recovered')
      await client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses idle timeout while waiting for interactive permission approval', async () => {
    vi.useFakeTimers()
    try {
      let promptMsgId: number | string | undefined
      let resolvePermission: ((outcome: { outcome: 'selected'; optionId: string }) => void) | undefined

      const transport = new MockAcpTransport((msg, t) => {
        if (msg.method === 'initialize') {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
        } else if (msg.method === 'session/new') {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp_perm' } })
        } else if (msg.method === 'session/prompt') {
          promptMsgId = msg.id
          t.emit({
            jsonrpc: '2.0',
            id: 99,
            method: 'session/request_permission',
            params: {
              sessionId: 'acp_perm',
              toolCall: { toolCallId: 'tc_perm', name: 'bash', title: 'Run check' },
              options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
            },
          })
        } else if (msg.id === 99 && !msg.method) {
          t.emit({ jsonrpc: '2.0', id: promptMsgId, result: { stopReason: 'end_turn' } })
        }
      })

      const client = new AcpRuntimeClient({
        cwd: '/repo',
        command: 'agent',
        args: [],
        promptIdleTimeoutMs: 100,
        transportFactory: () => transport,
      })
      await client.startOrResume()

      const turnPromise = client.runTurn([{ type: 'text', text: 'needs approval' }], {
        onPermission: () =>
          new Promise((resolve) => {
            resolvePermission = resolve
          }),
      })

      // Wait 500ms (> 5x idle timeout) for human approval without triggering idle timeout.
      await vi.advanceTimersByTimeAsync(500)
      expect(transport.sent.some((m) => m.method === 'session/cancel')).toBe(false)

      resolvePermission?.({ outcome: 'selected', optionId: 'allow_once' })
      const res = await turnPromise
      expect(res.stopReason).toBe('end_turn')
      await client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds external abort with cancelGraceTimeoutMs even when updates keep arriving and cancels stray permissions', async () => {
    vi.useFakeTimers()
    try {
      const transport = new MockAcpTransport((msg, t) => {
        if (msg.method === 'initialize') {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
        } else if (msg.method === 'session/new') {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp_abort' } })
        }
      })

      const client = new AcpRuntimeClient({
        cwd: '/repo',
        command: 'agent',
        args: [],
        promptIdleTimeoutMs: 60_000,
        cancelGraceTimeoutMs: 50,
        transportFactory: () => transport,
      })
      await client.startOrResume()

      // 1. Stray permission request when no activeTurn exists MUST be cancelled (never auto-approved)
      transport.emit({
        jsonrpc: '2.0',
        id: 701,
        method: 'session/request_permission',
        params: {
          sessionId: 'acp_abort',
          toolCall: { toolCallId: 'tc_stray', name: 'bash', title: 'Stray tool' },
          options: [{ optionId: 'allow_always', name: 'Always', kind: 'allow_always' }],
        },
      })
      await Promise.resolve()
      expect(transport.sent).toContainEqual({
        jsonrpc: '2.0',
        id: 701,
        result: { outcome: { outcome: 'cancelled' } },
      })

      // 2. External abort switches to short cancel grace timeout and ignores ongoing updates
      const ac = new AbortController()
      const turnPromise = client.runTurn([{ type: 'text', text: 'unresponsive peer' }], {}, ac.signal)
      const expectation = expect(turnPromise).rejects.toThrow(/cancel timed out after 50ms/)

      ac.abort(new Error('user cancelled'))
      expect(transport.sent).toContainEqual({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'acp_abort' },
      })

      // Permission arriving while cancelPending is also rejected as cancelled
      transport.emit({
        jsonrpc: '2.0',
        id: 702,
        method: 'session/request_permission',
        params: {
          sessionId: 'acp_abort',
          toolCall: { toolCallId: 'tc_cancelling', name: 'bash', title: 'Late tool' },
          options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
        },
      })
      await Promise.resolve()
      expect(transport.sent).toContainEqual({
        jsonrpc: '2.0',
        id: 702,
        result: { outcome: { outcome: 'cancelled' } },
      })

      // Streaming updates during cancel grace must NOT extend the timer back to 60s
      await vi.advanceTimersByTimeAsync(30)
      transport.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp_abort',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still streaming' } },
        },
      })
      await vi.advanceTimersByTimeAsync(30)
      await expectation

      await client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('AcpStdioTransport converts async stdin EPIPE errors into controlled onClose without crashing host', async () => {
    const { AcpStdioTransport } = await import('../src/stdio-transport.js')
    const transport = new AcpStdioTransport({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: process.cwd(),
      env: process.env,
    })

    const closedErrors: Array<Error | undefined> = []
    transport.onClose((err) => closedErrors.push(err))

    const child = (
      transport as unknown as {
        child: {
          exitCode: number | null
          signalCode: NodeJS.Signals | null
          stdin: { emit: (ev: string, err: Error) => void }
        }
      }
    ).child
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    child.stdin.emit('error', epipe)

    expect(closedErrors).toHaveLength(1)
    expect(closedErrors[0]?.message).toContain('stdin error: write EPIPE')
    expect(() => transport.send({ jsonrpc: '2.0', method: 'ping' })).toThrow(/transport is closed/)
    await transport.close()
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('closes transport when initialize fails and ignores stale close events from prior transports', async () => {
    const failedTransport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'acp init fail' } })
      }
    })
    const goodTransport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
      } else if (msg.method === 'session/new') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp_ok' } })
      }
    })

    let idx = 0
    const client = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agent',
      args: [],
      transportFactory: () => (idx++ === 0 ? failedTransport : goodTransport),
    })

    await expect(client.initialize()).rejects.toThrow(/acp init fail/)
    expect(failedTransport.closed).toBe(true)

    const sid = await client.startOrResume()
    expect(sid).toBe('acp_ok')
    // Late close from old transport must not disturb active transport
    failedTransport.emitClose(new Error('late stale close'))
    expect(goodTransport.closed).toBe(false)
    await client.close()
  })

  it('multiplexes concurrent sessions on one transport with per-session cwd, updates, permissions, isolated cancel, and session/close', async () => {
    let spawnCount = 0
    let sessionSeq = 0
    const promptIds = new Map<string, number | string>()
    const openedCwds: string[] = []
    const closedSessions: string[] = []

    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {}, close: {} },
            },
            authMethods: [{ id: 'oauth-personal', name: 'Google' }],
          },
        })
      } else if (msg.method === 'authenticate') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      } else if (msg.method === 'session/new') {
        const params = msg.params as { cwd?: string }
        openedCwds.push(params.cwd ?? '')
        const sid = `mux_sess_${++sessionSeq}`
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: sid,
            configOptions: [
              {
                id: 'model',
                category: 'model',
                type: 'select',
                currentValue: 'model-default',
                options: [{ value: 'model-default', name: 'Default' }],
              },
            ],
          },
        })
      } else if (msg.method === 'session/prompt') {
        const params = msg.params as { sessionId: string }
        promptIds.set(params.sessionId, msg.id!)
      } else if (msg.method === 'session/cancel') {
        const params = msg.params as { sessionId: string }
        const pid = promptIds.get(params.sessionId)
        if (pid !== undefined) {
          promptIds.delete(params.sessionId)
          t.emit({ jsonrpc: '2.0', id: pid, result: { stopReason: 'cancelled' } })
        }
      } else if (msg.method === 'session/close') {
        const params = msg.params as { sessionId: string }
        closedSessions.push(params.sessionId)
        t.emit({ jsonrpc: '2.0', id: msg.id, result: {} })
      }
    })

    const client = new AcpRuntimeClient({
      cwd: '/root',
      command: 'agy',
      args: ['acp', '--stdio'],
      authMethodId: 'oauth-personal',
      transportFactory: () => {
        spawnCount += 1
        return transport
      },
    })

    // Open two sessions concurrently: must share a single initialize + authenticate handshake
    const [handleA, handleB] = await Promise.all([
      client.openSession({ cwd: '/workspace/alpha' }),
      client.openSession({ cwd: '/workspace/beta' }),
    ])
    expect(spawnCount).toBe(1)
    expect(transport.sent.filter((m) => m.method === 'initialize')).toHaveLength(1)
    expect(transport.sent.filter((m) => m.method === 'authenticate')).toHaveLength(1)
    expect(openedCwds).toEqual(['/workspace/alpha', '/workspace/beta'])
    expect(client.activeSessionCount).toBe(2)
    expect(handleA.isOpen).toBe(true)
    expect(handleB.isOpen).toBe(true)

    const eventsA: string[] = []
    const eventsB: string[] = []
    const abortA = new AbortController()
    const turnA = handleA.runTurn(
      [{ type: 'text', text: 'run A' }],
      { onEvent: (ev) => { if (ev.type === 'text-delta') eventsA.push(ev.text) } },
      abortA.signal,
    )
    const turnB = handleB.runTurn(
      [{ type: 'text', text: 'run B' }],
      { onEvent: (ev) => { if (ev.type === 'text-delta') eventsB.push(ev.text) } },
    )
    expect(client.inFlightTurnCount).toBe(2)

    // Interleaved updates route strictly to their owning session
    transport.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: handleA.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A1' } },
      },
    })
    transport.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: handleB.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B1' } },
      },
    })

    // Cancelling A must leave B unaffected
    abortA.abort()
    const resA = await turnA
    expect(resA.stopReason).toBe('cancelled')
    expect(eventsA).toEqual(['A1'])

    transport.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: handleB.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B2' } },
      },
    })
    transport.emit({ jsonrpc: '2.0', id: promptIds.get(handleB.sessionId), result: { stopReason: 'end_turn' } })
    const resB = await turnB
    expect(resB.stopReason).toBe('end_turn')
    expect(resB.text).toBe('B1B2')
    expect(eventsB).toEqual(['B1', 'B2'])
    expect(client.inFlightTurnCount).toBe(0)

    // Closing A calls session/close and keeps B open
    await handleA.close()
    expect(closedSessions).toEqual([handleA.sessionId])
    expect(handleA.isOpen).toBe(false)
    expect(handleB.isOpen).toBe(true)
    expect(client.activeSessionCount).toBe(1)

    await handleB.close()
    expect(client.activeSessionCount).toBe(0)
    await client.close()
  })

  it('includes diagnostic metadata in idle timeout error message', async () => {
    vi.useFakeTimers()
    try {
      const transport = new MockAcpTransport((msg, t) => {
        if (msg.method === 'initialize') {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
        } else if (msg.method === 'session/new') {
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp_diag' } })
        } else if (msg.method === 'session/prompt') {
          t.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp_diag',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello world' } },
            },
          })
          t.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp_diag',
              update: { sessionUpdate: 'usage_update', used: 1200, size: 100000 },
            },
          })
        }
      })

      const client = new AcpRuntimeClient({
        cwd: '/repo',
        command: 'agy',
        args: [],
        promptIdleTimeoutMs: 100,
        transportFactory: () => transport,
      })
      await client.startOrResume()

      const turnPromise = client.runTurn([{ type: 'text', text: 'stuck after output' }])
      const expectation = expect(turnPromise).rejects.toThrow(
        /idle timed out after 100ms without updates \(session=acp_diag, elapsed=\d+s, updates=2, lastUpdate=usage_update, textChars=11, openTools=0\)/,
      )
      await vi.advanceTimersByTimeAsync(110)
      await expectation
      await client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed on unlabelled session/update and permission requests when multiple sessions are open', async () => {
    let seq = 0
    const promptIds = new Map<string, number | string>()
    const permissionReplies: Array<{ id: number | string; result: unknown }> = []
    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
      } else if (msg.method === 'session/new') {
        seq += 1
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `acp_mux_guard_${seq}` } })
      } else if (msg.method === 'session/prompt') {
        const sid = (msg.params as { sessionId: string }).sessionId
        promptIds.set(sid, msg.id!)
      } else if (msg.id === 777) {
        permissionReplies.push({ id: msg.id, result: msg.result })
      }
    })

    const client = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agy',
      args: [],
      transportFactory: () => transport,
    })

    const handleA = await client.openSession({ cwd: '/repo/a' })
    const handleB = await client.openSession({ cwd: '/repo/b' })
    expect(client.activeSessionCount).toBe(2)

    const onPermissionA = vi.fn(async () => ({ outcome: 'selected' as const, optionId: 'allow_once' }))
    const turnA = handleA.runTurn([{ type: 'text', text: 'only A is running' }], {
      onPermission: onPermissionA,
    })

    // Unlabelled session/update (missing sessionId) while 2 sessions are open MUST be dropped
    transport.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'UNLABELLED_LEAK' } },
      },
    })
    // Unlabelled permission request while 2 sessions are open MUST be cancelled fail-closed
    transport.emit({
      jsonrpc: '2.0',
      id: 777,
      method: 'session/request_permission',
      params: {
        toolCall: { toolCallId: 'p_unlabelled', name: 'run_command' },
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
      },
    })
    // Properly labelled update for session A succeeds normally
    transport.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: handleA.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SAFE_A' } },
      },
    })
    transport.emit({ jsonrpc: '2.0', id: promptIds.get(handleA.sessionId), result: { stopReason: 'end_turn' } })

    const resA = await turnA
    expect(resA.text).toBe('SAFE_A')
    expect(onPermissionA).not.toHaveBeenCalled()
    expect(permissionReplies).toEqual([{ id: 777, result: { outcome: { outcome: 'cancelled' } } }])

    await handleA.close()
    await handleB.close()
    await client.close()
  })

  it('emits mid-turn usage_update as context-usage without polluting billable usage when session/prompt returns authoritative usage', async () => {
    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
      } else if (msg.method === 'session/new') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp_usage_1' } })
      } else if (msg.method === 'session/prompt') {
        queueMicrotask(() => {
          t.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp_usage_1',
              update: { sessionUpdate: 'usage_update', used: 23_429, size: 1_048_576 },
            },
          })
          t.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp_usage_1',
              update: { sessionUpdate: 'usage_update', used: 68_199, size: 1_048_576 },
            },
          })
          t.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp_usage_1',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } },
            },
          })
          t.emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              stopReason: 'end_turn',
              usage: {
                inputTokens: 199_015,
                outputTokens: 22_416,
                cachedReadTokens: 1_153_637,
                totalTokens: 1_375_068,
              },
            },
          })
        })
      }
    })

    const client = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agy',
      args: [],
      transportFactory: () => transport,
    })
    await client.startOrResume()

    const events: AcpTurnEvent[] = []
    const res = await client.runTurn([{ type: 'text', text: 'analyze' }], {
      onEvent: (ev) => events.push(ev),
    })

    expect(events.filter((e) => e.type === 'context-usage')).toEqual([
      { type: 'context-usage', used: 23_429, size: 1_048_576 },
      { type: 'context-usage', used: 68_199, size: 1_048_576 },
    ])
    const usageEvents = events.filter((e) => e.type === 'usage')
    expect(usageEvents).toHaveLength(1)
    expect(res.usage).toEqual({
      inputTokens: 199_015,
      outputTokens: 22_416,
      cacheReadTokens: 1_153_637,
      totalTokens: 1_375_068,
    })
    await client.close()
  })

  it('falls back to a single final usage from the latest usage_update only when session/prompt omits usage', async () => {
    const transport = new MockAcpTransport((msg, t) => {
      if (msg.method === 'initialize') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
      } else if (msg.method === 'session/new') {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp_usage_fallback' } })
      } else if (msg.method === 'session/prompt') {
        queueMicrotask(() => {
          t.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp_usage_fallback',
              update: { sessionUpdate: 'usage_update', used: 10_000, size: 200_000 },
            },
          })
          t.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp_usage_fallback',
              update: { sessionUpdate: 'usage_update', used: 15_000, size: 200_000 },
            },
          })
          t.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp_usage_fallback',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } },
            },
          })
          t.emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn' },
          })
        })
      }
    })

    const client = new AcpRuntimeClient({
      cwd: '/repo',
      command: 'agy',
      args: [],
      transportFactory: () => transport,
    })
    await client.startOrResume()

    const events: AcpTurnEvent[] = []
    const res = await client.runTurn([{ type: 'text', text: 'hello' }], {
      onEvent: (ev) => events.push(ev),
    })

    const usageEvents = events.filter((e) => e.type === 'usage')
    expect(usageEvents).toHaveLength(1)
    expect(res.usage).toEqual({
      inputTokens: 15_000,
      outputTokens: 0,
      contextUsed: 15_000,
      contextSize: 200_000,
    })
    await client.close()
  })
})
