import { describe, expect, it } from 'vitest'
import { effectivePresetOfSession } from '../src/agent-loop-bridge.js'
import { createExternalRuntimeRegistry } from '../src/runtime/registry.js'

describe('ExternalRuntimeRegistry preset routing', () => {
  const registry = createExternalRuntimeRegistry([])

  it('routes built-in presets to their runtimes and keeps the persisted runtime ids stable', () => {
    expect(registry.resolve('codex')?.providerId).toBe('codex-cli')
    expect(registry.resolve('agy')?.providerId).toBe('agy-cli')
    expect(registry.resolve('claude-code')?.providerId).toBe('claude-code-cli')
    expect(registry.resolve('trae')?.providerId).toBe('trae-cli')
  })

  it('reconstructs effective preset from agent-preset/selected events and resolves live catalog defaults', async () => {
    expect(effectivePresetOfSession({ agentPreset: 'codex' }, [])).toBe('codex')
    expect(
      effectivePresetOfSession({ agentPreset: 'codex' }, [
        { type: 'agent-preset/selected', data: { agentPreset: 'agy' } },
        { type: 'agent-preset/selected', data: { agentPreset: 'trae' } },
      ]),
    ).toBe('trae')

    const customReg = createExternalRuntimeRegistry([])
    customReg.attachCatalog('trae-cli', async () => [
      { id: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro', isDefault: true, reasoningEfforts: [] },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', reasoningEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    ])
    await expect(customReg.resolveDefaultSelection('trae')).resolves.toEqual({
      provider: 'trae-cli',
      model: 'DeepSeek-V4-Pro',
    })
  })

  it('returns undefined for unknown or missing presets so the native AgentLoop handles them', () => {
    expect(registry.resolve('standard')).toBeUndefined()
    expect(registry.resolve(undefined)).toBeUndefined()
    expect(registry.resolve('')).toBeUndefined()
  })

  it('does not route presets of disabled runtimes', () => {
    const withoutAgy = createExternalRuntimeRegistry([{ id: 'agy', enabled: false }])
    expect(withoutAgy.resolve('agy')).toBeUndefined()
    expect(withoutAgy.list().map((r) => r.id)).toEqual(['codex', 'claude-code', 'trae'])
  })
})
