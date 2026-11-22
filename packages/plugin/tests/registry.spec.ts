import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.js'
import { buildRuntimeEnv, resolveRuntimeCommand, resolveRuntimeSpecs } from '../src/runtime/config.js'
import { createExternalRuntimeRegistry } from '../src/runtime/registry.js'

describe('resolveRuntimeSpecs', () => {
  it('provides codex, agy, claude-code and trae built-ins with their launch commands', () => {
    const specs = resolveRuntimeSpecs([])
    expect(specs.map((s) => [s.id, s.kind, s.command, s.args])).toEqual([
      ['codex', 'codex-app-server', 'codex', ['app-server', '--stdio']],
      ['agy', 'acp', 'agy', ['acp', '--stdio']],
      ['claude-code', 'acp', 'npx', ['-y', '@agentclientprotocol/claude-agent-acp@0.109.0']],
      ['trae', 'codex-app-server', 'traecli', ['app-server', '--listen', 'stdio://']],
    ])
    expect(specs.find((s) => s.id === 'agy')?.stripSshEnv).toBe(true)
  })

  it('resolves Trae CLI command candidates across PATH (traecli > trae-cli > fallback) and respects explicit command override', () => {
    const traeSpec = resolveRuntimeSpecs([]).find((s) => s.id === 'trae')!
    expect(traeSpec.commandCandidates).toEqual(['traecli', 'trae-cli'])

    const emptyDir = mkdtempSync(join(tmpdir(), 'trae-empty-'))
    expect(resolveRuntimeCommand(traeSpec, { PATH: emptyDir })).toBe('traecli')

    const dirOnlyAlias = mkdtempSync(join(tmpdir(), 'trae-alias-only-'))
    const traeAliasBin = join(dirOnlyAlias, 'trae-cli')
    writeFileSync(traeAliasBin, '#!/bin/sh\nexit 0\n')
    chmodSync(traeAliasBin, 0o755)
    expect(resolveRuntimeCommand(traeSpec, { PATH: dirOnlyAlias })).toBe(traeAliasBin)

    const dirCoexist = mkdtempSync(join(tmpdir(), 'trae-coexist-'))
    const traecliBin = join(dirCoexist, 'traecli')
    writeFileSync(traecliBin, '#!/bin/sh\nexit 0\n')
    chmodSync(traecliBin, 0o755)
    expect(
      resolveRuntimeCommand(traeSpec, { PATH: [dirOnlyAlias, dirCoexist].join(delimiter) }),
    ).toBe(traecliBin)

    const overridden = resolveRuntimeSpecs([{ id: 'trae', command: '/opt/custom/trae-custom' }]).find(
      (s) => s.id === 'trae',
    )!
    expect(overridden.commandCandidates).toBeUndefined()
    expect(resolveRuntimeCommand(overridden, { PATH: dirCoexist })).toBe('/opt/custom/trae-custom')
  })

  it('overrides only the fields a user sets and layers env over built-in env', () => {
    const [codex] = resolveRuntimeSpecs([
      { id: 'codex', defaultModel: 'gpt-6.2-sol', args: [], env: { CODEX_HOME: '/opt/codex' } },
    ])
    expect(codex).toMatchObject({
      id: 'codex',
      kind: 'codex-app-server',
      command: 'codex',
      args: ['app-server', '--stdio'],
      providerId: 'codex-cli',
      defaultModel: 'gpt-6.2-sol',
      defaultReasoningEffort: 'xhigh',
      env: { CODEX_HOME: '/opt/codex' },
    })
  })

  it('adds new ACP runtimes by id with generic defaults', () => {
    const custom = resolveRuntimeSpecs([{ id: 'qwen', command: 'qwen', args: ['--acp'] }]).at(-1)
    expect(custom).toMatchObject({
      id: 'qwen',
      kind: 'acp',
      enabled: true,
      displayName: 'qwen',
      providerId: 'qwen-cli',
      command: 'qwen',
      args: ['--acp'],
      defaultModel: 'default',
      fallbackModels: [{ id: 'default', name: 'default' }],
    })
  })

  it('rejects custom runtimes without a command and duplicated entries', () => {
    expect(() => resolveRuntimeSpecs([{ id: 'ghost' }])).toThrow(/must declare a command/)
    expect(() => resolveRuntimeSpecs([{ id: 'agy' }, { id: 'agy' }])).toThrow(/more than once/)
  })

  it('strips SSH session variables only when the runtime asks for it', () => {
    const [codex, agy] = resolveRuntimeSpecs([])
    const original = { ...process.env }
    process.env.SSH_CONNECTION = '1.2.3.4 0 1.2.3.4 0'
    process.env.SSH_AUTH_SOCK = '/sock'
    try {
      expect(buildRuntimeEnv(agy!).SSH_CONNECTION).toBeUndefined()
      expect(buildRuntimeEnv(agy!).SSH_AUTH_SOCK).toBe('/sock')
      expect(buildRuntimeEnv(codex!).SSH_CONNECTION).toBe('1.2.3.4 0 1.2.3.4 0')
    } finally {
      process.env = original
    }
  })
})

describe('Config schema + registry', () => {
  it('keeps built-in fields when a partial runtime entry passes through the schema', () => {
    const config = Config({ runtimes: [{ id: 'agy', defaultModel: 'gemini-4-carbon' }] })
    const registry = createExternalRuntimeRegistry(config.runtimes)
    expect(config.idleEvictMs).toBe(15 * 60_000)
    expect(registry.get('agy')).toEqual({
      id: 'agy',
      displayName: 'Antigravity',
      description: '通过 ACP 协议接入 Antigravity CLI，支持多模型切换与工具协作，适合通用研发与调研',
      providerId: 'agy-cli',
      defaultModel: 'gemini-4-carbon',
      defaultReasoningEffort: 'high',
    })
    expect(resolveRuntimeSpecs(config.runtimes).find((s) => s.id === 'agy')?.args).toEqual(['acp', '--stdio'])
  })

  it('lists plain summaries in registration order without driver factories', () => {
    const registry = createExternalRuntimeRegistry([])
    const summaries = registry.list()
    expect(summaries.map((s) => [s.id, s.displayName, s.defaultReasoningEffort])).toEqual([
      ['codex', 'Codex', 'xhigh'],
      ['agy', 'Antigravity', 'high'],
      ['claude-code', 'ClaudeCode', undefined],
      ['trae', 'Trae', undefined],
    ])
    expect(Object.keys(registry.get('claude-code') ?? {})).toEqual([
      'id',
      'displayName',
      'description',
      'providerId',
      'defaultModel',
    ])
    expect(registry.get('standard')).toBeUndefined()
  })

  it('rejects runtimes that share a provider id', () => {
    expect(() =>
      createExternalRuntimeRegistry([{ id: 'claude-2', command: 'claude-acp', providerId: 'claude-code-cli' }]),
    ).toThrow(/share provider id "claude-code-cli"/)
  })
})
