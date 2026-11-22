import type { AcpActiveToolCall, AcpDiffHunk, AcpTurnEvent } from './types.js'

type JsonRecord = Record<string, unknown>

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|ico)$/i

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as JsonRecord
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function firstLine(text: string): string {
  const trimmed = text.trim()
  const nl = trimmed.indexOf('\n')
  return nl === -1 ? trimmed : trimmed.slice(0, nl)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
}

function unwrapShellCommand(raw: unknown): string {
  if (Array.isArray(raw)) {
    const parts = raw.filter((v): v is string => typeof v === 'string')
    if (parts.length >= 3 && /^-(?:l?c|cl)$/.test(parts[1] ?? '')) return parts[2] ?? ''
    return parts.join(' ')
  }
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  const match = /^(?:\/usr\/bin\/env\s+)?(?:\/[^\s/]+\/)*(?:zsh|bash|sh)\s+-(?:l?c|cl)\s+([\s\S]+)$/.exec(trimmed)
  if (!match?.[1]) return trimmed
  const inner = match[1].trim()
  if (inner.length >= 2 && inner.startsWith("'") && inner.endsWith("'")) {
    const body = inner.slice(1, -1)
    if (!body.replace(/'\\''/g, '').includes("'")) return body.replace(/'\\''/g, "'")
  }
  if (inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"')) {
    const body = inner.slice(1, -1)
    if (!/(?<!\\)"/.test(body)) return body.replace(/\\(["\\$`])/g, '$1')
  }
  return inner
}

function extractDiffsFromContent(rawContent: unknown): AcpDiffHunk[] {
  if (!Array.isArray(rawContent)) return []
  const out: AcpDiffHunk[] = []
  for (const entry of rawContent) {
    const rec = asRecord(entry)
    if (!rec || rec.type !== 'diff') continue
    const path = asString(rec.path)
    if (!path) continue
    const oldText = typeof rec.oldText === 'string' ? rec.oldText : null
    const newText = typeof rec.newText === 'string' ? rec.newText : ''
    out.push({ path, oldText, newText })
  }
  return out
}

function extractLocations(rawLocations: unknown): Array<{ path: string; line?: number }> {
  if (!Array.isArray(rawLocations)) return []
  const out: Array<{ path: string; line?: number }> = []
  for (const entry of rawLocations) {
    const rec = asRecord(entry)
    const path = asString(rec?.path)
    if (!path) continue
    const line = asNumber(rec?.line)
    out.push({ path, ...(line !== undefined && line >= 1 ? { line: Math.trunc(line) } : {}) })
  }
  return out
}

function mergeToolUpdateIntoState(state: AcpActiveToolCall, update: JsonRecord): void {
  const meta = asRecord(update._meta)
  const claudeCode = asRecord(meta?.claudeCode)
  const rawName = asString(claudeCode?.toolName) ?? asString(update.name)
  if (rawName) state.rawName = rawName

  const title = asString(update.title)
  if (title) state.title = title

  const kind = asString(update.kind)
  if (kind) state.kind = kind

  const incomingInput = update.args !== undefined ? update.args : update.rawInput
  if (incomingInput !== undefined && incomingInput !== null) {
    const incomingRec = asRecord(incomingInput)
    if (incomingRec) {
      if (Object.keys(incomingRec).length > 0 || state.rawInput === undefined) {
        state.rawInput = { ...(asRecord(state.rawInput) ?? {}), ...incomingRec }
      }
    } else {
      state.rawInput = incomingInput
    }
  }

  const locations = extractLocations(update.locations)
  if (locations.length > 0) state.locations = locations

  const diffs = extractDiffsFromContent(update.content)
  if (diffs.length > 0) state.diffs = diffs

  const termDelta = asRecord(meta?.terminal_output_delta)
  const termFull = asRecord(meta?.terminal_output)
  if (typeof termDelta?.data === 'string') {
    state.terminalOutput = (state.terminalOutput ?? '') + termDelta.data
  } else if (typeof termFull?.data === 'string') {
    state.terminalOutput = termFull.data
  }

  const termExit = asRecord(meta?.terminal_exit)
  if (termExit && (typeof termExit.exit_code === 'number' || termExit.exit_code === null)) {
    state.exitCode = termExit.exit_code as number | null
  }
}

function hasMeaningfulInput(state: AcpActiveToolCall): boolean {
  if (typeof state.rawInput === 'string' && state.rawInput.trim().length > 0) return true
  const rec = asRecord(state.rawInput)
  if (rec && Object.keys(rec).length > 0) return true
  if (state.locations.length > 0 || state.diffs.length > 0) return true
  const lower = (state.rawName ?? '').toLowerCase()
  return lower === 'tasklist' || lower === 'listagents' || lower === 'list_agents'
}

function normalizeMcpName(rawName: string): string {
  if (!rawName.startsWith('mcp__')) return rawName
  const parts = rawName.slice('mcp__'.length).split('__').filter(Boolean)
  return parts.length >= 2 ? `${parts[0]}.${parts.slice(1).join('__')}` : rawName
}

export function resolveNativeAcpToolCall(state: AcpActiveToolCall): {
  readonly name: string
  readonly arguments: string
} {
  const rawName = state.rawName ?? ''
  const lower = rawName.toLowerCase()
  const kind = (state.kind ?? '').toLowerCase()
  const input = asRecord(state.rawInput) ?? {}
  const locPath = state.locations[0]?.path
  const locLine = state.locations[0]?.line
  const firstDiff = state.diffs[0]

  // 1. Shell / Terminal execution
  if (
    lower === 'bash' ||
    lower === 'powershell' ||
    lower === 'pwsh' ||
    lower === 'run_command' ||
    kind === 'execute'
  ) {
    const wireName = lower === 'powershell' || lower === 'pwsh' ? 'pwsh' : 'bash'
    const rawCmd = input.command ?? input.CommandLine ?? input.cmd ?? state.title ?? ''
    const command = unwrapShellCommand(rawCmd) || '(command)'
    const description =
      asString(input.description) ??
      asString(input.command_description) ??
      asString(input.toolSummary) ??
      firstLine(command)
    const workdir = asString(input.workdir) ?? asString(input.cwd) ?? asString(input.Cwd)
    const background = input.run_in_background === true || input.IsDaemon === true
    return {
      name: wireName,
      arguments: safeJson({
        command,
        description: description || command,
        ...(workdir ? { workdir } : {}),
        ...(background ? { run_in_background: true } : {}),
      }),
    }
  }

  // 2. File creation / full write
  if (lower === 'write' || lower === 'write_file') {
    const filePath =
      asString(input.file_path) ??
      asString(input.Path) ??
      asString(input.path) ??
      firstDiff?.path ??
      locPath ??
      ''
    const content =
      typeof input.content === 'string'
        ? input.content
        : typeof input.Content === 'string'
          ? input.Content
          : typeof input.file_text === 'string'
            ? input.file_text
            : typeof input.file_content === 'string'
              ? input.file_content
              : firstDiff?.newText ?? ''
    return {
      name: 'write',
      arguments: safeJson({ file_path: filePath, content }),
    }
  }

  // 3. File edit
  if (
    lower === 'edit' ||
    lower === 'edit_file' ||
    lower === 'multi_edit' ||
    (kind === 'edit' && (firstDiff !== undefined || locPath !== undefined || input.file_path !== undefined || input.Path !== undefined))
  ) {
    const filePath =
      asString(input.file_path) ??
      asString(input.Path) ??
      asString(input.path) ??
      firstDiff?.path ??
      locPath ??
      ''
    const oldString =
      typeof input.old_string === 'string'
        ? input.old_string
        : typeof input.Target === 'string'
          ? input.Target
          : firstDiff?.oldText ?? ''
    const newString =
      typeof input.new_string === 'string'
        ? input.new_string
        : typeof input.Replacement === 'string'
          ? input.Replacement
          : firstDiff?.newText ?? ''
    return {
      name: 'edit',
      arguments: safeJson({
        file_path: filePath,
        old_string: oldString,
        new_string: newString,
        ...(typeof input.replace_all === 'boolean' ? { replace_all: input.replace_all } : {}),
      }),
    }
  }

  // 4. Web search & fetch
  const urlArg = asString(input.url) ?? asString(input.Url)
  if (lower === 'websearch' || lower === 'web_search' || lower === 'search_web') {
    const rawQueries = Array.isArray(input.queries)
      ? input.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      : []
    const single = asString(input.query) ?? asString(input.Query) ?? state.title ?? '(search)'
    return {
      name: 'web_search',
      arguments: safeJson({ queries: rawQueries.length > 0 ? rawQueries : [single] }),
    }
  }
  if (lower === 'webfetch' || lower === 'web_fetch' || lower === 'read_url_content' || (kind === 'fetch' && urlArg)) {
    return {
      name: 'web_fetch',
      arguments: safeJson({ url: urlArg ?? state.title ?? '' }),
    }
  }

  // 5. Grep & Glob search
  if (lower === 'grep' || lower === 'grep_search') {
    const pattern = asString(input.pattern) ?? asString(input.Query) ?? asString(input.query) ?? state.title ?? ''
    const path = asString(input.path) ?? asString(input.SearchPath) ?? asString(input.file_path) ?? locPath
    const include = asString(input.glob) ?? asString(input.include)
    return {
      name: 'grep',
      arguments: safeJson({
        pattern,
        ...(path ? { path } : {}),
        ...(include ? { include } : {}),
      }),
    }
  }
  if (lower === 'glob' || lower === 'find_by_name') {
    const pattern = asString(input.pattern) ?? asString(input.Pattern) ?? state.title ?? '*'
    const path = asString(input.path) ?? asString(input.SearchDirectory) ?? locPath
    return {
      name: 'glob',
      arguments: safeJson({
        pattern,
        ...(path ? { path } : {}),
      }),
    }
  }

  // 6. File / Image read
  const readPath = asString(input.file_path) ?? asString(input.Path) ?? asString(input.path) ?? locPath
  if (lower === 'read' || lower === 'read_file' || lower === 'read_image' || (kind === 'read' && readPath)) {
    const filePath = readPath ?? state.title ?? ''
    const isImage = lower === 'read_image' || IMAGE_EXT_RE.test(filePath)
    if (isImage) {
      return { name: 'read_image', arguments: safeJson({ file_path: filePath }) }
    }
    const rawOffset = asNumber(input.offset) ?? asNumber(input.StartLine) ?? locLine
    const startLine = asNumber(input.StartLine)
    const endLine = asNumber(input.EndLine)
    const rawLimit =
      asNumber(input.limit) ??
      (startLine !== undefined && endLine !== undefined && endLine >= startLine
        ? endLine - startLine + 1
        : undefined)
    const offset = rawOffset !== undefined && rawOffset >= 1 ? Math.trunc(rawOffset) : undefined
    const limit = rawLimit !== undefined && rawLimit >= 1 ? Math.trunc(rawLimit) : undefined
    return {
      name: 'read',
      arguments: safeJson({
        file_path: filePath,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    }
  }

  // 7. Todo list updates
  if (lower === 'todowrite' || lower === 'todo_write') {
    return {
      name: 'todo_write',
      arguments: safeJson({ todos: Array.isArray(input.todos) ? input.todos : [] }),
    }
  }

  // 8. Subagents & User questions
  if (lower === 'agent' || lower === 'task' || lower === 'invoke_subagent' || lower === 'subagent') {
    const prompt = asString(input.prompt) ?? asString(input.Prompt)
    const description =
      asString(input.description) ?? asString(input.Role) ?? state.title ?? (prompt ? firstLine(prompt) : undefined)
    return {
      name: 'subagent',
      arguments: safeJson({
        ...(description ? { description } : {}),
        ...(prompt ? { prompt } : {}),
      }),
    }
  }
  if (lower === 'askuserquestion' || lower === 'ask_user_question' || lower === 'ask_question') {
    return {
      name: 'ask_user_question',
      arguments: typeof state.rawInput === 'string' ? state.rawInput : safeJson(state.rawInput),
    }
  }

  // 9. Preserve MCP and custom tools cleanly without falling back to synthetic `acp_tool`
  const fallbackName = rawName
    ? normalizeMcpName(rawName)
    : asString(state.title) ?? asString(state.kind) ?? 'tool'
  const fallbackArgs =
    typeof state.rawInput === 'string'
      ? state.rawInput
      : Object.keys(input).length > 0
        ? safeJson(input)
        : state.title
          ? safeJson({ description: state.title })
          : '{}'
  return {
    name: fallbackName,
    arguments: fallbackArgs,
  }
}

function stripConsoleCodeFence(text: string): string {
  const match = /^```(?:console|sh|bash|zsh)?\n([\s\S]*?)\n```$/u.exec(text.trim())
  return match?.[1] ?? text
}

function extractUpdateOutputText(state: AcpActiveToolCall, update: JsonRecord): string {
  if (typeof state.terminalOutput === 'string' && state.terminalOutput.length > 0) {
    return state.terminalOutput
  }
  const rawOutput = update.rawOutput
  if (typeof rawOutput === 'string' && rawOutput.length > 0) return rawOutput
  if (Array.isArray(rawOutput)) {
    const parts = rawOutput
      .map((item) => asString(asRecord(item)?.text))
      .filter((s): s is string => s !== undefined)
    if (parts.length > 0) return parts.join('\n')
  }
  if (rawOutput && typeof rawOutput === 'object') return safeJson(rawOutput)

  const content = Array.isArray(update.content) ? update.content : []
  const textParts = content
    .map((entry) => {
      const rec = asRecord(entry)
      if (!rec || rec.type === 'diff') return ''
      const inner = asRecord(rec.content)
      return asString(inner?.text) ?? asString(rec.text) ?? ''
    })
    .filter((s) => s.length > 0)
  if (textParts.length > 0) return textParts.join('\n')

  if (state.diffs.length > 0) {
    return state.diffs.map((d) => d.path).join(', ')
  }
  if (state.locations.length > 0) {
    return state.locations.map((l) => l.path).join('\n')
  }
  return asString(update.status) ?? 'completed'
}

function isTerminalStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled'
}

export function processAcpToolSessionUpdate(
  kind: 'tool_call' | 'tool_call_update',
  update: JsonRecord,
  activeTools: Map<string, AcpActiveToolCall>,
): readonly AcpTurnEvent[] {
  const callId = asString(update.toolCallId)
  if (!callId) return []

  let state = activeTools.get(callId)
  if (kind === 'tool_call' || !state) {
    state = {
      locations: [],
      diffs: [],
      started: state?.started ?? false,
      ...(state?.emittedName ? { emittedName: state.emittedName } : {}),
    }
    activeTools.set(callId, state)
  }

  mergeToolUpdateIntoState(state, update)
  const status = asString(update.status)?.toLowerCase()
  const events: AcpTurnEvent[] = []

  if (!isTerminalStatus(status)) {
    if (!state.started && hasMeaningfulInput(state)) {
      const resolved = resolveNativeAcpToolCall(state)
      state.started = true
      state.emittedName = resolved.name
      events.push({
        type: 'tool-start',
        callId,
        name: resolved.name,
        arguments: resolved.arguments,
      })
    }
    return events
  }

  const resolved = resolveNativeAcpToolCall(state)
  const finalName = state.emittedName ?? resolved.name
  if (!state.started) {
    events.push({
      type: 'tool-start',
      callId,
      name: finalName,
      arguments: resolved.arguments,
    })
  }
  activeTools.delete(callId)

  let output = extractUpdateOutputText(state, update)
  let isError = status !== 'completed'
  const meta: Record<string, unknown> = {}

  if (finalName === 'bash' || finalName === 'pwsh') {
    output = stripConsoleCodeFence(output).replace(/\n$/, '')
    let exitCode = typeof state.exitCode === 'number' ? state.exitCode : undefined
    if (exitCode === undefined && isError) {
      const exitMatch = /^Exit code (-?\d+)(?:\n|$)/.exec(output)
      if (exitMatch?.[1]) {
        exitCode = Number(exitMatch[1])
        output = output.slice(exitMatch[0].length)
      }
    }
    if (exitCode !== undefined && status !== 'cancelled') {
      isError = false
      if (exitCode !== 0 && !/\n\[exit code: -?\d+\]$/.test(output)) {
        output = `${output}\n[exit code: ${exitCode}]`
      }
    }
  }

  if (!isError && (finalName === 'write' || finalName === 'edit' || finalName === 'apply_patch')) {
    if (state.diffs.length > 0) {
      meta.diffs = state.diffs
    }
    const pathCandidate = state.diffs[0]?.path ?? state.locations[0]?.path
    if (pathCandidate && isAbsolutePath(pathCandidate)) {
      meta.path = pathCandidate
    }
  } else if (!isError && (finalName === 'read' || finalName === 'read_image')) {
    const pathCandidate = state.locations[0]?.path
    if (pathCandidate && isAbsolutePath(pathCandidate)) {
      meta.path = pathCandidate
    }
  }

  events.push({
    type: 'tool-complete',
    callId,
    name: finalName,
    output,
    isError,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  })
  return events
}

export function resolveAcpPermissionToolName(toolCall: JsonRecord | undefined): string {
  if (!toolCall) return 'tool'
  const tempState: AcpActiveToolCall = {
    locations: [],
    diffs: [],
    started: false,
  }
  mergeToolUpdateIntoState(tempState, toolCall)
  return resolveNativeAcpToolCall(tempState).name
}
