import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  createExternalAgentRouter,
  effectivePresetOfSession,
  mountWrappedAgentLoop,
  syncBlankSessionModelToPreset,
} from './agent-loop-bridge.js'
import { ExternalCatalogLlmAdapter } from './catalog-adapter.js'
import { createExternalRuntimeRegistry } from './runtime/registry.js'
import type { ExternalAgentsConfig, ExternalRuntimeOverride } from './types.js'

export const name = 'dsh-external-agents'

export const inject = [
  'agents',
  'sessions',
  'llm',
  'tools',
  'systemPrompt',
  'sessionProjections',
] as const

/**
 * Runtime entries carry no schema defaults on purpose: omitted fields inherit
 * the built-in runtime with the same id (see `resolveRuntimeSpecs`).
 */
const RuntimeConfig: z<ExternalRuntimeOverride> = z.object({
  id: z.string().required().description('运行时 id，同时也是路由到该运行时的 Agent preset id'),
  kind: z.union(['codex-app-server', 'acp'] as const).description('协议适配器'),
  enabled: z.boolean(),
  displayName: z.string(),
  description: z.string(),
  providerId: z.string().description('模型目录注册的 LLM provider id'),
  command: z.string(),
  args: z.array(z.string()).description('启动参数；留空沿用内置运行时的参数'),
  env: z.dict(z.string()).description('叠加到宿主进程环境上的变量'),
  stripSshEnv: z.boolean().description('剥离 SSH_CONNECTION / SSH_CLIENT / SSH_TTY（保留 SSH_AUTH_SOCK）'),
  defaultModel: z.string(),
  defaultReasoningEffort: z.string(),
  approvalPolicy: z
    .union(['untrusted', 'on-failure', 'on-request', 'never'] as const)
    .description('仅 codex-app-server'),
  sandbox: z
    .union(['read-only', 'workspace-write', 'danger-full-access'] as const)
    .description('仅 codex-app-server'),
}) as z<ExternalRuntimeOverride>

export const Config: z<Partial<ExternalAgentsConfig>, ExternalAgentsConfig> = z.object({
  idleEvictMs: z.number().min(0).default(15 * 60_000),
  catalogTtlMs: z.number().min(10_000).default(5 * 60_000),
  maxParallelToolCalls: z.number().min(1).default(8),
  runtimes: z.array(RuntimeConfig).default([]),
}) as z<Partial<ExternalAgentsConfig>, ExternalAgentsConfig>

export async function apply(ctx: Context, config: ExternalAgentsConfig): Promise<void> {
  const registry = createExternalRuntimeRegistry(config.runtimes)
  const captured = await mountWrappedAgentLoop(ctx, config.maxParallelToolCalls)

  for (const runtime of registry.definitions()) {
    const catalog = new ExternalCatalogLlmAdapter({
      displayName: runtime.displayName,
      ttlMs: config.catalogTtlMs,
      fallbackModels: runtime.fallbackModels,
      fetchModels: () => runtime.probeModels(),
      onWarn: (msg) => ctx.logger.warn(msg),
    })
    registry.attachCatalog(runtime.providerId, () => catalog.listCatalogEntries())
    ctx.effect(
      () => ctx.llm.registerAdapter([runtime.providerId], catalog),
      `dsh-external-agents.catalog(${runtime.id})`,
    )
  }

  const router = createExternalAgentRouter(ctx, {
    registry,
    captured,
    idleEvictMs: config.idleEvictMs,
  })
  ctx.effect(() => ctx.agents.setFactory(router), 'dsh-external-agents.router')
  ctx.on('session/event', (session, event) => {
    const raw = event as { readonly type?: string; readonly data?: { readonly agentPreset?: unknown } }
    if (raw.type !== 'agent-preset/selected') return
    const presetId = typeof raw.data?.agentPreset === 'string' ? raw.data.agentPreset : undefined
    if (!presetId) return
    queueMicrotask(() => {
      void syncBlankSessionModelToPreset(ctx, registry, session.id, presetId).catch(() => {})
    })
  })
  ctx.provide('externalRuntimes', registry)
}

export { ExternalAgent } from './external-agent.js'
export { effectivePresetOfSession } from './agent-loop-bridge.js'
export { ExternalCatalogLlmAdapter, type CatalogModelEntry } from './catalog-adapter.js'
export { ExternalAgentInbox } from './inbox.js'
export { ExternalStepRecorder } from './step-recorder.js'
export {
  ExternalRuntimeRegistry,
  createExternalRuntimeRegistry,
} from './runtime/registry.js'
export {
  BUILTIN_RUNTIMES,
  resolveRuntimeCommand,
  resolveRuntimeSpecs,
  type ExternalRuntimeSpec,
} from './runtime/config.js'
export type {
  ExternalRuntimeDefinition,
  ExternalRuntimeHost,
  ExternalRuntimeSummary,
} from './runtime/definition.js'
export {
  EXTERNAL_BINDING_RECORD_TYPE,
  type ExternalAgentsConfig,
  type ExternalBindingRecord,
  type ExternalDriverKind,
  type ExternalRuntimeConfig,
  type ExternalRuntimeDriver,
  type ExternalRuntimeKind,
  type ExternalRuntimeOverride,
  type ExternalTurnEvent,
  type ExternalTurnRequest,
  type ExternalTurnRunResult,
} from './types.js'
