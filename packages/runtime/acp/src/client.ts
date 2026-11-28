import { JsonRpcDispatcher } from '@dsh-external-agents/runtime-shared-stdio'
import { mergeConfigOptionsSnapshot, normalizeModelAndThought } from './catalog-state.js'
import {
  AcpRpcError,
  isAuthRequired,
  isMethodNotFound,
  isResourceNotFound,
  isResumeLoadFallbackHint,
} from './errors.js'
import { parseAcpCatalog, parseAcpInitializeResult } from './event-normalizer.js'
import { AcpStdioTransport } from './stdio-transport.js'
import { AcpTurnRunner, type ActiveTurnContext } from './turn-runner.js'
import type {
  AcpAgentCapabilities,
  AcpCatalogSnapshot,
  AcpInitializeResult,
  AcpJsonRpcMessage,
  AcpJsonRpcTransport,
  AcpPromptBlock,
  AcpRuntimeOptions,
  AcpSessionHandle,
  AcpStartOptions,
  AcpTransportFactoryOptions,
  AcpTurnHandlers,
  AcpTurnResult,
} from './types.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
/** `initialize` also covers process cold start (e.g. `npx` fetching the agent package). */
const STARTUP_TIMEOUT_MS = 5 * 60_000
const CLOSE_SESSION_TIMEOUT_MS = 3_000
/**
 * Default inactivity timeout for an in-flight `session/prompt` turn.
 * Unlike a fixed wall-clock deadline, this timer resets on every `session/update`
 * and pauses while waiting for an interactive permission response so active long
 * runs are never terminated mid-progress.
 */
export const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_CANCEL_GRACE_TIMEOUT_MS = 5_000

interface AcpSessionState {
  readonly sessionId: string
  readonly cwd: string
  catalogSnapshot: AcpCatalogSnapshot
  activeTurn?: ActiveTurnContext
}

interface OpenedSession {
  readonly sessionId: string
  readonly result: unknown
}

/**
 * Generic Agent Client Protocol (ACP) client over a stdio JSON-RPC transport.
 * Supports both single-session usage (`startOrResume` / `runTurn`) and
 * multiplexed multi-session hosting (`openSession` -> `AcpSessionHandle`).
 */
export class AcpRuntimeClient {
  private readonly cwd: string
  private readonly command: string
  private readonly args: readonly string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly defaultAuthMethodId?: string
  private readonly defaultSessionMeta?: Readonly<Record<string, unknown>>
  private readonly label: string
  private readonly requestTimeoutMs: number
  private readonly clientName: string
  private readonly clientVersion: string
  private readonly logger: (message: string) => void
  private readonly transportFactory: (options: AcpTransportFactoryOptions) => AcpJsonRpcTransport
  private readonly dispatcher: JsonRpcDispatcher
  private readonly turnRunner: AcpTurnRunner

  private initResult?: AcpInitializeResult
  private initPromise?: Promise<AcpInitializeResult>
  private authenticatedMethodId?: string
  private authPromise?: Promise<void>
  private closed = false
  private defaultSessionId?: string
  private lastCatalogSnapshot?: AcpCatalogSnapshot
  private readonly sessions = new Map<string, AcpSessionState>()

  constructor(options: AcpRuntimeOptions) {
    this.cwd = options.cwd
    this.command = options.command
    this.args = options.args
    this.env = options.env ?? process.env
    this.defaultAuthMethodId = options.authMethodId?.trim() || undefined
    this.defaultSessionMeta =
      options.sessionMeta && Object.keys(options.sessionMeta).length > 0
        ? options.sessionMeta
        : undefined
    this.label = `acp(${options.command})`
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const promptIdleTimeoutMs =
      options.promptIdleTimeoutMs !== undefined && Number.isFinite(options.promptIdleTimeoutMs)
        ? Math.max(0, options.promptIdleTimeoutMs)
        : DEFAULT_PROMPT_IDLE_TIMEOUT_MS
    const cancelGraceTimeoutMs =
      options.cancelGraceTimeoutMs !== undefined && Number.isFinite(options.cancelGraceTimeoutMs)
        ? Math.max(10, options.cancelGraceTimeoutMs)
        : DEFAULT_CANCEL_GRACE_TIMEOUT_MS
    this.clientName = options.clientName ?? 'dsh-external-agents'
    this.clientVersion = options.clientVersion ?? '0.1.0'
    this.logger = options.logger ?? (() => {})
    this.transportFactory = options.transportFactory ?? ((opts) => new AcpStdioTransport(opts))
    this.dispatcher = new JsonRpcDispatcher({
      label: this.label,
      defaultTimeoutMs: this.requestTimeoutMs,
      createRpcError: (method, error) => new AcpRpcError(method, error),
    })
    this.turnRunner = new AcpTurnRunner({
      label: this.label,
      promptIdleTimeoutMs,
      cancelGraceTimeoutMs,
      dispatcher: this.dispatcher,
      logger: this.logger,
      isClosed: () => this.closed,
      resolveTurnForSession: (sessionId) => this.resolveTurnForSession(sessionId),
    })
  }

  get sessionId(): string | undefined {
    return this.defaultSessionId
  }

  get catalog(): AcpCatalogSnapshot | undefined {
    if (this.defaultSessionId) {
      return this.sessions.get(this.defaultSessionId)?.catalogSnapshot ?? this.lastCatalogSnapshot
    }
    return this.lastCatalogSnapshot
  }

  /** Most recently observed catalog snapshot across all sessions on this connection. */
  get cachedCatalog(): AcpCatalogSnapshot | undefined {
    return this.lastCatalogSnapshot
  }

  /** Result of the most recent `initialize` handshake. */
  get initializeResult(): AcpInitializeResult | undefined {
    return this.initResult
  }

  get isConnected(): boolean {
    return Boolean(this.dispatcher.activeTransport && this.initResult && !this.closed)
  }

  /** Number of currently open multiplexed sessions on this connection. */
  get activeSessionCount(): number {
    return this.sessions.size
  }

  /** Number of sessions with a `session/prompt` turn currently in flight. */
  get inFlightTurnCount(): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.activeTurn) count += 1
    }
    return count
  }

  async initialize(): Promise<AcpInitializeResult> {
    if (this.initResult && this.dispatcher.activeTransport && !this.closed) return this.initResult
    if (this.initPromise) return await this.initPromise
    this.closed = false
    const pendingInit = this.performInitialize().finally(() => {
      if (this.initPromise === pendingInit) {
        this.initPromise = undefined
      }
    })
    this.initPromise = pendingInit
    return await pendingInit
  }

  async authenticate(methodId: string): Promise<void> {
    const clean = methodId.trim()
    if (!clean) return
    while (this.authPromise) {
      await this.authPromise.catch(() => {})
    }
    if (this.authenticatedMethodId === clean && this.isConnected) return
    const pendingAuth = this.performAuthenticate(clean).finally(() => {
      if (this.authPromise === pendingAuth) {
        this.authPromise = undefined
      }
    })
    this.authPromise = pendingAuth
    await pendingAuth
  }

  /**
   * Open or restore an ACP session and return a dedicated handle bound to its
   * `sessionId`. Multiple handles can coexist and execute `runTurn()` concurrently
   * over the same stdio JSON-RPC connection.
   */
  async openSession(options: AcpStartOptions = {}): Promise<AcpSessionHandle> {
    const state = await this.openSessionState(options)
    return this.createSessionHandle(state.sessionId)
  }

  /**
   * Single-session convenience wrapper: opens or resumes a session and sets it
   * as the client's default session for `runTurn` / `setModel` / `setMode`.
   */
  async startOrResume(options: AcpStartOptions = {}): Promise<string> {
    const state = await this.openSessionState(options)
    this.defaultSessionId = state.sessionId
    return state.sessionId
  }

  async closeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    this.sessions.delete(sessionId)
    if (this.defaultSessionId === sessionId) {
      this.defaultSessionId = undefined
    }
    if (state.activeTurn) {
      state.activeTurn.cancelPending = true
      state.activeTurn.abortController.abort()
      state.activeTurn.beginCancelGrace?.()
      this.dispatcher.notify('session/cancel', { sessionId })
    }
    if (this.isConnected && this.initResult?.agentCapabilities.closeSession) {
      await this.request('session/close', { sessionId }, CLOSE_SESSION_TIMEOUT_MS).catch(() => {})
    }
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.defaultSessionId) return
    await this.setModelForSession(this.defaultSessionId, modelId)
  }

  async setThoughtLevel(thoughtLevel: string): Promise<void> {
    if (!this.defaultSessionId) return
    await this.setThoughtLevelForSession(this.defaultSessionId, thoughtLevel)
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.defaultSessionId) return
    await this.setModeForSession(this.defaultSessionId, modeId)
  }

  async runTurn(
    prompt: readonly AcpPromptBlock[],
    handlers: AcpTurnHandlers = {},
    signal?: AbortSignal,
  ): Promise<AcpTurnResult> {
    if (!this.defaultSessionId) {
      throw new Error('AcpRuntimeClient.runTurn called before startOrResume()')
    }
    return await this.runTurnForSession(this.defaultSessionId, prompt, handlers, signal)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const transport = this.dispatcher.detach()
    this.initResult = undefined
    this.initPromise = undefined
    this.authenticatedMethodId = undefined
    this.authPromise = undefined
    this.defaultSessionId = undefined
    this.abortAllActiveTurns()
    this.sessions.clear()
    this.dispatcher.failAll(new Error(`${this.label} runtime closed`))
    if (transport) {
      await transport.close()
    }
  }

  static async probeCatalog(options: AcpRuntimeOptions): Promise<AcpCatalogSnapshot> {
    const client = new AcpRuntimeClient(options)
    try {
      const handle = await client.openSession()
      const snap = handle.catalog ?? { models: [], modes: [] }
      await handle.close().catch(() => {})
      return snap
    } finally {
      await client.close()
    }
  }

  private async performInitialize(): Promise<AcpInitializeResult> {
    const transport = this.transportFactory({
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      env: this.env,
    })
    this.dispatcher.attach(transport)
    transport.onMessage((msg) => this.handleMessage(msg))
    transport.onClose((err) => this.handleTransportClosed(transport, err))

    try {
      const raw = await this.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: this.clientName, version: this.clientVersion },
        },
        Math.max(this.requestTimeoutMs, STARTUP_TIMEOUT_MS),
      )
      this.initResult = parseAcpInitializeResult(raw)
      return this.initResult
    } catch (err) {
      if (this.dispatcher.detach(transport)) {
        this.initResult = undefined
        this.authenticatedMethodId = undefined
      }
      await transport.close().catch(() => {})
      throw err
    }
  }

  private async performAuthenticate(clean: string): Promise<void> {
    const init = await this.initialize()
    if (init.authMethods.length > 0 && !init.authMethods.some((m) => m.id === clean)) {
      const supported = init.authMethods.map((m) => m.id).join(', ')
      throw new Error(`${this.label} unsupported authMethod "${clean}" (available: ${supported})`)
    }
    await this.request('authenticate', { methodId: clean })
    this.authenticatedMethodId = clean
  }

  private async openSessionState(options: AcpStartOptions): Promise<AcpSessionState> {
    const init = await this.initialize()
    const targetAuthMethod = options.authMethodId?.trim() || this.defaultAuthMethodId
    if (targetAuthMethod && this.authenticatedMethodId !== targetAuthMethod) {
      await this.authenticate(targetAuthMethod)
    }
    const sessionCwd = options.cwd?.trim() || this.cwd
    const sessionMeta =
      options.sessionMeta && Object.keys(options.sessionMeta).length > 0
        ? options.sessionMeta
        : this.defaultSessionMeta
    const open = (): Promise<OpenedSession> =>
      options.sessionId
        ? this.restoreSession(options.sessionId, sessionCwd, init.agentCapabilities, sessionMeta)
        : this.newSession(sessionCwd, sessionMeta)

    let opened: OpenedSession
    try {
      opened = await open()
    } catch (err) {
      const fallbackAuthMethod =
        !targetAuthMethod && !this.authenticatedMethodId && isAuthRequired(err)
          ? init.authMethods[0]?.id
          : undefined
      if (!fallbackAuthMethod) throw err
      this.logger(
        `${this.label} session open requires authentication; retrying with default authMethod "${fallbackAuthMethod}"`,
      )
      await this.authenticate(fallbackAuthMethod)
      opened = await open()
    }

    const parsedCatalog = parseAcpCatalog(opened.result)
    const catalogSnapshot: AcpCatalogSnapshot =
      init.authMethods.length > 0
        ? { ...parsedCatalog, authMethods: init.authMethods }
        : parsedCatalog

    const state: AcpSessionState = {
      sessionId: opened.sessionId,
      cwd: sessionCwd,
      catalogSnapshot,
    }
    this.sessions.set(opened.sessionId, state)
    this.lastCatalogSnapshot = catalogSnapshot

    const normalized = normalizeModelAndThought(state.catalogSnapshot, options.modelId, options.thoughtLevel)
    if (normalized.modelId && normalized.modelId !== state.catalogSnapshot.currentModelId) {
      await this.applyStartModel(state.sessionId, normalized.modelId)
    }
    if (normalized.thoughtLevel && normalized.thoughtLevel !== state.catalogSnapshot.currentThoughtLevel) {
      await this.applyStartThoughtLevel(state.sessionId, normalized.thoughtLevel)
    }
    if (options.modeId && options.modeId !== state.catalogSnapshot.currentModeId) {
      await this.setModeForSession(state.sessionId, options.modeId)
    }
    return state
  }

  private createSessionHandle(sessionId: string): AcpSessionHandle {
    let handleClosed = false
    const client = this
    return {
      sessionId,
      get isOpen(): boolean {
        return !handleClosed && client.isConnected && client.sessions.has(sessionId)
      },
      get catalog(): AcpCatalogSnapshot | undefined {
        return client.sessions.get(sessionId)?.catalogSnapshot ?? client.lastCatalogSnapshot
      },
      setModel: (modelId: string) => this.setModelForSession(sessionId, modelId),
      setThoughtLevel: (thoughtLevel: string) => this.setThoughtLevelForSession(sessionId, thoughtLevel),
      setMode: (modeId: string) => this.setModeForSession(sessionId, modeId),
      runTurn: (prompt, handlers, signal) => this.runTurnForSession(sessionId, prompt, handlers, signal),
      close: async () => {
        if (handleClosed) return
        handleClosed = true
        await this.closeSession(sessionId)
      },
    }
  }

  private async setModelForSession(sessionId: string, modelId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    const normalized = normalizeModelAndThought(state.catalogSnapshot, modelId, undefined)
    const targetModelId = normalized.modelId ?? modelId
    const configId = state.catalogSnapshot.modelConfigOptionId
    if (configId) {
      const res = await this.request('session/set_config_option', {
        sessionId,
        configId,
        value: targetModelId,
      })
      state.catalogSnapshot = mergeConfigOptionsSnapshot(state.catalogSnapshot, res, {
        currentModelId: targetModelId,
      })
      this.lastCatalogSnapshot = state.catalogSnapshot
      if (normalized.inferredThoughtLevel) {
        await this.setThoughtLevelForSession(sessionId, normalized.inferredThoughtLevel)
      }
    } else {
      await this.request('session/set_model', {
        sessionId,
        modelId: targetModelId,
      })
      state.catalogSnapshot = { ...state.catalogSnapshot, currentModelId: targetModelId }
      this.lastCatalogSnapshot = state.catalogSnapshot
    }
  }

  private async setThoughtLevelForSession(sessionId: string, thoughtLevel: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    const snap = state.catalogSnapshot
    const configId = snap.thoughtConfigOptionId
    if (!configId) return

    const available = snap.thoughtLevels ?? []
    let targetValue = thoughtLevel.trim()
    if (!targetValue) {
      if (available.some((t) => t.id === 'default')) {
        targetValue = 'default'
      } else {
        const currentModel = snap.models.find((m) => m.id === snap.currentModelId)
        targetValue = currentModel?.defaultThoughtLevel ?? ''
      }
    }
    if (!targetValue) return
    if (available.length > 0 && !available.some((t) => t.id === targetValue)) {
      this.logger(`${this.label} skipping unsupported thoughtLevel "${targetValue}"`)
      return
    }
    const res = await this.request('session/set_config_option', {
      sessionId,
      configId,
      value: targetValue,
    })
    state.catalogSnapshot = mergeConfigOptionsSnapshot(state.catalogSnapshot, res, {
      currentThoughtLevel: targetValue,
    })
    this.lastCatalogSnapshot = state.catalogSnapshot
  }

  private async setModeForSession(sessionId: string, modeId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    await this.request('session/set_mode', {
      sessionId,
      modeId,
    })
    state.catalogSnapshot = { ...state.catalogSnapshot, currentModeId: modeId }
    this.lastCatalogSnapshot = state.catalogSnapshot
  }

  private async runTurnForSession(
    sessionId: string,
    prompt: readonly AcpPromptBlock[],
    handlers: AcpTurnHandlers = {},
    signal?: AbortSignal,
  ): Promise<AcpTurnResult> {
    const state = this.sessions.get(sessionId)
    if (!state) {
      throw new Error(`AcpRuntimeClient session "${sessionId}" is not open`)
    }
    if (state.activeTurn) {
      throw new Error('AcpRuntimeClient already has an active turn in flight')
    }
    return await this.turnRunner.executeTurn(sessionId, prompt, handlers, signal, (turn) => {
      state.activeTurn = turn
      return () => {
        if (state.activeTurn === turn) {
          state.activeTurn = undefined
        }
      }
    })
  }

  private async newSession(
    cwd: string,
    sessionMeta?: Readonly<Record<string, unknown>>,
  ): Promise<OpenedSession> {
    const res = (await this.request('session/new', {
      cwd,
      mcpServers: [],
      ...(sessionMeta ? { _meta: sessionMeta } : {}),
    })) as { sessionId?: unknown } | undefined
    if (typeof res?.sessionId !== 'string' || res.sessionId.length === 0) {
      throw new Error(`${this.label} session/new returned no sessionId`)
    }
    return { sessionId: res.sessionId, result: res }
  }

  private async restoreSession(
    sessionId: string,
    cwd: string,
    capabilities: AcpAgentCapabilities,
    sessionMeta?: Readonly<Record<string, unknown>>,
  ): Promise<OpenedSession> {
    const params = {
      sessionId,
      cwd,
      mcpServers: [],
      ...(sessionMeta ? { _meta: sessionMeta } : {}),
    }
    try {
      if (capabilities.resume !== 'unsupported') {
        try {
          return { sessionId, result: await this.request('session/resume', params) }
        } catch (err) {
          if (isMethodNotFound(err)) {
            this.logger(`${this.label} does not implement session/resume; trying fallback`)
          } else if (capabilities.loadSession && isResumeLoadFallbackHint(err)) {
            this.logger(`${this.label} session/resume suggested session/load fallback; trying session/load`)
          } else {
            throw err
          }
        }
      }
      if (capabilities.loadSession) {
        // History replayed via session/update while loading is dropped: no active turn yet.
        return { sessionId, result: await this.request('session/load', params) }
      }
      this.logger(`${this.label} cannot restore session ${sessionId}; starting a new session`)
    } catch (err) {
      // The agent no longer knows this session (e.g. it was never persisted because
      // the first prompt failed). Start over instead of failing every later turn.
      if (!isResourceNotFound(err)) throw err
      this.logger(`${this.label} session ${sessionId} not found; starting a new session`)
    }
    return await this.newSession(cwd, sessionMeta)
  }

  private async applyStartModel(sessionId: string, modelId: string): Promise<void> {
    const available = this.sessions.get(sessionId)?.catalogSnapshot.models ?? []
    if (available.length > 0 && !available.some((m) => m.id === modelId)) {
      this.logger(`${this.label} ignoring unknown modelId "${modelId}"`)
      return
    }
    try {
      await this.setModelForSession(sessionId, modelId)
    } catch (err) {
      this.logger(
        `${this.label} session/set_model(${modelId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private async applyStartThoughtLevel(sessionId: string, thoughtLevel: string): Promise<void> {
    try {
      await this.setThoughtLevelForSession(sessionId, thoughtLevel)
    } catch (err) {
      this.logger(
        `${this.label} session/set_config_option(thought_level=${thoughtLevel}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  private request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`cannot send ${this.label} RPC "${method}": transport closed`))
    }
    return this.dispatcher.request(method, params, timeoutMs)
  }

  private handleMessage(msg: AcpJsonRpcMessage): void {
    if (this.dispatcher.handleResponse(msg)) return

    if (msg.id !== undefined && typeof msg.method === 'string') {
      void this.turnRunner.handleServerRequest(msg.id, msg.method, msg.params)
      return
    }

    if (msg.method === 'session/update') {
      this.turnRunner.handleSessionUpdate(msg.params)
    }
  }

  private resolveTurnForSession(sessionId?: string): ActiveTurnContext | undefined {
    if (sessionId) {
      return this.sessions.get(sessionId)?.activeTurn
    }
    // Fail-closed in multiplexed connections (> 1 open session): an unlabelled
    // update or permission request must never be attributed to another session.
    if (this.sessions.size > 1) {
      this.logger(
        `${this.label} dropping unlabelled session event while ${this.sessions.size} sessions are open`,
      )
      return undefined
    }
    let soleTurn: ActiveTurnContext | undefined
    for (const state of this.sessions.values()) {
      if (!state.activeTurn) continue
      if (soleTurn) return undefined
      soleTurn = state.activeTurn
    }
    return soleTurn
  }

  private abortAllActiveTurns(): void {
    for (const state of this.sessions.values()) {
      if (state.activeTurn) {
        state.activeTurn.abortController.abort()
        state.activeTurn = undefined
      }
    }
  }

  private handleTransportClosed(closedTransport: AcpJsonRpcTransport, error?: Error): void {
    if (!this.dispatcher.detach(closedTransport)) return
    this.initResult = undefined
    this.initPromise = undefined
    this.authenticatedMethodId = undefined
    this.authPromise = undefined
    this.defaultSessionId = undefined
    this.abortAllActiveTurns()
    this.sessions.clear()
    this.dispatcher.failAll(error ?? new Error(`${this.label} transport closed`))
  }
}
