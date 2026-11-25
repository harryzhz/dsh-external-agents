import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error ESM release script outside tsconfig root
import {
  applyVersionToPackages,
  computeReleasePlan,
  isShippablePath,
} from '../../../scripts/release-plan.mjs'

describe('release-plan auto-release logic', () => {
  it('classifies shippable runtime/plugin files vs docs/CI/test-only files', () => {
    expect(isShippablePath('packages/plugin/src/index.ts')).toBe(true)
    expect(isShippablePath('packages/runtime/acp/src/client.ts')).toBe(true)
    expect(isShippablePath('package.json')).toBe(true)
    expect(isShippablePath('cordis.patch.yml')).toBe(true)

    expect(isShippablePath('docs/DEVELOPMENT.md')).toBe(false)
    expect(isShippablePath('.github/workflows/release.yml')).toBe(false)
    expect(isShippablePath('scripts/release-plan.mjs')).toBe(false)
    expect(isShippablePath('packages/plugin/tests/release-plan.spec.ts')).toBe(false)
  })

  it('auto-bumps patch on main merge when shippable files changed since last tag', () => {
    const plan = computeReleasePlan({
      eventName: 'push',
      ref: 'refs/heads/main',
      headSubject: 'fix(runtime): stabilize ACP startup (#15)',
      headTags: [],
      existingTags: ['v0.3.1', 'v0.4.0'],
      pkgVersion: '0.4.0',
      changedFiles: ['packages/runtime/acp/src/client.ts'],
      commitMessages: ['fix(runtime): stabilize ACP startup (#15)'],
    })
    expect(plan).toEqual({
      shouldRelease: true,
      mode: 'auto',
      version: '0.4.1',
      tag: 'v0.4.1',
      prevTag: 'v0.4.0',
      reason: 'auto_main_merge',
    })

    expect(
      computeReleasePlan({
        eventName: 'push',
        ref: 'refs/heads/main',
        headSubject: 'feat(runtime): pre-bumped milestone',
        headTags: [],
        existingTags: ['v0.4.0'],
        pkgVersion: '0.5.0',
        changedFiles: ['packages/plugin/src/index.ts'],
        commitMessages: ['feat(runtime): pre-bumped milestone'],
      }).tag,
    ).toBe('v0.5.0')
  })

  it('skips docs-only merges and release commits cleanly', () => {
    expect(
      computeReleasePlan({
        eventName: 'push',
        ref: 'refs/heads/main',
        headSubject: 'chore(release): v0.4.1 [skip ci]',
        existingTags: ['v0.4.0'],
        pkgVersion: '0.4.1',
        changedFiles: ['package.json'],
      }).shouldRelease,
    ).toBe(false)

    expect(
      computeReleasePlan({
        eventName: 'push',
        ref: 'refs/heads/main',
        headSubject: 'docs: update release workflow',
        existingTags: ['v0.4.0'],
        pkgVersion: '0.4.0',
        changedFiles: ['docs/DEVELOPMENT.md', '.github/workflows/release.yml'],
      }),
    ).toEqual({ shouldRelease: false, mode: 'none', reason: 'no_shippable_changes' })
  })

  it('updates version across root and workspace package.json files cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-release-plan-test-'))
    try {
      mkdirSync(join(dir, 'packages', 'plugin'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', version: '0.4.0' }, null, 2) + '\n')
      writeFileSync(
        join(dir, 'packages', 'plugin', 'package.json'),
        JSON.stringify({ name: 'plugin', version: '0.4.0' }, null, 2) + '\n',
      )
      const updated = applyVersionToPackages(dir, '0.4.1', ['package.json', 'packages/plugin/package.json'])
      expect(updated).toEqual(['package.json', 'packages/plugin/package.json'])
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('0.4.1')
      expect(JSON.parse(readFileSync(join(dir, 'packages', 'plugin', 'package.json'), 'utf8')).version).toBe('0.4.1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
