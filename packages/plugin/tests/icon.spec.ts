import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('plugin icon.svg', () => {
  it('preserves the modular blocks + 4-point spark geometry with the unified parchment/ink/terracotta palette', () => {
    const svg = readFileSync(resolve(import.meta.dirname, '../../../icon.svg'), 'utf8')
    expect(svg).toContain('viewBox="0 0 64 64"')
    expect(svg).toContain('fill="#F6F2EA"')
    expect(svg).toContain('fill="#141518"')
    expect(svg).toContain('fill="#D96B43"')
    // Preserves the 3 rounded module blocks and 4-point AI spark path.
    expect(svg).toContain('x="14" y="16" width="15" height="15" rx="4.5"')
    expect(svg).toContain('x="14" y="35" width="15" height="15" rx="4.5"')
    expect(svg).toContain('x="33" y="35" width="15" height="15" rx="4.5"')
    expect(svg).toContain('M42.5 11C43.4 17.6 46.4 20.6 53 21.5C46.4 22.4 43.4 25.4 42.5 32C41.6 25.4 38.6 22.4 32 21.5C38.6 20.6 41.6 17.6 42.5 11Z')
  })
})
