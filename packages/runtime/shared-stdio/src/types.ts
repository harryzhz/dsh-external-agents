export interface JsonRpcError {
  readonly code?: number
  readonly message?: string
  readonly data?: unknown
}

export interface JsonRpcMessage {
  readonly jsonrpc?: string
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: JsonRpcError
}

export interface JsonRpcTransport {
  send(message: JsonRpcMessage): void
  onMessage(listener: (message: JsonRpcMessage) => void): () => void
  onClose(listener: (error?: Error) => void): () => void
  close(): Promise<void>
}

export interface StdioTransportOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** Human-readable process label used in diagnostics and error messages. */
  readonly label?: string
  /** Resolve symlinks in `cwd` via `realpathSync` before spawning (default: false). */
  readonly resolveCwd?: boolean
}
