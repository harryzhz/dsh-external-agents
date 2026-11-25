import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  ExternalRuntimeProfile,
  ExternalRuntimeProfileConfig,
  ExternalRuntimeProfileInput,
  ExternalRuntimeProfilePublicView,
  RuntimeArgsMode,
} from '../types.js'
import type { ExternalRuntimeSpec } from './config.js'
import { parseTomlDocument } from './toml-subset.js'

const SECRET_ENV_KEY_RE = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)(?:$|_)|(?:APIKEY|ACCESS_KEY|AUTH_TOKEN)/i
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/

interface PersistedProfilesFileV1 {
  readonly version: 1
  readonly profiles: readonly ExternalRuntimeProfile[]
}

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY_RE.test(key.trim())
}

export function profilePresetId(runtimeId: string, profileId: string): string {
  return `${runtimeId}:${profileId}`
}

export function profileProviderId(runtimeId: string, profileId: string): string {
  return `${runtimeId}--${profileId}-cli`
}

export function expandUserPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ''
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2))
  }
  return resolve(trimmed)
}

export function slugifyProfileId(raw: string): string {
  const ascii = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-._]+$/g, '')
    .slice(0, 48)
  if (ascii && PROFILE_ID_RE.test(ascii)) return ascii
  return `profile-${Date.now().toString(36).slice(-6)}`
}

export function normalizeProfileId(raw: string): string {
  const clean = raw.trim().toLowerCase()
  if (!PROFILE_ID_RE.test(clean)) {
    throw new Error(
      `配置 ID "${raw}" 格式无效：仅允许小写字母、数字、点、下划线和短横线，且以字母或数字开头（最长 48 字符）`,
    )
  }
  return clean
}

function defaultExternalAgentsDataDir(): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(dshHome, 'external-agents')
}

function normalizeArgsMode(mode?: string): RuntimeArgsMode | undefined {
  if (mode === 'append' || mode === 'prepend' || mode === 'replace') return mode
  return undefined
}

function sanitizeEnvMap(raw?: Readonly<Record<string, string>>): Record<string, string> | undefined {
  if (!raw) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim()
    if (!key) continue
    out[key] = String(v ?? '')
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeArgs(raw?: readonly string[]): string[] | undefined {
  if (!raw) return undefined
  const out = raw.map((a) => String(a)).filter((a) => a.length > 0)
  return out.length > 0 ? out : undefined
}

function readTomlSummary(filePath: string): {
  readonly model?: string
  readonly reasoningEffort?: string
  readonly provider?: string
} {
  try {
    const doc = parseTomlDocument(readFileSync(filePath, 'utf8'))
    const model = typeof doc.model === 'string' && doc.model.trim() ? doc.model.trim() : undefined
    const reasoningEffort =
      typeof doc.model_reasoning_effort === 'string' && doc.model_reasoning_effort.trim()
        ? doc.model_reasoning_effort.trim()
        : undefined
    const provider =
      typeof doc.model_provider === 'string' && doc.model_provider.trim()
        ? doc.model_provider.trim()
        : undefined
    return {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(provider ? { provider } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Scan local CLI profile files using documented per-CLI conventions:
 * - Codex: `[profiles.<name>]` in `$CODEX_HOME/config.toml` and `$CODEX_HOME/<name>.config.toml`
 * - TRAE: `$TRAE_HOME/<name>.traecli.toml` (default `~/.trae`)
 */
export function discoverLocalProfiles(
  spec: ExternalRuntimeSpec,
  env: NodeJS.ProcessEnv = process.env,
): ExternalRuntimeProfile[] {
  let dir = ''
  let suffix = ''
  if (spec.id === 'codex') {
    dir = expandUserPath(spec.env.CODEX_HOME || env.CODEX_HOME || '~/.codex')
    suffix = '.config.toml'
  } else if (spec.id === 'trae') {
    dir = expandUserPath(spec.env.TRAE_HOME || env.TRAE_HOME || '~/.trae')
    suffix = '.traecli.toml'
  } else {
    return []
  }

  if (!dir || !existsSync(dir)) return []
  const byId = new Map<string, ExternalRuntimeProfile>()

  // 1. Standard Codex `[profiles.<name>]` sections in `$CODEX_HOME/config.toml`
  if (spec.id === 'codex') {
    const mainConfig = join(dir, 'config.toml')
    if (existsSync(mainConfig)) {
      try {
        const doc = parseTomlDocument(readFileSync(mainConfig, 'utf8'))
        const profilesTable = doc.profiles
        if (profilesTable && typeof profilesTable === 'object' && !Array.isArray(profilesTable)) {
          for (const [profileName, rawSection] of Object.entries(profilesTable)) {
            const id = profileName.trim().toLowerCase()
            if (!id || !PROFILE_ID_RE.test(id)) continue
            if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) continue
            const sec = rawSection as Record<string, unknown>
            const model = typeof sec.model === 'string' && sec.model.trim() ? sec.model.trim() : undefined
            const reasoningEffort =
              typeof sec.model_reasoning_effort === 'string' && sec.model_reasoning_effort.trim()
                ? sec.model_reasoning_effort.trim()
                : undefined
            const provider =
              typeof sec.model_provider === 'string' && sec.model_provider.trim()
                ? sec.model_provider.trim()
                : undefined
            const descParts = [
              provider ? `provider: ${provider}` : '',
              model ? `model: ${model}` : '',
            ].filter(Boolean)
            byId.set(id, {
              id,
              runtimeId: spec.id,
              name: profileName,
              description: descParts.length > 0 ? descParts.join(' · ') : 'config.toml [profiles]',
              source: 'discovered',
              cliProfile: profileName,
              ...(model ? { defaultModel: model } : {}),
              ...(reasoningEffort ? { defaultReasoningEffort: reasoningEffort } : {}),
            })
          }
        }
      } catch {
        // Ignore malformed config.toml during discovery.
      }
    }
  }

  // 2. Standalone per-profile TOML files (`<name>.config.toml` / `<name>.traecli.toml`)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return [...byId.values()]
  }

  for (const filename of entries.sort()) {
    if (!filename.endsWith(suffix)) continue
    const profileName = filename.slice(0, -suffix.length)
    if (!profileName || profileName.includes('.bak') || !PROFILE_ID_RE.test(profileName.toLowerCase())) {
      continue
    }
    const fullPath = join(dir, filename)
    try {
      if (!statSync(fullPath).isFile()) continue
    } catch {
      continue
    }
    const meta = readTomlSummary(fullPath)
    const descParts = [
      meta.provider ? `provider: ${meta.provider}` : '',
      meta.model ? `model: ${meta.model}` : '',
    ].filter(Boolean)
    const id = profileName.toLowerCase()
    byId.set(id, {
      id,
      runtimeId: spec.id,
      name: profileName,
      description: descParts.length > 0 ? descParts.join(' · ') : filename,
      source: 'discovered',
      cliProfile: profileName,
      configFile: fullPath,
      ...(meta.model ? { defaultModel: meta.model } : {}),
      ...(meta.reasoningEffort ? { defaultReasoningEffort: meta.reasoningEffort } : {}),
    })
  }
  return [...byId.values()]
}

export function toPublicProfileView(
  profile: ExternalRuntimeProfile,
  options: { readonly hasUserOverride?: boolean } = {},
): ExternalRuntimeProfilePublicView {
  const publicEnv: Record<string, string> = {}
  const secretEnvKeys: string[] = []
  for (const [key, val] of Object.entries(profile.env ?? {})) {
    if (isSecretEnvKey(key)) {
      secretEnvKeys.push(key)
      publicEnv[key] = ''
    } else {
      publicEnv[key] = val
    }
  }
  const exposed = profile.exposeAsPreset === true
  return {
    id: profile.id,
    runtimeId: profile.runtimeId,
    name: profile.name,
    ...(profile.description ? { description: profile.description } : {}),
    source: profile.source,
    ...(options.hasUserOverride ? { hasUserOverride: true } : {}),
    ...(profile.cliProfile ? { cliProfile: profile.cliProfile } : {}),
    ...(profile.configFile ? { configFile: profile.configFile } : {}),
    ...(Object.keys(publicEnv).length > 0 ? { env: publicEnv } : {}),
    secretEnvKeys,
    ...(profile.args && profile.args.length > 0 ? { args: [...profile.args] } : {}),
    ...(profile.argsMode ? { argsMode: profile.argsMode } : {}),
    ...(profile.authMethodId ? { authMethodId: profile.authMethodId } : {}),
    ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
    ...(profile.defaultReasoningEffort ? { defaultReasoningEffort: profile.defaultReasoningEffort } : {}),
    ...(exposed
      ? {
          exposeAsPreset: true,
          presetId: profilePresetId(profile.runtimeId, profile.id),
          providerId: profileProviderId(profile.runtimeId, profile.id),
        }
      : { exposeAsPreset: false }),
  }
}

function normalizeStaticConfigProfile(
  runtimeId: string,
  raw: ExternalRuntimeProfileConfig,
): ExternalRuntimeProfile {
  const id = normalizeProfileId(raw.id)
  const env = sanitizeEnvMap(raw.env)
  const args = sanitizeArgs(raw.args)
  const argsMode = normalizeArgsMode(raw.argsMode)
  return {
    id,
    runtimeId,
    name: raw.name?.trim() || id,
    ...(raw.description?.trim() ? { description: raw.description.trim() } : {}),
    source: 'config',
    ...(raw.cliProfile?.trim() ? { cliProfile: raw.cliProfile.trim() } : {}),
    ...(raw.configFile?.trim() ? { configFile: raw.configFile.trim() } : {}),
    ...(env ? { env } : {}),
    ...(args ? { args } : {}),
    ...(argsMode ? { argsMode } : {}),
    ...(raw.authMethodId?.trim() ? { authMethodId: raw.authMethodId.trim() } : {}),
    ...(raw.defaultModel?.trim() ? { defaultModel: raw.defaultModel.trim() } : {}),
    ...(raw.defaultReasoningEffort?.trim()
      ? { defaultReasoningEffort: raw.defaultReasoningEffort.trim() }
      : {}),
    ...(raw.exposeAsPreset === true ? { exposeAsPreset: true } : {}),
  }
}

function profileCompositeKey(runtimeId: string, profileId: string): string {
  return `${runtimeId}:${profileId}`
}

const DEFAULT_DISCOVERY_CACHE_TTL_MS = 5_000

export interface RuntimeProfileStoreOptions {
  readonly dataDir?: string
  readonly specs: readonly ExternalRuntimeSpec[]
  readonly enableDiscovery?: boolean
  readonly discoveryCacheTtlMs?: number
  readonly processEnv?: NodeJS.ProcessEnv
}

/**
 * Manages runtime launch profiles across three layers:
 * 1) Local CLI auto-discovery (read-only, short-TTL cached)
 * 2) `cordis.patch.yml` declarative entries (read-only)
 * 3) User-managed persisted profiles in `<dataDir>/profiles.json` (`0600`)
 */
export class RuntimeProfileStore {
  private readonly dataDir: string
  private readonly filePath: string
  private readonly specsById = new Map<string, ExternalRuntimeSpec>()
  private readonly configProfiles = new Map<string, ExternalRuntimeProfile>()
  private readonly userProfiles = new Map<string, ExternalRuntimeProfile>()
  private readonly discoveryCache = new Map<
    string,
    { readonly expiresAtMs: number; readonly profiles: readonly ExternalRuntimeProfile[] }
  >()
  private readonly enableDiscovery: boolean
  private readonly discoveryCacheTtlMs: number
  private readonly processEnv: NodeJS.ProcessEnv

  constructor(options: RuntimeProfileStoreOptions) {
    this.dataDir = options.dataDir?.trim() || defaultExternalAgentsDataDir()
    this.filePath = join(this.dataDir, 'profiles.json')
    this.enableDiscovery = options.enableDiscovery !== false
    this.discoveryCacheTtlMs =
      typeof options.discoveryCacheTtlMs === 'number' && options.discoveryCacheTtlMs >= 0
        ? options.discoveryCacheTtlMs
        : DEFAULT_DISCOVERY_CACHE_TTL_MS
    this.processEnv = options.processEnv ?? process.env

    for (const spec of options.specs) {
      if (!spec.enabled) continue
      this.specsById.set(spec.id, spec)
      for (const entry of spec.profiles ?? []) {
        const normalized = normalizeStaticConfigProfile(spec.id, entry)
        this.configProfiles.set(profileCompositeKey(spec.id, normalized.id), normalized)
      }
    }

    this.loadUserProfiles()
  }

  list(runtimeId?: string): ExternalRuntimeProfile[] {
    const merged = this.buildMergedMap(runtimeId)
    return [...merged.values()]
  }

  listPublic(runtimeId?: string): ExternalRuntimeProfilePublicView[] {
    const merged = this.buildMergedMap(runtimeId)
    return [...merged.entries()].map(([key, profile]) =>
      toPublicProfileView(profile, { hasUserOverride: this.userProfiles.has(key) }),
    )
  }

  get(runtimeId: string, profileId: string): ExternalRuntimeProfile | undefined {
    const cleanRuntime = runtimeId.trim()
    const cleanProfile = profileId.trim()
    if (!cleanRuntime || !cleanProfile) return undefined
    const merged = this.buildMergedMap(cleanRuntime)
    return merged.get(profileCompositeKey(cleanRuntime, cleanProfile))
  }

  getPublic(runtimeId: string, profileId: string): ExternalRuntimeProfilePublicView | undefined {
    const profile = this.get(runtimeId, profileId)
    if (!profile) return undefined
    const key = profileCompositeKey(profile.runtimeId, profile.id)
    return toPublicProfileView(profile, { hasUserOverride: this.userProfiles.has(key) })
  }

  upsert(input: ExternalRuntimeProfileInput): ExternalRuntimeProfile {
    const runtimeId = input.runtimeId.trim()
    if (!this.specsById.has(runtimeId)) {
      throw new Error(`未找到已启用的外部运行时 "${runtimeId}"`)
    }
    const name = input.name.trim()
    if (!name) {
      throw new Error('启动配置名称不能为空')
    }
    const id = input.id?.trim() ? normalizeProfileId(input.id) : slugifyProfileId(name)
    const key = profileCompositeKey(runtimeId, id)
    const existing = this.get(runtimeId, id)

    const configFile = input.configFile?.trim() || undefined
    if (configFile) {
      const expanded = expandUserPath(configFile)
      if (!existsSync(expanded) || !statSync(expanded).isFile()) {
        throw new Error(`配置文件不存在或不是常规文件：${configFile}`)
      }
    }

    const removedKeys = new Set((input.removeEnvKeys ?? []).map((k) => k.trim()).filter(Boolean))
    const mergedEnv: Record<string, string> = {}
    if (input.env !== undefined) {
      for (const [rawKey, rawVal] of Object.entries(input.env)) {
        const envKey = rawKey.trim()
        if (!envKey || removedKeys.has(envKey)) continue
        const val = String(rawVal ?? '')
        if (!val && isSecretEnvKey(envKey) && existing?.env?.[envKey]) {
          mergedEnv[envKey] = existing.env[envKey]!
        } else {
          mergedEnv[envKey] = val
        }
      }
    } else if (existing?.env) {
      for (const [envKey, val] of Object.entries(existing.env)) {
        if (!removedKeys.has(envKey)) mergedEnv[envKey] = val
      }
    }

    const args = sanitizeArgs(input.args)
    const argsMode = normalizeArgsMode(input.argsMode)
    const cliProfile = input.cliProfile?.trim() || undefined
    const authMethodId = input.authMethodId?.trim() || undefined
    const defaultModel = input.defaultModel?.trim() || undefined
    const defaultReasoningEffort = input.defaultReasoningEffort?.trim() || undefined
    const description = input.description?.trim() || undefined

    const saved: ExternalRuntimeProfile = {
      id,
      runtimeId,
      name,
      ...(description ? { description } : {}),
      source: 'user',
      ...(cliProfile ? { cliProfile } : {}),
      ...(configFile ? { configFile } : {}),
      ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
      ...(args ? { args } : {}),
      ...(argsMode ? { argsMode } : {}),
      ...(authMethodId ? { authMethodId } : {}),
      ...(defaultModel ? { defaultModel } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(input.exposeAsPreset === true ? { exposeAsPreset: true } : {}),
    }

    this.userProfiles.set(key, saved)
    this.discoveryCache.delete(runtimeId)
    this.persistUserProfiles()
    return saved
  }

  delete(runtimeId: string, profileId: string): boolean {
    const cleanRuntime = runtimeId.trim()
    const key = profileCompositeKey(cleanRuntime, profileId.trim())
    const existed = this.userProfiles.delete(key)
    if (existed) {
      this.discoveryCache.delete(cleanRuntime)
      this.persistUserProfiles()
    }
    return existed
  }

  invalidateDiscoveryCache(runtimeId?: string): void {
    if (runtimeId?.trim()) {
      this.discoveryCache.delete(runtimeId.trim())
    } else {
      this.discoveryCache.clear()
    }
  }

  private getDiscoveredProfiles(spec: ExternalRuntimeSpec): readonly ExternalRuntimeProfile[] {
    if (this.discoveryCacheTtlMs <= 0) {
      return discoverLocalProfiles(spec, this.processEnv)
    }
    const now = Date.now()
    const cached = this.discoveryCache.get(spec.id)
    if (cached && now < cached.expiresAtMs) {
      return cached.profiles
    }
    const profiles = discoverLocalProfiles(spec, this.processEnv)
    this.discoveryCache.set(spec.id, {
      expiresAtMs: now + this.discoveryCacheTtlMs,
      profiles,
    })
    return profiles
  }

  private buildMergedMap(filterRuntimeId?: string): Map<string, ExternalRuntimeProfile> {
    const merged = new Map<string, ExternalRuntimeProfile>()
    const targetSpecs = filterRuntimeId
      ? [this.specsById.get(filterRuntimeId)].filter((s): s is ExternalRuntimeSpec => Boolean(s))
      : [...this.specsById.values()]

    if (this.enableDiscovery) {
      for (const spec of targetSpecs) {
        for (const disc of this.getDiscoveredProfiles(spec)) {
          merged.set(profileCompositeKey(disc.runtimeId, disc.id), disc)
        }
      }
    }

    for (const [key, cfg] of this.configProfiles) {
      if (filterRuntimeId && cfg.runtimeId !== filterRuntimeId) continue
      const base = merged.get(key)
      merged.set(key, base ? mergeProfileLayers(base, cfg) : cfg)
    }

    for (const [key, usr] of this.userProfiles) {
      if (filterRuntimeId && usr.runtimeId !== filterRuntimeId) continue
      if (!this.specsById.has(usr.runtimeId)) continue
      const base = merged.get(key)
      merged.set(key, base ? mergeProfileLayers(base, usr) : usr)
    }

    return merged
  }

  private loadUserProfiles(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedProfilesFileV1>
      if (!Array.isArray(raw.profiles)) return
      for (const item of raw.profiles) {
        if (!item || typeof item !== 'object') continue
        const runtimeId = typeof item.runtimeId === 'string' ? item.runtimeId.trim() : ''
        const id = typeof item.id === 'string' ? item.id.trim().toLowerCase() : ''
        const name = typeof item.name === 'string' ? item.name.trim() : id
        if (!runtimeId || !id || !PROFILE_ID_RE.test(id)) continue
        const env = sanitizeEnvMap(item.env)
        const args = sanitizeArgs(item.args)
        const argsMode = normalizeArgsMode(item.argsMode)
        this.userProfiles.set(profileCompositeKey(runtimeId, id), {
          id,
          runtimeId,
          name: name || id,
          ...(typeof item.description === 'string' && item.description.trim()
            ? { description: item.description.trim() }
            : {}),
          source: 'user',
          ...(typeof item.cliProfile === 'string' && item.cliProfile.trim()
            ? { cliProfile: item.cliProfile.trim() }
            : {}),
          ...(typeof item.configFile === 'string' && item.configFile.trim()
            ? { configFile: item.configFile.trim() }
            : {}),
          ...(env ? { env } : {}),
          ...(args ? { args } : {}),
          ...(argsMode ? { argsMode } : {}),
          ...(typeof item.authMethodId === 'string' && item.authMethodId.trim()
            ? { authMethodId: item.authMethodId.trim() }
            : {}),
          ...(typeof item.defaultModel === 'string' && item.defaultModel.trim()
            ? { defaultModel: item.defaultModel.trim() }
            : {}),
          ...(typeof item.defaultReasoningEffort === 'string' && item.defaultReasoningEffort.trim()
            ? { defaultReasoningEffort: item.defaultReasoningEffort.trim() }
            : {}),
          ...(item.exposeAsPreset === true ? { exposeAsPreset: true } : {}),
        })
      }
    } catch {
      // Ignore malformed profile cache rather than blocking host startup.
    }
  }

  private persistUserProfiles(): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const payload: PersistedProfilesFileV1 = {
      version: 1,
      profiles: [...this.userProfiles.values()],
    }
    const tmpPath = `${this.filePath}.tmp`
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(tmpPath, 0o600)
    } catch {
      // Best-effort on Windows.
    }
    renameSync(tmpPath, this.filePath)
  }
}

function mergeProfileLayers(
  base: ExternalRuntimeProfile,
  override: ExternalRuntimeProfile,
): ExternalRuntimeProfile {
  const mergedEnv =
    base.env || override.env ? { ...(base.env ?? {}), ...(override.env ?? {}) } : undefined
  return {
    ...base,
    ...override,
    ...(mergedEnv && Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
  }
}
