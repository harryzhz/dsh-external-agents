import type { Context } from '@deepseek-ai/cordis'
import type { CatalogModelEntry } from '../catalog-adapter.js'
import type { ExternalAgent } from '../external-agent.js'
import type { ExternalRuntimeDriver } from '../types.js'

/** Public, serializable description of an external runtime. */
export interface ExternalRuntimeSummary {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly providerId: string
  readonly defaultModel: string
  readonly defaultReasoningEffort?: string
}

export interface ExternalRuntimeHost {
  readonly ctx: Context
  readonly agent: ExternalAgent
}

/** A runtime the router can hand sessions to: catalog probing plus per-agent drivers. */
export interface ExternalRuntimeDefinition extends ExternalRuntimeSummary {
  readonly fallbackModels: readonly CatalogModelEntry[]
  probeModels(): Promise<readonly CatalogModelEntry[]>
  createDriver(host: ExternalRuntimeHost): ExternalRuntimeDriver
}

/** Copy only the summary fields so callers never receive driver factories. */
export function toRuntimeSummary(source: ExternalRuntimeSummary): ExternalRuntimeSummary {
  return {
    id: source.id,
    displayName: source.displayName,
    description: source.description,
    providerId: source.providerId,
    defaultModel: source.defaultModel,
    ...(source.defaultReasoningEffort ? { defaultReasoningEffort: source.defaultReasoningEffort } : {}),
  }
}
