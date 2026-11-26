import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { stripSshSessionEnv } from '@dsh-external-agents/runtime-acp'
import type { CatalogModelEntry } from '../catalog-adapter.js'
import type { ExternalRuntimeConfig, ExternalRuntimeOverride } from '../types.js'

export function expandRuntimeCwd(rawCwd?: string): string {
  const trimmed = rawCwd?.trim() ?? ''
  if (!trimmed) return process.cwd()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2))
  }
  return resolve(trimmed)
}

/** Resolved runtime configuration plus code-only catalog defaults. */
export interface ExternalRuntimeSpec extends ExternalRuntimeConfig {
  readonly fallbackModels: readonly CatalogModelEntry[]
  /** Context window assumed for probed models that have no fallback entry. */
  readonly defaultContextWindow?: number
  /** Ordered executable aliases probed across PATH when the user did not override `command`. */
  readonly commandCandidates?: readonly string[]
  /**
   * Share a single multiplexed ACP child process per `(instance, runtime, profile)`
   * with isolated data directory storage (used for Antigravity `agy acp`).
   */
  readonly poolProcesses?: boolean
}

const CODEX_FALLBACK_MODELS: readonly CatalogModelEntry[] = [
  {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1-Sol',
    contextWindow: 400_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'xhigh',
  },
  {
    id: 'gpt-6.2-sol',
    name: 'GPT-6.2-Sol',
    contextWindow: 400_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
]

const AGY_FALLBACK_MODELS: readonly CatalogModelEntry[] = [
  {
    id: 'gemini-4-neon',
    name: 'Gemini 4 Neon',
    contextWindow: 1_048_576,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    contextWindow: 1_048_576,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-pro-orchestrator-neon',
    name: 'Orchestrator (Neon)',
    contextWindow: 1_048_576,
    reasoningEfforts: [],
  },
]

/** Aliases exposed by claude-agent-acp@0.109.0 through the `model` & `effort` session config options. */
const CLAUDE_CODE_FALLBACK_MODELS: readonly CatalogModelEntry[] = [
  { id: 'default', name: 'Default (recommended)', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'opus', name: 'Opus 5.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet', name: 'Sonnet 5.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'haiku', name: 'Haiku 5.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
]

/** Fallback catalog for TRAE CLI (`traecli` / `trae-cli`) before `model/list` live probe succeeds. */
const TRAE_FALLBACK_MODELS: readonly CatalogModelEntry[] = [
  {
    id: 'Doubao-Seed-2.0-Code',
    name: 'Doubao-Seed-2.0-Code',
    contextWindow: 256_000,
    reasoningEfforts: [],
  },
  {
    id: 'DeepSeek-V4-Pro',
    name: 'DeepSeek-V4-Pro',
    contextWindow: 128_000,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    contextWindow: 400_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi-K2.6',
    contextWindow: 256_000,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
]

const CODEX_ONLY_DEFAULTS = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
} as const satisfies Pick<ExternalRuntimeConfig, 'approvalPolicy' | 'sandbox'>

export const BUILTIN_RUNTIMES: readonly ExternalRuntimeSpec[] = [
  {
    id: 'codex',
    kind: 'codex-app-server',
    enabled: true,
    displayName: 'Codex',
    description: '通过 codex app-server 接入 OpenAI Codex，擅长仓库级代码工程与长程任务，支持推理强度调节与线程续接',
    providerId: 'codex-cli',
    command: 'codex',
    args: ['app-server', '--stdio'],
    env: {},
    stripSshEnv: false,
    defaultModel: 'gpt-6.1-sol',
    defaultReasoningEffort: 'xhigh',
    ...CODEX_ONLY_DEFAULTS,
    fallbackModels: CODEX_FALLBACK_MODELS,
    defaultContextWindow: 400_000,
  },
  {
    id: 'agy',
    kind: 'acp',
    enabled: true,
    displayName: 'Antigravity',
    description: '通过 ACP 协议接入 Antigravity CLI，支持多模型切换与工具协作，适合通用研发与调研',
    providerId: 'agy-cli',
    command: 'agy',
    args: ['acp', '--stdio'],
    env: {},
    stripSshEnv: true,
    defaultModel: 'gemini-4-neon',
    defaultReasoningEffort: 'high',
    ...CODEX_ONLY_DEFAULTS,
    fallbackModels: AGY_FALLBACK_MODELS,
    defaultContextWindow: 1_048_576,
    poolProcesses: true,
  },
  {
    id: 'claude-code',
    kind: 'acp',
    enabled: true,
    displayName: 'ClaudeCode',
    description: '通过 ACP 适配器接入 Anthropic Claude Code，擅长代码理解、重构与多步骤工程任务',
    providerId: 'claude-code-cli',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.109.0'],
    env: {},
    stripSshEnv: false,
    defaultModel: 'default',
    defaultReasoningEffort: '',
    ...CODEX_ONLY_DEFAULTS,
    fallbackModels: CLAUDE_CODE_FALLBACK_MODELS,
  },
  {
    id: 'trae',
    kind: 'codex-app-server',
    enabled: true,
    displayName: 'Trae',
    description: '通过 traecli app-server 接入 TRAE CLI，支持多模型切换、推理强度调节与工程协作',
    providerId: 'trae-cli',
    command: 'traecli',
    commandCandidates: ['traecli', 'trae-cli'],
    args: ['app-server', '--listen', 'stdio://'],
    env: {},
    stripSshEnv: false,
    defaultModel: 'Doubao-Seed-2.0-Code',
    defaultReasoningEffort: '',
    ...CODEX_ONLY_DEFAULTS,
    fallbackModels: TRAE_FALLBACK_MODELS,
    defaultContextWindow: 256_000,
  },
]

function customRuntimeBase(override: ExternalRuntimeOverride): ExternalRuntimeSpec {
  if (!override.command) {
    throw new Error(`external runtime "${override.id}" is not built in and must declare a command`)
  }
  const defaultModel = override.defaultModel || 'default'
  return {
    id: override.id,
    kind: 'acp',
    enabled: true,
    displayName: override.id,
    description: '',
    providerId: `${override.id}-cli`,
    command: override.command,
    args: [],
    env: {},
    stripSshEnv: false,
    defaultModel,
    defaultReasoningEffort: '',
    ...CODEX_ONLY_DEFAULTS,
    fallbackModels: [{ id: defaultModel, name: defaultModel }],
  }
}

/**
 * Field-level merge. `args` replaces the base only when non-empty (the config
 * schema materializes omitted arrays as `[]`); `env` entries are layered.
 */
function mergeRuntime(base: ExternalRuntimeSpec, override: ExternalRuntimeOverride): ExternalRuntimeSpec {
  const defined = Object.fromEntries(
    Object.entries(override).filter(([, value]) => value !== undefined),
  ) as ExternalRuntimeOverride
  const { commandCandidates: baseCandidates, ...restBase } = base
  const keepCandidates = override.command === undefined ? baseCandidates : undefined
  return {
    ...restBase,
    ...defined,
    ...(keepCandidates ? { commandCandidates: keepCandidates } : {}),
    args: override.args && override.args.length > 0 ? [...override.args] : base.args,
    env: { ...base.env, ...override.env },
    ...(override.profiles && override.profiles.length > 0
      ? { profiles: [...override.profiles] }
      : base.profiles
        ? { profiles: base.profiles }
        : {}),
    fallbackModels: base.fallbackModels,
  }
}

/** Merge user runtime entries over the built-ins by id; new ids add ACP (or codex) runtimes. */
export function resolveRuntimeSpecs(overrides: readonly ExternalRuntimeOverride[]): ExternalRuntimeSpec[] {
  const resolved = new Map<string, ExternalRuntimeSpec>(BUILTIN_RUNTIMES.map((spec) => [spec.id, spec]))
  const seen = new Set<string>()
  for (const override of overrides) {
    if (seen.has(override.id)) {
      throw new Error(`external runtime "${override.id}" is configured more than once`)
    }
    seen.add(override.id)
    const base = resolved.get(override.id) ?? customRuntimeBase(override)
    resolved.set(override.id, mergeRuntime(base, override))
  }
  return [...resolved.values()]
}

const INHERITED_SESSION_ENV_KEYS = [
  'DSH_SESSION_ID',
  'DSH_IN_AGENT_SESSION',
  'ANTIGRAVITY_CONVERSATION_ID',
  'ANTIGRAVITY_TRAJECTORY_ID',
] as const

/** Child environment for a runtime process: host env (stripped of inherited session IDs) + bridge CLI PATH + configured env, optionally SSH-stripped. */
export function buildRuntimeEnv(
  spec: ExternalRuntimeConfig,
  extraEnv?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const bridgeBinDir = join(dshHome, 'lark-bridge', 'bin')
  const userLocalBinDir = join(homedir(), '.local', 'bin')
  const traeBinDir = join(homedir(), '.trae', 'bin')
  const currentPath = process.env.PATH ?? ''
  const pathParts = [bridgeBinDir, userLocalBinDir, traeBinDir, ...currentPath.split(delimiter).filter(Boolean)]
  const dedupedPath = [...new Set(pathParts)].join(delimiter)

  // Never propagate ambient parent/host session IDs into newly spawned external
  // CLI processes; each runtime injects its own canonical session context via extraEnv.
  const sanitizedHostEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const key of INHERITED_SESSION_ENV_KEYS) {
    delete sanitizedHostEnv[key]
  }

  const merged: NodeJS.ProcessEnv = {
    ...sanitizedHostEnv,
    PATH: dedupedPath,
    ...spec.env,
    ...(extraEnv ?? {}),
  }
  return spec.stripSshEnv ? stripSshSessionEnv(merged) : merged
}

function isRunnableFile(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function candidateFilenames(candidate: string, env: NodeJS.ProcessEnv): readonly string[] {
  if (process.platform !== 'win32') return [candidate]
  if (/\.[a-z0-9]+$/i.test(candidate)) return [candidate]
  const rawExts = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  const exts = rawExts.length > 0 ? rawExts : ['.exe', '.cmd', '.bat']
  return [candidate, ...exts.map((ext) => `${candidate}${ext.toLowerCase()}`), ...exts.map((ext) => `${candidate}${ext}`)]
}

/**
 * Resolve the executable command for a runtime. When `spec.commandCandidates` is
 * present (e.g. `['traecli', 'trae-cli']` for TRAE CLI), picks the
 * first runnable binary on `env.PATH`, falling back to `spec.command` if absent.
 */
export function resolveRuntimeCommand(
  spec: ExternalRuntimeSpec,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = spec.commandCandidates
  if (!candidates || candidates.length === 0) return spec.command
  const searchDirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  for (const candidate of candidates) {
    if (isAbsolute(candidate)) {
      for (const variant of candidateFilenames(candidate, env)) {
        if (isRunnableFile(variant)) return variant
      }
      continue
    }
    const variants = candidateFilenames(candidate, env)
    for (const dir of searchDirs) {
      for (const variant of variants) {
        const fullPath = join(dir, variant)
        if (isRunnableFile(fullPath)) return fullPath
      }
    }
  }
  return spec.command
}

export function contextWindowFor(spec: ExternalRuntimeSpec, modelId: string): number | undefined {
  return spec.fallbackModels.find((m) => m.id === modelId)?.contextWindow ?? spec.defaultContextWindow
}
