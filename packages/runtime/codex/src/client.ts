import { basename } from 'node:path'
import {
  extractCodexTokenUsage,
  normalizeCodexApprovalRequest,
  normalizeCodexNotification,
  normalizeCodexUserInputRequest,
} from './event-normalizer.js'
import { CodexStdioTransport, resolveSafeCwd } from './stdio-transport.js'
import type {
  CodexApprovalDecision,
  CodexModelInfo,
  CodexRuntimeOptions,
  CodexSandboxMode,
  CodexStartOptions,
  CodexTokenUsage,
  CodexTransportFactoryOptions,
  CodexTurnHandlers,
  CodexTurnInput,
  CodexTurnResult,
  JsonRpcMessage,
  JsonRpcTransport,
} from './types.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_APP_SERVER_ARGS: readonly string[] = ['app-server', '--stdio']
const MAX_MODEL_LIST_PAGES = 20

interface PendingRequest {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ActiveTurnState {
  nativeTurnId?: string
  text: string
  currentItemStreamed: boolean
  usage?: CodexTokenUsage
  readonly handlers: CodexTurnHandlers
  readonly abortController: AbortController
  readonly settle: (result: CodexTurnResult) => void
  readonly fail: (error: Error) => void
}

function sandboxPolicyForTurn(sandbox?: CodexSandboxMode): Record<string, unknown> | undefined {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (sandbox === 'workspace-write') return { type: 'workspaceWrite' }
  if (sandbox === 'read-only') return { type: 'readOnly' }
  return undefined
}

function mapApprovalResponse(method: string, decision: CodexApprovalDecision): unknown {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    if (decision === 'allow-session') return { decision: 'approved_for_session' }
    if (decision === 'allow-once') return { decision: 'approved' }
    return { decision: 'denied' }
  }
  if (method === 'item/permissions/requestApproval') {
    return decision === 'reject'
      ? { permissions: {}, scope: 'turn', decision: 'decline' }
      : { permissions: {}, scope: 'turn' }
  }
  if (decision === 'allow-session') return { decision: 'acceptForSession' }
  if (decision === 'allow-once') return { decision: 'accept' }
  return { decision: 'decline' }
}

function parseModelList(result: unknown): { models: CodexModelInfo[]; nextCursor?: string } {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const models: CodexModelInfo[] = []
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (item.hidden === true || item.visibility === 'hidden') continue
    const id =
      typeof item.id === 'string' && item.id
        ? item.id
        : typeof item.model === 'string' && item.model
          ? item.model
          : typeof item.slug === 'string' && item.slug
            ? item.slug
            : ''
    if (!id) continue
    const name =
      typeof item.displayName === 'string' && item.displayName.trim()
        ? item.displayName.trim()
        : typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : id
    const rawEfforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts
      : Array.isArray(item.supported_reasoning_levels)
        ? item.supported_reasoning_levels
        : undefined
    const supportedReasoningEfforts = (rawEfforts ?? [])
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object') {
          const rec = entry as Record<string, unknown>
          if (typeof rec.reasoningEffort === 'string') return rec.reasoningEffort
          if (typeof rec.effort === 'string') return rec.effort
        }
        return ''
      })
      .filter((v) => v.length > 0)
    const defaultReasoningEffort =
      typeof item.defaultReasoningEffort === 'string' && item.defaultReasoningEffort.length > 0
        ? item.defaultReasoningEffort
        : typeof item.default_reasoning_level === 'string' && item.default_reasoning_level.length > 0
          ? item.default_reasoning_level
          : undefined
    const rawWindow =
      typeof item.contextWindow === 'number'
        ? item.contextWindow
        : typeof item.context_window === 'number'
          ? item.context_window
          : undefined
    const contextWindow =
      rawWindow !== undefined && Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : undefined
    models.push({
      id,
      name,
      supportedReasoningEfforts,
      ...(rawEfforts !== undefined ? { reasoningEffortsDeclared: true } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(item.isDefault === true ? { isDefault: true } : {}),
    })
  }
  const nextCursor =
    typeof record.nextCursor === 'string' && record.nextCursor.length > 0
      ? record.nextCursor
      : undefined
  return { models, ...(nextCursor ? { nextCursor } : {}) }
}

export class CodexRuntimeClient {
  private readonly cwd: string
  private readonly cliBin: string
  private readonly label: string
  private readonly args: readonly string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly requestTimeoutMs: number
  private readonly clientName: string
  private readonly clientVersion: string
  private readonly logger: (message: string) => void
  private readonly transportFactory: (options: CodexTransportFactoryOptions) => JsonRpcTransport

  private transport?: JsonRpcTransport
  private nextId = 1
  private initialized = false
  private closed = false
  private currentThreadId?: string
  private activeTurn?: ActiveTurnState
  private readonly pending = new Map<number, PendingRequest>()

  constructor(options: CodexRuntimeOptions) {
    this.cwd = resolveSafeCwd(options.cwd)
    this.cliBin = options.cliBin ?? 'codex'
    this.label = basename(this.cliBin) || 'codex'
    this.args = options.args ?? DEFAULT_APP_SERVER_ARGS
    this.env = options.env ?? process.env
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.clientName = options.clientName ?? 'dsh-external-agents'
    this.clientVersion = options.clientVersion ?? '0.1.0'
    this.logger = options.logger ?? (() => {})
    this.transportFactory = options.transportFactory ?? ((opts) => new CodexStdioTransport(opts))
  }

  get threadId(): string | undefined {
    return this.currentThreadId
  }

  get isConnected(): boolean {
    return Boolean(this.transport && this.initialized && !this.closed)
  }

  async initialize(): Promise<void> {
    if (this.initialized && this.transport && !this.closed) return
    this.closed = false
    const transport = this.transportFactory({
      cliBin: this.cliBin,
      args: this.args,
      cwd: this.cwd,
      env: this.env,
    })
    this.transport = transport
    transport.onMessage((msg) => this.handleMessage(msg))
    transport.onClose((err) => this.handleTransportClosed(err))

    await this.request('initialize', {
      clientInfo: { name: this.clientName, version: this.clientVersion },
      capabilities: { experimentalApi: true },
    })
    this.notify('initialized', {})
    this.initialized = true
  }

  async startOrResume(options: CodexStartOptions = {}): Promise<string> {
    await this.initialize()
    const approvalPolicy = options.approvalPolicy ?? 'never'
    const sandbox = options.sandbox ?? 'workspace-write'

    if (options.threadId) {
      const params: Record<string, unknown> = {
        threadId: options.threadId,
        cwd: this.cwd,
        approvalPolicy,
        sandbox,
        excludeTurns: true,
      }
      // Preserve persisted {model, provider, reasoning_effort} triple unless explicitly overridden.
      if (options.forceModelOverride) {
        const config: Record<string, unknown> = {}
        if (options.model) config.model = options.model
        if (options.reasoningEffort) config.model_reasoning_effort = options.reasoningEffort
        if (Object.keys(config).length > 0) params.config = config
      }
      const res = (await this.request('thread/resume', params)) as { thread?: { id?: string } }
      this.currentThreadId = res?.thread?.id || options.threadId
      return this.currentThreadId
    }

    const config: Record<string, unknown> = {}
    if (options.model) config.model = options.model
    if (options.reasoningEffort) config.model_reasoning_effort = options.reasoningEffort

    const res = (await this.request('thread/start', {
      cwd: this.cwd,
      approvalPolicy,
      sandbox,
      serviceName: options.serviceName ?? this.clientName,
      ephemeral: false,
      persistExtendedHistory: true,
      ...(options.model ? { model: options.model } : {}),
      ...(Object.keys(config).length > 0 ? { config } : {}),
    })) as { thread?: { id?: string } }

    const threadId = res?.thread?.id
    if (!threadId) throw new Error(`${this.label} thread/start returned no thread.id`)
    this.currentThreadId = threadId
    return threadId
  }

  async listModels(): Promise<readonly CodexModelInfo[]> {
    await this.initialize()
    const collected: CodexModelInfo[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page += 1) {
      const res = await this.request('model/list', cursor ? { cursor } : {})
      const parsed = parseModelList(res)
      collected.push(...parsed.models)
      if (!parsed.nextCursor || seenCursors.has(parsed.nextCursor)) break
      seenCursors.add(parsed.nextCursor)
      cursor = parsed.nextCursor
    }
    return collected
  }

  async runTurn(
    input: CodexTurnInput,
    handlers: CodexTurnHandlers = {},
    signal?: AbortSignal,
  ): Promise<CodexTurnResult> {
    if (!this.currentThreadId) {
      throw new Error('CodexRuntimeClient.runTurn called before startOrResume()')
    }
    if (this.activeTurn) {
      throw new Error('CodexRuntimeClient already has an active turn in flight')
    }
    if (signal?.aborted) {
      return { text: '', status: 'interrupted' }
    }

    const turnAbort = new AbortController()
    return await new Promise<CodexTurnResult>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        signal?.removeEventListener('abort', onExternalAbort)
        if (this.activeTurn?.abortController === turnAbort) {
          this.activeTurn = undefined
        }
        turnAbort.abort()
      }
      const settle = (result: CodexTurnResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }

      const onExternalAbort = () => {
        turnAbort.abort(signal?.reason)
        void this.interruptActiveTurn()
      }
      signal?.addEventListener('abort', onExternalAbort, { once: true })

      const state: ActiveTurnState = {
        text: '',
        currentItemStreamed: false,
        handlers,
        abortController: turnAbort,
        settle,
        fail,
      }
      this.activeTurn = state

      const inputBlocks: Record<string, unknown>[] = []
      if (input.text.length > 0) {
        inputBlocks.push({ type: 'text', text: input.text, text_elements: [] })
      }
      for (const image of input.images ?? []) {
        if (image.path) inputBlocks.push({ type: 'localImage', path: image.path })
        else if (image.url) inputBlocks.push({ type: 'image', url: image.url })
      }
      if (inputBlocks.length === 0) {
        inputBlocks.push({ type: 'text', text: '', text_elements: [] })
      }

      const sandboxPolicy = sandboxPolicyForTurn(input.sandbox)
      const params: Record<string, unknown> = {
        threadId: this.currentThreadId,
        input: inputBlocks,
        cwd: this.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
        ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
        ...(sandboxPolicy ? { sandboxPolicy } : {}),
      }

      this.request('turn/start', params)
        .then((res) => {
          const nativeId = (res as { turn?: { id?: string } } | undefined)?.turn?.id
          if (nativeId && this.activeTurn === state) {
            state.nativeTurnId = nativeId
          }
        })
        .catch((err: unknown) => {
          fail(err instanceof Error ? err : new Error(String(err)))
        })
    })
  }

  async interruptActiveTurn(): Promise<void> {
    if (!this.currentThreadId || !this.activeTurn?.nativeTurnId || this.closed) return
    try {
      await this.request('turn/interrupt', {
        threadId: this.currentThreadId,
        turnId: this.activeTurn.nativeTurnId,
      })
    } catch (err) {
      this.logger(`${this.label} turn/interrupt failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const transport = this.transport
    this.transport = undefined
    this.initialized = false
    this.failInflight(new Error(`${this.label} runtime closed`))
    if (transport) {
      await transport.close()
    }
  }

  static async probeModels(options: CodexRuntimeOptions): Promise<readonly CodexModelInfo[]> {
    const client = new CodexRuntimeClient(options)
    try {
      return await client.listModels()
    } finally {
      await client.close()
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.transport || this.closed) {
      return Promise.reject(new Error(`cannot send ${this.label} RPC "${method}": transport closed`))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`${this.label} RPC "${method}" timed out after ${this.requestTimeoutMs}ms`))
      }, this.requestTimeoutMs)
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
    this.transport?.send({ jsonrpc: '2.0', method, params })
  }

  private respond(id: number | string, result: unknown): void {
    try {
      this.transport?.send({ jsonrpc: '2.0', id, result })
    } catch {
      // Transport closed while preparing response.
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id === 'number' && !msg.method) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (msg.id !== undefined && typeof msg.method === 'string') {
      void this.handleServerRequest(msg.id, msg.method, msg.params)
      return
    }

    if (typeof msg.method === 'string') {
      this.handleNotification(msg.method, msg.params)
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const turn = this.activeTurn
    const signal = turn?.abortController.signal ?? new AbortController().signal

    if (method === 'item/tool/requestUserInput') {
      const handler = turn?.handlers.onUserInput
      if (!handler) {
        this.respond(id, { answers: {} })
        return
      }
      try {
        const answer = await handler(normalizeCodexUserInputRequest(params), signal)
        if (!signal.aborted && !this.closed) {
          this.respond(id, answer)
        }
      } catch (err) {
        this.logger(
          `codex requestUserInput failed; interrupting turn: ${err instanceof Error ? err.message : String(err)}`,
        )
        await this.interruptActiveTurn()
      }
      return
    }

    if (method === 'mcpServer/elicitation/request') {
      this.respond(id, { action: 'cancel', content: null, _meta: null })
      return
    }

    const approvalHandler = turn?.handlers.onApproval
    if (!approvalHandler) {
      this.respond(id, mapApprovalResponse(method, 'allow-session'))
      return
    }

    try {
      const decision = await approvalHandler(normalizeCodexApprovalRequest(method, params), signal)
      if (!signal.aborted && !this.closed) {
        this.respond(id, mapApprovalResponse(method, decision))
      }
    } catch {
      if (!this.closed) {
        this.respond(id, mapApprovalResponse(method, 'reject'))
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const turn = this.activeTurn
    if (!turn) return

    const events = normalizeCodexNotification(method, params)
    for (const event of events) {
      if (event.type === 'message-start') {
        turn.text = ''
        turn.currentItemStreamed = false
      } else if (event.type === 'tool-start') {
        turn.text = ''
        turn.currentItemStreamed = false
      } else if (event.type === 'text-delta') {
        turn.text += event.text
        turn.currentItemStreamed = true
      } else if (event.type === 'usage') {
        turn.usage = event.usage
      }
      try {
        turn.handlers.onEvent?.(event)
      } catch (err) {
        this.logger(`codex event handler threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (method === 'item/completed') {
      const item = (params as { item?: Record<string, unknown> } | undefined)?.item
      if (
        item?.type === 'agentMessage' &&
        typeof item.text === 'string' &&
        !turn.currentItemStreamed &&
        item.text
      ) {
        turn.text = item.text
        turn.currentItemStreamed = true
        try {
          turn.handlers.onEvent?.({
            type: 'text-delta',
            text: item.text,
            phase: typeof item.phase === 'string' ? item.phase : undefined,
          })
        } catch {
          // Isolate callback errors.
        }
      }
      return
    }

    if (method === 'turn/started') {
      const nativeId = (params as { turn?: { id?: string } } | undefined)?.turn?.id
      if (nativeId) turn.nativeTurnId = nativeId
      return
    }

    if (method === 'turn/completed') {
      const payload = (params as { turn?: Record<string, unknown> } | undefined)?.turn ?? {}
      const rawStatus = String(payload.status ?? 'completed').toLowerCase()
      const usage = extractCodexTokenUsage(params) ?? turn.usage
      const interrupted = ['interrupted', 'aborted', 'cancelled', 'canceled'].includes(rawStatus)
      const failed = Boolean(payload.error) || ['failed', 'error'].includes(rawStatus)
      const errorMessage = payload.error
        ? typeof payload.error === 'string'
          ? payload.error
          : JSON.stringify(payload.error)
        : undefined
      turn.settle({
        text: turn.text,
        status: interrupted ? 'interrupted' : failed ? 'failed' : 'completed',
        ...(usage ? { usage } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      })
      return
    }

    if (method === 'turn/aborted' || method === 'turn/cancelled' || method === 'turn/canceled') {
      turn.settle({
        text: turn.text,
        status: 'interrupted',
        ...(turn.usage ? { usage: turn.usage } : {}),
      })
      return
    }

    if (method === 'turn/failed' || method === 'turn/error') {
      const rawErr = (params as { error?: unknown } | undefined)?.error
      turn.settle({
        text: turn.text,
        status: 'failed',
        ...(turn.usage ? { usage: turn.usage } : {}),
        errorMessage: typeof rawErr === 'string' ? rawErr : JSON.stringify(rawErr ?? 'codex turn failed'),
      })
    }
  }

  private handleTransportClosed(error?: Error): void {
    this.initialized = false
    this.transport = undefined
    this.failInflight(error ?? new Error('codex app-server transport closed'))
  }

  private failInflight(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error)
    }
    if (this.activeTurn) {
      const turn = this.activeTurn
      this.activeTurn = undefined
      turn.fail(error)
    }
  }
}
