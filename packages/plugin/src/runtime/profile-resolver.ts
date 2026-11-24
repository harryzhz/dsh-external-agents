import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CatalogModelEntry } from '../catalog-adapter.js'
import type {
  ExternalRuntimeAuthMethod,
  ExternalRuntimeProfile,
  ExternalRuntimeProfileCapabilities,
  RuntimeArgsMode,
} from '../types.js'
import { buildRuntimeEnv, resolveRuntimeCommand, type ExternalRuntimeSpec } from './config.js'
import { expandUserPath } from './profile-store.js'
import { flattenTomlToCodexConfigArgs, parseTomlDocument } from './toml-subset.js'

const PATH_LIKE_ENV_KEYS = new Set(['CODEX_HOME', 'TRAE_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'])

const AGY_DEFAULT_AUTH_METHODS: readonly ExternalRuntimeAuthMethod[] = [
  { id: 'oauth-personal', name: 'Google 个人账号', description: '使用本机已登录的个人 Google 账号' },
  { id: 'oauth-business', name: 'Gemini Enterprise', description: '使用 Gemini Enterprise 企业账号' },
  { id: 'gemini-api-key', name: 'Gemini API Key', description: '使用 GEMINI_API_KEY 与 GOOGLE_GEMINI_BASE_URL' },
  { id: 'agent-platform', name: 'Agent Platform (ADC)', description: '使用 Vertex AI / ADC 凭据' },
]

export interface ResolvedProfileDefaults {
  readonly defaultModel?: string
  readonly defaultReasoningEffort?: string
}

export interface ResolvedRuntimeLaunchPlan extends ResolvedProfileDefaults {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly authMethodId?: string
  readonly sessionMeta?: Readonly<Record<string, unknown>>
}

export function resolveProfileCapabilities(
  spec: ExternalRuntimeSpec,
  liveAuthMethods?: readonly ExternalRuntimeAuthMethod[],
): ExternalRuntimeProfileCapabilities {
  if (spec.id === 'codex') {
    return {
      supportsCliProfile: true,
      cliProfileHint: '例如 personal（对应 ~/.codex/<name>.config.toml 或 config.toml 中的 [profiles.<name>]）',
      supportsConfigFile: true,
      configFileHint: '~/.codex/personal.config.toml',
      supportsEnv: true,
      envHints: ['CODEX_HOME', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
      supportsArgs: true,
      supportsAuthMethod: false,
      supportsExposeAsPreset: true,
    }
  }
  if (spec.id === 'trae') {
    return {
      supportsCliProfile: true,
      cliProfileHint: '例如 work（对应 ~/.trae/<name>.traecli.toml）',
      supportsConfigFile: true,
      configFileHint: '~/.trae/work.traecli.toml',
      supportsEnv: true,
      envHints: ['TRAE_HOME'],
      supportsArgs: true,
      supportsAuthMethod: false,
      supportsExposeAsPreset: true,
    }
  }
  if (spec.id === 'agy') {
    return {
      supportsCliProfile: false,
      supportsConfigFile: true,
      configFileHint: '~/.config/proxy/agy/settings.json',
      supportsEnv: true,
      envHints: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
      supportsArgs: true,
      supportsAuthMethod: true,
      authMethods: liveAuthMethods && liveAuthMethods.length > 0 ? liveAuthMethods : AGY_DEFAULT_AUTH_METHODS,
      supportsExposeAsPreset: true,
    }
  }
  if (spec.id === 'claude-code') {
    return {
      supportsCliProfile: false,
      supportsConfigFile: true,
      configFileHint: '~/.claude/custom.settings.json',
      supportsEnv: true,
      envHints: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
      supportsArgs: true,
      supportsAuthMethod: false,
      supportsExposeAsPreset: true,
    }
  }
  if (spec.kind === 'codex-app-server') {
    return {
      supportsCliProfile: true,
      supportsConfigFile: true,
      supportsEnv: true,
      envHints: [],
      supportsArgs: true,
      supportsAuthMethod: false,
      supportsExposeAsPreset: true,
    }
  }
  return {
    supportsCliProfile: false,
    supportsConfigFile: false,
    supportsEnv: true,
    envHints: [],
    supportsArgs: true,
    supportsAuthMethod: Boolean(liveAuthMethods && liveAuthMethods.length > 0),
    ...(liveAuthMethods && liveAuthMethods.length > 0 ? { authMethods: liveAuthMethods } : {}),
    supportsExposeAsPreset: true,
  }
}

function expandProfileEnv(raw?: Readonly<Record<string, string>>): Record<string, string> {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(raw)) {
    const cleanKey = key.trim()
    if (!cleanKey) continue
    out[cleanKey] =
      PATH_LIKE_ENV_KEYS.has(cleanKey) && (val === '~' || val.startsWith('~/') || val.startsWith('~\\'))
        ? expandUserPath(val)
        : val
  }
  return out
}

function mergeExtraArgs(
  baseArgs: readonly string[],
  extraArgs?: readonly string[],
  argsMode: RuntimeArgsMode = 'append',
): string[] {
  if (!extraArgs || extraArgs.length === 0) return [...baseArgs]
  if (argsMode === 'replace') return [...extraArgs]
  if (argsMode === 'prepend') return [...extraArgs, ...baseArgs]
  return [...baseArgs, ...extraArgs]
}

/**
 * Parse human-readable or slug model labels from Antigravity `settings.json`,
 * e.g. `"Gemini 4 Carbon (Medium)"` -> `{ model: 'gemini-4-carbon', effort: 'medium' }`.
 */
export function parseAgySettingsModel(
  rawModel: string,
): { readonly model: string; readonly effort?: string } | undefined {
  const trimmed = rawModel.trim()
  if (!trimmed) return undefined
  const parenMatch = /^(.+?)\s*\((low|medium|high|xhigh|max|ultra)\)\s*$/i.exec(trimmed)
  if (parenMatch) {
    const slug = parenMatch[1]!.trim().toLowerCase().replace(/\s+/g, '-')
    return { model: slug, effort: parenMatch[2]!.toLowerCase() }
  }
  const slugMatch = /^([a-z0-9][a-z0-9._-]*)-(low|medium|high|xhigh|max|ultra)$/i.exec(trimmed)
  if (slugMatch) {
    return { model: slugMatch[1]!.toLowerCase(), effort: slugMatch[2]!.toLowerCase() }
  }
  return { model: trimmed.toLowerCase().replace(/\s+/g, '-') }
}

interface AgySettingsMeta {
  readonly modelProvider?: string
  readonly model?: string
  readonly effort?: string
  readonly hasGcpConfig?: boolean
}

function defaultAgySettingsPath(env: NodeJS.ProcessEnv): string {
  const userHome = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()
  return join(userHome, '.gemini', 'antigravity-cli', 'settings.json')
}

function readAgySettingsFile(filePath: string): AgySettingsMeta {
  if (!existsSync(filePath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    const modelProvider =
      typeof parsed.modelProvider === 'string' && parsed.modelProvider.trim()
        ? parsed.modelProvider.trim().toLowerCase()
        : undefined
    const modelParsed = typeof parsed.model === 'string' ? parseAgySettingsModel(parsed.model) : undefined
    const gcp =
      parsed.gcp && typeof parsed.gcp === 'object' && !Array.isArray(parsed.gcp)
        ? (parsed.gcp as Record<string, unknown>)
        : undefined
    const hasGcpConfig = Boolean(
      typeof gcp?.project === 'string' &&
        gcp.project.trim() &&
        typeof gcp?.location === 'string' &&
        gcp.location.trim(),
    )
    return {
      ...(modelProvider ? { modelProvider } : {}),
      ...(modelParsed?.model ? { model: modelParsed.model } : {}),
      ...(modelParsed?.effort ? { effort: modelParsed.effort } : {}),
      ...(hasGcpConfig ? { hasGcpConfig: true } : {}),
    }
  } catch {
    return {}
  }
}

function inferAgyAuthMethodId(
  env: NodeJS.ProcessEnv,
  settingsMeta?: AgySettingsMeta,
  explicitAuthMethodId?: string,
): string | undefined {
  const explicit = explicitAuthMethodId?.trim()
  if (explicit) return explicit
  if (settingsMeta?.modelProvider === 'gemini') return 'gemini-api-key'
  if (
    settingsMeta?.modelProvider === 'vertex' ||
    settingsMeta?.modelProvider === 'agent-platform' ||
    settingsMeta?.hasGcpConfig
  ) {
    return 'agent-platform'
  }
  if (env.GEMINI_API_KEY?.trim()) return 'gemini-api-key'
  if (env.GOOGLE_CLOUD_PROJECT?.trim() && env.GOOGLE_CLOUD_LOCATION?.trim()) {
    return 'agent-platform'
  }
  return undefined
}

function readClaudeSettingsFile(
  rawPath: string,
  strict: boolean,
): Record<string, unknown> | undefined {
  const expanded = expandUserPath(rawPath)
  if (!existsSync(expanded)) {
    if (strict) {
      throw new Error(`配置文件不存在：${rawPath}`)
    }
    return undefined
  }
  try {
    const parsed = JSON.parse(readFileSync(expanded, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (strict) {
        throw new Error(`配置文件格式无效（需为 JSON 对象）：${rawPath}`)
      }
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (strict) throw err
    return undefined
  }
}

function normalizeClaudeSettingsEnv(
  rawEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { ...rawEnv }
  const hasApiKey = Boolean(out.ANTHROPIC_API_KEY?.trim())
  const hasAuthToken = Boolean(out.ANTHROPIC_AUTH_TOKEN?.trim())
  const isTruthy = (val?: string): boolean => val === '1' || val?.toLowerCase() === 'true'
  const useBedrock = isTruthy(out.CLAUDE_CODE_USE_BEDROCK)
  const useVertex = isTruthy(out.CLAUDE_CODE_USE_VERTEX)
  const hasBaseUrl = Boolean(out.ANTHROPIC_BASE_URL?.trim())

  if (hasApiKey && !Object.prototype.hasOwnProperty.call(out, 'ANTHROPIC_AUTH_TOKEN')) {
    out.ANTHROPIC_AUTH_TOKEN = ''
  }
  if (hasAuthToken && !Object.prototype.hasOwnProperty.call(out, 'ANTHROPIC_API_KEY')) {
    out.ANTHROPIC_API_KEY = ''
  }
  if (hasBaseUrl && !useBedrock && !useVertex) {
    if (!Object.prototype.hasOwnProperty.call(out, 'CLAUDE_CODE_USE_BEDROCK')) {
      out.CLAUDE_CODE_USE_BEDROCK = '0'
    }
    if (!Object.prototype.hasOwnProperty.call(out, 'CLAUDE_CODE_USE_VERTEX')) {
      out.CLAUDE_CODE_USE_VERTEX = '0'
    }
  } else if (useBedrock) {
    if (!Object.prototype.hasOwnProperty.call(out, 'CLAUDE_CODE_USE_VERTEX')) {
      out.CLAUDE_CODE_USE_VERTEX = '0'
    }
    if (!Object.prototype.hasOwnProperty.call(out, 'ANTHROPIC_BASE_URL')) out.ANTHROPIC_BASE_URL = ''
    if (!Object.prototype.hasOwnProperty.call(out, 'ANTHROPIC_API_KEY')) out.ANTHROPIC_API_KEY = ''
    if (!Object.prototype.hasOwnProperty.call(out, 'ANTHROPIC_AUTH_TOKEN')) out.ANTHROPIC_AUTH_TOKEN = ''
  } else if (useVertex) {
    if (!Object.prototype.hasOwnProperty.call(out, 'CLAUDE_CODE_USE_BEDROCK')) {
      out.CLAUDE_CODE_USE_BEDROCK = '0'
    }
    if (!Object.prototype.hasOwnProperty.call(out, 'ANTHROPIC_BASE_URL')) out.ANTHROPIC_BASE_URL = ''
    if (!Object.prototype.hasOwnProperty.call(out, 'ANTHROPIC_API_KEY')) out.ANTHROPIC_API_KEY = ''
    if (!Object.prototype.hasOwnProperty.call(out, 'ANTHROPIC_AUTH_TOKEN')) out.ANTHROPIC_AUTH_TOKEN = ''
  }
  return out
}

function buildClaudeSessionSettings(
  profile: ExternalRuntimeProfile,
  strict: boolean,
): {
  readonly settings?: Record<string, unknown>
  readonly defaults: ResolvedProfileDefaults
} {
  const fileSettings = profile.configFile ? readClaudeSettingsFile(profile.configFile, strict) : undefined
  const profileEnv = expandProfileEnv(profile.env)
  const runtimeEnvEntries = Object.entries(profileEnv).filter(([key]) => key !== 'CLAUDE_CONFIG_DIR')

  if (!fileSettings && runtimeEnvEntries.length === 0) {
    return { defaults: {} }
  }

  const baseSettings: Record<string, unknown> = fileSettings ? { ...fileSettings } : {}
  const existingEnv: Record<string, string> = {}
  if (baseSettings.env && typeof baseSettings.env === 'object' && !Array.isArray(baseSettings.env)) {
    for (const [k, v] of Object.entries(baseSettings.env as Record<string, unknown>)) {
      if (typeof v === 'string') existingEnv[k] = v
    }
  }
  const combinedRawEnv: Record<string, string> = {
    ...existingEnv,
    ...Object.fromEntries(runtimeEnvEntries),
  }
  if (Object.keys(combinedRawEnv).length > 0) {
    baseSettings.env = normalizeClaudeSettingsEnv(combinedRawEnv)
  }

  const envObj = baseSettings.env as Record<string, string> | undefined
  const defaultModel =
    (typeof baseSettings.model === 'string' && baseSettings.model.trim()
      ? baseSettings.model.trim()
      : undefined) ??
    (typeof envObj?.ANTHROPIC_MODEL === 'string' && envObj.ANTHROPIC_MODEL.trim()
      ? envObj.ANTHROPIC_MODEL.trim()
      : undefined)
  const defaultReasoningEffort =
    typeof baseSettings.effortLevel === 'string' && baseSettings.effortLevel.trim()
      ? baseSettings.effortLevel.trim()
      : undefined

  return {
    settings: baseSettings,
    defaults: {
      ...(defaultModel ? { defaultModel } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    },
  }
}

function readCodexProfileToml(
  spec: ExternalRuntimeSpec,
  profile: ExternalRuntimeProfile,
  env: NodeJS.ProcessEnv,
  strict: boolean,
): Record<string, unknown> | undefined {
  const isTrae = spec.id === 'trae'
  const explicitConfigPath = profile.configFile ? expandUserPath(profile.configFile) : undefined
  if (explicitConfigPath) {
    if (!existsSync(explicitConfigPath)) {
      if (strict) {
        throw new Error(`配置文件不存在：${profile.configFile || explicitConfigPath}`)
      }
      return undefined
    }
    try {
      return parseTomlDocument(readFileSync(explicitConfigPath, 'utf8'))
    } catch (err) {
      if (strict) throw err
      return undefined
    }
  }
  if (!profile.cliProfile) return undefined

  const homeDir = isTrae
    ? expandUserPath(env.TRAE_HOME || '~/.trae')
    : expandUserPath(env.CODEX_HOME || '~/.codex')
  const ext = isTrae ? '.traecli.toml' : '.config.toml'
  const standalonePath = join(homeDir, `${profile.cliProfile}${ext}`)
  if (existsSync(standalonePath)) {
    try {
      return parseTomlDocument(readFileSync(standalonePath, 'utf8'))
    } catch (err) {
      if (strict) throw err
      return undefined
    }
  }
  if (!isTrae) {
    const mainConfigPath = join(homeDir, 'config.toml')
    if (existsSync(mainConfigPath)) {
      try {
        const mainDoc = parseTomlDocument(readFileSync(mainConfigPath, 'utf8'))
        const profilesTable = mainDoc.profiles
        if (profilesTable && typeof profilesTable === 'object' && !Array.isArray(profilesTable)) {
          const section = (profilesTable as Record<string, unknown>)[profile.cliProfile]
          if (section && typeof section === 'object' && !Array.isArray(section)) {
            return section as Record<string, unknown>
          }
        }
      } catch (err) {
        if (strict) throw err
        return undefined
      }
    }
  }
  if (strict) {
    throw new Error(
      `未找到配置 "${profile.cliProfile}"（已检查 ${standalonePath}${!isTrae ? ' 及 config.toml [profiles.*]' : ''}）`,
    )
  }
  return undefined
}

function readTomlModelDefaults(doc: Record<string, unknown> | undefined): ResolvedProfileDefaults {
  if (!doc) return {}
  const defaultModel = typeof doc.model === 'string' && doc.model.trim() ? doc.model.trim() : undefined
  const defaultReasoningEffort =
    typeof doc.model_reasoning_effort === 'string' && doc.model_reasoning_effort.trim()
      ? doc.model_reasoning_effort.trim()
      : undefined
  return {
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  }
}

/**
 * Best-effort default model & reasoning effort for a launch profile, combining explicit
 * profile fields with values inferred from the referenced CLI config file (never throws).
 */
export function resolveProfileDefaults(
  spec: ExternalRuntimeSpec,
  profile?: ExternalRuntimeProfile,
  extraEnv?: Readonly<Record<string, string>>,
): ResolvedProfileDefaults {
  if (!profile) return {}
  let inferredModel: string | undefined
  let inferredEffort: string | undefined

  if (!profile.defaultModel || !profile.defaultReasoningEffort) {
    if (spec.kind === 'codex-app-server') {
      const profileEnv = expandProfileEnv(profile.env)
      const env = buildRuntimeEnv(spec, { ...profileEnv, ...(extraEnv ?? {}) })
      const doc = readCodexProfileToml(spec, profile, env, false)
      const parsed = readTomlModelDefaults(doc)
      inferredModel = parsed.defaultModel
      inferredEffort = parsed.defaultReasoningEffort
    } else if (spec.id === 'agy' && profile.configFile) {
      const settingsMeta = readAgySettingsFile(expandUserPath(profile.configFile))
      inferredModel = settingsMeta.model
      inferredEffort = settingsMeta.effort
    } else if (spec.id === 'claude-code') {
      const { defaults } = buildClaudeSessionSettings(profile, false)
      inferredModel = defaults.defaultModel
      inferredEffort = defaults.defaultReasoningEffort
    }
  }

  const defaultModel = profile.defaultModel?.trim() || inferredModel
  const defaultReasoningEffort = profile.defaultReasoningEffort?.trim() || inferredEffort
  return {
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  }
}

export interface RuntimeModelSelectionInput {
  readonly provider: string
  readonly runtimeDefaultModel: string
  readonly runtimeDefaultReasoningEffort?: string
  readonly hasProfile: boolean
  readonly profileDefaults?: ResolvedProfileDefaults
  readonly matched?: { readonly model?: string; readonly reasoningEffort?: string }
  readonly catalog?: readonly CatalogModelEntry[]
}

/**
 * Single source of truth for resolving an external runtime's effective `(provider, model, reasoningEffort)`.
 * When a launch profile is active, profile-level defaults and the profile's own catalog `isDefault`
 * take precedence over the parent runtime's static `defaultModel`.
 */
export function resolveRuntimeModelSelection(
  input: RuntimeModelSelectionInput,
): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined {
  const { provider, hasProfile, profileDefaults, matched, catalog } = input
  const baseDefault = input.runtimeDefaultModel.trim()
  const profileModel = profileDefaults?.defaultModel?.trim() || undefined
  const profileEffort = profileDefaults?.defaultReasoningEffort?.trim() || undefined
  const hasCatalog = Boolean(catalog && catalog.length > 0)
  const catalogHas = (id: string | undefined): id is string =>
    Boolean(id && (!hasCatalog || catalog!.some((m) => m.id === id)))

  let model = matched?.model?.trim() || undefined
  if (!model) {
    if (hasProfile) {
      if (catalogHas(profileModel)) {
        model = profileModel
      } else {
        model =
          catalog?.find((m) => m.isDefault)?.id ??
          (catalogHas(baseDefault) ? baseDefault : undefined) ??
          catalog?.[0]?.id ??
          profileModel ??
          baseDefault
      }
    } else if (catalogHas(baseDefault)) {
      model = baseDefault
    } else {
      model = catalog?.find((m) => m.isDefault)?.id ?? catalog?.[0]?.id ?? baseDefault
    }
  }
  if (!model) return undefined

  const entry = catalog?.find((m) => m.id === model)
  const applyProfileEffort = !matched?.model || !profileModel || model === profileModel
  let reasoningEffort =
    matched?.reasoningEffort ??
    (applyProfileEffort ? profileEffort : undefined) ??
    entry?.defaultEffort ??
    (!hasProfile && (!model || model === baseDefault)
      ? input.runtimeDefaultReasoningEffort
      : undefined)
  if (entry?.reasoningEfforts !== undefined) {
    if (entry.reasoningEfforts.length === 0) {
      reasoningEffort = undefined
    } else if (reasoningEffort && !entry.reasoningEfforts.includes(reasoningEffort)) {
      reasoningEffort = entry.defaultEffort
    }
  }
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

function resolveCodexAppServerPlan(
  spec: ExternalRuntimeSpec,
  profile: ExternalRuntimeProfile,
  env: NodeJS.ProcessEnv,
): ResolvedRuntimeLaunchPlan {
  const command = resolveRuntimeCommand(spec, env)
  let args = [...spec.args]
  let inferredModel: string | undefined
  let inferredEffort: string | undefined

  const isTrae = spec.id === 'trae'
  const explicitConfigPath = profile.configFile ? expandUserPath(profile.configFile) : undefined
  const canonicalTraeProfilePath =
    isTrae && profile.cliProfile
      ? join(expandUserPath(env.TRAE_HOME || '~/.trae'), `${profile.cliProfile}.traecli.toml`)
      : undefined
  const useNativeTraeProfile = Boolean(
    isTrae &&
      profile.cliProfile &&
      (!explicitConfigPath || explicitConfigPath === canonicalTraeProfilePath),
  )

  if (useNativeTraeProfile) {
    // TRAE CLI natively accepts `-p <profile>` before `app-server` for `$TRAE_HOME/<name>.traecli.toml`.
    if (profile.argsMode !== 'replace') {
      if (!existsSync(canonicalTraeProfilePath!)) {
        throw new Error(`未找到配置 "${profile.cliProfile}"（已检查 ${canonicalTraeProfilePath}）`)
      }
      args = ['-p', profile.cliProfile!, ...args]
    }
    const parsed = readTomlModelDefaults(readCodexProfileToml(spec, profile, env, false))
    inferredModel = parsed.defaultModel
    inferredEffort = parsed.defaultReasoningEffort
  } else {
    // Codex `app-server` rejects top-level `-p/--profile`; flatten the TOML layer into `-c` flags.
    // Supports standalone `<name>.config.toml` as well as `[profiles.<name>]` in `config.toml`.
    const resolvedDoc = readCodexProfileToml(spec, profile, env, true)
    if (resolvedDoc) {
      const parsed = readTomlModelDefaults(resolvedDoc)
      inferredModel = parsed.defaultModel
      inferredEffort = parsed.defaultReasoningEffort
      if (profile.argsMode !== 'replace') {
        args = [...args, ...flattenTomlToCodexConfigArgs(resolvedDoc as never)]
      }
    }
  }

  args = mergeExtraArgs(args, profile.args, profile.argsMode ?? 'append')
  const defaultModel = profile.defaultModel || inferredModel
  const defaultReasoningEffort = profile.defaultReasoningEffort || inferredEffort

  return {
    command,
    args,
    env,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  }
}

function resolveAcpPlan(
  spec: ExternalRuntimeSpec,
  profile: ExternalRuntimeProfile,
  env: NodeJS.ProcessEnv,
): ResolvedRuntimeLaunchPlan {
  const command = resolveRuntimeCommand(spec, env)
  let args = [...spec.args]
  let authMethodId = profile.authMethodId?.trim() || undefined
  let sessionMeta: Record<string, unknown> | undefined
  let inferredModel: string | undefined
  let inferredEffort: string | undefined

  if (spec.id === 'agy') {
    let settingsMeta: AgySettingsMeta | undefined
    if (profile.configFile) {
      const expandedSettings = expandUserPath(profile.configFile)
      if (!existsSync(expandedSettings)) {
        throw new Error(`配置文件不存在：${profile.configFile}`)
      }
      // `--settings` is a top-level `agy` flag and MUST precede `acp`.
      if (profile.argsMode !== 'replace') {
        args = ['--settings', expandedSettings, ...args]
      }
      settingsMeta = readAgySettingsFile(expandedSettings)
      inferredModel = settingsMeta.model
      inferredEffort = settingsMeta.effort
    } else {
      settingsMeta = readAgySettingsFile(defaultAgySettingsPath(env))
    }
    authMethodId = inferAgyAuthMethodId(env, settingsMeta, authMethodId)
  } else if (spec.id === 'claude-code') {
    // Claude Code applies `~/.claude/settings.json`'s `env` after child process env, so
    // forward profile `configFile` / `env` via programmatic ACP session settings to override it.
    const { settings, defaults } = buildClaudeSessionSettings(profile, true)
    if (settings) {
      sessionMeta = { claudeCode: { options: { settings } } }
    }
    inferredModel = defaults.defaultModel
    inferredEffort = defaults.defaultReasoningEffort
  }

  args = mergeExtraArgs(args, profile.args, profile.argsMode ?? 'append')
  const defaultModel = profile.defaultModel || inferredModel
  const defaultReasoningEffort = profile.defaultReasoningEffort || inferredEffort

  return {
    command,
    args,
    env,
    ...(authMethodId ? { authMethodId } : {}),
    ...(sessionMeta ? { sessionMeta } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  }
}

/**
 * Translate a runtime spec + optional launch profile into exact `spawn()` arguments,
 * merged environment, and optional ACP `authenticate` method id.
 */
export function resolveRuntimeLaunchPlan(
  spec: ExternalRuntimeSpec,
  profile?: ExternalRuntimeProfile,
  extraEnv?: Readonly<Record<string, string>>,
): ResolvedRuntimeLaunchPlan {
  const profileEnv = expandProfileEnv(profile?.env)
  const env = buildRuntimeEnv(spec, { ...profileEnv, ...(extraEnv ?? {}) })

  if (!profile) {
    const authMethodId =
      spec.id === 'agy'
        ? inferAgyAuthMethodId(env, readAgySettingsFile(defaultAgySettingsPath(env)))
        : undefined
    return {
      command: resolveRuntimeCommand(spec, env),
      args: spec.args,
      env,
      ...(authMethodId ? { authMethodId } : {}),
      ...(spec.defaultModel ? { defaultModel: spec.defaultModel } : {}),
      ...(spec.defaultReasoningEffort ? { defaultReasoningEffort: spec.defaultReasoningEffort } : {}),
    }
  }

  if (spec.kind === 'codex-app-server') {
    return resolveCodexAppServerPlan(spec, profile, env)
  }
  return resolveAcpPlan(spec, profile, env)
}
