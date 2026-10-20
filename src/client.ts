import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const PROTOCOL_VERSION = '2024-11-05'

export interface SpawnSpec {
  command: string
  args: string[]
}

export class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  method: string
}

/** Resolve an executable the way cmd.exe would (Node ignores PATHEXT on Windows). */
export function resolveCommand(command: string): { file: string; batch: boolean } {
  if (process.platform !== 'win32') return { file: command, batch: false }
  if (path.isAbsolute(command) || /[\\/]/.test(command)) {
    return { file: command, batch: /\.(cmd|bat)$/i.test(command) }
  }
  // PATHEXT order wins over the bare name: Node ships both `npx` (a bash script)
  // and `npx.cmd`, and only the latter is spawnable on Windows.
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of [...exts, '']) {
      const candidate = path.join(dir, command + ext)
      try {
        if (fs.statSync(candidate).isFile()) {
          return { file: candidate, batch: /\.(cmd|bat)$/i.test(candidate) }
        }
      } catch {
        // keep looking
      }
    }
  }
  return { file: command, batch: /\.(cmd|bat)$/i.test(command) }
}

function quoteWinArg(s: string): string {
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/**
 * Spawn an MCP server, transparently wrapping .cmd/.bat shims on Windows.
 * `cmd /s /c` strips exactly one outer pair of quotes, so the whole command
 * line needs that extra pair or paths with spaces (`C:\Program Files\...`) break.
 */
export function spawnServer(spec: SpawnSpec): ChildProcess {
  const { file, batch } = resolveCommand(spec.command)
  if (!batch) return spawn(file, spec.args)
  const line = [file, ...spec.args].map(quoteWinArg).join(' ')
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    windowsVerbatimArguments: true,
  })
}

/**
 * Minimal MCP stdio client used by the auditor. Speaks newline-delimited JSON-RPC,
 * records stdout pollution, and never blocks forever on a broken server.
 */
export class McpClient {
  readonly stats = { stdoutLines: 0, nonJson: [] as string[], responses: 0, orphanResponses: 0 }

  private child: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private exited: { code: number | null; signal: string | null } | null = null
  stderr = ''

  constructor(private readonly spec: SpawnSpec) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  get exitInfo(): { code: number | null; signal: string | null } | null {
    return this.exited
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawnServer(this.spec)

      this.child = child
      child.once('spawn', () => resolve())
      child.once('error', err => reject(err))
      child.once('exit', (code, signal) => {
        this.exited = { code, signal }
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer)
          this.pending.delete(id)
          p.reject(new Error(`server exited (${code ?? signal}) while waiting for ${p.method}${this.stderrTail()}`))
        }
      })

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => this.onData(chunk))
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        this.stderr = (this.stderr + chunk).slice(-4000)
      })
      child.stdin?.on('error', () => {
        // EPIPE after the server died; exit handling reports the real error.
      })
    })
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timed out waiting for ${method} (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
        method,
      })
      try {
        this.write(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    try {
      this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
    } catch {
      // notifications are best-effort
    }
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child || this.exited) return
    try {
      child.stdin?.end()
    } catch {
      // already closed
    }
    await new Promise<void>(done => {
      const timer = setTimeout(done, 400)
      child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).on('error', () => {})
      } else {
        try {
          child.kill('SIGTERM')
        } catch {
          // ignore
        }
      }
    })
  }

  private write(obj: unknown): void {
    if (!this.child || !this.child.stdin || this.exited) {
      throw new Error('server is not running')
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      this.stats.stdoutLines++
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        if (this.stats.nonJson.length < 5) this.stats.nonJson.push(line.slice(0, 200))
        continue
      }
      this.handleMessage(msg)
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const id = msg.id
    if (typeof id === 'number' && ('result' in msg || 'error' in msg)) {
      const pending = this.pending.get(id)
      if (!pending) {
        this.stats.orphanResponses++
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(id)
      this.stats.responses++
      if (msg.error && typeof msg.error === 'object') {
        const err = msg.error as { code?: unknown; message?: unknown; data?: unknown }
        pending.reject(new RpcError(Number(err.code ?? -1), String(err.message ?? 'unknown error'), err.data))
      } else {
        pending.resolve(msg.result)
      }
      return
    }
    if (typeof msg.method === 'string' && id !== undefined) {
      // Server-initiated request (sampling/roots). We do not implement them.
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'mcpcheck does not implement client capabilities' } })
    }
  }

  private stderrTail(): string {
    const tail = this.stderr.trim().split('\n').slice(-3).join('\n')
    return tail ? `\n${tail}` : ''
  }
}
