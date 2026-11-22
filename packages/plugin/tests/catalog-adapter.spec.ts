import { describe, expect, it, vi } from 'vitest'
import { ExternalCatalogLlmAdapter } from '../src/catalog-adapter.js'

describe('ExternalCatalogLlmAdapter', () => {
  it('deduplicates, caches within TTL, and singleflights concurrent model probes', async () => {
    const fetchModels = vi.fn().mockResolvedValue([
      {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol',
        contextWindow: 400_000,
        reasoningEfforts: ['low', 'xhigh'],
        defaultEffort: 'xhigh',
      },
      { id: 'gpt-6.1-sol', name: 'Duplicate should be dropped' },
    ])

    const adapter = new ExternalCatalogLlmAdapter({
      displayName: 'Codex CLI',
      ttlMs: 60_000,
      fallbackModels: [{ id: 'fallback', name: 'Fallback' }],
      fetchModels,
    })

    const [listA, listB] = await Promise.all([
      adapter.listModels('codex-cli'),
      adapter.listModels('codex-cli'),
    ])
    expect(fetchModels).toHaveBeenCalledTimes(1)
    expect(listA).toHaveLength(1)
    expect(listB).toEqual(listA)

    const resolved = await adapter.resolveModel('codex-cli', 'gpt-6.1-sol')
    expect(resolved.context?.contextWindow).toBe(400_000)
    expect(resolved.reasoning?.defaultEffort).toBe('xhigh')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'xhigh'])
  })

  it('falls back cleanly and warns when live CLI probe fails', async () => {
    const onWarn = vi.fn()
    const adapter = new ExternalCatalogLlmAdapter({
      displayName: 'Antigravity CLI',
      ttlMs: 60_000,
      fallbackModels: [{ id: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' }],
      fetchModels: vi.fn().mockRejectedValue(new Error('binary not found')),
      onWarn,
    })

    const list = await adapter.listModels('agy-cli')
    expect(list).toEqual([
      {
        provider: 'agy-cli',
        id: 'gemini-4-neon-xhigh',
        name: 'Gemini 4 Neon (XHigh)',
        inputModalities: ['text', 'image'],
      },
    ])
    expect(onWarn).toHaveBeenCalledTimes(1)
  })
})
