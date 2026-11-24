import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { InboxState, ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  }
})
import { ExternalAgent } from '../src/external-agent.js'
import { resolveRuntimeSpecs } from '../src/runtime/config.js'
import type { ExternalRuntimeDefinition } from '../src/runtime/definition.js'
import { resolveProfileDefaults } from '../src/runtime/profile-resolver.js'
import {
  EXTERNAL_LAUNCH_RECORD_TYPE,
  type ExternalRuntimeDriver,
  type ExternalRuntimeProfile,
  type ExternalTurnRequest,
} from '../src/types.js'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function createMemorySession(id: string, agentPreset: string, seedEvents: SessionEvent[] = []) {
  const events: SessionEvent[] = [...seedEvents]
  let seq = events.length
  const modelState: {
    lastUsed: ModelSelectionProjectionState['lastUsed']
    pending: ModelSelectionProjectionState['pending']
  } = { lastUsed: null, pending: null }
  const inboxState: { 'next-turn': unknown[]; 'next-step': unknown[] } = {
    'next-turn': [],
    'next-step': [],
  }

  const foldEvent = (ev: { type?: string; data?: Record<string, unknown> }) => {
    if (ev.type === 'model/selection' && ev.data) {
      modelState.pending = {
        provider: String(ev.data.provider),
        model: String(ev.data.model),
        ...(typeof ev.data.reasoningEffort === 'string'
          ? { reasoningEffort: brandString<ReasoningEffortId>(ev.data.reasoningEffort) }
          : {}),
      }
    } else if (ev.type === 'agent/inbox/spliced' && ev.data) {
      const target = ev.data.target as 'next-turn' | 'next-step'
      const start = Number(ev.data.start ?? 0)
      const removedCount = Number(ev.data.removedCount ?? 0)
      const inserted = Array.isArray(ev.data.inserted) ? ev.data.inserted : []
      inboxState[target].splice(start, removedCount, ...inserted)
    }
  }

  for (const ev of events) {
    foldEvent(ev as unknown as { type?: string; data?: Record<string, unknown> })
  }

  const session = {
    id: brandString<SessionId>(id),
    header: { cwd: '/tmp', agentPreset },
    append(type: string, data: unknown, opts?: { ignorable?: boolean }) {
      const ev = {
        type,
        seq: seq++,
        time: Date.now(),
        data,
        ...(opts?.ignorable ? { ignorable: true } : {}),
      } as unknown as SessionEvent
      events.push(ev)
      foldEvent(ev as unknown as { type?: string; data?: Record<string, unknown> })
      return ev
    },
    snapshotEvents() {
      return [...events]
    },
  } as unknown as Session

  return {
    session,
    events,
    projections: {
      modelSelection: () => ({ lastUsed: modelState.lastUsed, pending: modelState.pending }),
      inbox: () => ({
        'next-turn': [...inboxState['next-turn']],
        'next-step': [...inboxState['next-step']],
      }) as unknown as InboxState,
    },
  }
}

function createFakeRootCtx(): Context {
  const ctx = new Context()
  return ctx
}

describe('ExternalAgent model persistence and profile fallback on cold resume', () => {
  it('persists model/selection on turn execution so cold resume without AgentOptions preserves exact model & effort', async () => {
    const agySpec = resolveRuntimeSpecs([]).find((s) => s.id === 'agy')!
    const observedConnections: Array<{ model?: string; effort?: string }> = []
    const observedTurns: Array<{ model: string; effort?: string }> = []

    const createDriver = (): ExternalRuntimeDriver => ({
      kind: 'agy',
      externalId: 'ext-conv-1',
      async ensureConnected(_existingId, model, effort) {
        observedConnections.push({ model, effort })
        return 'ext-conv-1'
      },
      async runTurn(request: ExternalTurnRequest, onEvent) {
        observedTurns.push({ model: request.model, effort: request.reasoningEffort })
        onEvent({ type: 'text-delta', text: 'ok' })
        return { status: 'completed' }
      },
      async close() {},
    })

    const runtime: ExternalRuntimeDefinition = {
      id: agySpec.id,
      displayName: agySpec.displayName,
      description: agySpec.description,
      providerId: agySpec.providerId,
      defaultModel: agySpec.defaultModel,
      defaultReasoningEffort: agySpec.defaultReasoningEffort,
      fallbackModels: agySpec.fallbackModels,
      resolveProfileDefaults: (p) => resolveProfileDefaults(agySpec, p),
      probeModels: async () => agySpec.fallbackModels,
      createDriver,
    }

    // Turn 1: created with explicit AgentOptions (as Lark Bridge does)
    const turn1Mem = createMemorySession('session-cold-resume-1', 'agy')
    const agent1 = new ExternalAgent({
      rootCtx: createFakeRootCtx(),
      id: turn1Mem.session.id,
      runtime,
      idleEvictMs: 0,
      options: {
        provider: 'agy-cli',
        model: 'gemini-4-carbon',
        reasoningEffort: brandString<ReasoningEffortId>('medium'),
      },
      session: turn1Mem.session,
      projections: turn1Mem.projections,
      lastTurn: 0,
    })

    agent1.followup(createUserMessage({ content: [{ type: 'text', text: 'turn 1' }] }))
    await agent1.whenIdle()

    expect(observedTurns[0]).toEqual({ model: 'gemini-4-carbon', effort: 'medium' })
    const persistedSelections = turn1Mem.events.filter((e) => e.type === 'model/selection')
    expect(persistedSelections).toHaveLength(1)
    expect((persistedSelections[0] as unknown as { data: unknown }).data).toEqual({
      provider: 'agy-cli',
      model: 'gemini-4-carbon',
      reasoningEffort: 'medium',
    })

    // Turn 2: simulated process restart + cold resume with EMPTY AgentOptions `{}`
    const turn2Mem = createMemorySession('session-cold-resume-1', 'agy', turn1Mem.events)
    const agent2 = new ExternalAgent({
      rootCtx: createFakeRootCtx(),
      id: turn2Mem.session.id,
      runtime,
      idleEvictMs: 0,
      options: {},
      session: turn2Mem.session,
      projections: turn2Mem.projections,
      lastTurn: 1,
    })

    agent2.followup(createUserMessage({ content: [{ type: 'text', text: 'turn 2' }] }))
    await agent2.whenIdle()

    expect(observedConnections[1]).toEqual({ model: 'gemini-4-carbon', effort: 'medium' })
    expect(observedTurns[1]).toEqual({ model: 'gemini-4-carbon', effort: 'medium' })
    // Idempotent: no duplicate model/selection event appended on Turn 2
    expect(turn2Mem.events.filter((e) => e.type === 'model/selection')).toHaveLength(1)
  })

  it('prefers profile settings.json defaults and catalog isDefault over base runtime defaultModel on legacy cold resume', async () => {
    const dir = makeTempDir('ext-agent-legacy-resume-')
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ modelProvider: 'gemini', model: 'Gemini 4 Carbon (Medium)' }),
    )

    const agySpec = resolveRuntimeSpecs([]).find((s) => s.id === 'agy')!
    const profileFromSettings: ExternalRuntimeProfile = {
      id: 'demo-proxy',
      runtimeId: 'agy',
      name: 'Demo Proxy',
      source: 'user',
      configFile: settingsPath,
      env: { GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8787', GEMINI_API_KEY: 'test-key' },
      authMethodId: 'gemini-api-key',
      // Deliberately omit defaultModel / defaultReasoningEffort to mirror settings.json-only profiles
    }

    const observedTurns: Array<{ model: string; effort?: string }> = []
    const runtime: ExternalRuntimeDefinition = {
      id: agySpec.id,
      displayName: agySpec.displayName,
      description: agySpec.description,
      providerId: agySpec.providerId,
      defaultModel: agySpec.defaultModel, // gemini-4-neon
      defaultReasoningEffort: agySpec.defaultReasoningEffort, // high
      fallbackModels: agySpec.fallbackModels,
      resolveProfileDefaults: (p) => resolveProfileDefaults(agySpec, p),
      probeModels: async () => agySpec.fallbackModels,
      createDriver: () => ({
        kind: 'agy',
        async ensureConnected() {
          return 'ext-conv-legacy'
        },
        async runTurn(request, onEvent) {
          observedTurns.push({ model: request.model, effort: request.reasoningEffort })
          onEvent({ type: 'text-delta', text: 'ok' })
          return { status: 'completed' }
        },
        async close() {},
      }),
    }

    // Legacy session log: has launch profile record, NO model/selection event
    const v4LegacySeed = [
      {
        type: EXTERNAL_LAUNCH_RECORD_TYPE,
        seq: 0,
        time: Date.now(),
        data: { runtimeId: 'agy', profileId: 'demo-proxy' },
        ignorable: true,
      },
    ] as unknown as SessionEvent[]

    const mem = createMemorySession('session-legacy-1', 'agy', v4LegacySeed)
    const agent = new ExternalAgent({
      rootCtx: createFakeRootCtx(),
      id: mem.session.id,
      runtime,
      resolveProfile: (runtimeId, profileId) =>
        runtimeId === 'agy' && profileId === 'demo-proxy' ? profileFromSettings : undefined,
      idleEvictMs: 0,
      options: {},
      session: mem.session,
      projections: mem.projections,
      lastTurn: 1,
      resolveCatalogModels: async () => [
        {
          id: 'gemini-4-neon',
          name: 'Gemini 4 Neon',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultEffort: 'high',
        },
        {
          id: 'gemini-4-carbon',
          name: 'Gemini 4 Carbon',
          isDefault: true,
          reasoningEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
      ],
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }] }))
    await agent.whenIdle()

    expect(observedTurns[0]).toEqual({ model: 'gemini-4-carbon', effort: 'medium' })

    // Even when a profile has NO configFile model at all, catalog isDefault must beat base runtime defaultModel
    const envOnlyProfile: ExternalRuntimeProfile = {
      id: 'env-only',
      runtimeId: 'agy',
      name: 'Env Only Proxy',
      source: 'user',
      env: { GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8787', GEMINI_API_KEY: 'test-key' },
    }
    const envSeed = [
      {
        type: EXTERNAL_LAUNCH_RECORD_TYPE,
        seq: 0,
        time: Date.now(),
        data: { runtimeId: 'agy', profileId: 'env-only' },
        ignorable: true,
      },
    ] as unknown as SessionEvent[]
    const mem2 = createMemorySession('session-legacy-2', 'agy', envSeed)
    const agent2 = new ExternalAgent({
      rootCtx: createFakeRootCtx(),
      id: mem2.session.id,
      runtime,
      resolveProfile: (runtimeId, profileId) =>
        runtimeId === 'agy' && profileId === 'env-only' ? envOnlyProfile : undefined,
      idleEvictMs: 0,
      options: {},
      session: mem2.session,
      projections: mem2.projections,
      lastTurn: 1,
      resolveCatalogModels: async () => [
        { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        {
          id: 'gemini-4-carbon',
          name: 'Gemini 4 Carbon',
          isDefault: true,
          reasoningEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
      ],
    })

    agent2.followup(createUserMessage({ content: [{ type: 'text', text: 'continue 2' }] }))
    await agent2.whenIdle()

    expect(observedTurns[1]).toEqual({ model: 'gemini-4-carbon', effort: 'medium' })
  })
})
