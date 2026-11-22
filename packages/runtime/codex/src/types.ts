export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface CodexTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

export interface CodexModelInfo {
  readonly id: string
  readonly name: string
  readonly supportedReasoningEfforts: readonly string[]
  /** True when the server explicitly declared a reasoning effort list (even if empty `[]`). */
  readonly reasoningEffortsDeclared?: boolean
  readonly defaultReasoningEffort?: string
  readonly contextWindow?: number
  readonly isDefault?: boolean
}

export interface CodexTurnInput {
  readonly text: string
  readonly images?: readonly { readonly url?: string; readonly path?: string }[]
  readonly model?: string
  readonly reasoningEffort?: string
  readonly approvalPolicy?: CodexApprovalPolicy
  readonly sandbox?: CodexSandboxMode
}

export type CodexTurnEvent =
  | { readonly type: 'message-start'; readonly itemId?: string; readonly phase?: string }
  | { readonly type: 'text-delta'; readonly text: string; readonly phase?: string }
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
  | { readonly type: 'usage'; readonly usage: CodexTokenUsage }

export interface CodexApprovalRequest {
  readonly method: string
  readonly callId?: string
  readonly toolName: string
  readonly reason: string
  readonly rawParams: unknown
}

export type CodexApprovalDecision = 'allow-once' | 'allow-session' | 'reject'

export interface CodexUserInputQuestion {
  readonly id: string
  readonly header?: string
  readonly question: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly isMultiSelect?: boolean
}

export interface CodexUserInputRequest {
  readonly threadId?: string
  readonly turnId?: string
  readonly callId?: string
  readonly questions: readonly CodexUserInputQuestion[]
  readonly rawParams: unknown
}

export interface CodexUserInputAnswer {
  readonly answers: Record<string, { readonly answers: readonly string[] }>
}

export interface CodexTurnHandlers {
  readonly onEvent?: (event: CodexTurnEvent) => void
  readonly onApproval?: (
    request: CodexApprovalRequest,
    signal: AbortSignal,
  ) => Promise<CodexApprovalDecision>
  readonly onUserInput?: (
    request: CodexUserInputRequest,
    signal: AbortSignal,
  ) => Promise<CodexUserInputAnswer>
}

export interface CodexTurnResult {
  readonly text: string
  readonly status: 'completed' | 'interrupted' | 'failed'
  readonly usage?: CodexTokenUsage
  readonly errorMessage?: string
}

export interface CodexStartOptions {
  readonly threadId?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly forceModelOverride?: boolean
  readonly approvalPolicy?: CodexApprovalPolicy
  readonly sandbox?: CodexSandboxMode
  readonly serviceName?: string
}

export interface CodexRuntimeOptions {
  readonly cwd: string
  readonly cliBin?: string
  /** Arguments that start the JSON-RPC app server; defaults to `['app-server', '--stdio']`. */
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly requestTimeoutMs?: number
  readonly clientName?: string
  readonly clientVersion?: string
  readonly logger?: (message: string) => void
  readonly transportFactory?: (options: CodexTransportFactoryOptions) => JsonRpcTransport
}

export interface CodexTransportFactoryOptions {
  readonly cliBin: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

export interface JsonRpcMessage {
  readonly jsonrpc?: string
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown }
}

export interface JsonRpcTransport {
  send(message: JsonRpcMessage): void
  onMessage(listener: (message: JsonRpcMessage) => void): () => void
  onClose(listener: (error?: Error) => void): () => void
  close(): Promise<void>
}
