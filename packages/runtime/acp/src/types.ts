export interface AcpTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly contextUsed?: number
  readonly contextSize?: number
}

export interface AcpThoughtLevelInfo {
  readonly id: string
  readonly name: string
}

export interface AcpModelInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly thoughtLevels?: readonly AcpThoughtLevelInfo[]
  readonly defaultThoughtLevel?: string
}

export interface AcpModeInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface AcpCatalogSnapshot {
  readonly models: readonly AcpModelInfo[]
  readonly modes: readonly AcpModeInfo[]
  readonly authMethods?: readonly AcpAuthMethod[]
  readonly thoughtLevels?: readonly AcpThoughtLevelInfo[]
  readonly currentModelId?: string
  readonly currentModeId?: string
  readonly currentThoughtLevel?: string
  /**
   * Set when models are exposed as a session config option (category `model`);
   * switching then goes through `session/set_config_option` instead of `session/set_model`.
   */
  readonly modelConfigOptionId?: string
  /**
   * Set when reasoning / thinking effort is exposed as a session config option
   * (category `thought_level`, e.g. `thought_level` in Antigravity or `effort` in ClaudeCode).
   */
  readonly thoughtConfigOptionId?: string
}

/** Capabilities negotiated during `initialize`, reduced to what session recovery needs. */
export interface AcpAgentCapabilities {
  /** Agent declares `session/load` (replays history, then continues the session). */
  readonly loadSession: boolean
  /**
   * `session/resume` support: `supported` when declared in `sessionCapabilities`,
   * `unsupported` when `sessionCapabilities` is declared without it, `unknown`
   * when the agent does not declare session capabilities at all.
   */
  readonly resume: 'supported' | 'unsupported' | 'unknown'
  readonly promptImage: boolean
  /** Agent declares `session/close` in `sessionCapabilities`. */
  readonly closeSession?: boolean
}

export interface AcpAuthMethod {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface AcpInitializeResult {
  readonly protocolVersion?: number
  readonly agentCapabilities: AcpAgentCapabilities
  readonly authMethods: readonly AcpAuthMethod[]
  readonly agentInfo?: { readonly name?: string; readonly version?: string }
  readonly raw: unknown
}

export type AcpPromptBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string }

export interface AcpDiffHunk {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

export interface AcpActiveToolCall {
  rawName?: string
  title?: string
  kind?: string
  rawInput?: unknown
  locations: Array<{ path: string; line?: number }>
  diffs: AcpDiffHunk[]
  terminalOutput?: string
  exitCode?: number | null
  started: boolean
  emittedName?: string
}

export type AcpTurnEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | {
      readonly type: 'tool-start'
      readonly callId: string
      readonly name: string
      readonly arguments: string
    }
  | {
      readonly type: 'tool-complete'
      readonly callId: string
      readonly name: string
      readonly output: string
      readonly isError: boolean
      readonly meta?: Record<string, unknown>
    }
  | { readonly type: 'usage'; readonly usage: AcpTokenUsage }
  | { readonly type: 'title'; readonly title: string }

export interface AcpPermissionOption {
  readonly optionId: string
  readonly name: string
  readonly kind: string
}

export interface AcpPermissionRequest {
  readonly sessionId?: string
  readonly callId?: string
  readonly toolName: string
  readonly reason: string
  readonly options: readonly AcpPermissionOption[]
  readonly rawParams: unknown
}

export type AcpPermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

export interface AcpTurnHandlers {
  readonly onEvent?: (event: AcpTurnEvent) => void
  readonly onPermission?: (
    request: AcpPermissionRequest,
    signal: AbortSignal,
  ) => Promise<AcpPermissionOutcome>
}

export interface AcpTurnResult {
  readonly text: string
  readonly stopReason: string
  readonly usage?: AcpTokenUsage
}

export interface AcpStartOptions {
  readonly sessionId?: string
  /** Optional per-session working directory; defaults to the client's root `cwd`. */
  readonly cwd?: string
  readonly modelId?: string
  readonly thoughtLevel?: string
  readonly modeId?: string
  readonly authMethodId?: string
  /** Optional ACP `_meta` object forwarded on `session/new`, `session/resume`, and `session/load`. */
  readonly sessionMeta?: Readonly<Record<string, unknown>>
}

/** Handle to one multiplexed ACP session hosted on a shared `AcpRuntimeClient`. */
export interface AcpSessionHandle {
  readonly sessionId: string
  readonly isOpen: boolean
  readonly catalog: AcpCatalogSnapshot | undefined
  setModel(modelId: string): Promise<void>
  setThoughtLevel(thoughtLevel: string): Promise<void>
  setMode(modeId: string): Promise<void>
  runTurn(
    prompt: readonly AcpPromptBlock[],
    handlers?: AcpTurnHandlers,
    signal?: AbortSignal,
  ): Promise<AcpTurnResult>
  close(): Promise<void>
}

export interface AcpTransportFactoryOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

export interface AcpRuntimeOptions {
  readonly cwd: string
  /** Executable that speaks ACP over stdio, e.g. `agy` or `npx`. */
  readonly command: string
  /** Arguments that put the executable into ACP stdio mode. */
  readonly args: readonly string[]
  /** Child environment; defaults to `process.env`. Passed through unchanged. */
  readonly env?: NodeJS.ProcessEnv
  /** Optional ACP authentication method id to invoke right after `initialize` (e.g. `gemini-api-key`). */
  readonly authMethodId?: string
  /** Optional default ACP `_meta` object forwarded on `session/new`, `session/resume`, and `session/load`. */
  readonly sessionMeta?: Readonly<Record<string, unknown>>
  readonly requestTimeoutMs?: number
  /**
   * Idle timeout (ms) for an in-flight `session/prompt` turn when no `session/update`
   * or permission activity arrives. Defaults to 30 minutes; set `0` to disable.
   */
  readonly promptIdleTimeoutMs?: number
  /**
   * Grace timeout (ms) after an external abort sends `session/cancel` before forcibly
   * settling the pending `session/prompt` request. Defaults to 5 seconds.
   */
  readonly cancelGraceTimeoutMs?: number
  readonly clientName?: string
  readonly clientVersion?: string
  readonly logger?: (message: string) => void
  readonly transportFactory?: (options: AcpTransportFactoryOptions) => AcpJsonRpcTransport
}

export interface AcpJsonRpcError {
  readonly code?: number
  readonly message?: string
  readonly data?: unknown
}

export interface AcpJsonRpcMessage {
  readonly jsonrpc?: string
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: AcpJsonRpcError
}

export interface AcpJsonRpcTransport {
  send(message: AcpJsonRpcMessage): void
  onMessage(listener: (message: AcpJsonRpcMessage) => void): () => void
  onClose(listener: (error?: Error) => void): () => void
  close(): Promise<void>
}
