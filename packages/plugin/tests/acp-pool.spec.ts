import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { InboxState, ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
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
import {
  AcpRuntimePool,
  buildAgyIsolatedAppDataDirName,
  detectAcpExecutorError,
  hasAgyDataDirFlag,
  syncAgyBaseSettings,
  type AcpPoolClientLike,
} from '../src/runtime/acp-pool.js'
import { createAcpRuntime } from '../src/runtime/acp-runtime.js'
import { resolveRuntimeSpecs } from '../src/runtime/config.js'
import { createExternalRuntimeRegistry } from '../src/runtime/registry.js'
import type { ExternalRuntimeProfile } from '../src/types.js'

const tempDirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

class FakePoolClient implements AcpPoolClientLike {
  isConnected = true
  closed = false
  cachedCatalog: AcpCatalogSnapshot | undefined
  readonly openedSessions: Array<{ sessionId: string; options: AcpStartOptions }> = []
  readonly closedSessions: string[] = []
  private readonly openSet = new Set<string>()
  private seq = 0
  private readonly turnImpl: (
    sessionId: string,
    prompt: readonly AcpPromptBlock[],
    handlers?: AcpTurnHandlers,
  ) => Promise<AcpTurnResult>

  constructor(
    readonly options: AcpRuntimeOptions,
    turnImpl?: (
      sessionId: string,
      prompt: readonly AcpPromptBlock[],
      handlers?: AcpTurnHandlers,
    ) => Promise<AcpTurnResult>,
  ) {
    this.cachedCatalog = {
      models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
      modes: [],
      currentModelId: 'gemini-4-neon',
    }
    this.turnImpl =
      turnImpl ??
      (async (_sid, _prompt, handlers) => {
        handlers?.onEvent?.({ type: 'text-delta', text: 'ok' })
        return { text: 'ok', stopReason: 'end_turn' }
      })
  }

  get activeSessionCount(): number {
    return this.openSet.size
  }

  get inFlightTurnCount(): number {
    return 0
  }

  async openSession(startOptions: AcpStartOptions = {}): Promise<AcpSessionHandle> {
    const sid = startOptions.sessionId ?? `ext_sess_${++this.seq}`
    this.openSet.add(sid)
    this.openedSessions.push({ sessionId: sid, options: startOptions })
    const self = this
    return {
      sessionId: sid,
      get isOpen(): boolean {
        return self.isConnected && self.openSet.has(sid)
      },
      get catalog(): AcpCatalogSnapshot | undefined {
        return self.cachedCatalog
      },
      async setModel() {},
      async setThoughtLevel() {},
      async setMode() {},
      runTurn: (prompt, handlers) => this.turnImpl(sid, prompt, handlers),
      async close() {
        if (self.openSet.delete(sid)) {
          self.closedSessions.push(sid)
        }
      },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.isConnected = false
    this.openSet.clear()
  }
}

function createMemorySession(id: string, agentPreset: string) {
  const events: SessionEvent[] = []
  let seq = 0
  const modelState: {
    lastUsed: ModelSelectionProjectionState['lastUsed']
    pending: ModelSelectionProjectionState['pending']
  } = { lastUsed: null, pending: null }
  const inboxState: { 'next-turn': unknown[]; 'next-step': unknown[] } = {
    'next-turn': [],
    'next-step': [],
  }

  const fold = (ev: { type?: string; data?: Record<string, unknown> }) => {
    if (ev.type === 'agent/inbox/spliced' && ev.data) {
      const target = ev.data.target as 'next-turn' | 'next-step'
      const start = Number(ev.data.start ?? 0)
      const removedCount = Number(ev.data.removedCount ?? 0)
      const inserted = Array.isArray(ev.data.inserted) ? ev.data.inserted : []
      inboxState[target].splice(start, removedCount, ...inserted)
    }
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
      fold(ev as unknown as { type?: string; data?: Record<string, unknown> })
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

describe('agy isolation helpers & executor error detection', () => {
  it('detects explicit app-data-dir / gemini-dir flags and generates distinct relative names per scope and profile', () => {
    expect(hasAgyDataDirFlag(['acp', '--stdio'])).toBe(false)
    expect(hasAgyDataDirFlag(['acp', '--app-data-dir', 'custom'])).toBe(true)
    expect(hasAgyDataDirFlag(['acp', '--app_data_dir=custom'])).toBe(true)
    expect(hasAgyDataDirFlag(['acp', '--gemini-dir', '/opt/gemini'])).toBe(true)

    const prodDefault = buildAgyIsolatedAppDataDirName('/tmp/dsh-prod/external-agents')
    const prodProxy = buildAgyIsolatedAppDataDirName('/tmp/dsh-prod/external-agents', 'mh-proxy')
    const e2eDefault = buildAgyIsolatedAppDataDirName('/tmp/dsh-e2e/external-agents')
    const coldProbe = buildAgyIsolatedAppDataDirName('/tmp/dsh-prod/external-agents', 'mh-proxy', 'ab12cd34')

    expect(prodDefault).toMatch(/^dsh-agy-[0-9a-f]{8}-default$/)
    expect(prodProxy).toMatch(/^dsh-agy-[0-9a-f]{8}-mh-proxy$/)
    expect(e2eDefault).toMatch(/^dsh-agy-[0-9a-f]{8}-default$/)
    expect(coldProbe).toMatch(/^dsh-agy-probe-[0-9a-f]{8}-mh-proxy-ab12cd34$/)
    expect(new Set([prodDefault, prodProxy, e2eDefault, coldProbe]).size).toBe(4)
  })

  it('mirrors host antigravity-cli settings.json into isolated appDataDir without mutating host', () => {
    const fakeGemini = makeTempDir('fake-gemini-')
    const hostDir = join(fakeGemini, 'antigravity-cli')
    mkdirSync(hostDir, { recursive: true })
    const content = JSON.stringify({ allowNonWorkspaceAccess: true, toolPermission: 'always-proceed' })
    writeFileSync(join(hostDir, 'settings.json'), content)

    syncAgyBaseSettings(fakeGemini, 'dsh-agy-12345678-default')
    const targetPath = join(fakeGemini, 'dsh-agy-12345678-default', 'settings.json')
    expect(existsSync(targetPath)).toBe(true)
    expect(readFileSync(targetPath, 'utf8')).toBe(content)
    expect(readFileSync(join(hostDir, 'settings.json'), 'utf8')).toBe(content)
  })

  it('detects standalone agy executor error banners without false-positiving on multi-line explanations', () => {
    expect(
      detectAcpExecutorError(
        '\n⚠ agent executor error: expected pending tool step at index 79, got status CORTEX_STEP_STATUS_CANCELED\n',
      ),
    ).toBe('agent executor error: expected pending tool step at index 79, got status CORTEX_STEP_STATUS_CANCELED')

    expect(
      detectAcpExecutorError(
        '⚠ agent executor error: expected pending tool step at index 79\n\n原因分析：这是跨进程共享目录导致的踩踏。',
      ),
    ).toBeUndefined()
    expect(detectAcpExecutorError('一切正常，没有报错。')).toBeUndefined()
  })
})

describe('AcpRuntimePool isolation, multiplexing, probe reuse, and lifecycle', () => {
  it('multiplexes same-profile sessions on one client with isolated --app-data-dir and separates profiles', async () => {
    const fakeHome = makeTempDir('agy-pool-home-')
    const fakeProxySettings = join(fakeHome, 'proxy-settings.json')
    writeFileSync(fakeProxySettings, JSON.stringify({ modelProvider: 'gemini', model: 'Gemini 4 Carbon (Medium)' }))

    const agySpec = resolveRuntimeSpecs([{ id: 'agy', env: { HOME: fakeHome } }]).find((s) => s.id === 'agy')!
    const createdClients: FakePoolClient[] = []
    const pool = new AcpRuntimePool({
      spec: agySpec,
      instanceScopeKey: '/tmp/dsh-prod/external-agents',
      idleEvictMs: 1_000,
      clientFactory: (opts) => {
        const c = new FakePoolClient(opts)
        createdClients.push(c)
        return c
      },
    })

    // Two concurrent sessions on default agy share ONE pooled client
    const s1 = await pool.openSession(undefined, { cwd: '/workspace/a' })
    const s2 = await pool.openSession(undefined, { cwd: '/workspace/b' })
    expect(createdClients).toHaveLength(1)
    expect(createdClients[0]!.options.args).toContain('--app-data-dir')
    const defaultDirArg = createdClients[0]!.options.args.at(-1)!
    expect(defaultDirArg).toMatch(/^dsh-agy-[0-9a-f]{8}-default$/)
    expect(createdClients[0]!.options.env?.DSH_IN_AGENT_SESSION).toBe('1')
    expect(createdClients[0]!.options.env?.DSH_SESSION_ID).toBeUndefined()

    // Separate profile gets a separate pooled client & separate --app-data-dir
    const proxyProfile: ExternalRuntimeProfile = {
      id: 'local-proxy',
      runtimeId: 'agy',
      name: 'Local Proxy',
      source: 'user',
      configFile: fakeProxySettings,
      env: { HOME: fakeHome, GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8787', GEMINI_API_KEY: 'test-key' },
      authMethodId: 'gemini-api-key',
    }
    const s3 = await pool.openSession(proxyProfile, { cwd: '/workspace/c' })
    expect(createdClients).toHaveLength(2)
    const proxyDirArg = createdClients[1]!.options.args.at(-1)!
    expect(proxyDirArg).toMatch(/^dsh-agy-[0-9a-f]{8}-local-proxy$/)
    expect(proxyDirArg).not.toBe(defaultDirArg)

    // Releasing s1 must NOT close the shared process while s2 is still active
    await s1.release()
    expect(createdClients[0]!.closed).toBe(false)
    expect(createdClients[0]!.activeSessionCount).toBe(1)

    await s2.release()
    await s3.release()
    await pool.disposeAll()
    expect(createdClients[0]!.closed).toBe(true)
    expect(createdClients[1]!.closed).toBe(true)
  })

  it('reuses live pool catalog for probeCatalog and isolates + cleans up cold probes', async () => {
    const fakeHome = makeTempDir('agy-probe-home-')
    const agySpec = resolveRuntimeSpecs([{ id: 'agy', env: { HOME: fakeHome } }]).find((s) => s.id === 'agy')!
    const coldProbeCalls: AcpRuntimeOptions[] = []
    let probeDirObserved = ''

    const pool = new AcpRuntimePool({
      spec: agySpec,
      instanceScopeKey: '/tmp/dsh-e2e/external-agents',
      clientFactory: (opts) => new FakePoolClient(opts),
      probeCatalogFn: async (opts) => {
        coldProbeCalls.push(opts)
        const dirName = opts.args[opts.args.indexOf('--app-data-dir') + 1]!
        probeDirObserved = join(fakeHome, '.gemini', dirName)
        mkdirSync(probeDirObserved, { recursive: true })
        writeFileSync(join(probeDirObserved, 'marker'), '1')
        return { models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }], modes: [] }
      },
    })

    // Cold probe uses ephemeral --app-data-dir and cleans it up in finally
    const coldSnap = await pool.probeCatalog()
    expect(coldSnap.models).toHaveLength(1)
    expect(coldProbeCalls).toHaveLength(1)
    expect(coldProbeCalls[0]!.args.at(-1)).toMatch(/^dsh-agy-probe-[0-9a-f]{8}-default-/)
    expect(existsSync(probeDirObserved)).toBe(false)

    // Once pool is alive, probeCatalog reuses cachedCatalog without spawning a second process
    const s = await pool.openSession(undefined, { cwd: '/workspace/a' })
    const warmSnap = await pool.probeCatalog()
    expect(warmSnap.models).toHaveLength(1)
    expect(coldProbeCalls).toHaveLength(1)

    await s.release()
    await pool.disposeAll()
  })

  it('evicts idle pooled process after idleEvictMs and turns standalone executor error banner into failed turn/end', async () => {
    const fakeHome = makeTempDir('agy-err-home-')
    const agySpec = resolveRuntimeSpecs([{ id: 'agy', env: { HOME: fakeHome } }]).find((s) => s.id === 'agy')!
    const createdClients: FakePoolClient[] = []

    let returnErrorBanner = true
    const pool = new AcpRuntimePool({
      spec: agySpec,
      instanceScopeKey: '/tmp/dsh-err/external-agents',
      idleEvictMs: 50,
      clientFactory: (opts) => {
        const c = new FakePoolClient(opts, async (_sid, _prompt, handlers) => {
          const text = returnErrorBanner
            ? '\n⚠ agent executor error: expected pending tool step at index 79, got status CORTEX_STEP_STATUS_CANCELED\n'
            : '⚠ agent executor error: 说明文档\n\n这是对错误码的正常解释，不应被拦截。'
          handlers?.onEvent?.({ type: 'text-delta', text })
          return { text, stopReason: 'end_turn' }
        })
        createdClients.push(c)
        return c
      },
    })

    const runtime = createAcpRuntime(agySpec, { pool })
    const registry = createExternalRuntimeRegistry([])
    const mem = createMemorySession('session-err-banner-1', 'agy')
    const agent = new ExternalAgent({
      rootCtx: new Context(),
      id: mem.session.id,
      runtime,
      idleEvictMs: 0,
      options: { provider: 'agy-cli', model: 'gemini-4-neon' },
      session: mem.session,
      projections: mem.projections,
      lastTurn: 0,
      onExternalBinding: (extId, sid) => registry.registerExternalSession(extId, sid),
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'trigger error banner' }] }))
    await agent.whenIdle()

    // ExternalId -> DSH sessionId mapping is registered for pooled CLI lookups
    expect(registry.resolveSessionIdByExternalId('ext_sess_1')).toBe('session-err-banner-1')

    const turnEnds = mem.events.filter((e) => e.type === 'turn/end') as Array<{
      data: { reason: { kind: string; error?: { message: string } } }
    }>
    expect(turnEnds).toHaveLength(1)
    expect(turnEnds[0]!.data.reason.kind).toBe('error')
    expect(turnEnds[0]!.data.reason.error?.message).toContain('CORTEX_STEP_STATUS_CANCELED')
    // Failed turn closes its session handle, NOT the shared pool client immediately
    expect(createdClients[0]!.closedSessions).toContain('ext_sess_1')

    // Multi-line normal reply mentioning the error text must still succeed cleanly
    returnErrorBanner = false
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'explain error' }] }))
    await agent.whenIdle()
    const turnEnds2 = mem.events.filter((e) => e.type === 'turn/end') as Array<{
      data: { reason: { kind: string } }
    }>
    expect(turnEnds2).toHaveLength(2)
    expect(turnEnds2[1]!.data.reason.kind).toBe('completed')

    await agent.disposeExternal()
    await pool.disposeAll()
  })

  it('evicts idle pool process after idleEvictMs and retires/respawns on invalidateProfile', async () => {
    vi.useFakeTimers()
    const fakeHome = makeTempDir('agy-idle-home-')
    const agySpec = resolveRuntimeSpecs([{ id: 'agy', env: { HOME: fakeHome } }]).find((s) => s.id === 'agy')!
    const createdClients: FakePoolClient[] = []
    const pool = new AcpRuntimePool({
      spec: agySpec,
      instanceScopeKey: '/tmp/dsh-idle/external-agents',
      idleEvictMs: 200,
      clientFactory: (opts) => {
        const c = new FakePoolClient(opts)
        createdClients.push(c)
        return c
      },
    })

    const s1 = await pool.openSession(undefined, { cwd: '/workspace/a' })
    await s1.release()
    expect(createdClients[0]!.closed).toBe(false)

    await vi.advanceTimersByTimeAsync(210)
    expect(createdClients[0]!.closed).toBe(true)

    const s2 = await pool.openSession(undefined, { cwd: '/workspace/a' })
    expect(createdClients).toHaveLength(2)
    await pool.invalidateProfile(undefined)
    // Still active until released
    expect(createdClients[1]!.closed).toBe(false)
    await s2.release()
    expect(createdClients[1]!.closed).toBe(true)

    const s3 = await pool.openSession(undefined, { cwd: '/workspace/a' })
    expect(createdClients).toHaveLength(3)
    await s3.release()
    await pool.disposeAll()
  })
})
