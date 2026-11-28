import type { JsonRpcError, JsonRpcMessage, JsonRpcTransport } from './types.js'

export interface PendingRpcRequest {
  readonly id: number
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export interface ManagedRpcRequestContext {
  readonly id: number
  readonly isPending: () => boolean
  readonly setTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void
  readonly clearTimer: () => void
  readonly fail: (error: Error) => boolean
}

export interface JsonRpcDispatcherOptions {
  readonly label: string
  readonly defaultTimeoutMs: number
  readonly createRpcError: (method: string, error: JsonRpcError) => Error
}

/**
 * Shared JSON-RPC 2.0 request/response/notification tracker bound to a
 * replaceable `JsonRpcTransport`. Centralizes request ID allocation, timeout
 * teardown, response matching, safe notify/respond writes, and bulk failure
 * on transport close.
 */
export class JsonRpcDispatcher {
  private readonly label: string
  private readonly defaultTimeoutMs: number
  private readonly createRpcError: (method: string, error: JsonRpcError) => Error
  private transport?: JsonRpcTransport
  private nextId = 1
  private readonly pending = new Map<number, PendingRpcRequest>()

  constructor(options: JsonRpcDispatcherOptions) {
    this.label = options.label
    this.defaultTimeoutMs = options.defaultTimeoutMs
    this.createRpcError = options.createRpcError
  }

  get activeTransport(): JsonRpcTransport | undefined {
    return this.transport
  }

  attach(transport: JsonRpcTransport): void {
    this.transport = transport
  }

  detach(expected?: JsonRpcTransport): JsonRpcTransport | undefined {
    if (expected && this.transport !== expected) return undefined
    const prev = this.transport
    this.transport = undefined
    return prev
  }

  request(method: string, params: unknown, timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    return this.sendManagedRequest(method, params, (ctx) => {
      const timer = setTimeout(() => {
        ctx.fail(new Error(`${this.label} RPC "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      ctx.setTimer(timer)
    })
  }

  /**
   * Send a JSON-RPC request whose timeout lifecycle is controlled externally
   * (e.g. ACP `session/prompt` activity-resetting idle timer + cancel grace).
   */
  sendManagedRequest(
    method: string,
    params: unknown,
    configure?: (ctx: ManagedRpcRequestContext) => void,
  ): Promise<unknown> {
    const transport = this.transport
    if (!transport) {
      return Promise.reject(new Error(`cannot send ${this.label} RPC "${method}": transport closed`))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const entry: PendingRpcRequest = { id, method, resolve, reject }
      const clearTimer = () => {
        if (entry.timer) {
          clearTimeout(entry.timer)
          entry.timer = undefined
        }
      }
      const ctx: ManagedRpcRequestContext = {
        id,
        isPending: () => this.pending.get(id) === entry,
        setTimer: (timer) => {
          clearTimer()
          entry.timer = timer
        },
        clearTimer,
        fail: (error) => {
          if (this.pending.get(id) !== entry) return false
          this.pending.delete(id)
          clearTimer()
          reject(error)
          return true
        },
      }

      this.pending.set(id, entry)
      configure?.(ctx)
      try {
        transport.send({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimer()
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  notify(method: string, params: unknown, swallowError = true): void {
    if (!this.transport) return
    if (!swallowError) {
      this.transport.send({ jsonrpc: '2.0', method, params })
      return
    }
    try {
      this.transport.send({ jsonrpc: '2.0', method, params })
    } catch {
      // Transport closed while delivering fire-and-forget notification.
    }
  }

  respond(id: number | string, result: unknown): void {
    try {
      this.transport?.send({ jsonrpc: '2.0', id, result })
    } catch {
      // Transport closed while preparing response.
    }
  }

  /**
   * Match an incoming JSON-RPC response message against pending requests.
   * Returns `true` when the message was a response (matched or stale numeric id).
   */
  handleResponse(msg: JsonRpcMessage): boolean {
    if (typeof msg.id !== 'number' || msg.method) {
      return false
    }
    const pending = this.pending.get(msg.id)
    if (!pending) return true
    this.pending.delete(msg.id)
    if (pending.timer) clearTimeout(pending.timer)
    if (msg.error) {
      pending.reject(this.createRpcError(pending.method, msg.error))
    } else {
      pending.resolve(msg.result)
    }
    return true
  }

  failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}
