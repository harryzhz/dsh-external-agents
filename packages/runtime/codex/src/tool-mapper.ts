type JsonRecord = Record<string, unknown>

export interface CodexDiffHunk {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

export interface MappedCodexToolStart {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

export interface MappedCodexToolComplete {
  readonly callId: string
  readonly name: string
  readonly output: string
  readonly isError: boolean
  readonly meta?: Record<string, unknown>
}

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

/**
 * Unwraps shell wrapper invocations such as `["/bin/zsh", "-lc", "git status"]`
 * or `"/bin/zsh -lc 'git status'"` so DSH's terminal card displays the clean command.
 */
export function unwrapShellCommand(raw: unknown): string {
  if (Array.isArray(raw)) {
    const parts = raw.filter((v): v is string => typeof v === 'string')
    if (parts.length >= 3 && /^-(?:l?c|cl)$/.test(parts[1] ?? '')) {
      return parts[2] ?? ''
    }
    return parts.join(' ')
  }
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  const match = /^(?:\/usr\/bin\/env\s+)?(?:\/[^\s/]+\/)*(?:zsh|bash|sh)\s+-(?:l?c|cl)\s+([\s\S]+)$/.exec(trimmed)
  if (!match?.[1]) return trimmed
  const inner = match[1].trim()
  if (inner.length >= 2 && inner.startsWith("'") && inner.endsWith("'")) {
    const body = inner.slice(1, -1)
    if (!body.replace(/'\\''/g, '').includes("'")) {
      return body.replace(/'\\''/g, "'")
    }
  }
  if (inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"')) {
    const body = inner.slice(1, -1)
    if (!/(?<!\\)"/.test(body)) {
      return body.replace(/\\(["\\$`])/g, '$1')
    }
  }
  return inner
}

interface ParsedFileChange {
  readonly path: string
  readonly kindType: 'add' | 'delete' | 'update'
  readonly movePath?: string
  readonly diff: string
  readonly hunk: CodexDiffHunk
}

function parseChangeKind(rawKind: unknown): { kindType: 'add' | 'delete' | 'update'; movePath?: string } {
  if (typeof rawKind === 'string') {
    const lower = rawKind.toLowerCase()
    if (lower === 'add' || lower === 'create') return { kindType: 'add' }
    if (lower === 'delete' || lower === 'remove') return { kindType: 'delete' }
    return { kindType: 'update' }
  }
  const rec = asRecord(rawKind)
  const type = asString(rec?.type)?.toLowerCase()
  if (type === 'add' || type === 'create') return { kindType: 'add' }
  if (type === 'delete' || type === 'remove') return { kindType: 'delete' }
  const movePath = asString(rec?.move_path) ?? asString(rec?.movePath)
  return { kindType: 'update', ...(movePath ? { movePath } : {}) }
}

function parseDiffToHunk(
  path: string,
  kindType: 'add' | 'delete' | 'update',
  diff: string,
  movePath?: string,
): CodexDiffHunk {
  const targetPath = movePath ?? path
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const hasUnifiedMarkers = lines.some((l) => l.startsWith('@@'))

  if (kindType === 'add') {
    if (!hasUnifiedMarkers && !lines.some((l) => l.startsWith('+'))) {
      return { path: targetPath, oldText: null, newText: diff }
    }
    const added = lines
      .filter((l) => l.startsWith('+') && !l.startsWith('+++ '))
      .map((l) => l.slice(1))
    return { path: targetPath, oldText: null, newText: added.join('\n') }
  }

  if (kindType === 'delete') {
    if (!hasUnifiedMarkers && !lines.some((l) => l.startsWith('-'))) {
      return { path: targetPath, oldText: diff, newText: '' }
    }
    const removed = lines
      .filter((l) => l.startsWith('-') && !l.startsWith('--- '))
      .map((l) => l.slice(1))
    return { path: targetPath, oldText: removed.join('\n'), newText: '' }
  }

  if (!hasUnifiedMarkers) {
    return { path: targetPath, oldText: '', newText: diff }
  }

  const oldLines: string[] = []
  const newLines: string[] = []
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('\\ No newline')) continue
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1))
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1))
    } else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1))
      newLines.push(line.slice(1))
    }
  }
  return { path: targetPath, oldText: oldLines.join('\n'), newText: newLines.join('\n') }
}

function parseCodexFileChanges(rawChanges: unknown): ParsedFileChange[] {
  if (!Array.isArray(rawChanges)) return []
  const out: ParsedFileChange[] = []
  for (const entry of rawChanges) {
    const rec = asRecord(entry)
    const path = asString(rec?.path)
    if (!rec || !path) continue
    const { kindType, movePath } = parseChangeKind(rec.kind)
    const diff = typeof rec.diff === 'string' ? rec.diff : typeof rec.content === 'string' ? rec.content : ''
    out.push({
      path,
      kindType,
      ...(movePath ? { movePath } : {}),
      diff,
      hunk: parseDiffToHunk(path, kindType, diff, movePath),
    })
  }
  return out
}

function buildDshPatchInput(changes: readonly ParsedFileChange[]): string {
  const out: string[] = ['*** Begin Patch']
  for (const change of changes) {
    if (change.kindType === 'add') {
      out.push(`*** Add File: ${change.path}`)
      const bodyLines = change.hunk.newText.split('\n')
      for (const line of bodyLines) out.push(`+${line}`)
      continue
    }
    if (change.kindType === 'delete') {
      out.push(`*** Delete File: ${change.path}`)
      continue
    }
    out.push(`*** Update File: ${change.path}`)
    if (change.movePath) {
      out.push(`*** Move to: ${change.movePath}`)
    }
    const rawLines = change.diff.replace(/\r\n/g, '\n').split('\n')
    const patchBody: string[] = []
    for (const line of rawLines) {
      if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('\\ No newline')) continue
      if (line === '@@' || line.startsWith('@@ ')) {
        patchBody.push(line)
      } else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
        patchBody.push(line)
      }
    }
    if (!patchBody.some((l) => l.startsWith('+') || l.startsWith('-') || l.startsWith(' '))) {
      out.push('@@')
      out.push(' ')
    } else {
      if (!patchBody[0]?.startsWith('@@')) out.push('@@')
      out.push(...patchBody)
    }
  }
  out.push('*** End Patch')
  return out.join('\n')
}

function mapCollabToolName(rawTool: string | undefined): string {
  switch (rawTool) {
    case 'spawnAgent':
    case 'resumeAgent':
    case 'followupTask':
      return 'subagent'
    case 'sendMessage':
    case 'sendInput':
      return 'send_message'
    case 'wait':
      return 'wait_agent'
    case 'interruptAgent':
    case 'closeAgent':
      return 'interrupt_agent'
    case 'listAgents':
      return 'list_agents'
    default:
      return rawTool ?? 'subagent'
  }
}

export function extractCodexToolStart(item: JsonRecord): MappedCodexToolStart | undefined {
  const itemType = asString(item.type)
  const callId = asString(item.id) ?? asString(item.callId)
  if (!itemType || !callId) return undefined

  if (itemType === 'commandExecution') {
    const command = unwrapShellCommand(item.command ?? item.parsedCmd) || '(command)'
    const cwd = asString(item.cwd)
    const description = asString(item.description) ?? firstLine(command)
    return {
      callId,
      name: 'bash',
      arguments: safeJson({
        command,
        description: description || command,
        ...(cwd ? { workdir: cwd } : {}),
      }),
    }
  }

  if (itemType === 'fileChange') {
    const changes = parseCodexFileChanges(item.changes ?? item.files)
    if (changes.length === 1 && changes[0]!.kindType === 'add') {
      const only = changes[0]!
      return {
        callId,
        name: 'write',
        arguments: safeJson({ file_path: only.path, content: only.hunk.newText }),
      }
    }
    if (changes.length === 1 && changes[0]!.kindType === 'update' && !changes[0]!.movePath) {
      const only = changes[0]!
      return {
        callId,
        name: 'edit',
        arguments: safeJson({
          file_path: only.path,
          old_string: only.hunk.oldText ?? '',
          new_string: only.hunk.newText,
        }),
      }
    }
    return {
      callId,
      name: 'apply_patch',
      arguments: safeJson({ input: buildDshPatchInput(changes) }),
    }
  }

  if (itemType === 'webSearch') {
    const action = asRecord(item.action)
    const actionType = asString(action?.type)
    const actionUrl = asString(action?.url)
    if (actionType === 'open_page' && actionUrl) {
      return {
        callId,
        name: 'web_fetch',
        arguments: safeJson({ url: actionUrl }),
      }
    }
    const rawQueries = Array.isArray(action?.queries)
      ? action.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      : []
    const singleQuery = asString(action?.query) ?? asString(item.query) ?? asString(action?.pattern)
    const queries = rawQueries.length > 0 ? rawQueries : [singleQuery ?? '(search)']
    return {
      callId,
      name: 'web_search',
      arguments: safeJson({ queries }),
    }
  }

  if (itemType === 'imageView') {
    const path = asString(item.path) ?? ''
    return {
      callId,
      name: 'read_image',
      arguments: safeJson({ file_path: path }),
    }
  }

  if (itemType === 'collabAgentToolCall') {
    const name = mapCollabToolName(asString(item.tool))
    const prompt = asString(item.prompt)
    const model = asString(item.model)
    return {
      callId,
      name,
      arguments: safeJson({
        ...(prompt ? { description: firstLine(prompt), prompt } : {}),
        ...(model ? { model } : {}),
      }),
    }
  }

  if (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall') {
    const prefix = asString(item.server) ?? asString(item.namespace)
    const tool = asString(item.tool) ?? asString(item.name) ?? itemType
    const name = prefix ? `${prefix}.${tool}` : tool
    return {
      callId,
      name,
      arguments: typeof item.arguments === 'string' ? item.arguments : safeJson(item.arguments ?? item.input),
    }
  }

  return undefined
}

function extractWebSourcesMeta(item: JsonRecord): Record<string, unknown> | undefined {
  if (!Array.isArray(item.results)) return undefined
  const sources: Array<Record<string, string>> = []
  for (const raw of item.results) {
    const rec = asRecord(raw)
    const url = asString(rec?.url)
    if (!rec || !url) continue
    const title = asString(rec.title)
    const snippet = asString(rec.snippet) ?? asString(rec.summary)
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
    })
  }
  return sources.length > 0 ? { sources, truncated: false } : undefined
}

export function extractCodexToolComplete(item: JsonRecord): MappedCodexToolComplete | undefined {
  const start = extractCodexToolStart(item)
  if (!start) return undefined

  const itemType = asString(item.type)
  const status = asString(item.status)?.toLowerCase()

  if (itemType === 'commandExecution') {
    const exitCode = asNumber(item.exitCode)
    const cwd = asString(item.cwd)
    const rawOut = asString(item.aggregatedOutput) ?? asString(item.output) ?? asString(item.stdout) ?? ''
    const stderr = asString(item.stderr)
    const combined = [rawOut.replace(/\n$/, ''), stderr?.replace(/\n$/, '')].filter(Boolean).join('\n')
    const hardFailure =
      status === 'declined' ||
      ((status === 'failed' || status === 'error') && exitCode === undefined && item.error !== undefined)

    if (hardFailure) {
      const errText =
        typeof item.error === 'string'
          ? item.error
          : item.error
            ? safeJson(item.error)
            : combined || `Command ${status ?? 'failed'}`
      return {
        callId: start.callId,
        name: start.name,
        output: errText,
        isError: true,
      }
    }

    const withMarker =
      exitCode !== undefined && exitCode !== 0 ? `${combined}\n[exit code: ${exitCode}]` : combined
    return {
      callId: start.callId,
      name: start.name,
      output: withMarker,
      isError: false,
      ...(cwd && isAbsolutePath(cwd) ? { meta: { cwd } } : {}),
    }
  }

  if (itemType === 'fileChange') {
    const isError = status === 'failed' || status === 'error' || status === 'declined'
    const changes = parseCodexFileChanges(item.changes ?? item.files)
    const diffs = changes.map((c) => c.hunk)
    const singlePath = changes.length === 1 ? (changes[0]!.movePath ?? changes[0]!.path) : undefined
    const summary =
      changes.length > 0
        ? changes.map((c) => (c.movePath ? `${c.path} -> ${c.movePath}` : c.path)).join(', ')
        : isError
          ? 'File update failed'
          : 'Applied file changes'
    return {
      callId: start.callId,
      name: start.name,
      output: summary,
      isError,
      ...(!isError && diffs.length > 0
        ? {
            meta: {
              diffs,
              ...(singlePath && isAbsolutePath(singlePath) ? { path: singlePath } : {}),
            },
          }
        : {}),
    }
  }

  if (itemType === 'webSearch') {
    const meta = start.name === 'web_search' ? extractWebSourcesMeta(item) : undefined
    const output =
      Array.isArray(item.results) && item.results.length > 0
        ? safeJson(item.results)
        : asString(item.query) ?? 'ok'
    return {
      callId: start.callId,
      name: start.name,
      output,
      isError: status === 'failed' || status === 'error',
      ...(meta ? { meta } : {}),
    }
  }

  const isError =
    status === 'failed' ||
    status === 'error' ||
    status === 'declined' ||
    item.success === false ||
    (item.error !== undefined && item.error !== null)

  const parts: string[] = []
  if (item.result !== undefined && item.result !== null) {
    parts.push(typeof item.result === 'string' ? item.result : safeJson(item.result))
  }
  if (Array.isArray(item.contentItems) && parts.length === 0) {
    const texts = item.contentItems
      .map((entry) => asString(asRecord(entry)?.text))
      .filter((t): t is string => t !== undefined)
    if (texts.length > 0) parts.push(texts.join('\n'))
  }
  if (item.agentsStates && typeof item.agentsStates === 'object' && parts.length === 0) {
    parts.push(safeJson(item.agentsStates))
  }
  if (item.error !== undefined && item.error !== null) {
    parts.push(typeof item.error === 'string' ? item.error : safeJson(item.error))
  }

  return {
    callId: start.callId,
    name: start.name,
    output: parts.join('\n') || (isError ? 'tool execution failed' : 'ok'),
    isError,
  }
}
