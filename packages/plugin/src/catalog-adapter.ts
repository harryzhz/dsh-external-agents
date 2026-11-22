import { brandString } from '@deepseek-ai/dsh-brand'
import {
  LlmAdapter,
  LlmError,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

export interface CatalogModelEntry {
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly reasoningEfforts?: readonly string[]
  readonly defaultEffort?: string
  readonly isDefault?: boolean
}

export interface ExternalCatalogOptions {
  readonly displayName: string
  readonly ttlMs: number
  readonly fallbackModels: readonly CatalogModelEntry[]
  readonly fetchModels: () => Promise<readonly CatalogModelEntry[]>
  readonly onWarn?: (message: string) => void
}

export class ExternalCatalogLlmAdapter extends LlmAdapter {
  private cachedModels?: readonly CatalogModelEntry[]
  private expiresAt = 0
  private inflight?: Promise<readonly CatalogModelEntry[]>

  constructor(private readonly options: ExternalCatalogOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.displayName }
  }

  override async listModels(provider: string): Promise<LlmModelInfo[]> {
    const entries = await this.loadEntries()
    return entries.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: ['text', 'image'],
    }))
  }

  async listCatalogEntries(): Promise<readonly CatalogModelEntry[]> {
    return await this.loadEntries()
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entries = await this.loadEntries()
    const found = entries.find((entry) => entry.id === model)
    const efforts = found?.reasoningEfforts?.map((id) => ({
      id: brandString<ReasoningEffortId>(id),
      name: id,
    }))
    const defaultEffort = found?.defaultEffort
      ? brandString<ReasoningEffortId>(found.defaultEffort)
      : efforts?.[0]?.id

    return {
      provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: ['text', 'image'],
      ...(found?.contextWindow ? { context: { contextWindow: found.contextWindow } } : {}),
      ...(efforts && efforts.length > 0 && defaultEffort
        ? { reasoning: { efforts, defaultEffort } }
        : {}),
    }
  }

  override async *stream(): AsyncGenerator<StreamChunk, void, void> {
    throw new LlmError(
      `Provider "${this.options.displayName}" is executed by ExternalAgent, not native AgentLoop`,
      'NO_ADAPTER',
    )
  }

  private async loadEntries(): Promise<readonly CatalogModelEntry[]> {
    const now = Date.now()
    if (this.cachedModels && now < this.expiresAt) {
      return this.cachedModels
    }
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = undefined
      })
    }
    return await this.inflight
  }

  private async refresh(): Promise<readonly CatalogModelEntry[]> {
    try {
      const fetched = await this.options.fetchModels()
      const unique = deduplicateModels(fetched)
      if (unique.length > 0) {
        this.cachedModels = unique
        this.expiresAt = Date.now() + this.options.ttlMs
        return unique
      }
    } catch (err) {
      this.options.onWarn?.(
        `${this.options.displayName} model catalog probe failed; using fallback list: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    this.cachedModels = deduplicateModels(this.options.fallbackModels)
    this.expiresAt = Date.now() + Math.min(this.options.ttlMs, 30_000)
    return this.cachedModels
  }
}

function deduplicateModels(models: readonly CatalogModelEntry[]): CatalogModelEntry[] {
  const seen = new Set<string>()
  const out: CatalogModelEntry[] = []
  for (const item of models) {
    if (!item.id || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}
