import type { CodexApprovalDecision, CodexModelInfo, CodexSandboxMode } from './types.js'

export function extractCodexNotificationThreadId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined
  const rec = params as Record<string, unknown>
  const direct =
    typeof rec.threadId === 'string'
      ? rec.threadId
      : typeof rec.thread_id === 'string'
        ? rec.thread_id
        : undefined
  if (direct?.trim()) return direct.trim()
  const turn =
    rec.turn && typeof rec.turn === 'object' ? (rec.turn as Record<string, unknown>) : undefined
  if (typeof turn?.threadId === 'string' && turn.threadId.trim()) return turn.threadId.trim()
  if (typeof turn?.thread_id === 'string' && turn.thread_id.trim()) return turn.thread_id.trim()
  const thread =
    rec.thread && typeof rec.thread === 'object'
      ? (rec.thread as Record<string, unknown>)
      : undefined
  if (typeof thread?.id === 'string' && thread.id.trim()) return thread.id.trim()
  return undefined
}

export function sandboxPolicyForTurn(sandbox?: CodexSandboxMode): Record<string, unknown> | undefined {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (sandbox === 'workspace-write') return { type: 'workspaceWrite' }
  if (sandbox === 'read-only') return { type: 'readOnly' }
  return undefined
}

export function mapApprovalResponse(method: string, decision: CodexApprovalDecision): unknown {
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

export function parseModelList(result: unknown): { models: CodexModelInfo[]; nextCursor?: string } {
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
