import {
  extractCodexToolComplete,
  extractCodexToolStart,
  unwrapShellCommand,
} from './tool-mapper.js'
import type {
  CodexApprovalRequest,
  CodexTokenUsage,
  CodexTurnEvent,
  CodexUserInputQuestion,
  CodexUserInputRequest,
} from './types.js'

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as JsonRecord
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

export function extractCodexTokenUsage(params: unknown): CodexTokenUsage | undefined {
  const root = asRecord(params)
  const tokenUsage = asRecord(root?.tokenUsage)
  const bucket = asRecord(tokenUsage?.last) ?? asRecord(tokenUsage?.total) ?? tokenUsage
  if (!bucket) return undefined

  const inputTokens = asNumber(bucket.inputTokens)
  const outputTokens = asNumber(bucket.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined

  const totalTokens = asNumber(bucket.totalTokens)
  const cacheReadTokens = asNumber(bucket.cachedInputTokens) ?? asNumber(bucket.cacheReadTokens)
  const cacheWriteTokens = asNumber(bucket.cacheWriteInputTokens) ?? asNumber(bucket.cacheWriteTokens)
  const reasoningTokens = asNumber(bucket.reasoningOutputTokens) ?? asNumber(bucket.reasoningTokens)

  return {
    inputTokens,
    outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  }
}

export function normalizeCodexNotification(
  method: string,
  params: unknown,
): readonly CodexTurnEvent[] {
  const p = asRecord(params)
  if (!p) return []

  if (method === 'item/agentMessage/delta') {
    const delta = asString(p.delta)
    return delta ? [{ type: 'text-delta', text: delta, phase: asString(p.phase) }] : []
  }

  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
    const delta = asString(p.delta)
    return delta ? [{ type: 'reasoning-delta', text: delta }] : []
  }

  if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
    const callId = asString(p.itemId) ?? asString(p.callId)
    const delta = asString(p.delta)
    return callId && delta ? [{ type: 'tool-output-delta', callId, delta }] : []
  }

  if (method === 'thread/tokenUsage/updated') {
    const usage = extractCodexTokenUsage(p)
    return usage ? [{ type: 'usage', usage }] : []
  }

  if (method === 'item/started') {
    const item = asRecord(p.item)
    if (!item) return []
    if (item.type === 'agentMessage') {
      const itemId = asString(item.id)
      const phase = asString(item.phase)
      return [
        {
          type: 'message-start',
          ...(itemId ? { itemId } : {}),
          ...(phase ? { phase } : {}),
        },
      ]
    }
    const tool = extractCodexToolStart(item)
    return tool ? [{ type: 'tool-start', ...tool }] : []
  }

  if (method === 'item/completed') {
    const item = asRecord(p.item)
    if (!item) return []
    const done = extractCodexToolComplete(item)
    return done ? [{ type: 'tool-complete', ...done }] : []
  }

  return []
}

export function normalizeCodexApprovalRequest(
  method: string,
  params: unknown,
): CodexApprovalRequest {
  const p = asRecord(params) ?? {}
  const callId = asString(p.itemId) ?? asString(p.callId)
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    const cmd = unwrapShellCommand(p.command ?? p.parsedCmd)
    const reason = asString(p.reason) ?? `Run command: ${cmd || safeJson(p.command ?? '')}`
    return { method, callId, toolName: 'bash', reason, rawParams: params }
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const reason = asString(p.reason) ?? 'Apply file changes'
    return { method, callId, toolName: 'apply_patch', reason, rawParams: params }
  }
  const reason = asString(p.reason) ?? `Codex permission request (${method})`
  return { method, callId, toolName: method, reason, rawParams: params }
}

export function normalizeCodexUserInputRequest(params: unknown): CodexUserInputRequest {
  const p = asRecord(params) ?? {}
  const rawQuestions = Array.isArray(p.questions) ? p.questions : []
  const questions: CodexUserInputQuestion[] = []
  for (let i = 0; i < rawQuestions.length; i += 1) {
    const q = asRecord(rawQuestions[i])
    if (!q) continue
    const rawOptions = Array.isArray(q.options) ? q.options : undefined
    const options = rawOptions
      ?.map((opt) => asRecord(opt))
      .filter((opt): opt is JsonRecord => opt !== undefined)
      .map((opt) => ({
        label: asString(opt.label) ?? '',
        ...(asString(opt.description) ? { description: asString(opt.description) } : {}),
      }))
      .filter((opt) => opt.label.length > 0)

    questions.push({
      id: asString(q.id) ?? `q_${i}`,
      ...(asString(q.header) ? { header: asString(q.header) } : {}),
      question: asString(q.question) ?? '',
      ...(options && options.length > 0 ? { options } : {}),
      ...(q.isMultiSelect === true || q.multiSelect === true ? { isMultiSelect: true } : {}),
    })
  }
  return {
    ...(asString(p.threadId) ? { threadId: asString(p.threadId) } : {}),
    ...(asString(p.turnId) ? { turnId: asString(p.turnId) } : {}),
    ...(asString(p.itemId) ?? asString(p.callId) ? { callId: asString(p.itemId) ?? asString(p.callId) } : {}),
    questions,
    rawParams: params,
  }
}
