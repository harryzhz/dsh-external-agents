import { realpathSync } from 'node:fs'

/**
 * Strip SSH session markers while preserving SSH_AUTH_SOCK.
 * Some agent CLIs (e.g. Antigravity) switch away from the macOS Keychain to
 * file-based token storage when SSH_CONNECTION/SSH_CLIENT/SSH_TTY are present.
 */
export function stripSshSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env }
  delete sanitized.SSH_CONNECTION
  delete sanitized.SSH_CLIENT
  delete sanitized.SSH_TTY
  return sanitized
}

/**
 * Resolve symlinks in `cwd` when accessible so downstream CLIs match canonical
 * workspace roots; fall back to the original path if resolution fails.
 */
export function resolveSafeCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}
