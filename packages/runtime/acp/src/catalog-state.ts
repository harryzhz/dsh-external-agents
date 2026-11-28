import { parseAcpCatalog } from './event-normalizer.js'
import type { AcpCatalogSnapshot } from './types.js'

export interface NormalizedModelAndThought {
  readonly modelId?: string
  readonly thoughtLevel?: string
  readonly inferredThoughtLevel?: string
}

/**
 * Normalize an incoming model id / thought level pair against an ACP session's
 * catalog snapshot. When the server exposes models and thought levels via
 * `configOptions` (e.g. `model` + `thought_level`), splits composite suffixes
 * like `claude-opus-high` into `{ modelId: 'claude-opus', thoughtLevel: 'high' }`.
 */
export function normalizeModelAndThought(
  snap: AcpCatalogSnapshot | undefined,
  rawModelId?: string,
  rawThoughtLevel?: string,
): NormalizedModelAndThought {
  const trimmedModel = rawModelId?.trim() || undefined
  const trimmedThought = rawThoughtLevel?.trim() || undefined
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

/**
 * Merge a `session/set_config_option` response back into the session's cached
 * `AcpCatalogSnapshot`, preserving per-model thought level metadata from the
 * initial `session/new` / `session/resume` response.
 */
export function mergeConfigOptionsSnapshot(
  current: AcpCatalogSnapshot,
  rawResult: unknown,
  fallbackPatch: Partial<AcpCatalogSnapshot>,
): AcpCatalogSnapshot {
  if (
    rawResult &&
    typeof rawResult === 'object' &&
    Array.isArray((rawResult as Record<string, unknown>).configOptions)
  ) {
    const updated = parseAcpCatalog(rawResult)
    const mergedModels =
      updated.models.length > 0
        ? updated.models.map((m) => {
            const prev = current.models.find((pm) => pm.id === m.id)
            return prev?.thoughtLevels
              ? {
                  ...m,
                  thoughtLevels: prev.thoughtLevels,
                  ...(prev.defaultThoughtLevel ? { defaultThoughtLevel: prev.defaultThoughtLevel } : {}),
                }
              : m
          })
        : current.models
    return {
      ...current,
      ...fallbackPatch,
      models: mergedModels,
      thoughtLevels: updated.thoughtLevels,
      currentModelId: updated.currentModelId ?? fallbackPatch.currentModelId ?? current.currentModelId,
      currentThoughtLevel: updated.currentThoughtLevel ?? fallbackPatch.currentThoughtLevel,
      thoughtConfigOptionId: updated.thoughtConfigOptionId,
    }
  }
  return { ...current, ...fallbackPatch }
}
