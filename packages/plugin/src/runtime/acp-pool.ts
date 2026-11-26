import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AcpRuntimeClient,
  type AcpCatalogSnapshot,
  type AcpRuntimeOptions,
  type AcpSessionHandle,
  type AcpStartOptions,
} from '@dsh-external-agents/runtime-acp'
import type { ExternalRuntimeProfile } from '../types.js'
import type { ExternalRuntimeSpec } from './config.js'
import { resolveRuntimeLaunchPlan, type ResolvedRuntimeLaunchPlan } from './profile-resolver.js'

const DEFAULT_POOL_IDLE_EVICT_MS = 15 * 60_000
const AGY_DATA_DIR_FLAGS = new Set(['--app-data-dir', '--app_data_dir', '--gemini-dir', '--gemini_dir'])
const EXECUTOR_ERROR_BANNER_RE = /^⚠\s*agent executor error:\s*([^\r\n]+)$/u
const SAFE_AGY_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Detect fatal Antigravity ACP executor errors that upstream emits as plain
 * `agent_message_chunk` text followed by `stopReason: "end_turn"`.
 * Only matches standalone single-line banners so normal explanations quoting the
 * error text are never misclassified.
 */
export function detectAcpExecutorError(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const match = EXECUTOR_ERROR_BANNER_RE.exec(trimmed)
  if (!match?.[1]) return undefined
  return `agent executor error: ${match[1].trim()}`
}

/** True when args already configure an explicit Antigravity data or gemini directory. */
export function hasAgyDataDirFlag(args: readonly string[]): boolean {
  for (const raw of args) {
    const token = raw.trim()
    if (AGY_DATA_DIR_FLAGS.has(token)) return true
    const eqIdx = token.indexOf('=')
    if (eqIdx > 0 && AGY_DATA_DIR_FLAGS.has(token.slice(0, eqIdx))) return true
  }
  return false
}

function sanitizeSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return cleaned || 'default'
}

/**
 * Build a relative `--app-data-dir` subdirectory name under `~/.gemini/` scoped
 * to `(instanceScope, profileId)` so each pooled Antigravity ACP server owns an
 * exclusive trajectory/summary store without cross-process revival collisions.
 */
export function buildAgyIsolatedAppDataDirName(
  scopeKey: string,
  profileId?: string,
  ephemeralTag?: string,
): string {
  const normalizedScope = resolve(scopeKey)
  const scopeHash = createHash('sha256').update(normalizedScope).digest('hex').slice(0, 8)
  const profileSlug = sanitizeSegment(profileId ?? 'default')
  if (ephemeralTag) {
    return `dsh-agy-probe-${scopeHash}-${profileSlug}-${sanitizeSegment(ephemeralTag)}`
  }
  return `dsh-agy-${scopeHash}-${profileSlug}`
}

export function resolveAgyGeminiDir(env: NodeJS.ProcessEnv = process.env): string {
  const userHome = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()
  return join(userHome, '.gemini')
}

/**
 * Mirror host `~/.gemini/antigravity-cli/settings.json` into an isolated pool's
 * `appDataDir` (read-only copy) so global permissions, `allowNonWorkspaceAccess`,
 * and `trustedWorkspaces` stay intact while profile `--settings` overlays cleanly.
 */
export function syncAgyBaseSettings(geminiDir: string, appDataDirName: string): void {
  const hostSettingsPath = join(geminiDir, 'antigravity-cli', 'settings.json')
  if (!existsSync(hostSettingsPath)) return
  try {
    const sourceContent = readFileSync(hostSettingsPath, 'utf8')
    const targetDir = join(geminiDir, appDataDirName)
    const targetPath = join(targetDir, 'settings.json')
    if (existsSync(targetPath)) {
      const existing = readFileSync(targetPath, 'utf8')
      if (existing === sourceContent) return
    }
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(targetPath, sourceContent, { mode: 0o600 })
  } catch {
    // Non-fatal: Antigravity falls back to defaults if settings cannot be mirrored.
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function copyFileAtomicallyIfMissing(srcPath: string, dstPath: string, mode?: number): boolean {
  if (existsSync(dstPath) || !isRegularFile(srcPath)) return false
  const tmpPath = `${dstPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    copyFileSync(srcPath, tmpPath)
    if (mode !== undefined) {
      chmodSync(tmpPath, mode)
    }
    try {
      linkSync(tmpPath, dstPath)
      unlinkSync(tmpPath)
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        rmSync(tmpPath, { force: true })
        return false
      }
      if (!existsSync(dstPath)) {
        renameSync(tmpPath, dstPath)
        return true
      }
      rmSync(tmpPath, { force: true })
      return false
    }
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
}

function copyDirectoryIfMissing(srcDir: string, dstDir: string): void {
  if (existsSync(dstDir) || !isDirectory(srcDir)) return
  const tmpDir = `${dstDir}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    cpSync(srcDir, tmpDir, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })
    if (existsSync(dstDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
      return
    }
    renameSync(tmpDir, dstDir)
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true })
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return
    throw err
  }
}

/**
 * Copy a single legacy Antigravity session from `~/.gemini/antigravity-cli/`
 * into an isolated pool `appDataDir` on demand when resuming a pre-isolation
 * session. Leaves host originals untouched, skips active WAL-locked DBs, and
 * never overwrites an existing session in the target pool directory.
 */
export function migrateLegacyAgySession(
  geminiDir: string,
  appDataDirName: string,
  sessionId: string,
  logger?: (message: string) => void,
): boolean {
  const cleanId = sessionId.trim()
  if (!SAFE_AGY_SESSION_ID_RE.test(cleanId) || cleanId.includes('..')) return false

  const legacyDir = resolve(geminiDir, 'antigravity-cli')
  const targetDir = resolve(geminiDir, appDataDirName)
  if (legacyDir === targetDir) return false

  const srcDb = join(legacyDir, 'conversations', `${cleanId}.db`)
  const dstDb = join(targetDir, 'conversations', `${cleanId}.db`)
  if (existsSync(dstDb) || !isRegularFile(srcDb)) return false

  if (existsSync(`${srcDb}-wal`) || existsSync(`${srcDb}-shm`)) {
    logger?.(
      `agy pool skipped migrating legacy session ${cleanId}: source database has active WAL/SHM files`,
    )
    return false
  }

  try {
    mkdirSync(join(targetDir, 'conversations'), { recursive: true })
    const copiedDb = copyFileAtomicallyIfMissing(srcDb, dstDb, 0o600)
    if (!copiedDb) return false

    const srcAnnotation = join(legacyDir, 'annotations', `${cleanId}.pbtxt`)
    const dstAnnotation = join(targetDir, 'annotations', `${cleanId}.pbtxt`)
    if (isRegularFile(srcAnnotation) && !existsSync(dstAnnotation)) {
      mkdirSync(join(targetDir, 'annotations'), { recursive: true })
      copyFileAtomicallyIfMissing(srcAnnotation, dstAnnotation)
    }

    const srcBrain = join(legacyDir, 'brain', cleanId)
    const dstBrain = join(targetDir, 'brain', cleanId)
    if (isDirectory(srcBrain) && !existsSync(dstBrain)) {
      mkdirSync(join(targetDir, 'brain'), { recursive: true })
      copyDirectoryIfMissing(srcBrain, dstBrain)
    }

    logger?.(`agy pool migrated legacy session ${cleanId} into isolated app-data-dir ${appDataDirName}`)
    return true
  } catch (err) {
    logger?.(
      `agy pool failed to migrate legacy session ${cleanId}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}

export function resolveDefaultInstanceScopeKey(dataDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = dataDir?.trim()
  if (explicit) return resolve(explicit)
  const dshHome = env.DSH_HOME?.trim() || join(env.HOME?.trim() || env.USERPROFILE?.trim() || homedir(), '.dsh')
  return resolve(dshHome, 'external-agents')
}

function poolKeyFor(runtimeId: string, profileId?: string): string {
  return profileId ? `${runtimeId}#${profileId}` : runtimeId
}

export interface AcpPoolClientLike {
  readonly isConnected: boolean
  readonly activeSessionCount: number
  readonly inFlightTurnCount: number
  readonly cachedCatalog: AcpCatalogSnapshot | undefined
  openSession(options?: AcpStartOptions): Promise<AcpSessionHandle>
  close(): Promise<void>
}

export interface AcpRuntimePoolOptions {
  readonly spec: ExternalRuntimeSpec
  readonly instanceScopeKey: string
  readonly idleEvictMs?: number
  readonly logger?: (message: string) => void
  readonly clientFactory?: (options: AcpRuntimeOptions) => AcpPoolClientLike
  readonly probeCatalogFn?: (options: AcpRuntimeOptions) => Promise<AcpCatalogSnapshot>
}

interface AgyIsolationTarget {
  readonly geminiDir: string
  readonly appDataDirName: string
}

interface PoolEntry {
  readonly key: string
  client: AcpPoolClientLike
  readonly agyIsolation?: AgyIsolationTarget
  idleTimer?: ReturnType<typeof setTimeout>
  retired: boolean
  closing?: Promise<void>
}

/**
 * Process pool for ACP runtimes that maintain a stateful on-disk conversation
 * database (e.g. Antigravity `agy acp`). Guarantees at most one live child
 * process per `(instanceScope, runtimeId, profileId)` with an isolated
 * `--app-data-dir`, eliminating cross-process "Resuming interrupted conversation"
 * races while multiplexing concurrent DSH sessions over one stdio server.
 */
export class AcpRuntimePool {
  private readonly spec: ExternalRuntimeSpec
  private readonly instanceScopeKey: string
  private readonly idleEvictMs: number
  private readonly logger: (message: string) => void
  private readonly clientFactory: (options: AcpRuntimeOptions) => AcpPoolClientLike
  private readonly probeCatalogFn: (options: AcpRuntimeOptions) => Promise<AcpCatalogSnapshot>
  private readonly entries = new Map<string, PoolEntry>()
  private readonly retiring = new Map<string, Promise<void>>()
  private disposed = false

  constructor(options: AcpRuntimePoolOptions) {
    this.spec = options.spec
    this.instanceScopeKey = options.instanceScopeKey
    this.idleEvictMs = options.idleEvictMs ?? DEFAULT_POOL_IDLE_EVICT_MS
    this.logger = options.logger ?? (() => {})
    this.clientFactory = options.clientFactory ?? ((opts) => new AcpRuntimeClient(opts))
    this.probeCatalogFn = options.probeCatalogFn ?? ((opts) => AcpRuntimeClient.probeCatalog(opts))
  }

  /**
   * Open or resume a multiplexed session on the shared pool process for
   * `(spec.id, profile?.id)`. Callers should close ONLY the returned handle
   * when the DSH session goes idle; the pool manages child process teardown.
   */
  async openSession(
    profile: ExternalRuntimeProfile | undefined,
    startOptions: AcpStartOptions,
    logger?: (message: string) => void,
  ): Promise<{ readonly handle: AcpSessionHandle; readonly release: () => Promise<void> }> {
    if (this.disposed) {
      throw new Error(`ACP pool for "${this.spec.id}" has been disposed`)
    }
    const key = poolKeyFor(this.spec.id, profile?.id)
    const entry = await this.acquireEntry(key, profile, logger)
    this.clearIdleTimer(entry)

    if (entry.agyIsolation && startOptions.sessionId) {
      migrateLegacyAgySession(
        entry.agyIsolation.geminiDir,
        entry.agyIsolation.appDataDirName,
        startOptions.sessionId,
        logger ?? this.logger,
      )
    }

    try {
      const handle = await entry.client.openSession(startOptions)
      let released = false
      return {
        handle,
        release: async () => {
          if (released) return
          released = true
          await handle.close().catch(() => {})
          this.onSessionReleased(entry)
        },
      }
    } catch (err) {
      this.onSessionReleased(entry)
      throw err
    }
  }

  /**
   * Probe available models without ever spawning a second process against a
   * pool's active `appDataDir`. Reuses the live pool's cached catalog when
   * connected, otherwise probes in an ephemeral isolated directory cleaned up
   * immediately on exit.
   */
  async probeCatalog(profile?: ExternalRuntimeProfile): Promise<AcpCatalogSnapshot> {
    const key = poolKeyFor(this.spec.id, profile?.id)
    const existing = this.entries.get(key)
    if (existing && !existing.retired && existing.client.isConnected && existing.client.cachedCatalog) {
      return existing.client.cachedCatalog
    }

    const ephemeralTag = randomBytes(4).toString('hex')
    const { runtimeOptions, cleanupDir } = this.buildRuntimeOptions(profile, {
      ephemeralTag,
      isProbe: true,
    })
    try {
      return await this.probeCatalogFn(runtimeOptions)
    } finally {
      if (cleanupDir) {
        try {
          rmSync(cleanupDir, { recursive: true, force: true })
        } catch {
          // Best-effort cleanup of ephemeral probe directory.
        }
      }
    }
  }

  /**
   * Retire the pool entry for a modified or deleted profile. Active turns finish
   * gracefully; once idle, the old process closes before any replacement spawns.
   */
  async invalidateProfile(profileId?: string): Promise<void> {
    const key = poolKeyFor(this.spec.id, profileId)
    const entry = this.entries.get(key)
    if (!entry) return
    entry.retired = true
    this.clearIdleTimer(entry)
    if (entry.client.activeSessionCount === 0 && entry.client.inFlightTurnCount === 0) {
      await this.closeEntry(entry)
    }
  }

  async disposeAll(): Promise<void> {
    this.disposed = true
    const current = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(
      current.map((entry) => {
        entry.retired = true
        this.clearIdleTimer(entry)
        return this.closeEntry(entry)
      }),
    )
  }

  private async acquireEntry(
    key: string,
    profile: ExternalRuntimeProfile | undefined,
    logger?: (message: string) => void,
  ): Promise<PoolEntry> {
    while (this.retiring.has(key)) {
      await this.retiring.get(key)?.catch(() => {})
    }

    const existing = this.entries.get(key)
    if (existing && !existing.retired && !existing.closing) {
      return existing
    }
    if (existing) {
      await this.closeEntry(existing)
    }

    const { runtimeOptions, agyIsolation } = this.buildRuntimeOptions(profile, {
      isProbe: false,
      logger,
    })
    const client = this.clientFactory(runtimeOptions)
    const entry: PoolEntry = {
      key,
      client,
      ...(agyIsolation ? { agyIsolation } : {}),
      retired: false,
    }
    this.entries.set(key, entry)
    return entry
  }

  private buildRuntimeOptions(
    profile: ExternalRuntimeProfile | undefined,
    opts: {
      readonly ephemeralTag?: string
      readonly isProbe: boolean
      readonly logger?: (message: string) => void
    },
  ): {
    readonly runtimeOptions: AcpRuntimeOptions
    readonly cleanupDir?: string
    readonly agyIsolation?: AgyIsolationTarget
  } {
    const extraEnv: Record<string, string> = opts.isProbe ? {} : { DSH_IN_AGENT_SESSION: '1' }
    const plan: ResolvedRuntimeLaunchPlan = resolveRuntimeLaunchPlan(this.spec, profile, extraEnv)
    // Never leak a host/parent DSH_SESSION_ID or ANTIGRAVITY_CONVERSATION_ID into a shared
    // multiplexed pool process; each session's own tools receive ANTIGRAVITY_CONVERSATION_ID
    // per conversation from the ACP server and resolve back via externalRuntimes.
    const env: NodeJS.ProcessEnv = { ...plan.env }
    delete env.DSH_SESSION_ID
    delete env.ANTIGRAVITY_CONVERSATION_ID
    delete env.ANTIGRAVITY_TRAJECTORY_ID
    let args = [...plan.args]
    let cleanupDir: string | undefined
    let agyIsolation: AgyIsolationTarget | undefined

    if (this.spec.id === 'agy' && !hasAgyDataDirFlag(args)) {
      const appDataDirName = buildAgyIsolatedAppDataDirName(
        this.instanceScopeKey,
        profile?.id,
        opts.ephemeralTag,
      )
      const geminiDir = resolveAgyGeminiDir(env)
      syncAgyBaseSettings(geminiDir, appDataDirName)
      args = [...args, '--app-data-dir', appDataDirName]
      if (opts.ephemeralTag) {
        cleanupDir = join(geminiDir, appDataDirName)
      } else {
        agyIsolation = { geminiDir, appDataDirName }
      }
    }

    const runtimeOptions: AcpRuntimeOptions = {
      cwd: homedir(),
      command: plan.command,
      args,
      env,
      ...(plan.authMethodId ? { authMethodId: plan.authMethodId } : {}),
      ...(plan.sessionMeta ? { sessionMeta: plan.sessionMeta } : {}),
      logger: opts.logger ?? this.logger,
    }
    return {
      runtimeOptions,
      ...(cleanupDir ? { cleanupDir } : {}),
      ...(agyIsolation ? { agyIsolation } : {}),
    }
  }

  private onSessionReleased(entry: PoolEntry): void {
    if (entry.closing) return
    if (entry.retired) {
      if (entry.client.activeSessionCount === 0 && entry.client.inFlightTurnCount === 0) {
        void this.closeEntry(entry)
      }
      return
    }
    if (entry.client.activeSessionCount === 0 && entry.client.inFlightTurnCount === 0) {
      this.armIdleTimer(entry)
    }
  }

  private armIdleTimer(entry: PoolEntry): void {
    this.clearIdleTimer(entry)
    if (this.idleEvictMs <= 0 || this.disposed) return
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined
      if (entry.client.activeSessionCount === 0 && entry.client.inFlightTurnCount === 0) {
        void this.closeEntry(entry)
      }
    }, this.idleEvictMs)
    entry.idleTimer.unref?.()
  }

  private clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  private closeEntry(entry: PoolEntry): Promise<void> {
    if (entry.closing) return entry.closing
    this.clearIdleTimer(entry)
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }
    const task = entry.client
      .close()
      .catch(() => {})
      .finally(() => {
        if (this.retiring.get(entry.key) === task) {
          this.retiring.delete(entry.key)
        }
      })
    entry.closing = task
    this.retiring.set(entry.key, task)
    return task
  }
}
