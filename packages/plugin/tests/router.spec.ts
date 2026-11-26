import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentFactory,
  InboxState,
  ModelSelectionProjectionState,
} from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  AcpCatalogSnapshot,
  AcpPromptBlock,
  AcpRuntimeOptions,
  AcpSessionHandle,
  AcpStartOptions,
  AcpTurnHandlers,
  AcpTurnResult,
} from '@dsh-external-agents/runtime-acp'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session')>()
  return {
    ...actual,
    appendPluginRecord: (session: Session, type: string, data: unknown) =>
      (
        session as unknown as {
          append: (t: string, d: unknown, opts?: { ignorable?: boolean }) => unknown
        }
      ).append(type, data, { ignorable: true }),
    interruptedTurnClosers: () => [],
    SessionPreparation: {
      create<T>(session: T) {
        return {
          session,
          [Symbol.dispose]() {},
        }
      },
    },
  }
})

import {
  createExternalAgentRouter,
  effectivePresetOfSession,
  type CapturedAgentLoop,
} from '../src/agent-loop-bridge.js'
import { AcpRuntimePool, type AcpPoolClientLike } from '../src/runtime/acp-pool.js'
import { createAcpRuntime } from '../src/runtime/acp-runtime.js'
import { resolveRuntimeSpecs } from '../src/runtime/config.js'
import { ExternalRuntimeRegistry, createExternalRuntimeRegistry } from '../src/runtime/registry.js'

interface FakeSessionRecord {
  readonly session: Session
  readonly events: SessionEvent[]
  readonly modelState: {
    lastUsed: ModelSelectionProjectionState['lastUsed']
    pending: ModelSelectionProjectionState['pending']
  }
  readonly inboxState: { 'next-turn': unknown[]; 'next-step': unknown[] }
}

function createFakeSessionRecord(
  id: SessionId,
  header: { cwd?: string; agentPreset?: string },
  seed: readonly SessionEvent[] = [],
): FakeSessionRecord {
  const events: SessionEvent[] = [...seed]
  let seq = events.length
  const modelState: FakeSessionRecord['modelState'] = { lastUsed: null, pending: null }
  const inboxState: FakeSessionRecord['inboxState'] = { 'next-turn': [], 'next-step': [] }

  const fold = (ev: { type?: string; data?: Record<string, unknown> }) => {
    if (ev.type === 'agent/inbox/spliced' && ev.data) {
      const target = ev.data.target as 'next-turn' | 'next-step'
      const start = Number(ev.data.start ?? 0)
      const removedCount = Number(ev.data.removedCount ?? 0)
      const inserted = Array.isArray(ev.data.inserted) ? ev.data.inserted : []
      inboxState[target].splice(start, removedCount, ...inserted)
    }
  }
  for (const ev of events) {
    fold(ev as unknown as { type?: string; data?: Record<string, unknown> })
  }

  const session = {
    id,
    header: { cwd: header.cwd ?? '/tmp', ...(header.agentPreset ? { agentPreset: header.agentPreset } : {}) },
    inheritedEventCount: 0,
    append(type: string, data: unknown, opts?: { ignorable?: boolean }) {
      const ev = {
        type,
        seq: seq++,
        time: Date.now(),
        data,
        ...(opts?.ignorable ? { ignorable: true } : {}),
      } as unknown as SessionEvent
      events.push(ev)
      fold(ev as unknown as { type?: string; data?: Record<string, unknown> })
      return ev
    },
    snapshotEvents(offset = 0) {
      return events.slice(Number(offset))
    },
  } as unknown as Session

  return { session, events, modelState, inboxState }
}

function createFakeHostEnv() {
  const liveAgents = new Map<string, Agent>()
  const liveSessions = new Map<string, Session>()
  const sessionRecords = new Map<string, FakeSessionRecord>()
  const persisted = new Map<
    string,
    { header: { cwd?: string; agentPreset?: string }; events: SessionEvent[]; closedCount: number; openCount: number }
  >()
  const announcedAgents: string[] = []
  const detachedAgents: string[] = []

  const rootCtx = new Context()
  const agentsSvc = {
    get(id: SessionId) {
      return liveAgents.get(id)
    },
    enter(agent: Agent) {
      if (liveAgents.has(agent.id)) {
        throw new Error(`agent "${agent.id}" is already registered`)
      }
      liveAgents.set(agent.id, agent)
      return () => {
        if (liveAgents.get(agent.id) === agent) {
          liveAgents.delete(agent.id)
          detachedAgents.push(agent.id)
        }
      }
    },
    async announce(agent: Agent) {
      announcedAgents.push(agent.id)
    },
    turnBoundaryOf(session: Session) {
      let lastTurn = 0
      for (const ev of session.snapshotEvents()) {
        if (ev.type === 'turn/start') {
          const turn = Number((ev.data as { turn?: unknown } | undefined)?.turn ?? 0)
          if (turn > lastTurn) lastTurn = turn
        }
      }
      return { lastTurn, openTurnStartSeq: null }
    },
  }

  const sessionsSvc = {
    get(id: SessionId) {
      return liveSessions.get(id)
    },
    prepare(id: SessionId, opts: { seed?: readonly SessionEvent[]; meta?: { cwd?: string; agentPreset?: string } } = {}) {
      const rec = createFakeSessionRecord(id, opts.meta ?? {}, opts.seed ?? [])
      sessionRecords.set(id, rec)
      return rec.session
    },
    enter(session: Session) {
      liveSessions.set(session.id, session)
      return () => {
        if (liveSessions.get(session.id) === session) {
          liveSessions.delete(session.id)
        }
      }
    },
    announce() {},
  }

  const persistenceSvc = {
    async create(header: { id?: string; cwd?: string; agentPreset?: string }) {
      const id = String(header.id ?? [...sessionRecords.keys()].at(-1) ?? 'session-unknown')
      const entry = { header: { ...header }, events: [] as SessionEvent[], closedCount: 0, openCount: 1 }
      persisted.set(id, entry)
      return {
        header: entry.header,
        inheritedEventCount: 0,
        async append(evs: readonly SessionEvent[]) {
          entry.events.push(...evs)
        },
        async read() {
          return { events: [...entry.events], eventState: undefined }
        },
        async close() {
          entry.closedCount += 1
        },
      }
    },
    async open(id: SessionId) {
      const entry = persisted.get(id)
      if (!entry) throw new Error(`session "${id}" not found`)
      entry.openCount += 1
      return {
        header: entry.header,
        inheritedEventCount: 0,
        async append(evs: readonly SessionEvent[]) {
          entry.events.push(...evs)
        },
        async read() {
          return { events: [...entry.events], eventState: undefined }
        },
        async close() {
          entry.closedCount += 1
        },
      }
    },
  }

  rootCtx.provide('agents', agentsSvc as never)
  rootCtx.provide('sessions', sessionsSvc as never)
  rootCtx.provide('sessionPersistence', persistenceSvc as never)

  const captured: CapturedAgentLoop = {
    nativeFactory: {
      createAgent: vi.fn(),
      resume: vi.fn(),
    } as unknown as AgentFactory,
    modelProjection: {
      readerFor: (session: Session) => () => {
        const rec = sessionRecords.get(session.id)
        return rec ? { ...rec.modelState } : { lastUsed: null, pending: null }
      },
    } as unknown as CapturedAgentLoop['modelProjection'],
    inboxProjection: {
      readerFor: (session: Session) => () => {
        const rec = sessionRecords.get(session.id)
        return (
          rec
            ? { 'next-turn': [...rec.inboxState['next-turn']], 'next-step': [...rec.inboxState['next-step']] }
            : { 'next-turn': [], 'next-step': [] }
        ) as unknown as InboxState
      },
    } as unknown as CapturedAgentLoop['inboxProjection'],
  }

  // Keep persisted events synced whenever an agent appends directly to the session log.
  const syncSessionToPersisted = (id: SessionId) => {
    const rec = sessionRecords.get(id)
    const entry = persisted.get(id)
    if (rec && entry) {
      entry.events = [...rec.events]
    }
  }

  return {
    rootCtx,
    liveAgents,
    liveSessions,
    sessionRecords,
    persisted,
    announcedAgents,
    detachedAgents,
    captured,
    syncSessionToPersisted,
  }
}

function createFakePooledRegistry(
  tag: string,
  turnImpl?: (
    sessionId: string,
    prompt: readonly AcpPromptBlock[],
    handlers?: AcpTurnHandlers,
    signal?: AbortSignal,
  ) => Promise<AcpTurnResult>,
  onCloseError?: Error,
) {
  const agySpec = resolveRuntimeSpecs([]).find((s) => s.id === 'agy')!
  const openedExternalIds: string[] = []
  const closedExternalIds: string[] = []
  let seq = 0

  const pool = new AcpRuntimePool({
    spec: agySpec,
    instanceScopeKey: `/tmp/dsh-router-test-${tag}`,
    idleEvictMs: 0,
    clientFactory: (_opts: AcpRuntimeOptions): AcpPoolClientLike => {
      const openSet = new Set<string>()
      let connected = true
      const catalog: AcpCatalogSnapshot = {
        models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
        modes: [],
        currentModelId: 'gemini-4-neon',
      }
      return {
        get isConnected() {
          return connected
        },
        get activeSessionCount() {
          return openSet.size
        },
        get inFlightTurnCount() {
          return 0
        },
        cachedCatalog: catalog,
        async openSession(startOptions: AcpStartOptions = {}): Promise<AcpSessionHandle> {
          const sid = startOptions.sessionId ?? `${tag}_ext_${++seq}`
          openSet.add(sid)
          openedExternalIds.push(sid)
          return {
            sessionId: sid,
            get isOpen() {
              return connected && openSet.has(sid)
            },
            get catalog() {
              return catalog
            },
            async setModel() {},
            async setThoughtLevel() {},
            async setMode() {},
            runTurn: (prompt, handlers, signal) =>
              turnImpl
                ? turnImpl(sid, prompt, handlers, signal)
                : Promise.resolve().then(() => {
                    handlers?.onEvent?.({ type: 'text-delta', text: `reply:${tag}:${sid}` })
                    return { text: `reply:${tag}:${sid}`, stopReason: 'end_turn' }
                  }),
            async close() {
              openSet.delete(sid)
              closedExternalIds.push(sid)
              if (onCloseError) throw onCloseError
            },
          }
        },
        async close() {
          connected = false
          openSet.clear()
        },
      }
    },
  })

  const registry = new ExternalRuntimeRegistry()
  registry.register(createAcpRuntime(agySpec, { pool }))
  return { registry, pool, openedExternalIds, closedExternalIds }
}

describe('ExternalRuntimeRegistry preset routing', () => {
  const registry = createExternalRuntimeRegistry([])

  it('routes built-in presets to their runtimes and keeps the persisted runtime ids stable', () => {
    expect(registry.resolve('codex')?.providerId).toBe('codex-cli')
    expect(registry.resolve('agy')?.providerId).toBe('agy-cli')
    expect(registry.resolve('claude-code')?.providerId).toBe('claude-code-cli')
    expect(registry.resolve('trae')?.providerId).toBe('trae-cli')
  })

  it('reconstructs effective preset from agent-preset/selected events and resolves live catalog defaults', async () => {
    expect(effectivePresetOfSession({ agentPreset: 'codex' }, [])).toBe('codex')
    expect(
      effectivePresetOfSession({ agentPreset: 'codex' }, [
        { type: 'agent-preset/selected', data: { agentPreset: 'agy' } },
        { type: 'agent-preset/selected', data: { agentPreset: 'trae' } },
      ]),
    ).toBe('trae')

    const customReg = createExternalRuntimeRegistry([])
    customReg.attachCatalog('trae-cli', async () => [
      { id: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro', isDefault: true, reasoningEfforts: [] },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', reasoningEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    ])
    await expect(customReg.resolveDefaultSelection('trae')).resolves.toEqual({
      provider: 'trae-cli',
      model: 'DeepSeek-V4-Pro',
    })
  })

  it('returns undefined for unknown or missing presets so the native AgentLoop handles them', () => {
    expect(registry.resolve('standard')).toBeUndefined()
    expect(registry.resolve(undefined)).toBeUndefined()
    expect(registry.resolve('')).toBeUndefined()
  })

  it('does not route presets of disabled runtimes', () => {
    const withoutAgy = createExternalRuntimeRegistry([{ id: 'agy', enabled: false }])
    expect(withoutAgy.resolve('agy')).toBeUndefined()
    expect(withoutAgy.list().map((r) => r.id)).toEqual(['codex', 'claude-code', 'trae'])
  })
})

describe('createExternalAgentRouter HMR lifecycle ownership', () => {
  it('tears down agents owned by persistent third-party ownerCtx on router dispose so subsequent resume uses the fresh pool', async () => {
    const host = createFakeHostEnv()
    // Simulates a long-lived DSH core owner (e.g. api-session-controller) that does NOT reload on plugin HMR.
    const persistentOwnerFork = host.rootCtx.plugin({ name: 'persistent-session-controller', apply() {} })
    await persistentOwnerFork.await()
    const persistentOwnerCtx = persistentOwnerFork.ctx

    const sid = brandString<SessionId>('session-hmr-survivor-1')

    // Generation 1 of dsh-external-agents
    const gen1 = createFakePooledRegistry('gen1')
    const router1 = createExternalAgentRouter(host.rootCtx, {
      registry: gen1.registry,
      captured: host.captured,
      idleEvictMs: 0,
    })

    const handle1 = await router1.createAgent(persistentOwnerCtx, {
      sessionId: sid,
      meta: { cwd: '/tmp', agentPreset: 'agy' },
      agentOptions: { provider: 'agy-cli', model: 'gemini-4-neon' },
    })
    handle1.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'turn 1' }] }))
    await handle1.agent.whenIdle()
    host.syncSessionToPersisted(sid)

    expect(host.liveAgents.get(sid)).toBe(handle1.agent)
    expect(gen1.openedExternalIds).toEqual(['gen1_ext_1'])

    // Plugin HMR unload: router1 disposes FIRST, then gen1.registry disposes its ACP pool.
    // Persistent ownerCtx stays alive throughout!
    await router1.dispose()
    await gen1.registry.dispose()

    expect(host.liveAgents.get(sid)).toBeUndefined()
    expect(host.liveSessions.get(sid)).toBeUndefined()
    expect(host.persisted.get(sid)?.closedCount).toBe(1)
    expect(gen1.closedExternalIds).toContain('gen1_ext_1')

    // Calling followup on the old reference after factory teardown must be a no-op (never hits disposed pool).
    handle1.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'stale followup' }] }))
    await handle1.agent.whenIdle()

    // Generation 2 of dsh-external-agents mounts with a fresh AcpRuntimePool.
    const gen2 = createFakePooledRegistry('gen2')
    const router2 = createExternalAgentRouter(host.rootCtx, {
      registry: gen2.registry,
      captured: host.captured,
      idleEvictMs: 0,
    })

    const handle2 = await router2.resume(persistentOwnerCtx, {
      resumeSessionId: sid,
      agentOptions: { provider: 'agy-cli', model: 'gemini-4-neon' },
    })
    handle2.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'turn 2 after hmr' }] }))
    await handle2.agent.whenIdle()

    // Resumed session seamlessly reuses persisted external session id on the NEW pool without "has been disposed".
    expect(gen2.openedExternalIds).toEqual(['gen1_ext_1'])
    const turnEnds = host.sessionRecords
      .get(sid)!
      .events.filter((e) => e.type === 'turn/end') as Array<{ data: { reason: { kind: string } } }>
    expect(turnEnds).toHaveLength(2)
    expect(turnEnds[1]!.data.reason.kind).toBe('completed')

    await router2.dispose()
    await gen2.registry.dispose()
    await persistentOwnerFork.dispose()
  })

  it('bounds hung in-flight turn teardown, isolates driver close errors, and prevents new turns on disposed agent', async () => {
    const host = createFakeHostEnv()
    const ownerFork = host.rootCtx.plugin({ name: 'owner-hung-turn', apply() {} })
    await ownerFork.await()

    let releaseHungTurn!: () => void
    let turnStarted!: () => void
    const startedPromise = new Promise<void>((r) => {
      turnStarted = r
    })
    const hungTurn = new Promise<AcpTurnResult>((resolve) => {
      releaseHungTurn = () => resolve({ text: '', stopReason: 'cancelled' })
    })

    // Simulate a driver whose runTurn ignores AbortSignal AND whose close() throws an error.
    const gen = createFakePooledRegistry(
      'hung',
      async () => {
        turnStarted()
        return await hungTurn
      },
      new Error('simulated close error'),
    )
    const router = createExternalAgentRouter(host.rootCtx, {
      registry: gen.registry,
      captured: host.captured,
      idleEvictMs: 0,
      teardownIdleGraceMs: 40,
    })

    const sid = brandString<SessionId>('session-hmr-hung-1')
    const handle = await router.createAgent(ownerFork.ctx, {
      sessionId: sid,
      meta: { cwd: '/tmp', agentPreset: 'agy' },
      agentOptions: { provider: 'agy-cli', model: 'gemini-4-neon' },
    })

    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hung turn' }] }))
    await startedPromise

    const t0 = Date.now()
    await router.dispose()
    const elapsedMs = Date.now() - t0

    // Settled quickly despite hung turn & close() error, and still detached registries + closed persistence handle.
    expect(elapsedMs).toBeLessThan(1_500)
    expect(host.liveAgents.get(sid)).toBeUndefined()
    expect(host.liveSessions.get(sid)).toBeUndefined()
    expect(host.persisted.get(sid)?.closedCount).toBe(1)

    releaseHungTurn()
    await gen.registry.dispose()
    await ownerFork.dispose()
  })

  it('aborts in-flight setup and rejects new create/resume calls once router disposal begins', async () => {
    const host = createFakeHostEnv()
    const ownerFork = host.rootCtx.plugin({ name: 'owner-race', apply() {} })
    await ownerFork.await()

    const gen = createFakePooledRegistry('race')
    const router = createExternalAgentRouter(host.rootCtx, {
      registry: gen.registry,
      captured: host.captured,
      idleEvictMs: 0,
    })

    let enteredSetup!: () => void
    let releaseSetup!: () => void
    const setupEntered = new Promise<void>((r) => {
      enteredSetup = r
    })
    const setupGate = new Promise<void>((r) => {
      releaseSetup = r
    })

    const sid = brandString<SessionId>('session-hmr-setup-race')
    const creating = router.createAgent(ownerFork.ctx, {
      sessionId: sid,
      meta: { cwd: '/tmp', agentPreset: 'agy' },
      setup: async () => {
        enteredSetup()
        await setupGate
      },
    })

    await setupEntered
    const disposing = router.dispose()
    releaseSetup()

    await expect(creating).rejects.toThrow(/disposed during setup/)
    await disposing

    expect(host.liveAgents.get(sid)).toBeUndefined()
    expect(host.liveSessions.get(sid)).toBeUndefined()
    expect(host.persisted.get(sid)?.closedCount).toBeGreaterThanOrEqual(1)

    await expect(
      router.createAgent(ownerFork.ctx, {
        sessionId: brandString<SessionId>('session-after-dispose'),
        meta: { cwd: '/tmp', agentPreset: 'agy' },
      }),
    ).rejects.toThrow(/router is not active/)

    await gen.registry.dispose()
    await ownerFork.dispose()
  })

  it('tears down cleanly on ownerCtx disposal while keeping router active for other owners', async () => {
    const host = createFakeHostEnv()
    const bridgeOwnerFork = host.rootCtx.plugin({ name: 'transient-bridge-owner', apply() {} })
    await bridgeOwnerFork.await()

    const gen = createFakePooledRegistry('owner-dispose')
    const router = createExternalAgentRouter(host.rootCtx, {
      registry: gen.registry,
      captured: host.captured,
      idleEvictMs: 0,
    })

    const sid = brandString<SessionId>('session-owner-dispose-1')
    await router.createAgent(bridgeOwnerFork.ctx, {
      sessionId: sid,
      meta: { cwd: '/tmp', agentPreset: 'agy' },
    })
    expect(host.liveAgents.has(sid)).toBe(true)

    await bridgeOwnerFork.dispose()
    expect(host.liveAgents.has(sid)).toBe(false)
    expect(host.liveSessions.has(sid)).toBe(false)
    expect(host.persisted.get(sid)?.closedCount).toBe(1)

    await router.dispose()
    await gen.registry.dispose()
  })
})
