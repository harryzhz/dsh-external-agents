import { ExternalCatalogLlmAdapter, type CatalogModelEntry } from '../catalog-adapter.js'
import type {
  ExternalRuntimeOverride,
  ExternalRuntimeProfile,
  ExternalRuntimeProfileCapabilities,
  ExternalRuntimeProfileInput,
  ExternalRuntimeProfilePublicView,
} from '../types.js'
import { createAcpRuntime } from './acp-runtime.js'
import { createCodexRuntime } from './codex-runtime.js'
import { resolveRuntimeSpecs, type ExternalRuntimeSpec } from './config.js'
import {
  toRuntimeSummary,
  type ExposedProfilePresetSummary,
  type ExternalRuntimeDefinition,
  type ExternalRuntimeSummary,
} from './definition.js'
import {
  profilePresetId,
  profileProviderId,
  RuntimeProfileStore,
} from './profile-store.js'

export interface ProfilePresetSyncHandler {
  syncProfilePreset(
    derived: ExternalRuntimeDefinition | undefined,
    presetId: string,
    providerId: string,
    catalog?: ExternalCatalogLlmAdapter,
  ): Promise<void>
}

export interface ExternalRuntimeRegistryOptions {
  readonly dataDir?: string
  readonly catalogTtlMs?: number
  readonly enableDiscovery?: boolean
  readonly processEnv?: NodeJS.ProcessEnv
  readonly onWarn?: (message: string) => void
}

function profileCacheKey(runtimeId: string, profileId?: string): string {
  return profileId ? `${runtimeId}:${profileId}` : runtimeId
}

/**
 * Enabled external runtimes keyed by id (= agent preset id), plus managed launch profiles
 * and optional dynamically exposed profile presets (`<runtimeId>:<profileId>`).
 * Exposed as `ctx.externalRuntimes`.
 */
export class ExternalRuntimeRegistry {
  private readonly runtimes = new Map<string, ExternalRuntimeDefinition>()
  private readonly exposedPresets = new Map<string, ExternalRuntimeDefinition>()
  private readonly catalogLoaders = new Map<string, () => Promise<readonly CatalogModelEntry[]>>()
  private readonly profileCatalogs = new Map<string, ExternalCatalogLlmAdapter>()
  private profileStore?: RuntimeProfileStore
  private presetSyncHandler?: ProfilePresetSyncHandler
  private catalogTtlMs = 5 * 60_000
  private onWarn?: (message: string) => void

  attachProfileStore(
    store: RuntimeProfileStore,
    options: { readonly catalogTtlMs?: number; readonly onWarn?: (message: string) => void } = {},
  ): void {
    this.profileStore = store
    if (options.catalogTtlMs !== undefined) this.catalogTtlMs = options.catalogTtlMs
    if (options.onWarn) this.onWarn = options.onWarn
    this.rebuildExposedPresetDefinitions()
  }

  attachPresetSyncHandler(handler: ProfilePresetSyncHandler | undefined): void {
    this.presetSyncHandler = handler
  }

  attachCatalog(providerId: string, loader: () => Promise<readonly CatalogModelEntry[]>): void {
    this.catalogLoaders.set(providerId, loader)
  }

  detachCatalog(providerId: string): void {
    this.catalogLoaders.delete(providerId)
  }

  async listModelsForProvider(providerId: string): Promise<readonly CatalogModelEntry[] | undefined> {
    const loader = this.catalogLoaders.get(providerId)
    return loader ? await loader() : undefined
  }

  async listModelsForRuntime(
    runtimeId: string,
    profileId?: string,
    options: { readonly force?: boolean } = {},
  ): Promise<readonly CatalogModelEntry[] | undefined> {
    const cleanProfile = profileId?.trim() || undefined
    const def = this.resolve(runtimeId)
    if (!def) return undefined

    if (!cleanProfile && !def.boundProfile) {
      if (options.force) {
        const fresh = await def.probeModels()
        return fresh.length > 0 ? fresh : def.fallbackModels
      }
      return await this.listModelsForProvider(def.providerId)
    }

    const baseId = def.parentRuntimeId ?? def.id
    const baseDef = this.runtimes.get(baseId)
    if (!baseDef) return undefined
    const resolvedProfileId = cleanProfile ?? def.profileId
    const profile =
      (resolvedProfileId ? this.profileStore?.get(baseId, resolvedProfileId) : undefined) ??
      def.boundProfile
    if (!profile) {
      return await this.listModelsForProvider(baseDef.providerId)
    }

    const adapter = this.ensureProfileCatalog(baseDef, profile)
    if (options.force) {
      const fresh = await baseDef.probeModels(profile)
      if (fresh.length > 0) {
        // Refresh cache adapter cleanly by re-creating it with the new entries on next normal load.
        this.profileCatalogs.delete(profileCacheKey(baseId, profile.id))
        return fresh
      }
      return baseDef.fallbackModels
    }
    return await adapter.listCatalogEntries()
  }

  async probeProfileModels(
    runtimeId: string,
    profileId?: string,
  ): Promise<readonly CatalogModelEntry[]> {
    const baseDef = this.runtimes.get(runtimeId)
    if (!baseDef) {
      throw new Error(`未找到外部运行时 "${runtimeId}"`)
    }
    const cleanProfile = profileId?.trim() || undefined
    if (!cleanProfile) {
      const models = await baseDef.probeModels()
      return models.length > 0 ? models : baseDef.fallbackModels
    }
    const profile = this.profileStore?.get(runtimeId, cleanProfile)
    if (!profile) {
      throw new Error(`未找到运行时 "${runtimeId}" 的启动配置 "${cleanProfile}"`)
    }
    this.profileCatalogs.delete(profileCacheKey(runtimeId, cleanProfile))
    const models = await baseDef.probeModels(profile)
    return models.length > 0 ? models : baseDef.fallbackModels
  }

  async resolveDefaultSelection(
    runtimeId: string,
    profileId?: string,
  ): Promise<{ readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined> {
    const def = this.resolve(runtimeId)
    if (!def) return undefined
    const baseId = def.parentRuntimeId ?? def.id
    const resolvedProfile =
      (profileId ? this.profileStore?.get(baseId, profileId) : undefined) ?? def.boundProfile
    const entries = await this.listModelsForRuntime(def.id, resolvedProfile?.id).catch(() => undefined)
    const configured = (resolvedProfile?.defaultModel ?? def.defaultModel).trim()
    let model = configured
    if (entries && entries.length > 0 && (!configured || !entries.some((m) => m.id === configured))) {
      model = entries.find((m) => m.isDefault)?.id ?? entries[0]!.id
    }
    if (!model) return undefined
    const entry = entries?.find((m) => m.id === model)
    let reasoningEffort: string | undefined =
      resolvedProfile?.defaultReasoningEffort ||
      entry?.defaultEffort ||
      (!resolvedProfile ? def.defaultReasoningEffort : undefined)
    if (entry?.reasoningEfforts !== undefined) {
      if (entry.reasoningEfforts.length === 0) {
        reasoningEffort = undefined
      } else if (reasoningEffort && !entry.reasoningEfforts.includes(reasoningEffort)) {
        reasoningEffort = entry.defaultEffort
      }
    }
    return {
      provider: def.providerId,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  }

  register(definition: ExternalRuntimeDefinition): void {
    if (this.runtimes.has(definition.id)) {
      throw new Error(`external runtime "${definition.id}" is already registered`)
    }
    const clash = [...this.runtimes.values()].find((r) => r.providerId === definition.providerId)
    if (clash) {
      throw new Error(
        `external runtimes "${clash.id}" and "${definition.id}" share provider id "${definition.providerId}"`,
      )
    }
    this.runtimes.set(definition.id, definition)
  }

  /** Runtime (base or exposed profile preset) that owns sessions of `presetId`; `undefined` routes to native AgentLoop. */
  resolve(presetId: string | undefined): ExternalRuntimeDefinition | undefined {
    if (!presetId) return undefined
    return this.runtimes.get(presetId) ?? this.exposedPresets.get(presetId)
  }

  definitions(): readonly ExternalRuntimeDefinition[] {
    return [...this.runtimes.values()]
  }

  exposedPresetDefinitions(): readonly ExternalRuntimeDefinition[] {
    return [...this.exposedPresets.values()]
  }

  get(id: string): ExternalRuntimeSummary | undefined {
    const runtime = this.runtimes.get(id) ?? this.exposedPresets.get(id)
    return runtime ? toRuntimeSummary(runtime) : undefined
  }

  list(): ExternalRuntimeSummary[] {
    return [...this.runtimes.values()].map(toRuntimeSummary)
  }

  listExposedPresets(): ExposedProfilePresetSummary[] {
    return [...this.exposedPresets.values()].map((def) => ({
      ...toRuntimeSummary(def),
      parentRuntimeId: def.parentRuntimeId!,
      profileId: def.profileId!,
    }))
  }

  getProfileCapabilities(runtimeId: string): ExternalRuntimeProfileCapabilities | undefined {
    const def = this.runtimes.get(runtimeId)
    return def?.getProfileCapabilities?.()
  }

  getProfile(runtimeId: string, profileId: string): ExternalRuntimeProfile | undefined {
    return this.profileStore?.get(runtimeId, profileId)
  }

  listProfiles(runtimeId?: string): ExternalRuntimeProfilePublicView[] {
    return this.profileStore?.listPublic(runtimeId) ?? []
  }

  async upsertProfile(input: ExternalRuntimeProfileInput): Promise<ExternalRuntimeProfilePublicView> {
    if (!this.profileStore) {
      throw new Error('当前外部运行时注册表未启用启动配置管理')
    }
    const saved = this.profileStore.upsert(input)
    this.profileCatalogs.delete(profileCacheKey(saved.runtimeId, saved.id))
    await this.syncExposedProfile(saved.runtimeId, saved.id)
    return this.profileStore.getPublic(saved.runtimeId, saved.id)!
  }

  async deleteProfile(runtimeId: string, profileId: string): Promise<boolean> {
    if (!this.profileStore) return false
    const existed = this.profileStore.delete(runtimeId, profileId)
    if (!existed) return false
    this.profileCatalogs.delete(profileCacheKey(runtimeId, profileId))
    await this.syncExposedProfile(runtimeId, profileId)
    return true
  }

  /** Sync all currently exposed profiles into the attached host preset/LLM sync handler. */
  async syncAllExposedPresets(): Promise<void> {
    if (!this.profileStore) return
    this.rebuildExposedPresetDefinitions()
    for (const profile of this.profileStore.list()) {
      if (profile.exposeAsPreset) {
        await this.syncExposedProfile(profile.runtimeId, profile.id)
      }
    }
  }

  private async syncExposedProfile(runtimeId: string, profileId: string): Promise<void> {
    const presetId = profilePresetId(runtimeId, profileId)
    const providerId = profileProviderId(runtimeId, profileId)
    const base = this.runtimes.get(runtimeId)
    const effective = this.profileStore?.get(runtimeId, profileId)

    if (!base || !effective?.exposeAsPreset) {
      this.exposedPresets.delete(presetId)
      this.catalogLoaders.delete(providerId)
      await this.presetSyncHandler?.syncProfilePreset(undefined, presetId, providerId)
      return
    }

    const derived = this.buildDerivedPresetDefinition(base, effective)
    const catalog = this.ensureProfileCatalog(base, effective)
    this.exposedPresets.set(presetId, derived)
    this.catalogLoaders.set(providerId, () => catalog.listCatalogEntries())
    await this.presetSyncHandler?.syncProfilePreset(derived, presetId, providerId, catalog)
  }

  private rebuildExposedPresetDefinitions(): void {
    this.exposedPresets.clear()
    if (!this.profileStore) return
    for (const profile of this.profileStore.list()) {
      if (!profile.exposeAsPreset) continue
      const base = this.runtimes.get(profile.runtimeId)
      if (!base) continue
      const derived = this.buildDerivedPresetDefinition(base, profile)
      const catalog = this.ensureProfileCatalog(base, profile)
      this.exposedPresets.set(derived.id, derived)
      this.catalogLoaders.set(derived.providerId, () => catalog.listCatalogEntries())
    }
  }

  private buildDerivedPresetDefinition(
    base: ExternalRuntimeDefinition,
    profile: ExternalRuntimeProfile,
  ): ExternalRuntimeDefinition {
    const id = profilePresetId(base.id, profile.id)
    const providerId = profileProviderId(base.id, profile.id)
    const displayName = `${base.displayName} · ${profile.name}`
    const description =
      profile.description?.trim() ||
      `基于 ${base.displayName} 的启动配置「${profile.name}」`
    return {
      id,
      displayName,
      description,
      providerId,
      defaultModel: profile.defaultModel || base.defaultModel,
      ...(profile.defaultReasoningEffort || base.defaultReasoningEffort
        ? { defaultReasoningEffort: profile.defaultReasoningEffort || base.defaultReasoningEffort }
        : {}),
      fallbackModels: base.fallbackModels,
      parentRuntimeId: base.id,
      profileId: profile.id,
      boundProfile: profile,
      probeModels: () => base.probeModels(profile),
      createDriver: (host) => base.createDriver({ ...host, profile: host.profile ?? profile }),
    }
  }

  private ensureProfileCatalog(
    base: ExternalRuntimeDefinition,
    profile: ExternalRuntimeProfile,
  ): ExternalCatalogLlmAdapter {
    const key = profileCacheKey(base.id, profile.id)
    const existing = this.profileCatalogs.get(key)
    if (existing) return existing
    const adapter = new ExternalCatalogLlmAdapter({
      displayName: `${base.displayName} · ${profile.name}`,
      ttlMs: this.catalogTtlMs,
      fallbackModels: base.fallbackModels,
      fetchModels: () => base.probeModels(profile),
      ...(this.onWarn ? { onWarn: this.onWarn } : {}),
    })
    this.profileCatalogs.set(key, adapter)
    return adapter
  }
}

function createRuntimeDefinition(spec: ExternalRuntimeSpec): ExternalRuntimeDefinition {
  switch (spec.kind) {
    case 'codex-app-server':
      return createCodexRuntime(spec)
    case 'acp':
      return createAcpRuntime(spec)
  }
}

/** Build the registry from built-in runtimes merged with user entries; disabled ones are skipped. */
export function createExternalRuntimeRegistry(
  overrides: readonly ExternalRuntimeOverride[],
  options: ExternalRuntimeRegistryOptions = {},
): ExternalRuntimeRegistry {
  const specs = resolveRuntimeSpecs(overrides)
  const registry = new ExternalRuntimeRegistry()
  for (const spec of specs) {
    if (spec.enabled) registry.register(createRuntimeDefinition(spec))
  }
  const store = new RuntimeProfileStore({
    specs,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.enableDiscovery !== undefined ? { enableDiscovery: options.enableDiscovery } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  })
  registry.attachProfileStore(store, {
    ...(options.catalogTtlMs !== undefined ? { catalogTtlMs: options.catalogTtlMs } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  })
  return registry
}
