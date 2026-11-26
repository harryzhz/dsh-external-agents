import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  CreateAgentOptions,
  InboxState,
  ModelSelectionProjectionState,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  SessionLogOffset,
  SessionPreparation,
  interruptedTurnClosers,
  type Session,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { ExternalAgent } from './external-agent.js'
import type { ExternalRuntimeDefinition } from './runtime/definition.js'
import type { ExternalRuntimeRegistry } from './runtime/registry.js'

export interface CapturedAgentLoop {
  readonly nativeFactory: AgentFactory
  readonly modelProjection: ProjectionHandle<ModelSelectionProjectionState>
  readonly inboxProjection: ProjectionHandle<InboxState>
}

/**
 * Mount DSH's native AgentLoop inside an isolated sub-context so we can capture
 * its factory and session projections without monkey-patching or forking DSH.
 */
export async function mountWrappedAgentLoop(
  ctx: Context,
  maxParallelToolCalls: number,
): Promise<CapturedAgentLoop> {
  let nativeFactory: AgentFactory | null = null
  const capturedProjections = new Map<string, ProjectionHandle<unknown>>()

  const loopCtx = ctx.isolate('agents').isolate('sessionProjections')
  const rawAgents = ctx.agents
  const rawProjections = ctx.sessionProjections

  // Proxy an empty target and hide symbols so Cordis does not unwrap the proxy
  // back to the root service via Symbol.for('cordis.tracker' | 'cordis.original').
  const agentsProxy = new Proxy(Object.create(null) as typeof rawAgents, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'setFactory') {
        return (factory: AgentFactory) => {
          nativeFactory = factory
          return () => {
            if (nativeFactory === factory) nativeFactory = null
          }
        }
      }
      const val = Reflect.get(rawAgents, prop, rawAgents)
      return typeof val === 'function' ? val.bind(rawAgents) : val
    },
  })

  const projectionsProxy = new Proxy(Object.create(null) as typeof rawProjections, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'register') {
        return async (def: Parameters<typeof rawProjections.register>[0]) => {
          const handle = await rawProjections.register(def)
          capturedProjections.set(def.key, handle as ProjectionHandle<unknown>)
          return handle
        }
      }
      const val = Reflect.get(rawProjections, prop, rawProjections)
      return typeof val === 'function' ? val.bind(rawProjections) : val
    },
  })

  const bridgeFiber = loopCtx.plugin({
    name: 'dsh-external-agents-loop-proxy',
    apply(subCtx: Context) {
      subCtx.provide('agents', agentsProxy)
      subCtx.provide('sessionProjections', projectionsProxy)
    },
  })
  await bridgeFiber.await()

  const loopFork = loopCtx.plugin(AgentLoop, {
    agents: [],
    maxParallelToolCalls,
  })
  await loopFork.await()

  const modelProjection = capturedProjections.get('modelSelection') as
    | ProjectionHandle<ModelSelectionProjectionState>
    | undefined
  const inboxProjection = capturedProjections.get('inbox') as
    | ProjectionHandle<InboxState>
    | undefined

  if (!nativeFactory || !modelProjection || !inboxProjection) {
    throw new Error(
      `Failed to capture native AgentLoop seams (factory=${Boolean(nativeFactory)}, projections=${[...capturedProjections.keys()].join(',')})`,
    )
  }

  return { nativeFactory, modelProjection, inboxProjection }
}

const DEFAULT_TEARDOWN_IDLE_GRACE_MS = 6_000

export interface ExternalAgentRouterOptions {
  readonly registry: ExternalRuntimeRegistry
  readonly captured: CapturedAgentLoop
  readonly idleEvictMs: number
  readonly teardownIdleGraceMs?: number
}

export interface ManagedExternalAgentRouter extends AgentFactory {
  /** Stop accepting new external agents and tear down every live external agent created by this router. */
  dispose(): Promise<void>
}

async function waitWithTimeout(task: Promise<void>, timeoutMs: number): Promise<'settled' | 'timeout'> {
  if (timeoutMs <= 0) {
    await task
    return 'settled'
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Reconstruct the effective `agentPreset` of a session from its persisted event log,
 * honoring blank-session `agent-preset/selected` switches over the creation header.
 */
export function effectivePresetOfSession(
  header: { readonly agentPreset?: string } | undefined,
  events: readonly { readonly type?: string; readonly data?: unknown }[],
): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev?.type !== 'agent-preset/selected') continue
    const preset = (ev.data as { agentPreset?: unknown } | undefined)?.agentPreset
    if (typeof preset === 'string' && preset.length > 0) return preset
  }
  return header?.agentPreset
}

/**
 * Keep a blank session's durable `modelSelection` aligned with its selected `agentPreset`
 * so switching presets on the New Session screen immediately updates the session's model
 * to that Agent's provider without polluting the global `agentDefaultModel`.
 */
export async function syncBlankSessionModelToPreset(
  ctx: Context,
  registry: ExternalRuntimeRegistry,
  sessionId: SessionId,
  presetId: string | undefined,
): Promise<void> {
  if (!presetId) return
  const isBlankOnPreset = (target: Agent | undefined): target is Agent => {
    if (!target) return false
    const boundary = ctx.agents.turnBoundaryOf(target.session)
    if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) return false
    return effectivePresetOfSession(target.session.header, target.session.snapshotEvents()) === presetId
  }

  const initialAgent = ctx.agents.get(sessionId)
  if (!isBlankOnPreset(initialAgent)) return

  const ext = registry.resolve(presetId)
  if (ext) {
    const current = initialAgent.model.current()
    if (current?.provider === ext.providerId) return
    if (current === undefined && initialAgent.options.provider === ext.providerId && initialAgent.options.model) {
      return
    }
    const selection = await registry.resolveDefaultSelection(ext.id)
    if (!selection) return
    const liveAgent = ctx.agents.get(sessionId)
    if (!isBlankOnPreset(liveAgent) || liveAgent.model.current()?.provider === ext.providerId) return
    liveAgent.model.select({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort
        ? { reasoningEffort: brandString<ReasoningEffortId>(selection.reasoningEffort) }
        : {}),
    })
    return
  }

  // Native preset selected: if the inherited default belongs to an external CLI provider,
  // switch the blank session to the first configured native LLM model when available.
  const externalProviders = new Set([
    ...registry.list().map((r) => r.providerId),
    ...registry.listExposedPresets().map((r) => r.providerId),
  ])
  const current = initialAgent.model.current()
  const inheritedProvider = current?.provider ?? initialAgent.options.provider
  if (!inheritedProvider || !externalProviders.has(inheritedProvider)) return

  for (const providerInfo of ctx.llm.listProviders()) {
    if (externalProviders.has(providerInfo.id) || providerInfo.id.endsWith('-cli')) continue
    const models = await ctx.llm.listModels(providerInfo.id).catch(() => [])
    const first = models[0]
    if (!first) continue
    const liveAgent = ctx.agents.get(sessionId)
    if (!isBlankOnPreset(liveAgent)) return
    liveAgent.model.select({ provider: providerInfo.id, model: first.id })
    return
  }
}

/** Route presets owned by a registered external runtime; everything else goes to native AgentLoop. */
export function createExternalAgentRouter(
  ctx: Context,
  {
    registry,
    captured,
    idleEvictMs,
    teardownIdleGraceMs = DEFAULT_TEARDOWN_IDLE_GRACE_MS,
  }: ExternalAgentRouterOptions,
): ManagedExternalAgentRouter {
  let active = true
  const liveDisposers = new Set<() => Promise<void>>()
  const inFlightOps = new Set<Promise<unknown>>()

  const trackOp = <T>(op: Promise<T>): Promise<T> => {
    inFlightOps.add(op)
    const cleanup = () => {
      inFlightOps.delete(op)
    }
    op.then(cleanup, cleanup)
    return op
  }

  async function attachExternal(
    ownerCtx: Context,
    runtime: ExternalRuntimeDefinition,
    session: Session,
    agentOptions: AgentOptions,
    source: 'startup' | 'resume',
    stored: { readonly handle: SessionHandle } | undefined,
    setup: CreateAgentOptions['setup'],
  ): Promise<AgentHandle> {
    if (!active) {
      await stored?.handle.close().catch(() => {})
      throw new Error(`external agent "${session.id}" creation aborted: router is not active`)
    }

    const lastTurn = ctx.agents.turnBoundaryOf(session).lastTurn
    const agent = new ExternalAgent({
      rootCtx: ctx,
      id: session.id,
      runtime,
      resolveRuntime: (s) => registry.resolve(effectivePresetOfSession(s.header, s.snapshotEvents())),
      resolveProfile: (runtimeId, profileId) => registry.getProfile(runtimeId, profileId),
      idleEvictMs,
      options: agentOptions,
      session,
      projections: {
        modelSelection: captured.modelProjection.readerFor(session),
        inbox: captured.inboxProjection.readerFor(session),
      },
      lastTurn,
      resolveCatalogModels: (providerId, runtimeId, profileId) =>
        runtimeId && profileId
          ? registry.listModelsForRuntime(runtimeId, profileId)
          : registry.listModelsForProvider(providerId),
      onExternalBinding: (externalId, sid) => registry.registerExternalSession(externalId, sid),
    })

    let detachAgent: (() => void) | undefined
    const detachSession = agent.ctx.sessions.enter(session)
    agent.ctx.sessions.announce(session)

    let setupDone = false
    let releaseSetup!: () => void
    const setupSettled = new Promise<void>((resolve) => {
      releaseSetup = resolve
    })
    const markSetupDone = () => {
      if (setupDone) return
      setupDone = true
      releaseSetup()
    }

    let teardownRequested = false
    let disposing: Promise<void> | undefined
    let untrack: () => void = () => {}

    const teardown = (): Promise<void> => {
      teardownRequested = true
      return (disposing ??= (async () => {
        await setupSettled
        let idleOutcome: 'settled' | 'timeout' = 'settled'
        try {
          agent.cancel({ kind: 'disposed' })
          idleOutcome = await waitWithTimeout(agent.whenIdle(), teardownIdleGraceMs)
        } catch {
          // Best-effort cancellation drain; always continue cleanup.
        }
        try {
          await agent.disposeExternal()
        } catch {
          // Ignore driver close errors during teardown.
        }
        if (idleOutcome === 'timeout') {
          try {
            await waitWithTimeout(agent.whenIdle(), Math.min(teardownIdleGraceMs, 1_000))
          } catch {
            // Ignore post-force-close idle errors.
          }
        }
        try {
          await agent.scope.dispose()
        } catch {
          // Ignore scope disposal errors during teardown.
        }
        try {
          await stored?.handle.close()
        } catch {
          // Ignore persistence handle close errors during teardown.
        }
        try {
          detachAgent?.()
        } catch {
          // Ignore agent detach errors during teardown.
        }
        try {
          detachSession()
        } catch {
          // Ignore session detach errors during teardown.
        }
        untrack()
      })())
    }

    let unfollowOwner: (() => unknown) | undefined
    const dispose = async (): Promise<void> => {
      try {
        await teardown()
      } finally {
        untrack()
        const releaseOwner = unfollowOwner
        unfollowOwner = undefined
        if (releaseOwner) {
          await Promise.resolve(releaseOwner()).catch(() => {})
        }
      }
    }

    liveDisposers.add(dispose)
    untrack = () => {
      liveDisposers.delete(dispose)
    }

    try {
      unfollowOwner = ownerCtx.effect(
        () => () => teardown(),
        `externalAgent.lifecycle(${session.id})`,
      )
      if (!active || teardownRequested) {
        throw new Error(`external agent "${session.id}" setup aborted: disposed during setup`)
      }
      const commit = await setup?.(agent.ctx, agent)
      if (!active || teardownRequested) {
        throw new Error(`external agent "${session.id}" setup aborted: disposed during setup`)
      }
      commit?.commit()
      detachAgent = ctx.agents.enter(agent)
      await ctx.agents.announce(agent, source)
      if (!active || teardownRequested) {
        throw new Error(`external agent "${session.id}" setup aborted: disposed during announce`)
      }
      markSetupDone()
      if (source === 'startup' && lastTurn === 0) {
        const presetId = effectivePresetOfSession(session.header, session.snapshotEvents())
        queueMicrotask(() => {
          if (!active || teardownRequested) return
          void syncBlankSessionModelToPreset(ctx, registry, session.id, presetId).catch(() => {})
        })
      }
    } catch (err) {
      markSetupDone()
      await dispose().catch(() => {})
      throw err
    }

    return {
      agent,
      dispose,
    }
  }

  return {
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const runtime = registry.resolve(options.meta?.agentPreset)
      if (!runtime) {
        return await captured.nativeFactory.createAgent(ownerCtx, options)
      }
      if (!active) {
        throw new Error(`external agent "${options.sessionId}" creation aborted: router is not active`)
      }

      return await trackOp(
        (async () => {
          const preparation = SessionPreparation.create(
            ctx.sessions.prepare(options.sessionId, {
              ...(options.seed === undefined ? {} : { seed: options.seed }),
              ...(options.meta === undefined ? {} : { meta: options.meta }),
              ...(options.inheritedEventCount === undefined
                ? {}
                : { inheritedEventCount: options.inheritedEventCount }),
            }),
          )
          const persistence = ctx.get('sessionPersistence')
          let stored: { readonly handle: SessionHandle } | undefined
          try {
            if (persistence) {
              const handle = await persistence.create(preparation.session.header, {
                inheritedEventCount: preparation.session.inheritedEventCount,
              })
              stored = { handle }
              if (!active) {
                throw new Error(
                  `external agent "${options.sessionId}" creation aborted: router is not active`,
                )
              }
              const suffix = preparation.session.snapshotEvents(SessionLogOffset(0))
              if (suffix.length > 0) await handle.append(suffix)
            }
            return await attachExternal(
              ownerCtx,
              runtime,
              preparation.session,
              options.agentOptions ?? {},
              'startup',
              stored,
              options.setup,
            )
          } catch (err) {
            await stored?.handle.close().catch(() => {})
            throw err
          } finally {
            preparation[Symbol.dispose]()
          }
        })(),
      )
    },

    async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
      const persistence = ctx.get('sessionPersistence')
      if (!persistence) {
        return await captured.nativeFactory.resume(ownerCtx, options)
      }
      if (!active) {
        throw new Error(
          `external agent "${options.resumeSessionId}" resume aborted: router is not active`,
        )
      }

      return await trackOp(
        (async () => {
          const handle = await persistence.open(options.resumeSessionId, 'write')
          let handedOff = false
          let preparation: SessionPreparation | undefined
          try {
            const coldRead = await handle.read(0, undefined)
            const effectivePreset = effectivePresetOfSession(handle.header, coldRead.events)
            const runtime = registry.resolve(effectivePreset)
            if (!runtime) {
              await handle.close()
              handedOff = true
              return await captured.nativeFactory.resume(ownerCtx, options)
            }
            if (!active) {
              throw new Error(
                `external agent "${options.resumeSessionId}" resume aborted: router is not active`,
              )
            }
            const closers = interruptedTurnClosers(coldRead.events)
            if (closers.length > 0) await handle.append(closers)
            preparation = SessionPreparation.create(
              ctx.sessions.prepare(options.resumeSessionId, {
                seed: [...coldRead.events, ...closers],
                meta: structuredClone(handle.header),
                inheritedEventCount: handle.inheritedEventCount,
                eventState: coldRead.eventState,
              }),
            )
            const storedCount = coldRead.events.length + closers.length
            const unstoredSuffix = preparation.session.snapshotEvents(SessionLogOffset(storedCount))
            if (unstoredSuffix.length > 0) {
              await handle.append(unstoredSuffix)
            }
            const result = await attachExternal(
              ownerCtx,
              runtime,
              preparation.session,
              options.agentOptions ?? {},
              'resume',
              { handle },
              options.setup,
            )
            handedOff = true
            return result
          } finally {
            preparation?.[Symbol.dispose]()
            if (!handedOff) {
              await handle.close().catch(() => {})
            }
          }
        })(),
      )
    },

    async dispose(): Promise<void> {
      active = false
      const firstPass = [...liveDisposers]
      if (firstPass.length > 0) {
        await Promise.allSettled(firstPass.map((fn) => fn()))
      }
      if (inFlightOps.size > 0) {
        await Promise.allSettled([...inFlightOps])
      }
      if (liveDisposers.size > 0) {
        const remainder = [...liveDisposers]
        await Promise.allSettled(remainder.map((fn) => fn()))
      }
    },
  }
}
