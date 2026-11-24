import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  createExternalAgentRouter,
  effectivePresetOfSession,
  mountWrappedAgentLoop,
  syncBlankSessionModelToPreset,
} from './agent-loop-bridge.js'
import { ExternalCatalogLlmAdapter } from './catalog-adapter.js'
import type { ExternalRuntimeDefinition } from './runtime/definition.js'
import { createExternalRuntimeRegistry } from './runtime/registry.js'
import type {
  ExternalAgentsConfig,
  ExternalRuntimeOverride,
  ExternalRuntimeProfileConfig,
} from './types.js'

export const name = 'dsh-external-agents'

export const inject = [
  'agents',
  'sessions',
  'llm',
  'tools',
  'systemPrompt',
  'sessionProjections',
] as const

interface DynamicAgentPresetsService {
  register?(definition: {
    readonly id: string
    readonly name?: string
    readonly description?: string
    readonly order?: number
    readonly plugins: readonly unknown[]
  }): Promise<() => Promise<void>>
}

const ProfileConfig: z<ExternalRuntimeProfileConfig> = z.object({
  id: z.string().required().description('配置 ID（同运行时内唯一）'),
  name: z.string().description('展示名称'),
  description: z.string(),
  cliProfile: z.string().description('CLI 原生 Profile 名称（如 Codex / TRAE）'),
  configFile: z.string().description('启动配置文件路径（支持 ~ 展开）'),
  env: z.dict(z.string()).description('叠加环境变量'),
  args: z.array(z.string()).description('附加启动参数'),
  argsMode: z.union(['append', 'prepend', 'replace'] as const).description('参数合并策略'),
  authMethodId: z.string().description('ACP 可选认证方式 ID'),
  defaultModel: z.string(),
  defaultReasoningEffort: z.string(),
  exposeAsPreset: z.boolean().description('同步暴露为 DSH 预设'),
}) as z<ExternalRuntimeProfileConfig>

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
  profiles: z.array(ProfileConfig).description('静态声明的运行时启动配置档案'),
}) as z<ExternalRuntimeOverride>

export const Config: z<Partial<ExternalAgentsConfig>, ExternalAgentsConfig> = z.object({
  dataDir: z.string().default(''),
  idleEvictMs: z.number().min(0).default(15 * 60_000),
  catalogTtlMs: z.number().min(10_000).default(5 * 60_000),
  maxParallelToolCalls: z.number().min(1).default(8),
  runtimes: z.array(RuntimeConfig).default([]),
}) as z<Partial<ExternalAgentsConfig>, ExternalAgentsConfig>

interface MountedProfilePreset {
  disposeLlm?: () => void
  unregisterPreset?: () => Promise<void>
}

export async function apply(ctx: Context, config: ExternalAgentsConfig): Promise<void> {
  const registry = createExternalRuntimeRegistry(config.runtimes, {
    ...(config.dataDir?.trim() ? { dataDir: config.dataDir.trim() } : {}),
    catalogTtlMs: config.catalogTtlMs,
    onWarn: (msg) => ctx.logger.warn(msg),
  })
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

  const mountedProfilePresets = new Map<string, MountedProfilePreset>()
  let liveAgentPresets = ctx.get('agentPresets' as never) as DynamicAgentPresetsService | undefined
  let disposed = false
  let orderCounter = 0

  const unmountOneProfilePreset = async (presetId: string): Promise<void> => {
    const existing = mountedProfilePresets.get(presetId)
    if (!existing) return
    mountedProfilePresets.delete(presetId)
    try {
      existing.disposeLlm?.()
    } catch {
      // Ignore adapter cleanup errors during unload.
    }
    if (existing.unregisterPreset) {
      await existing.unregisterPreset().catch(() => {})
    }
  }

  const syncOneProfilePreset = async (
    derived: ExternalRuntimeDefinition | undefined,
    presetId: string,
    providerId: string,
    catalog?: ExternalCatalogLlmAdapter,
  ): Promise<void> => {
    await unmountOneProfilePreset(presetId)
    if (disposed || !derived) return

    const handle: MountedProfilePreset = {}
    if (catalog) {
      handle.disposeLlm = ctx.llm.registerAdapter([providerId], catalog)
    }
    const presetSvc =
      liveAgentPresets ??
      (ctx.get('agentPresets' as never) as DynamicAgentPresetsService | undefined)
    if (typeof presetSvc?.register === 'function') {
      try {
        handle.unregisterPreset = await presetSvc.register({
          id: presetId,
          name: derived.displayName,
          description: derived.description,
          order: 30 + (orderCounter++ % 100),
          plugins: [],
        })
      } catch (err) {
        ctx.logger.warn(
          `[dsh-external-agents] failed to register dynamic preset "${presetId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    mountedProfilePresets.set(presetId, handle)
  }

  registry.attachPresetSyncHandler({
    syncProfilePreset: syncOneProfilePreset,
  })

  ctx.effect(
    () => async () => {
      disposed = true
      registry.attachPresetSyncHandler(undefined)
      const ids = [...mountedProfilePresets.keys()]
      for (const id of ids) {
        await unmountOneProfilePreset(id)
      }
    },
    'dsh-external-agents.dynamic-profile-presets',
  )

  await registry.syncAllExposedPresets()

  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentPresets' as never], (presetCtx) => {
      const svc = (presetCtx as Context).get('agentPresets' as never) as
        | DynamicAgentPresetsService
        | undefined
      if (!svc) return
      liveAgentPresets = svc
      void registry.syncAllExposedPresets().catch((err) => {
        ctx.logger.warn(
          `[dsh-external-agents] dynamic preset sync warning: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
    })
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
  type ExternalRuntimeRegistryOptions,
  type ProfilePresetSyncHandler,
} from './runtime/registry.js'
export {
  BUILTIN_RUNTIMES,
  resolveRuntimeCommand,
  resolveRuntimeSpecs,
  type ExternalRuntimeSpec,
} from './runtime/config.js'
export {
  RuntimeProfileStore,
  discoverLocalProfiles,
  expandUserPath,
  isSecretEnvKey,
  normalizeProfileId,
  profilePresetId,
  profileProviderId,
  slugifyProfileId,
  toPublicProfileView,
} from './runtime/profile-store.js'
export {
  parseAgySettingsModel,
  resolveProfileCapabilities,
  resolveProfileDefaults,
  resolveRuntimeLaunchPlan,
  type ResolvedProfileDefaults,
  type ResolvedRuntimeLaunchPlan,
} from './runtime/profile-resolver.js'
export {
  flattenTomlToCodexConfigArgs,
  formatTomlKeySegment,
  formatTomlLiteral,
  parseTomlDocument,
} from './runtime/toml-subset.js'
export type {
  ExposedProfilePresetSummary,
  ExternalRuntimeDefinition,
  ExternalRuntimeHost,
  ExternalRuntimeSummary,
} from './runtime/definition.js'
export {
  EXTERNAL_BINDING_RECORD_TYPE,
  EXTERNAL_LAUNCH_RECORD_TYPE,
  type ExternalAgentsConfig,
  type ExternalBindingRecord,
  type ExternalDriverKind,
  type ExternalLaunchRecord,
  type ExternalRuntimeAuthMethod,
  type ExternalRuntimeConfig,
  type ExternalRuntimeDriver,
  type ExternalRuntimeKind,
  type ExternalRuntimeOverride,
  type ExternalRuntimeProfile,
  type ExternalRuntimeProfileCapabilities,
  type ExternalRuntimeProfileConfig,
  type ExternalRuntimeProfileInput,
  type ExternalRuntimeProfilePublicView,
  type ExternalTurnEvent,
  type ExternalTurnRequest,
  type ExternalTurnRunResult,
  type RuntimeArgsMode,
  type RuntimeProfileSource,
} from './types.js'
