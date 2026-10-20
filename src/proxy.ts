import fs from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { spawnServer, type SpawnSpec } from './client'
import { estimateTokens, fmtBytes, fmtNum } from './tokens'
import { fmt } from './ui'

export interface ProxyOptions {
  spec: SpawnSpec
  /** Cap for each text block inside a tool result. 0 disables truncation. */
  maxChars: number
  statsFile?: string
  quiet?: boolean
}

export interface ProxyStats {
  requests: number
  responses: number
  serverRequests: number
  truncated: number
  bytesToServer: number
  bytesToHost: number
  savedBytes: number
  savedTokens: number
}

/**
 * Shrink an oversized JSON-RPC response while keeping it valid JSON.
 * Only `result.content[].text` is touched — the part that usually carries
 * a full file, a web page or a stack of rows.
 */
export function shrinkLine(line: string, maxChars: number): string | null {
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  const result = msg?.result
  if (!result || !Array.isArray(result.content)) return null

  const budget = Math.max(200, maxChars)
  const kept: any[] = []
  let used = 0
  let cut = 0

  for (const item of result.content) {
    if (item && item.type === 'text' && typeof item.text === 'string') {
      const room = budget - used
      if (room <= 64) {
        cut += item.text.length
        continue
      }
      if (item.text.length > room) {
        const removed = item.text.length - room
        cut += removed
        kept.push({ ...item, text: `${item.text.slice(0, room)}\n…[mcpcheck truncated ${removed} chars]` })
        used += room
      } else {
        kept.push(item)
        used += item.text.length
      }
    } else {
      kept.push(item)
      used += JSON.stringify(item).length
    }
  }

  if (cut === 0) return null
  result.content = kept
  return JSON.stringify(msg)
}

export function runProxy(opts: ProxyOptions): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const stats: ProxyStats = {
      requests: 0,
      responses: 0,
      serverRequests: 0,
      truncated: 0,
      bytesToServer: 0,
      bytesToHost: 0,
      savedBytes: 0,
      savedTokens: 0,
    }

    let child: ChildProcess
    try {
      child = spawnServer(opts.spec)
    } catch (err) {
      reject(err)
      return
    }

    let outBuf = ''
    let inBuf = ''
    let finished = false

    function observeHost(line: string): void {
      const text = line.trim()
      if (!text) return
      try {
        const msg = JSON.parse(text) as Record<string, unknown>
        if (typeof msg.method === 'string' && msg.id !== undefined) stats.requests++
      } catch {
        // not JSON; the server will decide what to do with it
      }
    }

    function observeServer(line: string): void {
      const text = line.trim()
      if (!text) return
      try {
        const msg = JSON.parse(text) as Record<string, unknown>
        if (typeof msg.method === 'string' && msg.id !== undefined) stats.serverRequests++
        else if (msg.id !== undefined && ('result' in msg || 'error' in msg)) stats.responses++
      } catch {
        // stdout pollution, passed through untouched
      }
    }

    function forward(raw: string): void {
      const line = raw.replace(/\r$/, '')
      if (!line.trim()) return
      observeServer(line)

      let out = line
      if (opts.maxChars > 0 && line.length > opts.maxChars) {
        const shrunk = shrinkLine(line, opts.maxChars)
        if (shrunk) {
          out = shrunk
          stats.truncated++
          stats.savedBytes += line.length - out.length
          stats.savedTokens += Math.max(0, estimateTokens(line) - estimateTokens(out))
        }
      }
      stats.bytesToHost += Buffer.byteLength(out) + 1
      process.stdout.write(`${out}\n`)
    }

    function flushRemainder(): void {
      if (outBuf.trim()) {
        forward(outBuf)
        outBuf = ''
      }
    }

    child.once('error', err => {
      if (finished) return
      finished = true
      reject(err)
    })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      outBuf += chunk
      let idx: number
      while ((idx = outBuf.indexOf('\n')) !== -1) {
        const line = outBuf.slice(0, idx)
        outBuf = outBuf.slice(idx + 1)
        forward(line)
      }
    })
    child.stdout?.on('end', flushRemainder)
    child.stderr?.pipe(process.stderr)

    process.stdin.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      stats.bytesToServer += buf.length
      inBuf += buf.toString('utf8')
      let idx: number
      while ((idx = inBuf.indexOf('\n')) !== -1) {
        observeHost(inBuf.slice(0, idx))
        inBuf = inBuf.slice(idx + 1)
      }
      if (child.stdin && !child.stdin.write(buf)) process.stdin.pause()
    })
    child.stdin?.on('drain', () => process.stdin.resume())
    child.stdin?.on('error', () => {
      // server died mid-write; the exit handler reports it
    })
    process.stdin.on('end', () => {
      try {
        child.stdin?.end()
      } catch {
        // already closed
      }
    })
    process.stdin.on('error', () => {})

    child.once('exit', code => {
      if (finished) return
      finished = true
      process.stdin.pause()
      flushRemainder()

      const summary =
        `${fmt.dim('mcpcheck proxy')} · ${stats.requests} req / ${stats.responses} res · ` +
        `${fmtBytes(stats.bytesToServer)} in → ${fmtBytes(stats.bytesToHost)} out · ` +
        `${stats.truncated} truncated · ~${fmtNum(stats.savedTokens)} tokens kept out of context\n`
      if (!opts.quiet) process.stderr.write(`\n${summary}`)

      if (opts.statsFile) {
        try {
          fs.writeFileSync(opts.statsFile, `${JSON.stringify(stats, null, 2)}\n`)
        } catch (err) {
          process.stderr.write(`${fmt.red('mcpcheck')}: cannot write stats file: ${(err as Error).message}\n`)
        }
      }
      resolve(code ?? 0)
    })
  })
}
