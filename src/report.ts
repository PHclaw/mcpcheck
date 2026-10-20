import type { AuditResult, Issue, Level } from './audit'
import { fmtBytes, fmtNum, fmtShare } from './tokens'
import { fmt, ms, pad } from './ui'

export interface RenderOptions {
  version: string
  contextWindow: number
  strict: boolean
}

const LEVEL_LABEL: Record<Level, string> = { error: 'ERR ', warn: 'WARN', info: 'INFO' }

function colorFor(level: Level, text: string): string {
  if (level === 'error') return fmt.red(text)
  if (level === 'warn') return fmt.yellow(text)
  return fmt.cyan(text)
}

function padL(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

/** Nine tools missing parameter docs is one finding, not nine lines of noise. */
function renderIssues(issues: Issue[]): string[] {
  const out: string[] = []
  const buckets: { key: string; level: Level; code: string; items: Issue[] }[] = []

  for (const issue of issues) {
    const key = `${issue.level}:${issue.code}`
    const bucket = buckets.find(b => b.key === key)
    if (bucket) bucket.items.push(issue)
    else buckets.push({ key, level: issue.level, code: issue.code, items: [issue] })
  }

  for (const bucket of buckets) {
    if (bucket.items.length > 2 && bucket.items.every(i => i.tool)) {
      out.push(
        `  ${colorFor(bucket.level, LEVEL_LABEL[bucket.level])}  ${bucket.code} ${fmt.dim(`×${bucket.items.length}`)}`,
      )
      out.push(`        ${fmt.dim(bucket.items.map(i => i.tool).join(', '))}`)
      continue
    }
    for (const issue of bucket.items) {
      out.push(`  ${colorFor(issue.level, LEVEL_LABEL[issue.level])}  ${issue.code}`)
      out.push(`        ${fmt.dim(issue.message)}`)
    }
  }

  return out
}

export function renderText(result: AuditResult, opts: RenderOptions): string {
  const out: string[] = []
  const errors = result.issues.filter(i => i.level === 'error').length
  const warnings = result.issues.filter(i => i.level === 'warn').length

  out.push(`${fmt.bold('mcpcheck')} ${opts.version} ${fmt.dim('· audit')}`)
  out.push('')
  out.push(`  ${fmt.dim(pad('target', 9))}${result.target}`)
  out.push(
    `  ${fmt.dim(pad('server', 9))}${
      result.serverInfo ? `${result.serverInfo.name} ${result.serverInfo.version}` : fmt.yellow('unknown')
    }`,
  )
  out.push(`  ${fmt.dim(pad('protocol', 9))}${result.protocolVersion ?? fmt.yellow('not negotiated')}`)
  out.push(`  ${fmt.dim(pad('timing', 9))}init ${ms(result.initMs)} · total ${ms(result.totalMs)}`)
  out.push('')

  out.push(fmt.bold('CONTEXT MANIFEST'))
  out.push(
    fmt.dim(`  ${pad('surface', 16)}${padL('items', 7)}${padL('size', 10)}${padL('tokens', 9)}${padL('share', 8)}`),
  )
  for (const surface of result.surfaces) {
    const count = surface.supported ? String(surface.count) : '-'
    const size = surface.supported ? fmtBytes(surface.bytes) : '-'
    const tokens = surface.supported ? fmtNum(surface.tokens) : '-'
    const share = surface.supported ? fmtShare(surface.tokens, opts.contextWindow) : '-'
    out.push(`  ${pad(surface.surface, 16)}${padL(count, 7)}${padL(size, 10)}${padL(tokens, 9)}${padL(share, 8)}`)
  }
  const totalShare = fmtShare(result.manifestTokens, opts.contextWindow)
  out.push(
    `  ${fmt.dim(pad('total', 16))}${padL('', 7)}${padL(fmtBytes(result.manifestBytes), 10)}${padL(
      fmtNum(result.manifestTokens),
      9,
    )}${padL(totalShare, 8)}`,
  )
  for (const surface of result.surfaces) {
    if (surface.supported || !surface.note) continue
    out.push(`  ${fmt.dim(`${surface.surface}: ${surface.note}`)}`)
  }
  out.push('')

  if (result.tools.length > 0) {
    out.push(fmt.bold('TOOLS BY WEIGHT'))
    out.push(
      fmt.dim(
        `  ${pad('name', 24)}${padL('size', 9)}${padL('tokens', 8)}${padL('params', 8)}${padL('undoc', 7)}${padL('depth', 7)}`,
      ),
    )
    const ranked = [...result.tools].sort((a, b) => b.tokens - a.tokens)
    for (const tool of ranked.slice(0, 10)) {
      out.push(
        `  ${pad(tool.name, 24)}${padL(fmtBytes(tool.bytes), 9)}${padL(fmtNum(tool.tokens), 8)}${padL(
          String(tool.params),
          8,
        )}${padL(String(tool.undocumented), 7)}${padL(String(tool.depth), 7)}`,
      )
    }
    if (ranked.length > 10) out.push(fmt.dim(`  … ${ranked.length - 10} more`))
    out.push('')
  }

  if (result.issues.length === 0) {
    out.push(fmt.green('  no issues found'))
    out.push('')
  } else {
    out.push(fmt.bold(`ISSUES ${result.issues.length}`))
    out.push(...renderIssues(result.issues))
    out.push('')
  }

  out.push(fmt.bold('HYGIENE'))
  out.push(
    `  ${fmt.dim('stdout')}   ${result.hygiene.stdoutLines} lines · ${result.hygiene.nonJson.length} non-JSON · ${
      result.hygiene.orphanResponses
    } orphan response(s)`,
  )
  out.push(`  ${fmt.dim('stderr')}   ${result.hygiene.stderrTail ? 'present' : 'silent'}`)
  if (result.hygiene.exitedEarly) out.push(`  ${fmt.red('exit')}     ${result.hygiene.exitedEarly}`)
  for (const line of result.hygiene.nonJson.slice(0, 2)) {
    out.push(`  ${fmt.yellow('!')} ${JSON.stringify(line.slice(0, 70))}`)
  }
  out.push('')

  if (result.tools.length > 0) {
    out.push(fmt.bold('NEXT'))
    out.push(
      `  ${fmt.dim('cap what tools return at runtime:')} mcpcheck proxy --max-chars 8000 -- ${result.target}`,
    )
    out.push('')
  }

  const verdict =
    errors > 0
      ? fmt.red(`${errors} error(s), ${warnings} warning(s)`)
      : warnings > 0
        ? fmt.yellow(`${warnings} warning(s)`)
        : fmt.green('clean')
  out.push(`${fmt.bold('verdict')}  ${verdict}`)
  if (opts.strict && warnings > 0) out.push(fmt.dim('  --strict: warnings fail this run'))
  out.push('')

  return out.join('\n')
}
