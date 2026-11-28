import { basename } from 'node:path'
import { JsonRpcDispatcher } from '@dsh-external-agents/runtime-shared-stdio'
import {
  extractCodexTokenUsage,
  normalizeCodexApprovalRequest,
  normalizeCodexNotification,
  normalizeCodexUserInputRequest,
} from './event-normalizer.js'
import {
  extractCodexNotificationThreadId,
  mapApprovalResponse,
  parseModelList,
  sandboxPolicyForTurn,
} from './protocol-helpers.js'
import { CodexStdioTransport, resolveSafeCwd } from './stdio-transport.js'
import type {
  CodexModelInfo,
  CodexRuntimeOptions,
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
const CODEX_RESOURCE_NOT_FOUND_CODE = -32002
const THREAD_NOT_FOUND_RE =
  /no rollout found|thread\s+\S*\s*not found|session\s+\S*\s*not found|unknown thread/i

/** Error returned by a Codex/TRAE app-server JSON-RPC response, preserving its error code and data. */
export class CodexRpcError extends Error {
  readonly method: string
  readonly code?: number
  readonly data?: unknown

  constructor(method: string, error: { readonly code?: number; readonly message?: string; readonly data?: unknown }) {
    super(error.message || JSON.stringify(error))
    this.name = 'CodexRpcError'
    this.method = method
    this.code = error.code
    this.data = error.data
  }
}

/** True when `thread/resume` failed because the stored thread/rollout no longer exists. */
export function isThreadNotFoundError(err: unknown): boolean {
  if (err instanceof CodexRpcError && err.code === CODEX_RESOURCE_NOT_FOUND_CODE) {
    return true
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return THREAD_NOT_FOUND_RE.test(message)
}

interface ActiveTurnState {
  nativeTurnId?: string
  cancelRequested?: boolean
  text: string
  currentItemStreamed: boolean
  usage?: CodexTokenUsage
  readonly handlers: CodexTurnHandlers
  readonly abortController: AbortController
  readonly settle: (result: CodexTurnResult) => void
  readonly fail: (error: Error) => void
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
  private readonly dispatcher: JsonRpcDispatcher

  private initialized = false
  private closed = false
  private currentThreadId?: string
  private pendingTurnSelection?: { readonly model?: string; readonly reasoningEffort?: string }
  private activeTurn?: ActiveTurnState

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
    this.dispatcher = new JsonRpcDispatcher({
      label: this.label,
      defaultTimeoutMs: this.requestTimeoutMs,
      createRpcError: (method, error) => new CodexRpcError(method, error),
    })
  }

  get threadId(): string | undefined {
    return this.currentThreadId
  }

  get isConnected(): boolean {
    return Boolean(this.dispatcher.activeTransport && this.initialized && !this.closed)
  }

  async initialize(): Promise<void> {
    if (this.initialized && this.dispatcher.activeTransport && !this.closed) return
    this.closed = false
    const transport = this.transportFactory({
      cliBin: this.cliBin,
      args: this.args,
      cwd: this.cwd,
      env: this.env,
    })
    this.dispatcher.attach(transport)
    transport.onMessage((msg) => this.handleMessage(msg))
    transport.onClose((err) => this.handleTransportClosed(transport, err))

    try {
      await this.request('initialize', {
        clientInfo: { name: this.clientName, version: this.clientVersion },
        capabilities: { experimentalApi: true },
      })
      this.dispatcher.notify('initialized', {}, false)
      this.initialized = true
    } catch (err) {
      if (this.dispatcher.detach(transport)) {
        this.initialized = false
      }
      await transport.close().catch(() => {})
      throw err
    }
  }

  async startOrResume(options: CodexStartOptions = {}): Promise<string> {
    await this.initialize()
    const approvalPolicy = options.approvalPolicy ?? 'never'
    const sandbox = options.sandbox ?? 'workspace-write'
    this.pendingTurnSelection = undefined

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
      try {
        const res = (await this.request('thread/resume', params)) as {
          thread?: { id?: string; model?: string }
          model?: string
          reasoningEffort?: string
        }
        this.currentThreadId = res?.thread?.id || options.threadId
        if (!options.forceModelOverride) {
          const resumedModel =
            typeof res?.model === 'string' && res.model
              ? res.model
              : typeof res?.thread?.model === 'string' && res.thread.model
                ? res.thread.model
                : undefined
          const resumedEffort =
            typeof res?.reasoningEffort === 'string' && res.reasoningEffort
              ? res.reasoningEffort
              : undefined
          const modelNeedsApply = Boolean(options.model && (!resumedModel || options.model !== resumedModel))
          const effortNeedsApply = Boolean(
            options.reasoningEffort && (!resumedEffort || options.reasoningEffort !== resumedEffort),
          )
          if (modelNeedsApply || effortNeedsApply) {
            this.pendingTurnSelection = {
              ...(options.model ? { model: options.model } : {}),
              ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
            }
          }
        }
        return this.currentThreadId
      } catch (err) {
        if (!isThreadNotFoundError(err)) throw err
        this.logger(
          `${this.label} thread ${options.threadId} not found; starting a new thread`,
        )
      }
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
        state.cancelRequested = true
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
      const pendingSelection = this.pendingTurnSelection
      this.pendingTurnSelection = undefined
      const effectiveModel = input.model ?? pendingSelection?.model
      const effectiveEffort = input.reasoningEffort ?? pendingSelection?.reasoningEffort
      const params: Record<string, unknown> = {
        threadId: this.currentThreadId,
        input: inputBlocks,
        cwd: this.cwd,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
        ...(sandboxPolicy ? { sandboxPolicy } : {}),
      }

      this.request('turn/start', params)
        .then((res) => {
          const nativeId = (res as { turn?: { id?: string } } | undefined)?.turn?.id
          if (nativeId && this.activeTurn === state) {
            const wasUnset = !state.nativeTurnId
            state.nativeTurnId = nativeId
            if (wasUnset && state.cancelRequested) {
              void this.interruptActiveTurn()
            }
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
    const transport = this.dispatcher.detach()
    this.initialized = false
    this.pendingTurnSelection = undefined
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
    if (this.closed) {
      return Promise.reject(new Error(`cannot send ${this.label} RPC "${method}": transport closed`))
    }
    return this.dispatcher.request(method, params)
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (this.dispatcher.handleResponse(msg)) return

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
    const incomingThreadId = extractCodexNotificationThreadId(params)
    if (incomingThreadId && this.currentThreadId && incomingThreadId !== this.currentThreadId) {
      this.logger(
        `${this.label} declining server request "${method}" for foreign thread ${incomingThreadId} (current=${this.currentThreadId})`,
      )
      if (method === 'item/tool/requestUserInput') {
        this.dispatcher.respond(id, { answers: {} })
      } else if (method === 'mcpServer/elicitation/request') {
        this.dispatcher.respond(id, { action: 'cancel', content: null, _meta: null })
      } else {
        this.dispatcher.respond(id, mapApprovalResponse(method, 'reject'))
      }
      return
    }

    const turn = this.activeTurn
    const signal = turn?.abortController.signal ?? new AbortController().signal

    if (method === 'item/tool/requestUserInput') {
      const handler = turn?.handlers.onUserInput
      if (!handler) {
        this.dispatcher.respond(id, { answers: {} })
        return
      }
      try {
        const answer = await handler(normalizeCodexUserInputRequest(params), signal)
        if (!signal.aborted && !this.closed) {
          this.dispatcher.respond(id, answer)
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
      this.dispatcher.respond(id, { action: 'cancel', content: null, _meta: null })
      return
    }

    const approvalHandler = turn?.handlers.onApproval
    if (!approvalHandler) {
      this.dispatcher.respond(id, mapApprovalResponse(method, 'allow-session'))
      return
    }

    try {
      const decision = await approvalHandler(normalizeCodexApprovalRequest(method, params), signal)
      if (!signal.aborted && !this.closed) {
        this.dispatcher.respond(id, mapApprovalResponse(method, decision))
      }
    } catch {
      if (!this.closed) {
        this.dispatcher.respond(id, mapApprovalResponse(method, 'reject'))
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const turn = this.activeTurn
    if (!turn) return

    const incomingThreadId = extractCodexNotificationThreadId(params)
    if (incomingThreadId && this.currentThreadId && incomingThreadId !== this.currentThreadId) {
      this.logger(
        `${this.label} ignoring notification "${method}" for foreign thread ${incomingThreadId} (current=${this.currentThreadId})`,
      )
      return
    }

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
      if (nativeId) {
        const wasUnset = !turn.nativeTurnId
        turn.nativeTurnId = nativeId
        if (wasUnset && turn.cancelRequested) {
          void this.interruptActiveTurn()
        }
      }
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

  private handleTransportClosed(closedTransport: JsonRpcTransport, error?: Error): void {
    if (!this.dispatcher.detach(closedTransport)) return
    this.initialized = false
    this.pendingTurnSelection = undefined
    this.failInflight(error ?? new Error('codex app-server transport closed'))
  }

  private failInflight(error: Error): void {
    this.dispatcher.failAll(error)
    if (this.activeTurn) {
      const turn = this.activeTurn
      this.activeTurn = undefined
      turn.fail(error)
    }
  }
}
