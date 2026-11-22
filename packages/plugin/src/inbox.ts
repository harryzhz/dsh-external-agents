import type { AgentEventDispatch, Inbox, InboxState, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

export class ExternalAgentInbox implements Inbox {
  constructor(
    private readonly readState: () => Readonly<InboxState>,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  get nextTurn(): readonly UserMessage[] {
    return this.readState()['next-turn']
  }

  get nextStep(): readonly UserMessage[] {
    return this.readState()['next-step']
  }

  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = [...this.mutate('next-step', 0, this.nextStep.length, [], false)]
    if (target === 'next-turn') {
      claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    }
    for (const message of claimed) {
      this.dispatch.emit('agent/inbox/claimed', { message, turn })
    }
    return claimed
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.readState()[target].length, 0, [message])
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const loc = this.locate(messageId)
    if (!loc) return false
    this.splice(loc.target, loc.index, 1, [newMessage])
    return true
  }

  remove(messageId: MessageId): boolean {
    const loc = this.locate(messageId)
    if (!loc) return false
    this.splice(loc.target, loc.index, 1, [])
    return true
  }

  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.readState()
    const stepIndex = state['next-step'].findIndex((m) => m.id === messageId)
    if (stepIndex !== -1) return { target: 'next-step', index: stepIndex }
    const turnIndex = state['next-turn'].findIndex((m) => m.id === messageId)
    if (turnIndex !== -1) return { target: 'next-turn', index: turnIndex }
    return undefined
  }

  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    notify: boolean,
  ): UserMessage[] {
    const current = this.readState()[target]
    const clampedStart = Math.max(0, Math.min(start, current.length))
    const clampedDelete = Math.max(0, Math.min(deleteCount, current.length - clampedStart))
    const removed = current.slice(clampedStart, clampedStart + clampedDelete)
    if (clampedDelete === 0 && inserted.length === 0) return removed

    const data = {
      target,
      start: clampedStart,
      inserted: [...inserted],
      ...(clampedDelete > 0 ? { removedCount: clampedDelete } : {}),
    }
    this.session.append('agent/inbox/spliced', data)
    if (notify) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
      for (const message of inserted) this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
