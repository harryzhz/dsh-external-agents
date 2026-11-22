import {
  processAcpToolSessionUpdate,
  resolveAcpPermissionToolName,
} from './tool-mapper.js'
import type {
  AcpActiveToolCall,
  AcpAgentCapabilities,
  AcpAuthMethod,
  AcpCatalogSnapshot,
  AcpInitializeResult,
  AcpModeInfo,
  AcpModelInfo,
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpThoughtLevelInfo,
  AcpTokenUsage,
  AcpTurnEvent,
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

export function extractAcpPromptUsage(usageRaw: unknown): AcpTokenUsage | undefined {
  const u = asRecord(usageRaw)
  if (!u) return undefined
  const inputTokens = asNumber(u.inputTokens)
  const outputTokens = asNumber(u.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const totalTokens = asNumber(u.totalTokens)
  const cacheReadTokens = asNumber(u.cachedReadTokens) ?? asNumber(u.cacheReadTokens)
  const cacheWriteTokens = asNumber(u.cachedWriteTokens) ?? asNumber(u.cacheWriteTokens)
  const reasoningTokens = asNumber(u.thoughtTokens) ?? asNumber(u.reasoningTokens)
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  }
}

export function parseAcpInitializeResult(result: unknown): AcpInitializeResult {
  const root = asRecord(result) ?? {}
  const caps = asRecord(root.agentCapabilities) ?? {}
  const sessionCaps = asRecord(caps.sessionCapabilities)
  const promptCaps = asRecord(caps.promptCapabilities)
  const resume: AcpAgentCapabilities['resume'] = !sessionCaps
    ? 'unknown'
    : sessionCaps.resume !== undefined && sessionCaps.resume !== null && sessionCaps.resume !== false
      ? 'supported'
      : 'unsupported'

  const authMethods: AcpAuthMethod[] = []
  for (const raw of Array.isArray(root.authMethods) ? root.authMethods : []) {
    const m = asRecord(raw)
    const id = asString(m?.id)
    if (!m || !id) continue
    authMethods.push({
      id,
      name: asString(m.name) ?? id,
      ...(asString(m.description) ? { description: asString(m.description) } : {}),
    })
  }

  const info = asRecord(root.agentInfo)
  const protocolVersion = asNumber(root.protocolVersion)
  return {
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    agentCapabilities: {
      loadSession: caps.loadSession === true,
      resume,
      promptImage: promptCaps?.image === true,
    },
    authMethods,
    ...(info ? { agentInfo: { name: asString(info.name), version: asString(info.version) } } : {}),
    raw: result,
  }
}

function parseInfoList(raw: unknown, idKeys: readonly string[]): AcpModelInfo[] {
  const out: AcpModelInfo[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    const m = asRecord(entry)
    if (!m) continue
    const id = idKeys.map((key) => asString(m[key])).find((v) => v !== undefined)
    if (!id) continue
    out.push({
      id,
      name: asString(m.name) ?? id,
      ...(asString(m.description) ? { description: asString(m.description) } : {}),
    })
  }
  return out
}

/** Flatten `select` config option values; ACP allows grouped (`{ group, options }`) entries. */
function flattenSelectOptions(raw: unknown): unknown[] {
  return (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    const rec = asRecord(entry)
    return rec && Array.isArray(rec.options) ? rec.options : [entry]
  })
}

interface SelectConfigOption {
  readonly id: string
  readonly currentValue?: string
  readonly values: readonly AcpModelInfo[]
}

function findSelectConfigOption(root: JsonRecord, category: string): SelectConfigOption | undefined {
  for (const entry of Array.isArray(root.configOptions) ? root.configOptions : []) {
    const opt = asRecord(entry)
    const id = asString(opt?.id)
    if (!opt || !id || opt.category !== category || opt.type !== 'select') continue
    const currentValue = asString(opt.currentValue)
    return {
      id,
      ...(currentValue ? { currentValue } : {}),
      values: parseInfoList(flattenSelectOptions(opt.options), ['value']),
    }
  }
  return undefined
}

/**
 * Read models/modes/thoughtLevels from a session/new|load|resume|set_config_option result.
 * Prefers structured `configOptions` (`category: "model"` + `category: "thought_level"`) when
 * present so runtimes like Antigravity expose base models + per-model thinking effort instead
 * of pre-multiplied `(Low)/(Medium)/(High)/(XHigh)` entries.
 */
export function parseAcpCatalog(sessionResult: unknown): AcpCatalogSnapshot {
  const root = asRecord(sessionResult) ?? {}
  const modelsNode = asRecord(root.models)
  const modesNode = asRecord(root.modes)
  const modelOption = findSelectConfigOption(root, 'model')
  const modeOption = modesNode ? undefined : findSelectConfigOption(root, 'mode')
  const thoughtOption = findSelectConfigOption(root, 'thought_level')

  const legacyFlatModels = modelsNode
    ? parseInfoList(modelsNode.availableModels, ['modelId', 'id'])
    : []
  const legacyCurrentModelId = asString(modelsNode?.currentModelId)

  const rawThoughtLevels: AcpThoughtLevelInfo[] = (thoughtOption?.values ?? []).map((v) => ({
    id: v.id,
    name: v.name,
  }))
  const selectableThoughtLevels = rawThoughtLevels.filter((lvl) => lvl.id !== 'default')

  let models: readonly AcpModelInfo[]
  if (modelOption && modelOption.values.length > 0) {
    const legacyIds = new Set(legacyFlatModels.map((m) => m.id))
    const candidateLevels: readonly AcpThoughtLevelInfo[] =
      selectableThoughtLevels.length > 0
        ? selectableThoughtLevels
        : [
            { id: 'low', name: 'Low' },
            { id: 'medium', name: 'Medium' },
            { id: 'high', name: 'High' },
            { id: 'xhigh', name: 'XHigh' },
            { id: 'max', name: 'Max' },
            { id: 'ultra', name: 'Ultra' },
          ]

    models = modelOption.values.map((base) => {
      if (legacyIds.size > 0) {
        const supported = candidateLevels.filter((lvl) => legacyIds.has(`${base.id}-${lvl.id}`))
        let defaultThoughtLevel: string | undefined
        if (supported.length > 0) {
          if (legacyCurrentModelId?.startsWith(`${base.id}-`)) {
            const suffix = legacyCurrentModelId.slice(base.id.length + 1)
            if (supported.some((s) => s.id === suffix)) defaultThoughtLevel = suffix
          }
          if (!defaultThoughtLevel) {
            const firstLegacy = legacyFlatModels.find((lm) =>
              supported.some((s) => lm.id === `${base.id}-${s.id}`),
            )
            if (firstLegacy) {
              defaultThoughtLevel = firstLegacy.id.slice(base.id.length + 1)
            }
          }
          defaultThoughtLevel ??= supported[0]?.id
        }
        return {
          ...base,
          thoughtLevels: supported,
          ...(defaultThoughtLevel ? { defaultThoughtLevel } : {}),
        }
      }

      if (selectableThoughtLevels.length > 0) {
        const defaultThoughtLevel =
          thoughtOption?.currentValue && thoughtOption.currentValue !== 'default'
            ? thoughtOption.currentValue
            : undefined
        return {
          ...base,
          thoughtLevels: selectableThoughtLevels,
          ...(defaultThoughtLevel ? { defaultThoughtLevel } : {}),
        }
      }

      return base
    })
  } else {
    models = legacyFlatModels
  }

  const modes: readonly AcpModeInfo[] = modesNode
    ? parseInfoList(modesNode.availableModes, ['id'])
    : (modeOption?.values ?? [])
  const currentModelId = modelOption?.currentValue ?? legacyCurrentModelId
  const currentModeId = asString(modesNode?.currentModeId) ?? modeOption?.currentValue
  const currentThoughtLevel = thoughtOption?.currentValue

  return {
    models,
    modes,
    ...(rawThoughtLevels.length > 0 ? { thoughtLevels: rawThoughtLevels } : {}),
    ...(currentModelId ? { currentModelId } : {}),
    ...(currentModeId ? { currentModeId } : {}),
    ...(currentThoughtLevel ? { currentThoughtLevel } : {}),
    ...(modelOption ? { modelConfigOptionId: modelOption.id } : {}),
    ...(thoughtOption ? { thoughtConfigOptionId: thoughtOption.id } : {}),
  }
}

export function normalizeAcpSessionUpdate(
  params: unknown,
  activeTools: Map<string, AcpActiveToolCall>,
): readonly AcpTurnEvent[] {
  const root = asRecord(params)
  const update = asRecord(root?.update)
  if (!update) return []
  const kind = asString(update.sessionUpdate)
  if (!kind) return []

  if (kind === 'agent_message_chunk') {
    const content = asRecord(update.content)
    const text = content?.type === 'text' ? asString(content.text) : undefined
    return text ? [{ type: 'text-delta', text }] : []
  }

  if (kind === 'agent_thought_chunk') {
    const content = asRecord(update.content)
    const text = content?.type === 'text' ? asString(content.text) : undefined
    return text ? [{ type: 'reasoning-delta', text }] : []
  }

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    return processAcpToolSessionUpdate(kind, update, activeTools)
  }

  if (kind === 'usage_update') {
    const used = asNumber(update.used)
    const size = asNumber(update.size)
    if (used === undefined) return []
    return [{
      type: 'usage',
      usage: {
        inputTokens: used,
        outputTokens: 0,
        contextUsed: used,
        ...(size !== undefined ? { contextSize: size } : {}),
      },
    }]
  }

  if (kind === 'session_info_update') {
    const title = asString(update.title)
    return title ? [{ type: 'title', title }] : []
  }

  return []
}

export function normalizeAcpPermissionRequest(params: unknown): AcpPermissionRequest {
  const root = asRecord(params) ?? {}
  const toolCall = asRecord(root.toolCall)
  const callId = asString(toolCall?.toolCallId) ?? asString(root.toolCallId)
  const toolName = resolveAcpPermissionToolName(toolCall)
  const reason = asString(toolCall?.title) ?? `Agent requests permission to run ${toolName}`

  const rawOptions = Array.isArray(root.options) ? root.options : []
  const options: AcpPermissionOption[] = []
  for (const raw of rawOptions) {
    const opt = asRecord(raw)
    if (!opt) continue
    const optionId = asString(opt.optionId)
    if (!optionId) continue
    options.push({
      optionId,
      name: asString(opt.name) ?? optionId,
      kind: asString(opt.kind) ?? 'allow_once',
    })
  }

  return {
    ...(asString(root.sessionId) ? { sessionId: asString(root.sessionId) } : {}),
    ...(callId ? { callId } : {}),
    toolName,
    reason,
    options,
    rawParams: params,
  }
}

export function pickDefaultAllowOptionId(options: readonly AcpPermissionOption[]): string | undefined {
  const allowAlways = options.find((o) => o.kind === 'allow_always' || o.optionId === 'allow_always')
  if (allowAlways) return allowAlways.optionId
  const allowOnce = options.find((o) => o.kind === 'allow_once' || o.optionId === 'allow_once')
  return allowOnce?.optionId ?? options[0]?.optionId
}
