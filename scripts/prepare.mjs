#!/usr/bin/env node
/**
 * Self-contained bundle builder for root `@harryzhz/dsh-external-agents`.
 * Can run with ONLY root `devDependencies` (`esbuild`) during Git installs (`prepare`)
 * or full workspace builds (`pnpm build`).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootPackageName = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).name
const entryFile = resolve(repoRoot, 'packages/plugin/src/index.ts')
const outFile = resolve(repoRoot, 'dist/index.js')

export async function buildExternalAgentsBundle() {
  if (!existsSync(entryFile)) {
    if (existsSync(outFile)) {
      return
    }
    throw new Error(`Cannot locate source entry: ${entryFile}`)
  }

  const workspaceAliasPlugin = {
    name: 'workspace-source-aliases',
    setup(buildApi) {
      const aliases = new Map([
        ['@dsh-external-agents/runtime-shared-stdio', resolve(repoRoot, 'packages/runtime/shared-stdio/src/index.ts')],
        ['@dsh-external-agents/runtime-codex', resolve(repoRoot, 'packages/runtime/codex/src/index.ts')],
        ['@dsh-external-agents/runtime-acp', resolve(repoRoot, 'packages/runtime/acp/src/index.ts')],
      ])
      buildApi.onResolve({ filter: /^@dsh-external-agents\/runtime-(?:shared-stdio|codex|acp)$/ }, (args) => {
        const target = aliases.get(args.path)
        return target ? { path: target } : null
      })
    },
  }

  mkdirSync(dirname(outFile), { recursive: true })
  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    sourcemap: false,
    plugins: [workspaceAliasPlugin],
    external: [
      'node:*',
      '@deepseek-ai/*',
    ],
  })

  console.log(`Built standalone bundle ${rootPackageName}:`, outFile)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildExternalAgentsBundle()
}
