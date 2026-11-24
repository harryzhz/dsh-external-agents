import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionItem, UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import {
  CodexRuntimeClient,
  type CodexApprovalDecision,
  type CodexApprovalRequest,
  type CodexUserInputAnswer,
  type CodexUserInputRequest,
} from '@dsh-external-agents/runtime-codex'
import type { CatalogModelEntry } from '../catalog-adapter.js'
import type { ExternalAgent } from '../external-agent.js'
import type {
  ExternalRuntimeDriver,
  ExternalRuntimeProfile,
  ExternalTurnEvent,
  ExternalTurnRequest,
  ExternalTurnRunResult,
} from '../types.js'
import {
  contextWindowFor,
  expandRuntimeCwd,
  type ExternalRuntimeSpec,
} from './config.js'
import { toRuntimeSummary, type ExternalRuntimeDefinition } from './definition.js'
import { extractTextFromMessages, readImageSource } from './message-content.js'
import {
  resolveProfileCapabilities,
  resolveProfileDefaults,
  resolveRuntimeLaunchPlan,
} from './profile-resolver.js'

function extractCodexImages(messages: readonly UserMessage[]): Array<{ url: string }> {
  const images: Array<{ url: string }> = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image') continue
      const source = readImageSource(block)
      if (source.url) {
        images.push({ url: source.url })
      } else if (source.data) {
        images.push({ url: `data:${source.mimeType};base64,${source.data}` })
      }
    }
  }
  return images
}

async function bridgeCodexApproval(
  ctx: Context,
  agent: ExternalAgent,
  request: CodexApprovalRequest,
  signal: AbortSignal,
): Promise<CodexApprovalDecision> {
  const approval = ctx.get('approval') as ApprovalService | undefined
  if (!approval) return 'allow-session'
  const outcome = await approval.request({
    agent,
    toolName: request.toolName,
    ...(request.callId ? { callId: brandString<ToolCallId>(request.callId) } : {}),
    reason: request.reason,
    signal,
  })
  return outcome === 'allowed-once' ? 'allow-once' : 'reject'
}

async function bridgeCodexUserInput(
  ctx: Context,
  agent: ExternalAgent,
  request: CodexUserInputRequest,
  signal: AbortSignal,
): Promise<CodexUserInputAnswer> {
  const userQuestions = ctx.get('userQuestions') as UserQuestionService | undefined
  if (!userQuestions || request.questions.length === 0) {
    return { answers: {} }
  }
  const items: AskUserQuestionItem[] = request.questions.map((q) => ({
    id: q.id,
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.isMultiSelect ? { multiSelect: true } : {}),
    ...(q.options
      ? {
          options: q.options.map((opt) => ({
            label: opt.label,
            ...(opt.description ? { description: opt.description } : {}),
          })),
        }
      : {}),
  }))
  const res = await userQuestions.ask({
    agent,
    questions: items,
    signal,
  })
  const answers: Record<string, { answers: string[] }> = {}
  for (const ans of res.answers) {
    const values = [...ans.selected]
    if (ans.custom && ans.custom.trim()) values.push(ans.custom.trim())
    answers[ans.id] = { answers: values }
  }
  return { answers }
}

class CodexDriverAdapter implements ExternalRuntimeDriver {
  readonly kind: string
  private readonly client: CodexRuntimeClient

  constructor(
    private readonly ctx: Context,
    private readonly agent: ExternalAgent,
    private readonly spec: ExternalRuntimeSpec,
    profile?: ExternalRuntimeProfile,
  ) {
    this.kind = spec.id
    const plan = resolveRuntimeLaunchPlan(spec, profile, { DSH_SESSION_ID: agent.id })
    this.client = new CodexRuntimeClient({
      cwd: expandRuntimeCwd(agent.session.header.cwd),
      cliBin: plan.command,
      args: plan.args,
      env: plan.env,
      logger: (msg) => ctx.logger.warn(msg),
    })
  }

  get externalId(): string | undefined {
    return this.client.threadId
  }

  async ensureConnected(
    existingExternalId?: string,
    model?: string,
    reasoningEffort?: string,
  ): Promise<string> {
    if (this.client.isConnected && this.client.threadId) {
      return this.client.threadId
    }
    return await this.client.startOrResume({
      ...(existingExternalId ? { threadId: existingExternalId } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      approvalPolicy: this.spec.approvalPolicy,
      sandbox: this.spec.sandbox,
    })
  }

  async runTurn(
    request: ExternalTurnRequest,
    onEvent: (event: ExternalTurnEvent) => void,
    signal: AbortSignal,
  ): Promise<ExternalTurnRunResult> {
    const text = extractTextFromMessages(request.messages)
    const images = extractCodexImages(request.messages)
    const res = await this.client.runTurn(
      {
        text,
        ...(images.length > 0 ? { images } : {}),
        ...(request.modelChangedSinceStart ? { model: request.model } : {}),
        ...(request.modelChangedSinceStart && request.reasoningEffort
          ? { reasoningEffort: request.reasoningEffort }
          : {}),
        approvalPolicy: this.spec.approvalPolicy,
        sandbox: this.spec.sandbox,
      },
      {
        onEvent,
        onApproval: (req, sig) => bridgeCodexApproval(this.ctx, this.agent, req, sig),
        onUserInput: (req, sig) => bridgeCodexUserInput(this.ctx, this.agent, req, sig),
      },
      signal,
    )
    return {
      status: res.status,
      ...(res.usage ? { usage: res.usage } : {}),
      ...(res.errorMessage ? { errorMessage: res.errorMessage } : {}),
    }
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

/** `codex app-server` JSON-RPC runtime. */
export function createCodexRuntime(spec: ExternalRuntimeSpec): ExternalRuntimeDefinition {
  return {
    ...toRuntimeSummary(spec),
    fallbackModels: spec.fallbackModels,
    getProfileCapabilities: () => resolveProfileCapabilities(spec),
    resolveProfileDefaults: (profile) => resolveProfileDefaults(spec, profile),
    async probeModels(profile?: ExternalRuntimeProfile): Promise<readonly CatalogModelEntry[]> {
      const plan = resolveRuntimeLaunchPlan(spec, profile)
      const models = await CodexRuntimeClient.probeModels({
        cwd: process.cwd(),
        cliBin: plan.command,
        args: plan.args,
        env: plan.env,
      })
      const hasPlanDefault = Boolean(
        plan.defaultModel && models.some((m) => m.id === plan.defaultModel),
      )
      return models.map((m) => {
        const contextWindow = m.contextWindow ?? contextWindowFor(spec, m.id)
        const isDefault = hasPlanDefault ? m.id === plan.defaultModel : Boolean(m.isDefault)
        const defaultEffort =
          isDefault &&
          plan.defaultReasoningEffort &&
          m.supportedReasoningEfforts.includes(plan.defaultReasoningEffort)
            ? plan.defaultReasoningEffort
            : m.defaultReasoningEffort ?? m.supportedReasoningEfforts[0]
        return {
          id: m.id,
          name: m.name,
          ...(contextWindow ? { contextWindow } : {}),
          ...(isDefault ? { isDefault: true } : {}),
          ...(m.supportedReasoningEfforts.length > 0
            ? {
                reasoningEfforts: m.supportedReasoningEfforts,
                defaultEffort,
              }
            : m.reasoningEffortsDeclared
              ? { reasoningEfforts: [] }
              : {}),
        }
      })
    },
    createDriver: ({ ctx, agent, profile }) => new CodexDriverAdapter(ctx, agent, spec, profile),
  }
}
