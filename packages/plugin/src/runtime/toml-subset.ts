/**
 * Minimal, zero-dependency TOML parser and Codex `-c key=value` flattener.
 * Supports comments, tables (`[a.b]`, `[a."b/c"]`), array-of-tables (`[[a]]`),
 * basic/literal/multiline strings, booleans, numbers, arrays, and inline tables.
 */

export type TomlValue =
  | string
  | number
  | boolean
  | readonly TomlValue[]
  | { readonly [key: string]: TomlValue }

type MutableTomlObject = Record<string, TomlValue>

const DEFAULT_IGNORED_TOP_LEVEL_KEYS = new Set(['tui', 'notice', 'history'])

function stripTomlComment(line: string): string {
  let inDouble = false
  let inSingle = false
  let escaped = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (inDouble) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inDouble = false
      }
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') {
      inDouble = true
    } else if (ch === "'") {
      inSingle = true
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

function unescapeBasicString(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (ch !== '\\' || i + 1 >= raw.length) {
      out += ch
      continue
    }
    const next = raw[++i]!
    switch (next) {
      case 'n':
        out += '\n'
        break
      case 'r':
        out += '\r'
        break
      case 't':
        out += '\t'
        break
      case 'b':
        out += '\b'
        break
      case 'f':
        out += '\f'
        break
      case '"':
        out += '"'
        break
      case '\\':
        out += '\\'
        break
      case 'u': {
        const hex = raw.slice(i + 1, i + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
        } else {
          out += '\\u'
        }
        break
      }
      case 'U': {
        const hex = raw.slice(i + 1, i + 9)
        if (/^[0-9a-fA-F]{8}$/.test(hex)) {
          out += String.fromCodePoint(parseInt(hex, 16))
          i += 8
        } else {
          out += '\\U'
        }
        break
      }
      default:
        out += next
        break
    }
  }
  return out
}

function parseKeySegments(raw: string): string[] {
  const segments: string[] = []
  let i = 0
  const len = raw.length
  while (i < len) {
    while (i < len && /\s/.test(raw[i]!)) i += 1
    if (i >= len) break
    const ch = raw[i]!
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      let buf = ''
      let escaped = false
      while (i < len) {
        const c = raw[i++]!
        if (quote === '"' && escaped) {
          buf += `\\${c}`
          escaped = false
        } else if (quote === '"' && c === '\\') {
          escaped = true
        } else if (c === quote) {
          break
        } else {
          buf += c
        }
      }
      segments.push(quote === '"' ? unescapeBasicString(buf) : buf)
    } else {
      const start = i
      while (i < len && raw[i] !== '.' && !/\s/.test(raw[i]!)) i += 1
      const seg = raw.slice(start, i).trim()
      if (seg) segments.push(seg)
    }
    while (i < len && /\s/.test(raw[i]!)) i += 1
    if (i < len && raw[i] === '.') i += 1
  }
  return segments
}

function findTopLevelChar(input: string, target: string): number {
  let inDouble = false
  let inSingle = false
  let escaped = false
  let depth = 0
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!
    if (inDouble) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') inDouble = true
    else if (ch === "'") inSingle = true
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && ch === target) return i
  }
  return -1
}

function splitTopLevelItems(input: string): string[] {
  const items: string[] = []
  let start = 0
  let inDouble = false
  let inSingle = false
  let escaped = false
  let depth = 0
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!
    if (inDouble) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') inDouble = true
    else if (ch === "'") inSingle = true
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && ch === ',') {
      const part = input.slice(start, i).trim()
      if (part) items.push(part)
      start = i + 1
    }
  }
  const tail = input.slice(start).trim()
  if (tail) items.push(tail)
  return items
}

function parseTomlValue(rawValue: string): TomlValue {
  const trimmed = rawValue.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false

  if (trimmed.startsWith('"""') && trimmed.endsWith('"""') && trimmed.length >= 6) {
    const inner = trimmed.slice(3, -3).replace(/^\r?\n/, '')
    return unescapeBasicString(inner)
  }
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''") && trimmed.length >= 6) {
    return trimmed.slice(3, -3).replace(/^\r?\n/, '')
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapeBasicString(trimmed.slice(1, -1))
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (!inner) return []
    return splitTopLevelItems(inner).map((item) => parseTomlValue(item))
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1).trim()
    const obj: MutableTomlObject = {}
    if (!inner) return obj
    for (const pair of splitTopLevelItems(inner)) {
      const eq = findTopLevelChar(pair, '=')
      if (eq < 0) continue
      const keys = parseKeySegments(pair.slice(0, eq))
      const val = parseTomlValue(pair.slice(eq + 1))
      setNestedValue(obj, keys, val)
    }
    return obj
  }

  const numericCandidate = trimmed.replace(/_/g, '')
  if (/^[+-]?(?:0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(numericCandidate)) {
    const num = Number(numericCandidate)
    if (Number.isFinite(num)) return num
  }

  return trimmed
}

function isPlainObject(value: unknown): value is MutableTomlObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function ensureTablePath(root: MutableTomlObject, keys: readonly string[]): MutableTomlObject {
  let cursor = root
  for (const key of keys) {
    const existing = cursor[key]
    if (Array.isArray(existing) && existing.length > 0 && isPlainObject(existing[existing.length - 1])) {
      cursor = existing[existing.length - 1] as MutableTomlObject
      continue
    }
    if (!isPlainObject(existing)) {
      const next: MutableTomlObject = {}
      cursor[key] = next
      cursor = next
    } else {
      cursor = existing
    }
  }
  return cursor
}

function ensureArrayTablePath(root: MutableTomlObject, keys: readonly string[]): MutableTomlObject {
  const parent = ensureTablePath(root, keys.slice(0, -1))
  const leaf = keys[keys.length - 1]!
  const existing = parent[leaf]
  const list: TomlValue[] = Array.isArray(existing) ? [...existing] : []
  const item: MutableTomlObject = {}
  list.push(item)
  parent[leaf] = list
  return item
}

function setNestedValue(target: MutableTomlObject, keys: readonly string[], value: TomlValue): void {
  if (keys.length === 0) return
  const parent = ensureTablePath(target, keys.slice(0, -1))
  parent[keys[keys.length - 1]!] = value
}

function hasUnclosedStructure(raw: string): boolean {
  let inDouble = false
  let inSingle = false
  let escaped = false
  let brackets = 0
  let braces = 0
  let i = 0
  while (i < raw.length) {
    if (!inSingle && raw.startsWith('"""', i)) {
      const close = raw.indexOf('"""', i + 3)
      if (close < 0) return true
      i = close + 3
      continue
    }
    if (!inDouble && raw.startsWith("'''", i)) {
      const close = raw.indexOf("'''", i + 3)
      if (close < 0) return true
      i = close + 3
      continue
    }
    const ch = raw[i++]!
    if (inDouble) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') inDouble = true
    else if (ch === "'") inSingle = true
    else if (ch === '[') brackets += 1
    else if (ch === ']') brackets -= 1
    else if (ch === '{') braces += 1
    else if (ch === '}') braces -= 1
  }
  return brackets > 0 || braces > 0
}

/** Parse a TOML document into a plain JS object tree. */
export function parseTomlDocument(source: string): Record<string, TomlValue> {
  const root: MutableTomlObject = {}
  let current: MutableTomlObject = root
  const lines = source.split(/\r?\n/)

  for (let i = 0; i < lines.length; i += 1) {
    const cleaned = stripTomlComment(lines[i]!).trim()
    if (!cleaned) continue

    if (cleaned.startsWith('[[') && cleaned.endsWith(']]')) {
      const keys = parseKeySegments(cleaned.slice(2, -2))
      if (keys.length > 0) current = ensureArrayTablePath(root, keys)
      continue
    }
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
      const keys = parseKeySegments(cleaned.slice(1, -1))
      current = keys.length > 0 ? ensureTablePath(root, keys) : root
      continue
    }

    const eq = findTopLevelChar(cleaned, '=')
    if (eq < 0) continue

    const keys = parseKeySegments(cleaned.slice(0, eq))
    let rawVal = cleaned.slice(eq + 1).trim()
    while (hasUnclosedStructure(rawVal) && i + 1 < lines.length) {
      i += 1
      const nextChunk =
        rawVal.startsWith('"""') || rawVal.startsWith("'''")
          ? lines[i]!
          : stripTomlComment(lines[i]!).trim()
      rawVal = `${rawVal}\n${nextChunk}`
    }
    setNestedValue(current, keys, parseTomlValue(rawVal))
  }

  return root
}

export function formatTomlKeySegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment)
}

export function formatTomlLiteral(value: TomlValue): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatTomlLiteral(item)).join(', ')}]`
  }
  const entries = Object.entries(value as Record<string, TomlValue>)
  const pairs = entries.map(([k, v]) => `${formatTomlKeySegment(k)} = ${formatTomlLiteral(v)}`)
  return `{ ${pairs.join(', ')} }`
}

/**
 * Flatten a parsed TOML config document into repeatable `['-c', 'key=toml_value']`
 * CLI flags accepted by `codex app-server` and `traecli app-server`.
 */
export function flattenTomlToCodexConfigArgs(
  doc: Readonly<Record<string, TomlValue>>,
  options: { readonly ignoreTopLevelKeys?: ReadonlySet<string> } = {},
): string[] {
  const ignored = options.ignoreTopLevelKeys ?? DEFAULT_IGNORED_TOP_LEVEL_KEYS
  const args: string[] = []

  const walk = (node: Readonly<Record<string, TomlValue>>, prefix: readonly string[]): void => {
    for (const [key, val] of Object.entries(node)) {
      if (prefix.length === 0 && ignored.has(key)) continue
      const path = [...prefix, formatTomlKeySegment(key)]
      if (isPlainObject(val)) {
        const keys = Object.keys(val)
        if (keys.length === 0) {
          args.push('-c', `${path.join('.')}={}`)
        } else {
          walk(val, path)
        }
      } else {
        args.push('-c', `${path.join('.')}=${formatTomlLiteral(val)}`)
      }
    }
  }

  walk(doc, [])
  return args
}
