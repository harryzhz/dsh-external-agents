import type { TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { CodexApprovalPolicy, CodexSandboxMode } from '@dsh-external-agents/runtime-codex'
import type { ExternalRuntimeRegistry } from './runtime/registry.js'

/** Runtime id (equal to the agent preset id). Persisted as `driver` in binding records. */
export type ExternalDriverKind = string

export const EXTERNAL_BINDING_RECORD_TYPE = 'plugin:external-agent/binding'
export const EXTERNAL_LAUNCH_RECORD_TYPE = 'plugin:external-agent/launch'

export interface ExternalBindingRecord {
  readonly driver: ExternalDriverKind
  readonly externalId: string
}

export interface ExternalLaunchRecord {
  readonly runtimeId: string
  readonly profileId: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:external-agent/binding': {
      driver: ExternalDriverKind
      externalId: string
    }
    'plugin:external-agent/launch': {
      runtimeId: string
      profileId: string
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read-only catalog and profile registry of enabled external runtimes, provided by `dsh-external-agents`. */
    externalRuntimes: ExternalRuntimeRegistry
  }
}

/** Protocol adapter used to drive a runtime process. */
export type ExternalRuntimeKind = 'codex-app-server' | 'acp'

export type RuntimeArgsMode = 'append' | 'prepend' | 'replace'
export type RuntimeProfileSource = 'discovered' | 'config' | 'user'

export interface ExternalRuntimeAuthMethod {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Declarative launch-profile capabilities advertised per runtime so consumers never hard-code engines. */
export interface ExternalRuntimeProfileCapabilities {
  readonly supportsCliProfile: boolean
  readonly cliProfileHint?: string
  readonly supportsConfigFile: boolean
  readonly configFileHint?: string
  readonly supportsEnv: boolean
  readonly envHints?: readonly string[]
  readonly supportsArgs: boolean
  readonly supportsAuthMethod: boolean
  readonly authMethods?: readonly ExternalRuntimeAuthMethod[]
  readonly supportsExposeAsPreset: boolean
}

/** Declarative profile entry configured in `cordis.patch.yml` under a runtime. */
export interface ExternalRuntimeProfileConfig {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly cliProfile?: string
  readonly configFile?: string
  readonly env?: Readonly<Record<string, string>>
  readonly args?: readonly string[]
  readonly argsMode?: RuntimeArgsMode
  readonly authMethodId?: string
  readonly defaultModel?: string
  readonly defaultReasoningEffort?: string
  readonly exposeAsPreset?: boolean
}

/** Full launch profile owned by `dsh-external-agents` (may hold secret env values). */
export interface ExternalRuntimeProfile {
  readonly id: string
  readonly runtimeId: string
  readonly name: string
  readonly description?: string
  readonly source: RuntimeProfileSource
  readonly cliProfile?: string
  readonly configFile?: string
  readonly env?: Readonly<Record<string, string>>
  readonly args?: readonly string[]
  readonly argsMode?: RuntimeArgsMode
  readonly authMethodId?: string
  readonly defaultModel?: string
  readonly defaultReasoningEffort?: string
  readonly exposeAsPreset?: boolean
}

/** Sanitized profile DTO safe to expose to UI/API consumers (secret env values are omitted). */
export interface ExternalRuntimeProfilePublicView {
  readonly id: string
  readonly runtimeId: string
  readonly name: string
  readonly description?: string
  readonly source: RuntimeProfileSource
  readonly hasUserOverride?: boolean
  readonly cliProfile?: string
  readonly configFile?: string
  readonly env?: Readonly<Record<string, string>>
  readonly secretEnvKeys: readonly string[]
  readonly args?: readonly string[]
  readonly argsMode?: RuntimeArgsMode
  readonly authMethodId?: string
  readonly defaultModel?: string
  readonly defaultReasoningEffort?: string
  readonly exposeAsPreset?: boolean
  readonly presetId?: string
  readonly providerId?: string
}

/** Input accepted by `upsertProfile` (empty values for existing secret env keys preserve the stored secret). */
export interface ExternalRuntimeProfileInput {
  readonly id?: string
  readonly runtimeId: string
  readonly name: string
  readonly description?: string
  readonly cliProfile?: string
  readonly configFile?: string
  readonly env?: Readonly<Record<string, string>>
  readonly removeEnvKeys?: readonly string[]
  readonly args?: readonly string[]
  readonly argsMode?: RuntimeArgsMode
  readonly authMethodId?: string
  readonly defaultModel?: string
  readonly defaultReasoningEffort?: string
  readonly exposeAsPreset?: boolean
}

/** Fully resolved runtime configuration (built-in defaults merged with user overrides). */
export interface ExternalRuntimeConfig {
  /** Runtime id; also the agent preset id that routes sessions to this runtime. */
  readonly id: string
  readonly kind: ExternalRuntimeKind
  readonly enabled: boolean
  readonly displayName: string
  readonly description: string
  /** LLM provider id under which the runtime's model catalog is registered. */
  readonly providerId: string
  readonly command: string
  readonly args: readonly string[]
  /** Extra environment variables layered over the host process environment. */
  readonly env: Readonly<Record<string, string>>
  /** Remove SSH_CONNECTION / SSH_CLIENT / SSH_TTY (keeps SSH_AUTH_SOCK) for Keychain-backed CLIs. */
  readonly stripSshEnv: boolean
  readonly defaultModel: string
  /** Empty string means the runtime has no default reasoning effort. */
  readonly defaultReasoningEffort: string
  /** codex-app-server only. */
  readonly approvalPolicy: CodexApprovalPolicy
  /** codex-app-server only. */
  readonly sandbox: CodexSandboxMode
  /** Static launch profiles declared in `cordis.patch.yml`. */
  readonly profiles?: readonly ExternalRuntimeProfileConfig[]
}

/** User-supplied runtime entry: fields left out inherit the built-in runtime with the same id. */
export type ExternalRuntimeOverride = { readonly id: string } & Partial<Omit<ExternalRuntimeConfig, 'id'>>

export interface ExternalAgentsConfig {
  readonly dataDir?: string
  readonly idleEvictMs: number
  readonly catalogTtlMs: number
  readonly maxParallelToolCalls: number
  readonly runtimes: readonly ExternalRuntimeOverride[]
}

export type ExternalTurnEvent =
  | { readonly type: 'message-start'; readonly itemId?: string; readonly phase?: string }
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | {
      readonly type: 'tool-start'
      readonly callId: string
      readonly name: string
      readonly arguments: string
    }
  | { readonly type: 'tool-output-delta'; readonly callId: string; readonly delta: string }
  | {
      readonly type: 'tool-complete'
      readonly callId: string
      readonly name: string
      readonly output: string
      readonly isError: boolean
      readonly meta?: Record<string, unknown>
    }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'title'; readonly title: string }

export interface ExternalTurnRunResult {
  readonly status: 'completed' | 'interrupted' | 'failed'
  readonly usage?: TokenUsage
  readonly errorMessage?: string
}

export interface ExternalTurnRequest {
  readonly messages: readonly UserMessage[]
  readonly model: string
  readonly reasoningEffort?: string
  readonly modelChangedSinceStart: boolean
}

export interface ExternalRuntimeDriver {
  readonly kind: ExternalDriverKind
  readonly externalId: string | undefined
  ensureConnected(existingExternalId?: string, model?: string, reasoningEffort?: string): Promise<string>
  runTurn(
    request: ExternalTurnRequest,
    onEvent: (event: ExternalTurnEvent) => void,
    signal: AbortSignal,
  ): Promise<ExternalTurnRunResult>
  close(): Promise<void>
}
