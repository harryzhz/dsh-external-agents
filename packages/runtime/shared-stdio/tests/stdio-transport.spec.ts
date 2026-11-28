import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  JsonRpcDispatcher,
  StdioJsonRpcTransport,
  resolveSafeCwd,
  stripSshSessionEnv,
  type JsonRpcMessage,
  type JsonRpcTransport,
} from '../src/index.js'

class InMemoryTransport implements JsonRpcTransport {
  readonly sent: JsonRpcMessage[] = []
  private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  throwOnSend?: Error

  send(message: JsonRpcMessage): void {
    if (this.throwOnSend) throw this.throwOnSend
    this.sent.push(message)
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async close(): Promise<void> {
    for (const listener of [...this.closeListeners]) listener(undefined)
  }
}

describe('shared-stdio env helpers', () => {
  it('stripSshSessionEnv removes SSH session markers while preserving SSH_AUTH_SOCK', () => {
    const out = stripSshSessionEnv({
      PATH: '/usr/bin',
      SSH_CONNECTION: '198.51.100.1 12345 198.51.100.2 22',
      SSH_CLIENT: '198.51.100.1 12345 22',
      SSH_TTY: '/dev/pts/0',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    })
    expect(out.SSH_CONNECTION).toBeUndefined()
    expect(out.SSH_CLIENT).toBeUndefined()
    expect(out.SSH_TTY).toBeUndefined()
    expect(out.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock')
    expect(out.PATH).toBe('/usr/bin')
  })

  it('resolveSafeCwd resolves symlinks and falls back cleanly for missing paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-stdio-cwd-'))
    const link = join(dir, 'alias')
    const target = join(dir, 'real')
    try {
      const realDir = mkdtempSync(target)
      symlinkSync(realDir, link)
      expect(resolveSafeCwd(link)).toBe(realpathSync(realDir))
      const missing = join(dir, 'does-not-exist')
      expect(resolveSafeCwd(missing)).toBe(missing)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('StdioJsonRpcTransport', () => {
  it('exchanges newline-delimited JSON-RPC messages and ignores non-JSON stdout noise', async () => {
    const script = [
      "const readline = require('node:readline');",
      "console.log('boot banner noise');",
      "console.log('[1,2,3]');",
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.on("line", (line) => {',
      '  const msg = JSON.parse(line);',
      '  console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: msg.params } }));',
      '});',
    ].join('')
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: process.env,
      label: 'test-stdio',
    })
    const received: JsonRpcMessage[] = []
    transport.onMessage((msg) => received.push(msg))

    transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: { ok: true } })

    const deadline = Date.now() + 3000
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15))
    }

    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, result: { echo: { ok: true } } }])
    await transport.close()
    await transport.close()
    expect(() => transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' })).toThrow(
      'test-stdio transport is closed',
    )
  })

  it('converts async stdin EPIPE errors into controlled onClose and terminates child without leaking', async () => {
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 10000)'],
      cwd: process.cwd(),
      env: process.env,
      label: 'epipe-test',
    })
    let closedErr: Error | undefined
    transport.onClose((err) => {
      closedErr = err
    })

    const child = (transport as unknown as { child: { stdin: NodeJS.WritableStream; exitCode: number | null; signalCode: string | null } }).child
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    child.stdin.emit('error', epipe)

    expect(closedErr?.message).toContain('epipe-test stdin error: write EPIPE')

    const deadline = Date.now() + 3000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })
})

describe('JsonRpcDispatcher', () => {
  it('routes requests, responses, custom RPC errors, timeouts, and bulk failAll', async () => {
    const transport = new InMemoryTransport()
    const dispatcher = new JsonRpcDispatcher({
      label: 'unit-rpc',
      defaultTimeoutMs: 500,
      createRpcError: (method, err) => new Error(`custom:${method}:${err.code}:${err.message}`),
    })
    dispatcher.attach(transport)

    const p1 = dispatcher.request('hello', { a: 1 })
    const p2 = dispatcher.request('boom', { b: 2 })
    expect(transport.sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'hello', params: { a: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'boom', params: { b: 2 } },
    ])

    expect(dispatcher.handleResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })).toBe(true)
    expect(
      dispatcher.handleResponse({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32002, message: 'not found' },
      }),
    ).toBe(true)
    expect(dispatcher.handleResponse({ jsonrpc: '2.0', method: 'notify/event', params: {} })).toBe(
      false,
    )

    await expect(p1).resolves.toEqual({ ok: true })
    await expect(p2).rejects.toThrow('custom:boom:-32002:not found')

    const p3 = dispatcher.request('slow', {}, 25)
    await expect(p3).rejects.toThrow('unit-rpc RPC "slow" timed out after 25ms')

    const p4 = dispatcher.request('inflight', {}, 5000)
    dispatcher.failAll(new Error('transport gone'))
    await expect(p4).rejects.toThrow('transport gone')
  })

  it('cleans up pending state if transport.send throws synchronously', async () => {
    const transport = new InMemoryTransport()
    transport.throwOnSend = new Error('pipe broken')
    const dispatcher = new JsonRpcDispatcher({
      label: 'unit-rpc',
      defaultTimeoutMs: 500,
      createRpcError: (_m, err) => new Error(err.message ?? 'err'),
    })
    dispatcher.attach(transport)

    await expect(dispatcher.request('ping', {})).rejects.toThrow('pipe broken')
    expect(() => dispatcher.notify('ev', {}, true)).not.toThrow()
    expect(() => dispatcher.notify('ev', {}, false)).toThrow('pipe broken')
  })
})
