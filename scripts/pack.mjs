#!/usr/bin/env node
/**
 * Build and pack `dsh-external-agents` into a `.tgz` release tarball.
 * Usage: node scripts/pack.mjs [--out-dir .local/releases]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildExternalAgentsBundle } from './prepare.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outIdx = process.argv.indexOf('--out-dir')
const outDir = resolve(repoRoot, outIdx >= 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : '.local/releases')

mkdirSync(outDir, { recursive: true })
await buildExternalAgentsBundle()

console.log(`\nPacking dsh-external-agents -> ${outDir}`)
execFileSync('pnpm', ['pack', '--pack-destination', outDir], {
  cwd: repoRoot,
  stdio: 'inherit',
})
