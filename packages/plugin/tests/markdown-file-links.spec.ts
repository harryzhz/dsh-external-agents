import { describe, expect, it } from 'vitest'
import {
  MarkdownFileLinkNormalizer,
  convertFileUriDestination,
  normalizeMarkdownFileLinks,
} from '../src/markdown-file-links.js'

function runChunked(input: string, chunkSize: number): string {
  const normalizer = new MarkdownFileLinkNormalizer()
  let out = ''
  for (let i = 0; i < input.length; i += chunkSize) {
    out += normalizer.push(input.slice(i, i + chunkSize))
  }
  out += normalizer.flush()
  return out
}

describe('convertFileUriDestination', () => {
  it('converts POSIX, localhost, line anchors, percent-encoded, and Windows file URIs', () => {
    expect(convertFileUriDestination('file:///Users/demo/repo/MemoryView.tsx')).toBe(
      '/Users/demo/repo/MemoryView.tsx',
    )
    expect(convertFileUriDestination('file:///Users/demo/repo/MemoryView.tsx#L10-L20')).toBe(
      '/Users/demo/repo/MemoryView.tsx#L10-L20',
    )
    expect(convertFileUriDestination('file:///Users/demo/repo/MemoryView.tsx:42:5')).toBe(
      '/Users/demo/repo/MemoryView.tsx:42:5',
    )
    expect(convertFileUriDestination('FILE:///Users/demo/My%20Docs/notes%231.md#L3')).toBe(
      '/Users/demo/My%20Docs/notes%231.md#L3',
    )
    expect(convertFileUriDestination('file://localhost/Users/demo/repo/index.ts#L5')).toBe(
      '/Users/demo/repo/index.ts#L5',
    )
    expect(convertFileUriDestination('file://LOCALHOST/opt/app/main.ts')).toBe('/opt/app/main.ts')
    expect(convertFileUriDestination('file:///C:/repo/src/app.ts#L12-L18')).toBe(
      'C:/repo/src/app.ts#L12-L18',
    )
    expect(convertFileUriDestination('file:///c%3A/repo/src/app.ts')).toBe('c:/repo/src/app.ts')
    expect(convertFileUriDestination('file://localhost/D:/work/readme.md')).toBe('D:/work/readme.md')
  })

  it('rejects non-local hosts, bare roots, UNC, query strings, malformed escapes, and other schemes', () => {
    expect(convertFileUriDestination('https://example.com/a.ts')).toBeUndefined()
    expect(convertFileUriDestination('file://example.com/share/doc.md')).toBeUndefined()
    expect(convertFileUriDestination('file://')).toBeUndefined()
    expect(convertFileUriDestination('file:///')).toBeUndefined()
    expect(convertFileUriDestination('file:///C:/')).toBeUndefined()
    expect(convertFileUriDestination('file:////server/share/doc.md')).toBeUndefined()
    expect(convertFileUriDestination('file:///Users/demo/a.ts?raw=1')).toBeUndefined()
    expect(convertFileUriDestination('file:///Users/demo/%ZZ.ts')).toBeUndefined()
    expect(convertFileUriDestination('file:///Users/demo/a\u0000b.ts')).toBeUndefined()
    expect(convertFileUriDestination('/Users/demo/already-path.ts')).toBeUndefined()
  })
})

describe('normalizeMarkdownFileLinks', () => {
  it('rewrites inline file links, images, nested lists, code labels, balanced parens, angle brackets, titles, and reference defs', () => {
    const input = [
      '交付结果：',
      '- 核心改动：',
      '    - [MemoryView.tsx](file:///Users/demo/repo/MemoryView.tsx)、[`memory-model.ts`](file:///Users/demo/repo/memory-model.ts#L10-L20)',
      '    - [page.tsx](file:///Users/demo/app/(dashboard)/page.tsx#L12)',
      '    - [With Spaces](<file:///Users/demo/My Docs/report final.md#L5> "Open doc")',
      '    - [With Title](file:///Users/demo/repo/app.ts "App entry")',
      '    - [Win File](file:///C:/repo/src/main.ts#L8)',
      '    - ![preview](file:///Users/demo/repo/preview.png)',
      '    - [![thumb](file:///Users/demo/repo/thumb.png)](file:///Users/demo/repo/spec.md)',
      '[ref-one]: file:///Users/demo/repo/ref.ts#L3',
      '[ref-two]: <file:///Users/demo/My Docs/ref two.md> "Ref title"',
    ].join('\n')

    const expected = [
      '交付结果：',
      '- 核心改动：',
      '    - [MemoryView.tsx](/Users/demo/repo/MemoryView.tsx)、[`memory-model.ts`](/Users/demo/repo/memory-model.ts#L10-L20)',
      '    - [page.tsx](/Users/demo/app/(dashboard)/page.tsx#L12)',
      '    - [With Spaces](</Users/demo/My Docs/report final.md#L5> "Open doc")',
      '    - [With Title](/Users/demo/repo/app.ts "App entry")',
      '    - [Win File](C:/repo/src/main.ts#L8)',
      '    - ![preview](/Users/demo/repo/preview.png)',
      '    - [![thumb](/Users/demo/repo/thumb.png)](/Users/demo/repo/spec.md)',
      '[ref-one]: /Users/demo/repo/ref.ts#L3',
      '[ref-two]: </Users/demo/My Docs/ref two.md> "Ref title"',
    ].join('\n')

    expect(normalizeMarkdownFileLinks(input)).toBe(expected)
  })

  it('preserves fenced code blocks, tilde fences, blockquote fences, and inline code spans untouched', () => {
    const input = [
      'Use `[a.ts](file:///Users/demo/a.ts)` or ``[b.ts](file:///Users/demo/b.ts)`` as syntax examples.',
      '',
      '```markdown',
      '[inside-backtick-fence](file:///Users/demo/fence1.ts)',
      '[ref-in-fence]: file:///Users/demo/fence2.ts',
      '```',
      '',
      '  ~~~md',
      '  [inside-tilde-fence](file:///Users/demo/fence3.ts)',
      '  ~~~',
      '',
      '> ```md',
      '> [inside-quote-fence](file:///Users/demo/fence4.ts)',
      '> ```',
      '> [outside-quote-fence](file:///Users/demo/outside.ts)',
      '',
      'Back to [real.ts](file:///Users/demo/real.ts#L4).',
    ].join('\n')

    const expected = [
      'Use `[a.ts](file:///Users/demo/a.ts)` or ``[b.ts](file:///Users/demo/b.ts)`` as syntax examples.',
      '',
      '```markdown',
      '[inside-backtick-fence](file:///Users/demo/fence1.ts)',
      '[ref-in-fence]: file:///Users/demo/fence2.ts',
      '```',
      '',
      '  ~~~md',
      '  [inside-tilde-fence](file:///Users/demo/fence3.ts)',
      '  ~~~',
      '',
      '> ```md',
      '> [inside-quote-fence](file:///Users/demo/fence4.ts)',
      '> ```',
      '> [outside-quote-fence](/Users/demo/outside.ts)',
      '',
      'Back to [real.ts](/Users/demo/real.ts#L4).',
    ].join('\n')

    expect(normalizeMarkdownFileLinks(input)).toBe(expected)
  })

  it('recovers cleanly from unclosed backticks, escaped brackets, and incomplete links without corrupting text', () => {
    const input = [
      'Stray ` tick then [ok.ts](file:///Users/demo/ok.ts)',
      '',
      'Escaped [a\\](file:///Users/demo/nope.ts) and [b]\\(file:///Users/demo/nope2.ts)',
      'Unclosed [partial](file:///Users/demo/partial.ts without closing paren',
      'Remote [share](file://example.com/share/a.ts) and [web](https://example.com/a.ts)',
      'Bare text file:///Users/demo/raw.ts stays raw.',
    ].join('\n')

    const expected = [
      'Stray ` tick then [ok.ts](/Users/demo/ok.ts)',
      '',
      'Escaped [a\\](file:///Users/demo/nope.ts) and [b]\\(file:///Users/demo/nope2.ts)',
      'Unclosed [partial](file:///Users/demo/partial.ts without closing paren',
      'Remote [share](file://example.com/share/a.ts) and [web](https://example.com/a.ts)',
      'Bare text file:///Users/demo/raw.ts stays raw.',
    ].join('\n')

    expect(normalizeMarkdownFileLinks(input)).toBe(expected)
  })

  it('produces byte-for-byte identical output across arbitrary streaming chunk boundaries', () => {
    const sample = [
      '[leading.ts](file:///Users/demo/leading.ts#L1-L5)',
      'Inline `` `ticks` `` and [`code.ts`](file:///Users/demo/code.ts) plus [spaced](<file:///Users/demo/a b/c.ts> "t").',
      '> ```md',
      '> [quoted-fence](file:///Users/demo/in-fence.ts)',
      'After exiting quote without closing fence: [exited.ts](file:///Users/demo/exited.ts)',
      '[ref]: file://localhost/Users/demo/ref.ts#L9',
      'Stray ` unclosed before',
      '```ts',
      '[codeblock](file:///Users/demo/codeblock.ts)',
      '```',
      'Tail [final.ts](file:///C:/repo/final.ts#L20)',
    ].join('\n')

    const baseline = normalizeMarkdownFileLinks(sample)
    expect(baseline).toContain('[leading.ts](/Users/demo/leading.ts#L1-L5)')
    expect(baseline).toContain('[`code.ts`](/Users/demo/code.ts)')
    expect(baseline).toContain('[spaced](</Users/demo/a b/c.ts> "t")')
    expect(baseline).toContain('> [quoted-fence](file:///Users/demo/in-fence.ts)')
    expect(baseline).toContain('[exited.ts](/Users/demo/exited.ts)')
    expect(baseline).toContain('[ref]: /Users/demo/ref.ts#L9')
    expect(baseline).toContain('[codeblock](file:///Users/demo/codeblock.ts)')
    expect(baseline).toContain('[final.ts](C:/repo/final.ts#L20)')

    for (const chunkSize of [1, 2, 3, 5, 7, 13, 31]) {
      expect(runChunked(sample, chunkSize)).toBe(baseline)
    }
  })

  it('streams normal prose immediately without buffering until newline', () => {
    const normalizer = new MarkdownFileLinkNormalizer()
    expect(normalizer.push('Hello world, ')).toBe('Hello world, ')
    expect(normalizer.push('see [a.ts]')).toBe('see [a.ts')
    expect(normalizer.push('(https://example.com)')).toBe('](https://example.com)')
    expect(normalizer.push(' and [b.ts](')).toBe(' and [b.ts')
    expect(normalizer.push('file:///Users/demo/b.ts')).toBe('')
    expect(normalizer.push(') done.')).toBe('](/Users/demo/b.ts) done.')
    expect(normalizer.flush()).toBe('')
  })
})
