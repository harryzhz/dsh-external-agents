#!/usr/bin/env node
/**
 * Build and pack `@harryzhz/dsh-external-agents` into a `.tgz` release tarball.
 * Usage: node scripts/pack.mjs [--out-dir .local/releases]
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildExternalAgentsBundle } from './prepare.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
const rootPackageName = rootPkg.name
const rootVersion = rootPkg.version
const outIdx = process.argv.indexOf('--out-dir')
const outDir = resolve(repoRoot, outIdx >= 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : '.local/releases')

mkdirSync(outDir, { recursive: true })
await buildExternalAgentsBundle()

console.log(`\nPacking ${rootPackageName} -> ${outDir}`)
execFileSync('pnpm', ['pack', '--pack-destination', outDir], {
  cwd: repoRoot,
  stdio: 'inherit',
})

const packedFileName = `${rootPackageName.replace(/^@/, '').replace(/\//g, '-')}-${rootVersion}.tgz`
const latestAliasName = 'dsh-external-agents.tgz'
copyFileSync(join(outDir, packedFileName), join(outDir, latestAliasName))
console.log(`Updated latest alias -> ${join(outDir, latestAliasName)}`)
