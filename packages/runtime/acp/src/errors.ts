import type { AcpJsonRpcError } from './types.js'

/** JSON-RPC 2.0 "method not found". */
export const JSON_RPC_METHOD_NOT_FOUND = -32601

/** A JSON-RPC error response returned by the ACP agent, preserving its code. */
export class AcpRpcError extends Error {
  readonly method: string
  readonly code?: number
  readonly data?: unknown

  constructor(method: string, error: AcpJsonRpcError) {
    super(error.message || JSON.stringify(error))
    this.name = 'AcpRpcError'
    this.method = method
    if (error.code !== undefined) this.code = error.code
    if (error.data !== undefined) this.data = error.data
  }
}

export function isMethodNotFound(error: unknown): boolean {
  return error instanceof AcpRpcError && error.code === JSON_RPC_METHOD_NOT_FOUND
}

/** ACP "resource not found", e.g. resuming a session the agent never persisted. */
export const ACP_RESOURCE_NOT_FOUND = -32002

export function isResourceNotFound(error: unknown): boolean {
  return error instanceof AcpRpcError && error.code === ACP_RESOURCE_NOT_FOUND
}
