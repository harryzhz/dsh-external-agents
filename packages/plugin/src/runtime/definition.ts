import type { Context } from '@deepseek-ai/cordis'
import type { CatalogModelEntry } from '../catalog-adapter.js'
import type { ExternalAgent } from '../external-agent.js'
import type {
  ExternalRuntimeAuthMethod,
  ExternalRuntimeDriver,
  ExternalRuntimeProfile,
  ExternalRuntimeProfileCapabilities,
} from '../types.js'

/** Public, serializable description of an external runtime. */
export interface ExternalRuntimeSummary {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly providerId: string
  readonly defaultModel: string
  readonly defaultReasoningEffort?: string
}

/** Public summary for a profile dynamically exposed as a top-level DSH preset. */
export interface ExposedProfilePresetSummary extends ExternalRuntimeSummary {
  readonly parentRuntimeId: string
  readonly profileId: string
}

export interface ExternalRuntimeHost {
  readonly ctx: Context
  readonly agent: ExternalAgent
  readonly profile?: ExternalRuntimeProfile
}

/** A runtime the router can hand sessions to: catalog probing plus per-agent drivers. */
export interface ExternalRuntimeDefinition extends ExternalRuntimeSummary {
  readonly fallbackModels: readonly CatalogModelEntry[]
  readonly parentRuntimeId?: string
  readonly profileId?: string
  readonly boundProfile?: ExternalRuntimeProfile
  getProfileCapabilities?(): ExternalRuntimeProfileCapabilities
  getLiveAuthMethods?(): readonly ExternalRuntimeAuthMethod[] | undefined
  resolveProfileDefaults?(
    profile: ExternalRuntimeProfile,
  ): { readonly defaultModel?: string; readonly defaultReasoningEffort?: string }
  probeModels(profile?: ExternalRuntimeProfile): Promise<readonly CatalogModelEntry[]>
  createDriver(host: ExternalRuntimeHost): ExternalRuntimeDriver
  invalidateProfile?(profileId?: string): Promise<void>
  dispose?(): Promise<void>
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
