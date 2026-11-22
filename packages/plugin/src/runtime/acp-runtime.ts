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
} from '@dsh-external-agents/runtime-acp'
import type { CatalogModelEntry } from '../catalog-adapter.js'
import type { ExternalAgent } from '../external-agent.js'
import type {
  ExternalRuntimeDriver,
  ExternalTurnEvent,
  ExternalTurnRequest,
  ExternalTurnRunResult,
} from '../types.js'
import {
  buildRuntimeEnv,
  contextWindowFor,
  expandRuntimeCwd,
  resolveRuntimeCommand,
  type ExternalRuntimeSpec,
} from './config.js'
import { toRuntimeSummary, type ExternalRuntimeDefinition } from './definition.js'
import { readImageSource } from './message-content.js'

function extractAcpPromptBlocks(messages: readonly UserMessage[]): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.length > 0) {
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const source = readImageSource(block)
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
  extraEnv?: Readonly<Record<string, string>>,
): Pick<AcpRuntimeOptions, 'command' | 'args' | 'env'> {
  const env = buildRuntimeEnv(spec, extraEnv)
  return { command: resolveRuntimeCommand(spec, env), args: spec.args, env }
}

class AcpDriverAdapter implements ExternalRuntimeDriver {
  readonly kind: string
  private readonly client: AcpRuntimeClient

  constructor(
    private readonly ctx: Context,
    private readonly agent: ExternalAgent,
    spec: ExternalRuntimeSpec,
  ) {
    this.kind = spec.id
    this.client = new AcpRuntimeClient({
      cwd: expandRuntimeCwd(agent.session.header.cwd),
      ...launchOptions(spec, { DSH_SESSION_ID: agent.id }),
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
    if (request.modelChangedSinceStart) {
      if (request.model) {
        await this.client.setModel(request.model)
      }
      await this.client.setThoughtLevel(request.reasoningEffort ?? '')
    }
    const res = await this.client.runTurn(
      extractAcpPromptBlocks(request.messages),
      {
        onEvent,
        onPermission: (req, sig) => bridgeAcpPermission(this.ctx, this.agent, req, sig),
      },
      signal,
    )
    const interrupted = res.stopReason === 'cancelled' || signal.aborted
    return {
      status: interrupted ? 'interrupted' : 'completed',
      ...(res.usage ? { usage: res.usage } : {}),
    }
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

/** Any agent speaking the Agent Client Protocol over stdio. */
export function createAcpRuntime(spec: ExternalRuntimeSpec): ExternalRuntimeDefinition {
  return {
    ...toRuntimeSummary(spec),
    fallbackModels: spec.fallbackModels,
    async probeModels(): Promise<readonly CatalogModelEntry[]> {
      const snapshot = await AcpRuntimeClient.probeCatalog({ cwd: process.cwd(), ...launchOptions(spec) })
      return snapshot.models.map((m) => {
        const contextWindow = contextWindowFor(spec, m.id)
        return {
          id: m.id,
          name: m.name,
          ...(contextWindow ? { contextWindow } : {}),
          ...(m.thoughtLevels !== undefined
            ? { reasoningEfforts: m.thoughtLevels.map((t) => t.id) }
            : {}),
          ...(m.defaultThoughtLevel ? { defaultEffort: m.defaultThoughtLevel } : {}),
        }
      })
    },
    createDriver: ({ ctx, agent }) => new AcpDriverAdapter(ctx, agent, spec),
  }
}
