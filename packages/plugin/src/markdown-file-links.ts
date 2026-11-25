/**
 * Streaming-safe Markdown normalizer that rewrites local `file://` URI link
 * and image destinations into DSH-native filesystem paths so DSH Web's
 * right-sidebar file preview and `/api/file` image loader can open remote-host
 * files directly.
 *
 * Preserves fenced code blocks, inline code spans, non-local `file://` hosts,
 * query-bearing URIs, malformed percent escapes, and non-`file:` schemes.
 */

const FILE_SCHEME_PREFIX = 'file://'
const FILE_SCHEME_RE = /^file:\/\//i
const LOCALHOST_PREFIX_RE = /^localhost\//i
const WINDOWS_DRIVE_RE = /^\/([a-z])(?::|%3a)(\/.*)$/i
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/
const MAX_INLINE_CODE_LOOKAHEAD = 4096
const MAX_REF_LABEL_LENGTH = 999
const MAX_LINK_TITLE_LENGTH = 512

interface FenceState {
  readonly char: '`' | '~'
  readonly len: number
  readonly quoteDepth: number
}

type MatchResult =
  | { readonly kind: 'need-more' }
  | { readonly kind: 'no-match' }
  | { readonly kind: 'matched'; readonly nextPos: number; readonly output: string }

type WhitespaceResult =
  | { readonly kind: 'need-more' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly pos: number; readonly hadWhitespace: boolean }

type TailResult =
  | { readonly kind: 'need-more' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly endPos: number }

type LinePrefixResult =
  | { readonly kind: 'need-more' }
  | { readonly kind: 'eol'; readonly nextPos: number }
  | { readonly kind: 'ready'; readonly prefixEnd: number; readonly quoteDepth: number }

function isFileSchemePrefix(slice: string): boolean {
  if (slice.length === 0) return true
  const lower = slice.slice(0, FILE_SCHEME_PREFIX.length).toLowerCase()
  return FILE_SCHEME_PREFIX.startsWith(lower) || lower === FILE_SCHEME_PREFIX
}

/**
 * Convert a local `file://` URI destination into a DSH-compatible path while
 * preserving valid percent-encoding and `#L...` / `:line` suffixes.
 *
 * Returns `undefined` when the destination is not a local `file://` URI or
 * cannot be represented safely for DSH's `parseFileLink()`.
 */
export function convertFileUriDestination(rawDestination: string): string | undefined {
  if (!FILE_SCHEME_RE.test(rawDestination) || CONTROL_CHAR_RE.test(rawDestination)) {
    return undefined
  }

  const hashIdx = rawDestination.indexOf('#')
  const beforeHash = hashIdx < 0 ? rawDestination : rawDestination.slice(0, hashIdx)
  const fragment = hashIdx < 0 ? '' : rawDestination.slice(hashIdx)
  if (beforeHash.includes('?')) return undefined

  const afterScheme = beforeHash.slice(FILE_SCHEME_PREFIX.length)
  let rawPath: string
  if (afterScheme.startsWith('/')) {
    rawPath = afterScheme
  } else if (LOCALHOST_PREFIX_RE.test(afterScheme)) {
    rawPath = afterScheme.slice('localhost'.length)
  } else {
    return undefined
  }

  // Reject bare `/` root and double-slash `//` (UNC / malformed authority).
  if (rawPath.length <= 1 || rawPath.startsWith('//')) return undefined

  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return undefined
  }
  if (decoded.length <= 1 || CONTROL_CHAR_RE.test(decoded)) return undefined

  const winMatch = WINDOWS_DRIVE_RE.exec(rawPath)
  if (winMatch) {
    const drive = winMatch[1]!
    const rest = winMatch[2]!
    if (rest.length <= 1) return undefined
    return `${drive}:${rest}${fragment}`
  }

  return `${rawPath}${fragment}`
}

function scanLinePrefix(buf: string, pos: number, eof: boolean): LinePrefixResult {
  let i = pos
  let quoteDepth = 0
  while (i < buf.length) {
    const ch = buf[i]!
    if (ch === ' ' || ch === '\t') {
      i += 1
      continue
    }
    if (ch === '>') {
      quoteDepth += 1
      i += 1
      continue
    }
    if (ch === '\r') {
      if (i + 1 === buf.length && !eof) return { kind: 'need-more' }
      const nextPos = buf[i + 1] === '\n' ? i + 2 : i + 1
      return { kind: 'eol', nextPos }
    }
    if (ch === '\n') {
      return { kind: 'eol', nextPos: i + 1 }
    }
    return { kind: 'ready', prefixEnd: i, quoteDepth }
  }
  return eof ? { kind: 'eol', nextPos: buf.length } : { kind: 'need-more' }
}

function checkBlankLineAtNewline(buf: string, nlPos: number, eof: boolean): 'blank' | 'not-blank' | 'need-more' {
  let i = nlPos + 1
  while (i < buf.length && (buf[i] === ' ' || buf[i] === '\t')) i += 1
  if (i === buf.length) return eof ? 'not-blank' : 'need-more'
  if (buf[i] === '\n') return 'blank'
  if (buf[i] === '\r') {
    if (i + 1 === buf.length && !eof) return 'need-more'
    return buf[i + 1] === '\n' ? 'blank' : 'not-blank'
  }
  return 'not-blank'
}

function skipOptionalWhitespace(buf: string, start: number, eof: boolean): WhitespaceResult {
  let i = start
  let seenNewline = false
  let hadWhitespace = false

  while (i < buf.length) {
    const ch = buf[i]!
    if (ch === ' ' || ch === '\t') {
      hadWhitespace = true
      i += 1
      continue
    }
    if (ch === '\r') {
      if (i + 1 === buf.length && !eof) return { kind: 'need-more' }
      if (buf[i + 1] !== '\n') return { kind: 'invalid' }
      if (seenNewline) return { kind: 'invalid' }
      seenNewline = true
      hadWhitespace = true
      i += 2
      continue
    }
    if (ch === '\n') {
      if (seenNewline) return { kind: 'invalid' }
      seenNewline = true
      hadWhitespace = true
      i += 1
      continue
    }
    return { kind: 'ok', pos: i, hadWhitespace }
  }

  return eof ? { kind: 'ok', pos: i, hadWhitespace } : { kind: 'need-more' }
}

function verifyInlineLinkTail(buf: string, start: number, eof: boolean): TailResult {
  const ws1 = skipOptionalWhitespace(buf, start, eof)
  if (ws1.kind !== 'ok') return ws1
  if (ws1.pos >= buf.length) return eof ? { kind: 'invalid' } : { kind: 'need-more' }

  const ch = buf[ws1.pos]!
  if (ch === ')') return { kind: 'valid', endPos: ws1.pos + 1 }
  if (!ws1.hadWhitespace) return { kind: 'invalid' }

  const closeQuote = ch === '"' ? '"' : ch === "'" ? "'" : ch === '(' ? ')' : undefined
  if (!closeQuote) return { kind: 'invalid' }

  let i = ws1.pos + 1
  const limit = ws1.pos + 1 + MAX_LINK_TITLE_LENGTH
  while (i < buf.length && i <= limit) {
    const c = buf[i]!
    if (c === '\\') {
      if (i + 1 === buf.length) return eof ? { kind: 'invalid' } : { kind: 'need-more' }
      i += 2
      continue
    }
    if (c === closeQuote) {
      const ws2 = skipOptionalWhitespace(buf, i + 1, eof)
      if (ws2.kind !== 'ok') return ws2
      if (ws2.pos >= buf.length) return eof ? { kind: 'invalid' } : { kind: 'need-more' }
      return buf[ws2.pos] === ')' ? { kind: 'valid', endPos: ws2.pos + 1 } : { kind: 'invalid' }
    }
    if (c === '(' && closeQuote === ')') return { kind: 'invalid' }
    if (c === '\n') {
      const blank = checkBlankLineAtNewline(buf, i, eof)
      if (blank === 'need-more') return { kind: 'need-more' }
      if (blank === 'blank') return { kind: 'invalid' }
    }
    i += 1
  }

  if (i > limit) return { kind: 'invalid' }
  return eof ? { kind: 'invalid' } : { kind: 'need-more' }
}

function parseAngleDestination(
  buf: string,
  originPos: number,
  destStart: number,
  eof: boolean,
  mode: 'inline' | 'ref-def',
): MatchResult {
  const innerStart = destStart + 1
  if (!isFileSchemePrefix(buf.slice(innerStart))) return { kind: 'no-match' }

  let i = innerStart
  while (i < buf.length) {
    const ch = buf[i]!
    if (ch === '\n' || ch === '\r' || ch === '<') return { kind: 'no-match' }
    if (ch === '\\') {
      if (i + 1 === buf.length) return eof ? { kind: 'no-match' } : { kind: 'need-more' }
      i += 2
      continue
    }
    if (ch === '>') {
      const converted = convertFileUriDestination(buf.slice(innerStart, i))
      if (!converted) return { kind: 'no-match' }

      if (mode === 'inline') {
        const tail = verifyInlineLinkTail(buf, i + 1, eof)
        if (tail.kind === 'need-more') return { kind: 'need-more' }
        if (tail.kind === 'invalid') return { kind: 'no-match' }
        return {
          kind: 'matched',
          nextPos: tail.endPos,
          output: `${buf.slice(originPos, innerStart)}${converted}>${buf.slice(i + 1, tail.endPos)}`,
        }
      }

      if (i + 1 === buf.length && !eof) return { kind: 'need-more' }
      if (i + 1 < buf.length && !/[ \t\r\n]/.test(buf[i + 1]!)) return { kind: 'no-match' }
      return {
        kind: 'matched',
        nextPos: i + 1,
        output: `${buf.slice(originPos, innerStart)}${converted}>`,
      }
    }
    i += 1
  }

  return eof ? { kind: 'no-match' } : { kind: 'need-more' }
}

function parseBareDestination(
  buf: string,
  originPos: number,
  destStart: number,
  eof: boolean,
  mode: 'inline' | 'ref-def',
): MatchResult {
  if (!isFileSchemePrefix(buf.slice(destStart))) return { kind: 'no-match' }

  let i = destStart
  let parenDepth = 0
  while (i < buf.length) {
    const ch = buf[i]!
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || CONTROL_CHAR_RE.test(ch)) {
      break
    }
    if (ch === '\\') {
      if (i + 1 === buf.length) return eof ? { kind: 'no-match' } : { kind: 'need-more' }
      i += 2
      continue
    }
    if (ch === '(') {
      parenDepth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      if (mode === 'inline' && parenDepth === 0) break
      if (parenDepth > 0) parenDepth -= 1
      i += 1
      continue
    }
    i += 1
  }

  if (i === buf.length && !eof) return { kind: 'need-more' }
  if (i === destStart || parenDepth !== 0) return { kind: 'no-match' }

  const converted = convertFileUriDestination(buf.slice(destStart, i))
  if (!converted) return { kind: 'no-match' }

  if (mode === 'inline') {
    if (i === buf.length) return { kind: 'no-match' }
    if (buf[i] === ')') {
      return {
        kind: 'matched',
        nextPos: i + 1,
        output: `${buf.slice(originPos, destStart)}${converted})`,
      }
    }
    const tail = verifyInlineLinkTail(buf, i, eof)
    if (tail.kind === 'need-more') return { kind: 'need-more' }
    if (tail.kind === 'invalid') return { kind: 'no-match' }
    return {
      kind: 'matched',
      nextPos: tail.endPos,
      output: `${buf.slice(originPos, destStart)}${converted}${buf.slice(i, tail.endPos)}`,
    }
  }

  return {
    kind: 'matched',
    nextPos: i,
    output: `${buf.slice(originPos, destStart)}${converted}`,
  }
}

function parseLinkDestination(
  buf: string,
  originPos: number,
  afterDelimiterPos: number,
  eof: boolean,
  mode: 'inline' | 'ref-def',
): MatchResult {
  const ws = skipOptionalWhitespace(buf, afterDelimiterPos, eof)
  if (ws.kind === 'need-more') return { kind: 'need-more' }
  if (ws.kind === 'invalid' || ws.pos >= buf.length) {
    return ws.kind === 'ok' && !eof ? { kind: 'need-more' } : { kind: 'no-match' }
  }
  if (buf[ws.pos] === '<') {
    return parseAngleDestination(buf, originPos, ws.pos, eof, mode)
  }
  return parseBareDestination(buf, originPos, ws.pos, eof, mode)
}

function tryMatchInlineLinkDest(buf: string, pos: number, eof: boolean): MatchResult {
  if (pos + 1 === buf.length) return eof ? { kind: 'no-match' } : { kind: 'need-more' }
  if (buf[pos + 1] !== '(') return { kind: 'no-match' }
  return parseLinkDestination(buf, pos, pos + 2, eof, 'inline')
}

function tryMatchRefDef(buf: string, originPos: number, bracketPos: number, eof: boolean): MatchResult {
  let i = bracketPos + 1
  const limit = bracketPos + 1 + MAX_REF_LABEL_LENGTH
  let hasNonWhitespace = false

  while (i < buf.length && i <= limit) {
    const ch = buf[i]!
    if (ch === '\\') {
      if (i + 1 === buf.length) return eof ? { kind: 'no-match' } : { kind: 'need-more' }
      hasNonWhitespace = true
      i += 2
      continue
    }
    if (ch === '[') return { kind: 'no-match' }
    if (ch === ']') {
      if (!hasNonWhitespace) return { kind: 'no-match' }
      if (i + 1 === buf.length) return eof ? { kind: 'no-match' } : { kind: 'need-more' }
      if (buf[i + 1] !== ':') return { kind: 'no-match' }
      return parseLinkDestination(buf, originPos, i + 2, eof, 'ref-def')
    }
    if (ch === '\n') {
      const blank = checkBlankLineAtNewline(buf, i, eof)
      if (blank === 'need-more') return { kind: 'need-more' }
      if (blank === 'blank') return { kind: 'no-match' }
    } else if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
      hasNonWhitespace = true
    }
    i += 1
  }

  if (i > limit) return { kind: 'no-match' }
  return eof ? { kind: 'no-match' } : { kind: 'need-more' }
}

function tryMatchInlineCode(buf: string, pos: number, eof: boolean): MatchResult {
  let openEnd = pos
  while (openEnd < buf.length && buf[openEnd] === '`') openEnd += 1
  if (openEnd === buf.length && !eof) return { kind: 'need-more' }

  const openLen = openEnd - pos
  let i = openEnd
  const limit = pos + MAX_INLINE_CODE_LOOKAHEAD

  while (i < buf.length && i < limit) {
    const ch = buf[i]!
    if (ch === '`') {
      let runEnd = i
      while (runEnd < buf.length && buf[runEnd] === '`') runEnd += 1
      if (runEnd === buf.length && !eof) return { kind: 'need-more' }
      if (runEnd - i === openLen) {
        return { kind: 'matched', nextPos: runEnd, output: buf.slice(pos, runEnd) }
      }
      i = runEnd
      continue
    }
    if (ch === '\n') {
      const blank = checkBlankLineAtNewline(buf, i, eof)
      if (blank === 'need-more') return { kind: 'need-more' }
      if (blank === 'blank') {
        return { kind: 'matched', nextPos: openEnd, output: buf.slice(pos, openEnd) }
      }
    }
    i += 1
  }

  if (i < limit && !eof) return { kind: 'need-more' }
  // Unclosed backtick run: emit the opening ticks literally and resume normal scanning.
  return { kind: 'matched', nextPos: openEnd, output: buf.slice(pos, openEnd) }
}

function tryMatchFenceOpen(
  buf: string,
  prefixEnd: number,
  quoteDepth: number,
  eof: boolean,
): { readonly kind: 'need-more' | 'no-match' } | { readonly kind: 'matched'; readonly nextPos: number; readonly fence: FenceState } {
  const ch = buf[prefixEnd]
  if (ch !== '`' && ch !== '~') return { kind: 'no-match' }

  let runEnd = prefixEnd
  while (runEnd < buf.length && buf[runEnd] === ch) runEnd += 1
  if (runEnd === buf.length && !eof) return { kind: 'need-more' }

  const len = runEnd - prefixEnd
  if (len < 3) return { kind: 'no-match' }

  let i = runEnd
  while (i < buf.length && buf[i] !== '\n') {
    if (ch === '`' && buf[i] === '`') return { kind: 'no-match' }
    i += 1
  }
  if (i === buf.length && !eof) return { kind: 'need-more' }

  const nextPos = i < buf.length ? i + 1 : buf.length
  return { kind: 'matched', nextPos, fence: { char: ch, len, quoteDepth } }
}

function tryMatchFenceClose(
  buf: string,
  prefixEnd: number,
  fence: FenceState,
  eof: boolean,
): 'need-more' | 'no-match' | { readonly nextPos: number } {
  if (buf[prefixEnd] !== fence.char) return 'no-match'

  let runEnd = prefixEnd
  while (runEnd < buf.length && buf[runEnd] === fence.char) runEnd += 1
  if (runEnd === buf.length && !eof) return 'need-more'
  if (runEnd - prefixEnd < fence.len) return 'no-match'

  let i = runEnd
  while (i < buf.length && (buf[i] === ' ' || buf[i] === '\t' || buf[i] === '\r')) i += 1
  if (i === buf.length) return eof ? { nextPos: buf.length } : 'need-more'
  return buf[i] === '\n' ? { nextPos: i + 1 } : 'no-match'
}

/**
 * Stateful streaming normalizer guaranteeing byte-for-byte identical output
 * regardless of how incoming Markdown text is chunked across `push()` calls.
 */
export class MarkdownFileLinkNormalizer {
  private buffer = ''
  private fence: FenceState | null = null
  private atLineStart = true

  push(chunk: string): string {
    if (!chunk) return ''
    this.buffer += chunk
    return this.drain(false)
  }

  flush(): string {
    return this.drain(true)
  }

  private drain(eof: boolean): string {
    const buf = this.buffer
    let pos = 0
    let out = ''

    while (pos < buf.length) {
      if (this.fence) {
        const step = this.stepFence(buf, pos, eof)
        if (step.kind === 'need-more') break
        out += step.output
        pos = step.nextPos
        continue
      }

      if (this.atLineStart) {
        const step = this.stepLineStart(buf, pos, eof)
        if (step.kind === 'need-more') break
        out += step.output
        pos = step.nextPos
        continue
      }

      const step = this.stepNormal(buf, pos, eof)
      if (step.kind === 'need-more') break
      out += step.output
      pos = step.nextPos
    }

    this.buffer = pos === 0 ? buf : buf.slice(pos)
    return out
  }

  private stepFence(
    buf: string,
    pos: number,
    eof: boolean,
  ): { readonly kind: 'need-more' } | { readonly kind: 'done'; readonly nextPos: number; readonly output: string } {
    const fence = this.fence!
    if (this.atLineStart) {
      const prefix = scanLinePrefix(buf, pos, eof)
      if (prefix.kind === 'need-more') return { kind: 'need-more' }
      if (prefix.kind === 'eol') {
        return { kind: 'done', nextPos: prefix.nextPos, output: buf.slice(pos, prefix.nextPos) }
      }
      if (fence.quoteDepth > 0 && prefix.quoteDepth < fence.quoteDepth) {
        // Exiting the enclosing blockquote implicitly closes the fenced block.
        this.fence = null
        return { kind: 'done', nextPos: pos, output: '' }
      }
      if (prefix.quoteDepth === fence.quoteDepth) {
        const close = tryMatchFenceClose(buf, prefix.prefixEnd, fence, eof)
        if (close === 'need-more') return { kind: 'need-more' }
        if (close !== 'no-match') {
          this.fence = null
          this.atLineStart = true
          return { kind: 'done', nextPos: close.nextPos, output: buf.slice(pos, close.nextPos) }
        }
      }
      this.atLineStart = false
      return { kind: 'done', nextPos: prefix.prefixEnd, output: buf.slice(pos, prefix.prefixEnd) }
    }

    const nl = buf.indexOf('\n', pos)
    if (nl >= 0) {
      this.atLineStart = true
      return { kind: 'done', nextPos: nl + 1, output: buf.slice(pos, nl + 1) }
    }
    return { kind: 'done', nextPos: buf.length, output: buf.slice(pos) }
  }

  private stepLineStart(
    buf: string,
    pos: number,
    eof: boolean,
  ): { readonly kind: 'need-more' } | { readonly kind: 'done'; readonly nextPos: number; readonly output: string } {
    const prefix = scanLinePrefix(buf, pos, eof)
    if (prefix.kind === 'need-more') return { kind: 'need-more' }
    if (prefix.kind === 'eol') {
      return { kind: 'done', nextPos: prefix.nextPos, output: buf.slice(pos, prefix.nextPos) }
    }

    const ch = buf[prefix.prefixEnd]!
    if (ch === '`' || ch === '~') {
      const open = tryMatchFenceOpen(buf, prefix.prefixEnd, prefix.quoteDepth, eof)
      if (open.kind === 'need-more') return { kind: 'need-more' }
      if (open.kind === 'matched') {
        this.fence = open.fence
        this.atLineStart = true
        return { kind: 'done', nextPos: open.nextPos, output: buf.slice(pos, open.nextPos) }
      }
    } else if (ch === '[') {
      const refDef = tryMatchRefDef(buf, pos, prefix.prefixEnd, eof)
      if (refDef.kind === 'need-more') return { kind: 'need-more' }
      if (refDef.kind === 'matched') {
        this.atLineStart = false
        return { kind: 'done', nextPos: refDef.nextPos, output: refDef.output }
      }
    }

    this.atLineStart = false
    return { kind: 'done', nextPos: prefix.prefixEnd, output: buf.slice(pos, prefix.prefixEnd) }
  }

  private stepNormal(
    buf: string,
    pos: number,
    eof: boolean,
  ): { readonly kind: 'need-more' } | { readonly kind: 'done'; readonly nextPos: number; readonly output: string } {
    const ch = buf[pos]!
    if (ch === '\n') {
      this.atLineStart = true
      return { kind: 'done', nextPos: pos + 1, output: '\n' }
    }
    if (ch === '\\') {
      if (pos + 1 === buf.length) {
        return eof ? { kind: 'done', nextPos: pos + 1, output: '\\' } : { kind: 'need-more' }
      }
      if (buf[pos + 1] === '\n') {
        return { kind: 'done', nextPos: pos + 1, output: '\\' }
      }
      return { kind: 'done', nextPos: pos + 2, output: buf.slice(pos, pos + 2) }
    }
    if (ch === '`') {
      const code = tryMatchInlineCode(buf, pos, eof)
      if (code.kind === 'need-more') return { kind: 'need-more' }
      if (code.kind === 'matched') {
        return { kind: 'done', nextPos: code.nextPos, output: code.output }
      }
    }
    if (ch === ']') {
      const link = tryMatchInlineLinkDest(buf, pos, eof)
      if (link.kind === 'need-more') return { kind: 'need-more' }
      if (link.kind === 'matched') {
        return { kind: 'done', nextPos: link.nextPos, output: link.output }
      }
      return { kind: 'done', nextPos: pos + 1, output: ']' }
    }

    let i = pos + 1
    while (i < buf.length) {
      const c = buf[i]!
      if (c === '\n' || c === '\\' || c === '`' || c === ']') break
      i += 1
    }
    return { kind: 'done', nextPos: i, output: buf.slice(pos, i) }
  }
}

/**
 * Normalize all local `file://` Markdown links, images, and reference
 * definitions in a complete text string.
 */
export function normalizeMarkdownFileLinks(text: string): string {
  const normalizer = new MarkdownFileLinkNormalizer()
  return normalizer.push(text) + normalizer.flush()
}
