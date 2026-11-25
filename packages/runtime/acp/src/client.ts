import { AcpRpcError, isAuthRequired, isMethodNotFound, isResourceNotFound } from './errors.js'
import {
  extractAcpPromptUsage,
  normalizeAcpPermissionRequest,
  normalizeAcpSessionUpdate,
  parseAcpCatalog,
  parseAcpInitializeResult,
  pickDefaultAllowOptionId,
} from './event-normalizer.js'
import { AcpStdioTransport } from './stdio-transport.js'
import type {
  AcpActiveToolCall,
  AcpAgentCapabilities,
  AcpCatalogSnapshot,
  AcpInitializeResult,
  AcpJsonRpcMessage,
  AcpJsonRpcTransport,
  AcpPromptBlock,
  AcpRuntimeOptions,
  AcpStartOptions,
  AcpTokenUsage,
  AcpTransportFactoryOptions,
  AcpTurnHandlers,
  AcpTurnResult,
} from './types.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
/** `initialize` also covers process cold start (e.g. `npx` fetching the agent package). */
const STARTUP_TIMEOUT_MS = 5 * 60_000
/**
 * Default inactivity timeout for an in-flight `session/prompt` turn.
 * Unlike a fixed wall-clock deadline, this timer resets on every `session/update`
 * and pauses while waiting for an interactive permission response so active long
 * runs are never terminated mid-progress.
 */
export const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_CANCEL_GRACE_TIMEOUT_MS = 5_000

interface PendingRequest {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

interface ActiveTurnContext {
  text: string
  usage?: AcpTokenUsage
  cancelPending: boolean
  readonly activeTools: Map<string, AcpActiveToolCall>
  readonly handlers: AcpTurnHandlers
  readonly abortController: AbortController
  touchActivity?: () => void
  pauseIdleTimer?: () => void
  resumeIdleTimer?: () => void
  beginCancelGrace?: () => void
}

interface OpenedSession {
  readonly sessionId: string
  readonly result: unknown
}

/** Generic Agent Client Protocol (ACP) client over a stdio JSON-RPC transport. */
export class AcpRuntimeClient {
  private readonly cwd: string
  private readonly command: string
  private readonly args: readonly string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly defaultAuthMethodId?: string
  private readonly defaultSessionMeta?: Readonly<Record<string, unknown>>
  private readonly label: string
  private readonly requestTimeoutMs: number
  private readonly promptIdleTimeoutMs: number
  private readonly cancelGraceTimeoutMs: number
  private readonly clientName: string
  private readonly clientVersion: string
  private readonly logger: (message: string) => void
  private readonly transportFactory: (options: AcpTransportFactoryOptions) => AcpJsonRpcTransport

  private transport?: AcpJsonRpcTransport
  private nextId = 1
  private initResult?: AcpInitializeResult
  private authenticatedMethodId?: string
  private closed = false
  private currentSessionId?: string
  private catalogSnapshot?: AcpCatalogSnapshot
  private activeTurn?: ActiveTurnContext
  private readonly pending = new Map<number, PendingRequest>()

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
    this.promptIdleTimeoutMs =
      options.promptIdleTimeoutMs !== undefined && Number.isFinite(options.promptIdleTimeoutMs)
        ? Math.max(0, options.promptIdleTimeoutMs)
        : DEFAULT_PROMPT_IDLE_TIMEOUT_MS
    this.cancelGraceTimeoutMs =
      options.cancelGraceTimeoutMs !== undefined && Number.isFinite(options.cancelGraceTimeoutMs)
        ? Math.max(10, options.cancelGraceTimeoutMs)
        : DEFAULT_CANCEL_GRACE_TIMEOUT_MS
    this.clientName = options.clientName ?? 'dsh-external-agents'
    this.clientVersion = options.clientVersion ?? '0.1.0'
    this.logger = options.logger ?? (() => {})
    this.transportFactory = options.transportFactory ?? ((opts) => new AcpStdioTransport(opts))
  }

  get sessionId(): string | undefined {
    return this.currentSessionId
  }

  get catalog(): AcpCatalogSnapshot | undefined {
    return this.catalogSnapshot
  }

  /** Result of the most recent `initialize` handshake. */
  get initializeResult(): AcpInitializeResult | undefined {
    return this.initResult
  }

  get isConnected(): boolean {
    return Boolean(this.transport && this.initResult && !this.closed)
  }

  async initialize(): Promise<AcpInitializeResult> {
    if (this.initResult && this.transport && !this.closed) return this.initResult
    this.closed = false
    const transport = this.transportFactory({
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      env: this.env,
    })
    this.transport = transport
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
      if (this.transport === transport) {
        this.transport = undefined
        this.initResult = undefined
        this.authenticatedMethodId = undefined
      }
      await transport.close().catch(() => {})
      throw err
    }
  }

  async authenticate(methodId: string): Promise<void> {
    const clean = methodId.trim()
    if (!clean) return
    const init = await this.initialize()
    if (init.authMethods.length > 0 && !init.authMethods.some((m) => m.id === clean)) {
      const supported = init.authMethods.map((m) => m.id).join(', ')
      throw new Error(`${this.label} unsupported authMethod "${clean}" (available: ${supported})`)
    }
    await this.request('authenticate', { methodId: clean })
    this.authenticatedMethodId = clean
  }

  /**
   * Open a session. With `sessionId`, recovery follows negotiated capabilities:
   * `session/resume` first (unless declared unsupported), then `session/load`
   * when the agent advertises `loadSession`, otherwise a fresh `session/new`.
   * The returned id differs from `options.sessionId` only in the last case.
   */
  async startOrResume(options: AcpStartOptions = {}): Promise<string> {
    const init = await this.initialize()
    const targetAuthMethod = options.authMethodId?.trim() || this.defaultAuthMethodId
    if (targetAuthMethod && this.authenticatedMethodId !== targetAuthMethod) {
      await this.authenticate(targetAuthMethod)
    }
    const sessionMeta =
      options.sessionMeta && Object.keys(options.sessionMeta).length > 0
        ? options.sessionMeta
        : this.defaultSessionMeta
    const open = (): Promise<OpenedSession> =>
      options.sessionId
        ? this.restoreSession(options.sessionId, init.agentCapabilities, sessionMeta)
        : this.newSession(sessionMeta)

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
    this.currentSessionId = opened.sessionId
    const parsedCatalog = parseAcpCatalog(opened.result)
    this.catalogSnapshot =
      init.authMethods.length > 0
        ? { ...parsedCatalog, authMethods: init.authMethods }
        : parsedCatalog

    const normalized = this.normalizeModelAndThought(options.modelId, options.thoughtLevel)
    if (normalized.modelId && normalized.modelId !== this.catalogSnapshot.currentModelId) {
      await this.applyStartModel(normalized.modelId)
    }
    if (normalized.thoughtLevel && normalized.thoughtLevel !== this.catalogSnapshot.currentThoughtLevel) {
      await this.applyStartThoughtLevel(normalized.thoughtLevel)
    }
    if (options.modeId && options.modeId !== this.catalogSnapshot.currentModeId) {
      await this.setMode(options.modeId)
    }
    return opened.sessionId
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.currentSessionId) return
    const normalized = this.normalizeModelAndThought(modelId, undefined)
    const targetModelId = normalized.modelId ?? modelId
    const configId = this.catalogSnapshot?.modelConfigOptionId
    if (configId) {
      const res = await this.request('session/set_config_option', {
        sessionId: this.currentSessionId,
        configId,
        value: targetModelId,
      })
      this.mergeConfigOptionsSnapshot(res, { currentModelId: targetModelId })
      if (normalized.inferredThoughtLevel) {
        await this.setThoughtLevel(normalized.inferredThoughtLevel)
      }
    } else {
      await this.request('session/set_model', {
        sessionId: this.currentSessionId,
        modelId: targetModelId,
      })
      if (this.catalogSnapshot) {
        this.catalogSnapshot = { ...this.catalogSnapshot, currentModelId: targetModelId }
      }
    }
  }

  async setThoughtLevel(thoughtLevel: string): Promise<void> {
    if (!this.currentSessionId) return
    const snap = this.catalogSnapshot
    const configId = snap?.thoughtConfigOptionId
    if (!configId) return

    const available = snap?.thoughtLevels ?? []
    let targetValue = thoughtLevel.trim()
    if (!targetValue) {
      if (available.some((t) => t.id === 'default')) {
        targetValue = 'default'
      } else {
        const currentModel = snap?.models.find((m) => m.id === snap.currentModelId)
        targetValue = currentModel?.defaultThoughtLevel ?? ''
      }
    }
    if (!targetValue) return
    if (available.length > 0 && !available.some((t) => t.id === targetValue)) {
      this.logger(`${this.label} skipping unsupported thoughtLevel "${targetValue}"`)
      return
    }
    const res = await this.request('session/set_config_option', {
      sessionId: this.currentSessionId,
      configId,
      value: targetValue,
    })
    this.mergeConfigOptionsSnapshot(res, { currentThoughtLevel: targetValue })
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.currentSessionId) return
    await this.request('session/set_mode', {
      sessionId: this.currentSessionId,
      modeId,
    })
    if (this.catalogSnapshot) {
      this.catalogSnapshot = { ...this.catalogSnapshot, currentModeId: modeId }
    }
  }

  async runTurn(
    prompt: readonly AcpPromptBlock[],
    handlers: AcpTurnHandlers = {},
    signal?: AbortSignal,
  ): Promise<AcpTurnResult> {
    if (!this.currentSessionId) {
      throw new Error('AcpRuntimeClient.runTurn called before startOrResume()')
    }
    if (this.activeTurn) {
      throw new Error('AcpRuntimeClient already has an active turn in flight')
    }
    if (signal?.aborted) {
      return { text: '', stopReason: 'cancelled' }
    }

    const abortController = new AbortController()
    const turn: ActiveTurnContext = {
      text: '',
      cancelPending: false,
      activeTools: new Map(),
      handlers,
      abortController,
    }
    this.activeTurn = turn

    const onExternalAbort = () => {
      turn.cancelPending = true
      abortController.abort(signal?.reason)
      turn.beginCancelGrace?.()
      this.notify('session/cancel', { sessionId: this.currentSessionId })
    }
    signal?.addEventListener('abort', onExternalAbort, { once: true })

    try {
      const res = (await this.requestPrompt(
        this.currentSessionId,
        prompt,
        turn,
      )) as { stopReason?: string; usage?: unknown }
      const usage = extractAcpPromptUsage(res?.usage) ?? turn.usage
      if (usage) {
        try {
          handlers.onEvent?.({ type: 'usage', usage })
        } catch {
          // Isolate callback errors.
        }
      }
      return {
        text: turn.text,
        stopReason: res?.stopReason ?? 'end_turn',
        ...(usage ? { usage } : {}),
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort)
      abortController.abort()
      if (this.activeTurn === turn) {
        this.activeTurn = undefined
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const transport = this.transport
    this.transport = undefined
    this.initResult = undefined
    this.authenticatedMethodId = undefined
    this.failPending(new Error(`${this.label} runtime closed`))
    if (transport) {
      await transport.close()
    }
  }

  static async probeCatalog(options: AcpRuntimeOptions): Promise<AcpCatalogSnapshot> {
    const client = new AcpRuntimeClient(options)
    try {
      await client.startOrResume()
      return client.catalog ?? { models: [], modes: [] }
    } finally {
      await client.close()
    }
  }

  private async newSession(
    sessionMeta?: Readonly<Record<string, unknown>>,
  ): Promise<OpenedSession> {
    const res = (await this.request('session/new', {
      cwd: this.cwd,
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
    capabilities: AcpAgentCapabilities,
    sessionMeta?: Readonly<Record<string, unknown>>,
  ): Promise<OpenedSession> {
    const params = {
      sessionId,
      cwd: this.cwd,
      mcpServers: [],
      ...(sessionMeta ? { _meta: sessionMeta } : {}),
    }
    try {
      if (capabilities.resume !== 'unsupported') {
        try {
          return { sessionId, result: await this.request('session/resume', params) }
        } catch (err) {
          if (!isMethodNotFound(err)) throw err
          this.logger(`${this.label} does not implement session/resume; trying fallback`)
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
    return await this.newSession(sessionMeta)
  }

  private normalizeModelAndThought(
    rawModelId?: string,
    rawThoughtLevel?: string,
  ): { modelId?: string; thoughtLevel?: string; inferredThoughtLevel?: string } {
    const trimmedModel = rawModelId?.trim() || undefined
    const trimmedThought = rawThoughtLevel?.trim() || undefined
    const snap = this.catalogSnapshot
    if (!trimmedModel || !snap?.modelConfigOptionId || snap.models.length === 0) {
      return {
        ...(trimmedModel ? { modelId: trimmedModel } : {}),
        ...(trimmedThought ? { thoughtLevel: trimmedThought } : {}),
      }
    }
    if (snap.models.some((m) => m.id === trimmedModel)) {
      return {
        modelId: trimmedModel,
        ...(trimmedThought ? { thoughtLevel: trimmedThought } : {}),
      }
    }
    const match = /^(.*)-(low|medium|high|xhigh|max|ultra)$/i.exec(trimmedModel)
    if (match) {
      const baseId = match[1]!
      const suffix = match[2]!.toLowerCase()
      if (snap.models.some((m) => m.id === baseId)) {
        return {
          modelId: baseId,
          thoughtLevel: trimmedThought ?? suffix,
          inferredThoughtLevel: trimmedThought ?? suffix,
        }
      }
    }
    return {
      modelId: trimmedModel,
      ...(trimmedThought ? { thoughtLevel: trimmedThought } : {}),
    }
  }

  private mergeConfigOptionsSnapshot(
    rawResult: unknown,
    fallbackPatch: Partial<AcpCatalogSnapshot>,
  ): void {
    if (!this.catalogSnapshot) return
    if (
      rawResult &&
      typeof rawResult === 'object' &&
      Array.isArray((rawResult as Record<string, unknown>).configOptions)
    ) {
      const updated = parseAcpCatalog(rawResult)
      // Preserve per-model thoughtLevels metadata parsed from initial session/new
      const mergedModels =
        updated.models.length > 0
          ? updated.models.map((m) => {
              const prev = this.catalogSnapshot?.models.find((pm) => pm.id === m.id)
              return prev?.thoughtLevels ? { ...m, thoughtLevels: prev.thoughtLevels, ...(prev.defaultThoughtLevel ? { defaultThoughtLevel: prev.defaultThoughtLevel } : {}) } : m
            })
          : this.catalogSnapshot.models
      this.catalogSnapshot = {
        ...this.catalogSnapshot,
        ...fallbackPatch,
        models: mergedModels,
        thoughtLevels: updated.thoughtLevels,
        currentModelId: updated.currentModelId ?? fallbackPatch.currentModelId ?? this.catalogSnapshot.currentModelId,
        currentThoughtLevel: updated.currentThoughtLevel ?? fallbackPatch.currentThoughtLevel,
        thoughtConfigOptionId: updated.thoughtConfigOptionId,
      }
      return
    }
    this.catalogSnapshot = { ...this.catalogSnapshot, ...fallbackPatch }
  }

  private async applyStartModel(modelId: string): Promise<void> {
    const available = this.catalogSnapshot?.models ?? []
    if (available.length > 0 && !available.some((m) => m.id === modelId)) {
      this.logger(`${this.label} ignoring unknown modelId "${modelId}"`)
      return
    }
    try {
      await this.setModel(modelId)
    } catch (err) {
      this.logger(
        `${this.label} session/set_model(${modelId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private async applyStartThoughtLevel(thoughtLevel: string): Promise<void> {
    try {
      await this.setThoughtLevel(thoughtLevel)
    } catch (err) {
      this.logger(
        `${this.label} session/set_config_option(thought_level=${thoughtLevel}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  private requestPrompt(
    sessionId: string,
    prompt: readonly AcpPromptBlock[],
    turn: ActiveTurnContext,
  ): Promise<unknown> {
    if (!this.transport || this.closed) {
      return Promise.reject(new Error(`cannot send ${this.label} RPC "session/prompt": transport closed`))
    }
    const id = this.nextId++
    const idleTimeoutMs = this.promptIdleTimeoutMs
    let pendingPermissions = 0

    return new Promise((resolve, reject) => {
      const entry: PendingRequest = {
        method: 'session/prompt',
        resolve,
        reject,
      }

      const clearIdleTimer = () => {
        if (entry.timer) {
          clearTimeout(entry.timer)
          entry.timer = undefined
        }
      }

      const armIdleTimer = () => {
        clearIdleTimer()
        if (turn.cancelPending || idleTimeoutMs <= 0 || pendingPermissions > 0 || !this.pending.has(id)) return
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          entry.timer = undefined
          const err = new Error(
            `${this.label} RPC "session/prompt" idle timed out after ${idleTimeoutMs}ms without updates`,
          )
          turn.cancelPending = true
          turn.abortController.abort(err)
          this.notify('session/cancel', { sessionId })
          reject(err)
        }, idleTimeoutMs)
        entry.timer.unref?.()
      }

      turn.touchActivity = () => {
        if (turn.cancelPending) return
        armIdleTimer()
      }
      turn.pauseIdleTimer = () => {
        pendingPermissions += 1
        clearIdleTimer()
      }
      turn.resumeIdleTimer = () => {
        pendingPermissions = Math.max(0, pendingPermissions - 1)
        if (turn.cancelPending) return
        armIdleTimer()
      }
      turn.beginCancelGrace = () => {
        clearIdleTimer()
        if (!this.pending.has(id)) return
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          entry.timer = undefined
          reject(
            new Error(
              `${this.label} RPC "session/prompt" cancel timed out after ${this.cancelGraceTimeoutMs}ms`,
            ),
          )
        }, this.cancelGraceTimeoutMs)
        entry.timer.unref?.()
      }

      this.pending.set(id, entry)
      if (turn.cancelPending) {
        turn.beginCancelGrace()
      } else {
        armIdleTimer()
      }
      try {
        this.transport!.send({
          jsonrpc: '2.0',
          id,
          method: 'session/prompt',
          params: { sessionId, prompt },
        })
      } catch (err) {
        clearIdleTimer()
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (!this.transport || this.closed) {
      return Promise.reject(new Error(`cannot send ${this.label} RPC "${method}": transport closed`))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`${this.label} RPC "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.transport!.send({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private notify(method: string, params: unknown): void {
    try {
      this.transport?.send({ jsonrpc: '2.0', method, params })
    } catch {
      // Transport closed.
    }
  }

  private respond(id: number | string, result: unknown): void {
    try {
      this.transport?.send({ jsonrpc: '2.0', id, result })
    } catch {
      // Transport closed.
    }
  }

  private handleMessage(msg: AcpJsonRpcMessage): void {
    if (typeof msg.id === 'number' && !msg.method) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (msg.error) {
        pending.reject(new AcpRpcError(pending.method, msg.error))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (msg.id !== undefined && typeof msg.method === 'string') {
      void this.handleServerRequest(msg.id, msg.method, msg.params)
      return
    }

    if (msg.method === 'session/update') {
      this.handleSessionUpdate(msg.params)
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method !== 'session/request_permission') {
      this.respond(id, {})
      return
    }

    const request = normalizeAcpPermissionRequest(params)
    const turn = this.activeTurn
    if (!turn || turn.cancelPending) {
      this.respond(id, { outcome: { outcome: 'cancelled' } })
      return
    }
    const handler = turn.handlers.onPermission
    if (!handler) {
      turn.touchActivity?.()
      const optionId = pickDefaultAllowOptionId(request.options)
      this.respond(
        id,
        optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } },
      )
      return
    }

    turn.pauseIdleTimer?.()
    try {
      const outcome = await handler(request, turn.abortController.signal)
      if (!this.closed) {
        this.respond(id, { outcome })
      }
    } catch {
      if (!this.closed) {
        this.respond(id, { outcome: { outcome: 'cancelled' } })
      }
    } finally {
      turn.resumeIdleTimer?.()
    }
  }

  private handleSessionUpdate(params: unknown): void {
    const turn = this.activeTurn
    if (!turn) return
    turn.touchActivity?.()
    const events = normalizeAcpSessionUpdate(params, turn.activeTools)
    for (const event of events) {
      if (event.type === 'text-delta') {
        turn.text += event.text
      } else if (event.type === 'usage') {
        turn.usage = event.usage
      }
      try {
        turn.handlers.onEvent?.(event)
      } catch (err) {
        this.logger(`${this.label} event handler threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private handleTransportClosed(closedTransport: AcpJsonRpcTransport, error?: Error): void {
    if (this.transport !== closedTransport) return
    this.initResult = undefined
    this.authenticatedMethodId = undefined
    this.transport = undefined
    this.failPending(error ?? new Error(`${this.label} transport closed`))
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}
