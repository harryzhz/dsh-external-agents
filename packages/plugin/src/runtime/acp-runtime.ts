import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import {
  AcpRuntimeClient,
  pickDefaultAllowOptionId,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpPromptBlock,
  type AcpRuntimeOptions,
  type AcpSessionHandle,
} from '@dsh-external-agents/runtime-acp'
import type { CatalogModelEntry } from '../catalog-adapter.js'
import type { ExternalAgent } from '../external-agent.js'
import type {
  ExternalRuntimeAuthMethod,
  ExternalRuntimeDriver,
  ExternalRuntimeProfile,
  ExternalTurnEvent,
  ExternalTurnRequest,
  ExternalTurnRunResult,
} from '../types.js'
import {
  AcpRuntimePool,
  detectAcpExecutorError,
  resolveDefaultInstanceScopeKey,
} from './acp-pool.js'
import {
  contextWindowFor,
  expandRuntimeCwd,
  type ExternalRuntimeSpec,
} from './config.js'
import { toRuntimeSummary, type ExternalRuntimeDefinition } from './definition.js'
import { resolveImageSource } from './message-content.js'
import {
  resolveProfileCapabilities,
  resolveProfileDefaults,
  resolveRuntimeLaunchPlan,
} from './profile-resolver.js'

export interface CreateAcpRuntimeOptions {
  readonly dataDir?: string
  readonly idleEvictMs?: number
  readonly onWarn?: (message: string) => void
  readonly pool?: AcpRuntimePool
}

async function extractAcpPromptBlocks(
  ctx: Context,
  messages: readonly UserMessage[],
  signal: AbortSignal,
): Promise<AcpPromptBlock[]> {
  const blocks: AcpPromptBlock[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.length > 0) {
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const source = await resolveImageSource(ctx, block, { signal })
        if (source.data) {
          blocks.push({ type: 'image', mimeType: source.mimeType, data: source.data })
        }
      }
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

async function bridgeAcpPermission(
  ctx: Context,
  agent: ExternalAgent,
  request: AcpPermissionRequest,
  signal: AbortSignal,
): Promise<AcpPermissionOutcome> {
  const approval = ctx.get('approval') as ApprovalService | undefined
  const allowOptionId = pickDefaultAllowOptionId(request.options)
  if (!approval) {
    return allowOptionId ? { outcome: 'selected', optionId: allowOptionId } : { outcome: 'cancelled' }
  }
  const outcome = await approval.request({
    agent,
    toolName: request.toolName,
    ...(request.callId ? { callId: brandString<ToolCallId>(request.callId) } : {}),
    reason: request.reason,
    signal,
  })
  if (outcome === 'allowed-once' && allowOptionId) {
    return { outcome: 'selected', optionId: allowOptionId }
  }
  const rejectOpt = request.options.find(
    (o) => o.kind === 'reject_once' || o.kind === 'reject_always' || o.optionId.includes('reject'),
  )
  return rejectOpt ? { outcome: 'selected', optionId: rejectOpt.optionId } : { outcome: 'cancelled' }
}

function launchOptions(
  spec: ExternalRuntimeSpec,
  profile?: ExternalRuntimeProfile,
  extraEnv?: Readonly<Record<string, string>>,
): Pick<AcpRuntimeOptions, 'command' | 'args' | 'env' | 'authMethodId' | 'sessionMeta'> {
  const plan = resolveRuntimeLaunchPlan(spec, profile, extraEnv)
  return {
    command: plan.command,
    args: plan.args,
    env: plan.env,
    ...(plan.authMethodId ? { authMethodId: plan.authMethodId } : {}),
    ...(plan.sessionMeta ? { sessionMeta: plan.sessionMeta } : {}),
  }
}

async function executeAcpHandleTurn(
  ctx: Context,
  agent: ExternalAgent,
  handle: Pick<AcpSessionHandle, 'setModel' | 'setThoughtLevel' | 'runTurn'>,
  request: ExternalTurnRequest,
  onEvent: (event: ExternalTurnEvent) => void,
  signal: AbortSignal,
): Promise<ExternalTurnRunResult> {
  if (request.modelChangedSinceStart) {
    if (request.model) {
      await handle.setModel(request.model)
    }
    await handle.setThoughtLevel(request.reasoningEffort ?? '')
  }
  const promptBlocks = await extractAcpPromptBlocks(ctx, request.messages, signal)
  let lastStepText = ''
  const res = await handle.runTurn(
    promptBlocks,
    {
      onEvent: (event) => {
        if (event.type === 'tool-start' || event.type === 'tool-complete') {
          lastStepText = ''
        } else if (event.type === 'text-delta') {
          lastStepText += event.text
        }
        onEvent(event)
      },
      onPermission: (req, sig) => bridgeAcpPermission(ctx, agent, req, sig),
    },
    signal,
  )
  const interrupted = res.stopReason === 'cancelled' || signal.aborted
  if (!interrupted) {
    const executorError = detectAcpExecutorError(lastStepText)
    if (executorError) {
      return {
        status: 'failed',
        errorMessage: executorError,
        ...(res.usage ? { usage: res.usage } : {}),
      }
    }
  }
  return {
    status: interrupted ? 'interrupted' : 'completed',
    ...(res.usage ? { usage: res.usage } : {}),
  }
}

class DedicatedAcpDriverAdapter implements ExternalRuntimeDriver {
  readonly kind: string
  private readonly client: AcpRuntimeClient

  constructor(
    private readonly ctx: Context,
    private readonly agent: ExternalAgent,
    spec: ExternalRuntimeSpec,
    profile?: ExternalRuntimeProfile,
  ) {
    this.kind = spec.id
    this.client = new AcpRuntimeClient({
      cwd: expandRuntimeCwd(agent.session.header.cwd),
      ...launchOptions(spec, profile, { DSH_SESSION_ID: agent.id }),
      logger: (msg) => ctx.logger.warn(msg),
    })
  }

  get externalId(): string | undefined {
    return this.client.sessionId
  }

  async ensureConnected(
    existingExternalId?: string,
    model?: string,
    reasoningEffort?: string,
  ): Promise<string> {
    if (this.client.isConnected && this.client.sessionId) {
      return this.client.sessionId
    }
    return await this.client.startOrResume({
      ...(existingExternalId ? { sessionId: existingExternalId } : {}),
      ...(model ? { modelId: model } : {}),
      ...(reasoningEffort ? { thoughtLevel: reasoningEffort } : {}),
    })
  }

  async runTurn(
    request: ExternalTurnRequest,
    onEvent: (event: ExternalTurnEvent) => void,
    signal: AbortSignal,
  ): Promise<ExternalTurnRunResult> {
    return await executeAcpHandleTurn(this.ctx, this.agent, this.client, request, onEvent, signal)
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

class PooledAcpDriverAdapter implements ExternalRuntimeDriver {
  readonly kind: string
  private sessionHandle?: AcpSessionHandle
  private releaseHandle?: () => Promise<void>

  constructor(
    private readonly ctx: Context,
    private readonly agent: ExternalAgent,
    private readonly pool: AcpRuntimePool,
    spec: ExternalRuntimeSpec,
    private readonly profile?: ExternalRuntimeProfile,
  ) {
    this.kind = spec.id
  }

  get externalId(): string | undefined {
    return this.sessionHandle?.sessionId
  }

  async ensureConnected(
    existingExternalId?: string,
    model?: string,
    reasoningEffort?: string,
  ): Promise<string> {
    if (this.sessionHandle?.isOpen) {
      return this.sessionHandle.sessionId
    }
    if (this.releaseHandle) {
      await this.releaseHandle().catch(() => {})
      this.sessionHandle = undefined
      this.releaseHandle = undefined
    }
    const opened = await this.pool.openSession(
      this.profile,
      {
        cwd: expandRuntimeCwd(this.agent.session.header.cwd),
        ...(existingExternalId ? { sessionId: existingExternalId } : {}),
        ...(model ? { modelId: model } : {}),
        ...(reasoningEffort ? { thoughtLevel: reasoningEffort } : {}),
      },
      (msg) => this.ctx.logger.warn(msg),
    )
    this.sessionHandle = opened.handle
    this.releaseHandle = opened.release
    return opened.handle.sessionId
  }

  async runTurn(
    request: ExternalTurnRequest,
    onEvent: (event: ExternalTurnEvent) => void,
    signal: AbortSignal,
  ): Promise<ExternalTurnRunResult> {
    if (!this.sessionHandle) {
      throw new Error(`Pooled ACP driver for "${this.kind}" called runTurn before ensureConnected()`)
    }
    return await executeAcpHandleTurn(
      this.ctx,
      this.agent,
      this.sessionHandle,
      request,
      onEvent,
      signal,
    )
  }

  async close(): Promise<void> {
    const release = this.releaseHandle
    this.sessionHandle = undefined
    this.releaseHandle = undefined
    if (release) {
      await release()
    }
  }
}

/** Any agent speaking the Agent Client Protocol over stdio. */
export function createAcpRuntime(
  spec: ExternalRuntimeSpec,
  options: CreateAcpRuntimeOptions = {},
): ExternalRuntimeDefinition {
  let cachedAuthMethods: readonly ExternalRuntimeAuthMethod[] | undefined
  const pool =
    options.pool ??
    (spec.poolProcesses
      ? new AcpRuntimePool({
          spec,
          instanceScopeKey: resolveDefaultInstanceScopeKey(options.dataDir),
          ...(options.idleEvictMs !== undefined ? { idleEvictMs: options.idleEvictMs } : {}),
          ...(options.onWarn ? { logger: options.onWarn } : {}),
        })
      : undefined)

  return {
    ...toRuntimeSummary(spec),
    fallbackModels: spec.fallbackModels,
    getLiveAuthMethods: () => cachedAuthMethods,
    getProfileCapabilities: () => resolveProfileCapabilities(spec, cachedAuthMethods),
    resolveProfileDefaults: (profile) => resolveProfileDefaults(spec, profile),
    async probeModels(profile?: ExternalRuntimeProfile): Promise<readonly CatalogModelEntry[]> {
      const plan = resolveRuntimeLaunchPlan(spec, profile)
      const snapshot = pool
        ? await pool.probeCatalog(profile)
        : await AcpRuntimeClient.probeCatalog({
            cwd: process.cwd(),
            command: plan.command,
            args: plan.args,
            env: plan.env,
            ...(plan.authMethodId ? { authMethodId: plan.authMethodId } : {}),
            ...(plan.sessionMeta ? { sessionMeta: plan.sessionMeta } : {}),
          })
      if (snapshot.authMethods && snapshot.authMethods.length > 0) {
        cachedAuthMethods = snapshot.authMethods
      }
      const preferredDefault = plan.defaultModel || snapshot.currentModelId
      return snapshot.models.map((m) => {
        const contextWindow = contextWindowFor(spec, m.id)
        const isDefault = Boolean(preferredDefault && m.id === preferredDefault)
        const efforts = m.thoughtLevels?.map((t) => t.id)
        const defaultEffort =
          isDefault &&
          plan.defaultReasoningEffort &&
          (!efforts || efforts.includes(plan.defaultReasoningEffort))
            ? plan.defaultReasoningEffort
            : m.defaultThoughtLevel
        return {
          id: m.id,
          name: m.name,
          ...(contextWindow ? { contextWindow } : {}),
          ...(isDefault ? { isDefault: true } : {}),
          ...(efforts !== undefined ? { reasoningEfforts: efforts } : {}),
          ...(defaultEffort ? { defaultEffort } : {}),
        }
      })
    },
    createDriver: ({ ctx, agent, profile }) =>
      pool
        ? new PooledAcpDriverAdapter(ctx, agent, pool, spec, profile)
        : new DedicatedAcpDriverAdapter(ctx, agent, spec, profile),
    ...(pool
      ? {
          invalidateProfile: (profileId?: string) => pool.invalidateProfile(profileId),
          dispose: () => pool.disposeAll(),
        }
      : {}),
  }
}
