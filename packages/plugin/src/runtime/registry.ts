import type { CatalogModelEntry } from '../catalog-adapter.js'
import type { ExternalRuntimeOverride } from '../types.js'
import { createAcpRuntime } from './acp-runtime.js'
import { createCodexRuntime } from './codex-runtime.js'
import { resolveRuntimeSpecs, type ExternalRuntimeSpec } from './config.js'
import {
  toRuntimeSummary,
  type ExternalRuntimeDefinition,
  type ExternalRuntimeSummary,
} from './definition.js'

/**
 * Enabled external runtimes keyed by id (= agent preset id).
 * `list()` / `get()` are the read-only surface exposed as `ctx.externalRuntimes`.
 */
export class ExternalRuntimeRegistry {
  private readonly runtimes = new Map<string, ExternalRuntimeDefinition>()
  private readonly catalogLoaders = new Map<string, () => Promise<readonly CatalogModelEntry[]>>()

  attachCatalog(providerId: string, loader: () => Promise<readonly CatalogModelEntry[]>): void {
    this.catalogLoaders.set(providerId, loader)
  }

  async listModelsForProvider(providerId: string): Promise<readonly CatalogModelEntry[] | undefined> {
    const loader = this.catalogLoaders.get(providerId)
    return loader ? await loader() : undefined
  }

  async resolveDefaultSelection(
    runtimeId: string,
  ): Promise<{ readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined> {
    const def = this.runtimes.get(runtimeId)
    if (!def) return undefined
    const entries = await this.listModelsForProvider(def.providerId).catch(() => undefined)
    const configured = def.defaultModel.trim()
    let model = configured
    if (entries && entries.length > 0 && (!configured || !entries.some((m) => m.id === configured))) {
      model = entries.find((m) => m.isDefault)?.id ?? entries[0]!.id
    }
    if (!model) return undefined
    const entry = entries?.find((m) => m.id === model)
    let reasoningEffort: string | undefined = def.defaultReasoningEffort || entry?.defaultEffort
    if (entry?.reasoningEfforts !== undefined && entry.reasoningEfforts.length === 0) {
      reasoningEffort = undefined
    }
    return {
      provider: def.providerId,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  }

  register(definition: ExternalRuntimeDefinition): void {
    if (this.runtimes.has(definition.id)) {
      throw new Error(`external runtime "${definition.id}" is already registered`)
    }
    const clash = [...this.runtimes.values()].find((r) => r.providerId === definition.providerId)
    if (clash) {
      throw new Error(
        `external runtimes "${clash.id}" and "${definition.id}" share provider id "${definition.providerId}"`,
      )
    }
    this.runtimes.set(definition.id, definition)
  }

  /** Runtime that owns sessions of `presetId`; `undefined` routes to the native AgentLoop. */
  resolve(presetId: string | undefined): ExternalRuntimeDefinition | undefined {
    return presetId ? this.runtimes.get(presetId) : undefined
  }

  definitions(): readonly ExternalRuntimeDefinition[] {
    return [...this.runtimes.values()]
  }

  get(id: string): ExternalRuntimeSummary | undefined {
    const runtime = this.runtimes.get(id)
    return runtime ? toRuntimeSummary(runtime) : undefined
  }

  list(): ExternalRuntimeSummary[] {
    return [...this.runtimes.values()].map(toRuntimeSummary)
  }
}

function createRuntimeDefinition(spec: ExternalRuntimeSpec): ExternalRuntimeDefinition {
  switch (spec.kind) {
    case 'codex-app-server':
      return createCodexRuntime(spec)
    case 'acp':
      return createAcpRuntime(spec)
  }
}

/** Build the registry from built-in runtimes merged with user entries; disabled ones are skipped. */
export function createExternalRuntimeRegistry(
  overrides: readonly ExternalRuntimeOverride[],
): ExternalRuntimeRegistry {
  const registry = new ExternalRuntimeRegistry()
  for (const spec of resolveRuntimeSpecs(overrides)) {
    if (spec.enabled) registry.register(createRuntimeDefinition(spec))
  }
  return registry
}
