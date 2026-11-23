import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRuntimeSpecs } from '../src/runtime/config.js'
import {
  parseAgySettingsModel,
  resolveProfileCapabilities,
  resolveRuntimeLaunchPlan,
} from '../src/runtime/profile-resolver.js'
import {
  discoverLocalProfiles,
  isSecretEnvKey,
  profilePresetId,
  profileProviderId,
  RuntimeProfileStore,
} from '../src/runtime/profile-store.js'
import { createExternalRuntimeRegistry } from '../src/runtime/registry.js'
import {
  flattenTomlToCodexConfigArgs,
  parseTomlDocument,
} from '../src/runtime/toml-subset.js'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('toml-subset parser & Codex -c flattener', () => {
  it('parses quoted table paths, nested values, arrays, inline tables and ignores UI-only sections', () => {
    const doc = parseTomlDocument(`
# Comment line
model_provider = "openai" # trailing comment
model = "gpt-6.2-sol"
model_reasoning_effort = 'high'
max_tokens = 128_000
enabled = true
tags = ["a", "b"]

[model_providers.custom]
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false

[projects."/Users/demo/workspace"]
trust_level = "trusted"

[tui]
status_line = ["model"]
`)
    expect(doc.model_provider).toBe('openai')
    expect(doc.max_tokens).toBe(128000)
    expect(doc.enabled).toBe(true)

    const flags = flattenTomlToCodexConfigArgs(doc)
    expect(flags).toEqual([
      '-c', 'model_provider="openai"',
      '-c', 'model="gpt-6.2-sol"',
      '-c', 'model_reasoning_effort="high"',
      '-c', 'max_tokens=128000',
      '-c', 'enabled=true',
      '-c', 'tags=["a", "b"]',
      '-c', 'model_providers.custom.base_url="http://127.0.0.1:8787/v1"',
      '-c', 'model_providers.custom.wire_api="responses"',
      '-c', 'model_providers.custom.requires_openai_auth=false',
      '-c', 'projects."/Users/demo/workspace".trust_level="trusted"',
    ])
  })
})

describe('RuntimeProfileStore & local discovery', () => {
  it('discovers local Codex and TRAE profile files, persists user profiles with 0600, and masks secret env keys', () => {
    const codexHome = makeTempDir('codex-home-')
    const traeHome = makeTempDir('trae-home-')
    const dataDir = makeTempDir('ext-agents-data-')

    writeFileSync(
      join(codexHome, 'config.toml'),
      'model = "gpt-6.1-sol"\n\n[profiles.team]\nmodel_provider = "relay"\nmodel = "gpt-6.3-team"\nmodel_reasoning_effort = "medium"\n',
    )
    writeFileSync(
      join(codexHome, 'personal.config.toml'),
      'model_provider = "openai"\nmodel = "gpt-6.2-sol"\nmodel_reasoning_effort = "high"\n',
    )
    writeFileSync(join(codexHome, 'config.toml.bak'), 'model = "ignored"\n')
    writeFileSync(join(traeHome, 'work.traecli.toml'), 'model = "DeepSeek-V4-Pro"\n')

    const agySettingsPath = join(dataDir, 'agy-proxy.json')
    writeFileSync(
      agySettingsPath,
      JSON.stringify({ modelProvider: 'gemini', model: 'Gemini 4 Carbon (Medium)' }),
    )

    const specs = resolveRuntimeSpecs([])
    const env = { CODEX_HOME: codexHome, TRAE_HOME: traeHome }

    const codexDiscovered = discoverLocalProfiles(specs.find((s) => s.id === 'codex')!, env)
    expect(codexDiscovered.map((p) => p.id)).toEqual(['team', 'personal'])
    expect(codexDiscovered.find((p) => p.id === 'team')).toMatchObject({
      id: 'team',
      runtimeId: 'codex',
      source: 'discovered',
      cliProfile: 'team',
      defaultModel: 'gpt-6.3-team',
      defaultReasoningEffort: 'medium',
    })
    expect(codexDiscovered.find((p) => p.id === 'personal')).toMatchObject({
      id: 'personal',
      runtimeId: 'codex',
      source: 'discovered',
      cliProfile: 'personal',
      defaultModel: 'gpt-6.2-sol',
      defaultReasoningEffort: 'high',
    })

    const store = new RuntimeProfileStore({ dataDir, specs, processEnv: env })
    expect(store.list('codex').map((p) => p.id)).toEqual(['team', 'personal'])
    expect(store.list('trae').map((p) => p.id)).toEqual(['work'])

    // Flattening a `[profiles.team]` section from `config.toml` works via `-c` flags
    const teamPlan = resolveRuntimeLaunchPlan(
      specs.find((s) => s.id === 'codex')!,
      {
        id: 'team',
        runtimeId: 'codex',
        name: 'team',
        source: 'discovered',
        cliProfile: 'team',
      },
      { CODEX_HOME: codexHome },
    )
    expect(teamPlan.args).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'model_provider="relay"',
      '-c',
      'model="gpt-6.3-team"',
      '-c',
      'model_reasoning_effort="medium"',
    ])

    // Upsert a custom Antigravity profile with secret env key
    const saved = store.upsert({
      id: 'local-proxy',
      runtimeId: 'agy',
      name: 'Local Proxy',
      configFile: agySettingsPath,
      env: {
        GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8787',
        GEMINI_API_KEY: 'test-key-value',
      },
      exposeAsPreset: true,
    })
    expect(saved.env?.GEMINI_API_KEY).toBe('test-key-value')

    const pub = store.getPublic('agy', 'local-proxy')!
    expect(pub.env).toEqual({
      GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8787',
      GEMINI_API_KEY: '',
    })
    expect(pub.secretEnvKeys).toEqual(['GEMINI_API_KEY'])
    expect(pub.presetId).toBe(profilePresetId('agy', 'local-proxy'))
    expect(pub.providerId).toBe(profileProviderId('agy', 'local-proxy'))

    // Updating without re-entering secret preserves the stored secret
    store.upsert({
      id: 'local-proxy',
      runtimeId: 'agy',
      name: 'Local Proxy Updated',
      configFile: agySettingsPath,
      env: {
        GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8788',
        GEMINI_API_KEY: '',
      },
      exposeAsPreset: true,
    })
    expect(store.get('agy', 'local-proxy')?.env).toEqual({
      GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8788',
      GEMINI_API_KEY: 'test-key-value',
    })

    if (process.platform !== 'win32') {
      const mode = statSync(join(dataDir, 'profiles.json')).mode & 0o777
      expect(mode).toBe(0o600)
    }

    // Reload from disk preserves everything
    const reloaded = new RuntimeProfileStore({ dataDir, specs, processEnv: env })
    expect(reloaded.get('agy', 'local-proxy')?.name).toBe('Local Proxy Updated')
    expect(reloaded.get('agy', 'local-proxy')?.env?.GEMINI_API_KEY).toBe('test-key-value')

    // Reject missing configFile explicitly
    expect(() =>
      store.upsert({
        runtimeId: 'agy',
        name: 'Broken',
        configFile: join(dataDir, 'does-not-exist.json'),
      }),
    ).toThrow(/配置文件不存在/)

    expect(isSecretEnvKey('GEMINI_API_KEY')).toBe(true)
    expect(isSecretEnvKey('ANTHROPIC_AUTH_TOKEN')).toBe(true)
    expect(isSecretEnvKey('GOOGLE_GEMINI_BASE_URL')).toBe(false)
  })
})

describe('resolveRuntimeLaunchPlan', () => {
  it('translates Codex profile TOML into -c flags, TRAE profile into -p, and Agy settings into --settings + gemini-api-key auth', () => {
    const dir = makeTempDir('launch-plan-')
    const codexProfilePath = join(dir, 'personal.config.toml')
    writeFileSync(codexProfilePath, 'model_provider = "openai"\nmodel = "gpt-6.2-sol"\n')

    const agySettingsPath = join(dir, 'settings.json')
    writeFileSync(
      agySettingsPath,
      JSON.stringify({ modelProvider: 'gemini', model: 'Gemini 4 Carbon (Medium)' }),
    )

    const specs = resolveRuntimeSpecs([])
    const codexSpec = specs.find((s) => s.id === 'codex')!
    const agySpec = specs.find((s) => s.id === 'agy')!
    const traeSpec = specs.find((s) => s.id === 'trae')!
    const claudeSpec = specs.find((s) => s.id === 'claude-code')!

    const codexPlan = resolveRuntimeLaunchPlan(codexSpec, {
      id: 'personal',
      runtimeId: 'codex',
      name: 'Personal',
      source: 'user',
      configFile: codexProfilePath,
    })
    expect(codexPlan.args).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'model_provider="openai"',
      '-c',
      'model="gpt-6.2-sol"',
    ])
    expect(codexPlan.defaultModel).toBe('gpt-6.2-sol')

    const agyPlan = resolveRuntimeLaunchPlan(agySpec, {
      id: 'local-proxy',
      runtimeId: 'agy',
      name: 'Local Proxy',
      source: 'user',
      configFile: agySettingsPath,
      env: {
        GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8787',
        GEMINI_API_KEY: 'test-token',
      },
    })
    expect(agyPlan.args).toEqual(['--settings', agySettingsPath, 'acp', '--stdio'])
    expect(agyPlan.authMethodId).toBe('gemini-api-key')
    expect(agyPlan.env.GOOGLE_GEMINI_BASE_URL).toBe('http://127.0.0.1:8787')
    expect(agyPlan.env.GEMINI_API_KEY).toBe('test-token')
    expect(agyPlan.defaultModel).toBe('gemini-4-carbon')
    expect(agyPlan.defaultReasoningEffort).toBe('medium')

    const traePlan = resolveRuntimeLaunchPlan(traeSpec, {
      id: 'work',
      runtimeId: 'trae',
      name: 'Work',
      source: 'discovered',
      cliProfile: 'work',
    })
    expect(traePlan.args).toEqual(['-p', 'work', 'app-server', '--listen', 'stdio://'])

    const claudePlan = resolveRuntimeLaunchPlan(claudeSpec, {
      id: 'relay',
      runtimeId: 'claude-code',
      name: 'Relay',
      source: 'user',
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000', ANTHROPIC_API_KEY: 'test-key' },
      args: ['--debug'],
    })
    expect(claudePlan.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp@0.109.0', '--debug'])
    expect(claudePlan.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9000')

    expect(parseAgySettingsModel('Gemini 4 Carbon (Medium)')).toEqual({
      model: 'gemini-4-carbon',
      effort: 'medium',
    })
    expect(resolveProfileCapabilities(agySpec)).toMatchObject({
      supportsCliProfile: false,
      supportsConfigFile: true,
      supportsEnv: true,
      supportsArgs: true,
      supportsAuthMethod: true,
      supportsExposeAsPreset: true,
    })
    expect(resolveProfileCapabilities(codexSpec)).toMatchObject({
      supportsCliProfile: true,
      supportsConfigFile: true,
      supportsEnv: true,
      supportsArgs: true,
      supportsAuthMethod: false,
      supportsExposeAsPreset: true,
    })
  })
})

describe('ExternalRuntimeRegistry dynamic exposed profile presets', () => {
  it('hot-syncs exposed profiles into preset definitions, provider routing, and cleans up on toggle/delete', async () => {
    const dir = makeTempDir('registry-sync-')
    const agySettingsPath = join(dir, 'settings.json')
    writeFileSync(agySettingsPath, JSON.stringify({ modelProvider: 'gemini' }))

    const registry = createExternalRuntimeRegistry([], {
      dataDir: dir,
      enableDiscovery: false,
    })

    const synced = new Map<string, string>()
    const syncSpy = vi.fn(async (derived, presetId: string, providerId: string) => {
      if (derived) synced.set(presetId, providerId)
      else synced.delete(presetId)
    })
    registry.attachPresetSyncHandler({ syncProfilePreset: syncSpy })

    const created = await registry.upsertProfile({
      id: 'ark',
      runtimeId: 'agy',
      name: 'Ark Proxy',
      configFile: agySettingsPath,
      env: { GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8787', GEMINI_API_KEY: 'test-token' },
      exposeAsPreset: true,
    })

    expect(created.presetId).toBe('agy:ark')
    expect(created.providerId).toBe('agy--ark-cli')
    expect(synced.get('agy:ark')).toBe('agy--ark-cli')
    // Base list() stays unchanged while resolve() & listExposedPresets() include the exposed preset
    expect(registry.list().map((r) => r.id)).toEqual(['codex', 'agy', 'claude-code', 'trae'])
    expect(registry.listExposedPresets().map((r) => [r.id, r.parentRuntimeId, r.profileId])).toEqual([
      ['agy:ark', 'agy', 'ark'],
    ])
    expect(registry.resolve('agy:ark')?.boundProfile?.id).toBe('ark')
    expect(registry.get('agy:ark')?.displayName).toBe('Antigravity · Ark Proxy')

    // Disabling exposeAsPreset unmounts the dynamic preset while keeping the profile
    await registry.upsertProfile({
      id: 'ark',
      runtimeId: 'agy',
      name: 'Ark Proxy',
      configFile: agySettingsPath,
      env: { GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8787', GEMINI_API_KEY: '' },
      exposeAsPreset: false,
    })
    expect(synced.has('agy:ark')).toBe(false)
    expect(registry.resolve('agy:ark')).toBeUndefined()
    expect(registry.getProfile('agy', 'ark')?.env?.GEMINI_API_KEY).toBe('test-token')

    // Deleting removes profile completely
    expect(await registry.deleteProfile('agy', 'ark')).toBe(true)
    expect(registry.getProfile('agy', 'ark')).toBeUndefined()
  })
})
