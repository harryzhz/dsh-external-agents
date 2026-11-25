import { spawn, type ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { CodexTransportFactoryOptions, JsonRpcMessage, JsonRpcTransport } from './types.js'

const MAX_STDERR_BYTES = 4096
const KILL_GRACE_MS = 2000

export function resolveSafeCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

export class CodexStdioTransport implements JsonRpcTransport {
  private readonly child: ChildProcess
  private readonly rl: Interface
  private readonly label: string
  private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private stderrTail = ''
  private closed = false

  constructor(options: CodexTransportFactoryOptions) {
    const safeCwd = resolveSafeCwd(options.cwd)
    this.label = `${basename(options.cliBin) || 'codex'} app-server`
    const needsWindowsShell =
      process.platform === 'win32' && !/\.exe$/i.test(options.cliBin)
    this.child = spawn(options.cliBin, [...options.args], {
      cwd: safeCwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(needsWindowsShell ? { shell: true } : {}),
    })

    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
    })

    if (!this.child.stdout || !this.child.stdin) {
      throw new Error(`${this.label} stdio pipes unavailable`)
    }

    this.child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (this.closed) return
      const code = err.code
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        this.notifyClosed(new Error(`${this.label} stdin pipe closed (${code}): ${err.message}`))
        return
      }
      this.notifyClosed(new Error(`${this.label} stdin error: ${err.message}`))
    })

    this.rl = createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this.handleLine(line))

    this.child.once('error', (err) => {
      this.notifyClosed(new Error(`${this.label} spawn error: ${err.message}`))
    })
    this.child.once('exit', (code, signal) => {
      if (this.closed) {
        this.notifyClosed(undefined)
        return
      }
      const detail = this.stderrTail.trim()
      const suffix = detail ? `\n${detail}` : ''
      this.notifyClosed(
        new Error(`${this.label} exited unexpectedly (code=${code}, signal=${signal})${suffix}`),
      )
    })
  }

  send(message: JsonRpcMessage): void {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error(`${this.label} transport is closed`)
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => {
      this.messageListeners.delete(listener)
    }
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.rl.close()
    try {
      this.child.stdin?.end()
    } catch {
      // Pipe already closed.
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.notifyClosed(undefined)
      return
    }
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          this.child.kill('SIGKILL')
        } catch {
          // Process already exited.
        }
        done()
      }, KILL_GRACE_MS)
      timer.unref?.()
      this.child.once('exit', done)
      try {
        this.child.kill('SIGTERM')
      } catch {
        done()
      }
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const msg = parsed as JsonRpcMessage
    for (const listener of [...this.messageListeners]) {
      try {
        listener(msg)
      } catch {
        // Isolate listener failures from the stdio read loop.
      }
    }
  }

  private notifyClosed(error?: Error): void {
    this.closed = true
    this.rl.close()
    for (const listener of [...this.closeListeners]) {
      try {
        listener(error)
      } catch {
        // Isolate teardown listener failures.
      }
    }
    this.closeListeners.clear()
    this.messageListeners.clear()
  }
}
