import type { AuditResult, Entry } from './audit'
import { fmtBytes, fmtNum } from './tokens'
import { fmt } from './ui'

export type ChangeLevel = 'breaking' | 'compatible' | 'info'

export interface Change {
  level: ChangeLevel
  code: string
  tool?: string
  message: string
}

export interface Side {
  target: string
  server: string
  tools: number
  manifestTokens: number
}

export interface DiffResult {
  before: Side
  after: Side
  changes: Change[]
  breaking: number
}

const LEVEL_ORDER: Record<ChangeLevel, number> = { breaking: 0, compatible: 1, info: 2 }

function summarize(report: AuditResult): Side {
  return {
    target: report.target,
    server: report.serverInfo ? `${report.serverInfo.name} ${report.serverInfo.version}` : 'unknown',
    tools: report.tools.length,
    manifestTokens: report.manifestTokens,
  }
}

function byName(tools: Entry[]): Map<string, Entry> {
  const map = new Map<string, Entry>()
  for (const tool of tools) map.set(tool.name, tool)
  return map
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat || '(empty)'
}

/**
 * Compares two audits for the changes that actually break an agent:
 * tools that vanished, parameters that appeared/moved to required,
 * enum values that were removed. Everything else is noise-level.
 */
export function diffReports(before: AuditResult, after: AuditResult): DiffResult {
  const changes: Change[] = []
  const oldTools = byName(before.tools)
  const newTools = byName(after.tools)

  for (const [name] of oldTools) {
    if (!newTools.has(name)) {
      changes.push({
        level: 'breaking',
        code: 'tool-removed',
        tool: name,
        message: 'removed — any prompt that learned it now calls a method that does not exist',
      })
    }
  }
  for (const [name, tool] of newTools) {
    if (!oldTools.has(name)) {
      changes.push({
        level: 'compatible',
        code: 'tool-added',
        tool: name,
        message: `added (+${fmtNum(tool.tokens)} tokens in every prompt)`,
      })
    }
  }

  for (const [name, oldTool] of oldTools) {
    const newTool = newTools.get(name)
    if (!newTool) continue

    const removed = oldTool.paramNames.filter(p => !newTool.paramNames.includes(p))
    if (removed.length > 0) {
      changes.push({
        level: 'breaking',
        code: 'param-removed',
        tool: name,
        message: `parameter(s) removed: ${removed.join(', ')}`,
      })
    }

    const added = newTool.paramNames.filter(p => !oldTool.paramNames.includes(p))
    if (added.length > 0) {
      const requiredAdded = added.filter(p => newTool.requiredNames.includes(p))
      changes.push({
        level: requiredAdded.length > 0 ? 'breaking' : 'compatible',
        code: requiredAdded.length > 0 ? 'param-required-new' : 'param-added',
        tool: name,
        message:
          requiredAdded.length > 0
            ? `new required parameter(s): ${requiredAdded.join(', ')}`
            : `new optional parameter(s): ${added.join(', ')}`,
      })
    }

    const becameRequired = newTool.requiredNames.filter(p => !oldTool.requiredNames.includes(p))
    if (becameRequired.length > 0) {
      changes.push({
        level: 'breaking',
        code: 'param-required',
        tool: name,
        message: `now required: ${becameRequired.join(', ')}`,
      })
    }

    const becameOptional = oldTool.requiredNames.filter(p => !newTool.requiredNames.includes(p))
    if (becameOptional.length > 0) {
      changes.push({
        level: 'compatible',
        code: 'param-optional',
        tool: name,
        message: `no longer required: ${becameOptional.join(', ')}`,
      })
    }

    for (const [param, values] of Object.entries(oldTool.enums)) {
      const next = newTool.enums[param]
      if (!next) continue
      const dropped = values.filter(v => !next.includes(v))
      if (dropped.length > 0) {
        changes.push({
          level: 'breaking',
          code: 'enum-narrowed',
          tool: name,
          message: `${param} no longer accepts: ${dropped.join(', ')}`,
        })
      }
      const gained = next.filter(v => !values.includes(v))
      if (gained.length > 0) {
        changes.push({
          level: 'compatible',
          code: 'enum-widened',
          tool: name,
          message: `${param} now also accepts: ${gained.join(', ')}`,
        })
      }
    }

    if (oldTool.description !== newTool.description) {
      changes.push({
        level: 'info',
        code: 'description-changed',
        tool: name,
        message: `description "${clip(oldTool.description)}" → "${clip(newTool.description)}"`,
      })
    }

    if (oldTool.tokens > 0) {
      const delta = newTool.tokens - oldTool.tokens
      if (Math.abs(delta) > 40 && Math.abs(delta) / oldTool.tokens > 0.25) {
        changes.push({
          level: 'info',
          code: 'weight-changed',
          tool: name,
          message: `costs ${delta > 0 ? '+' : ''}${fmtNum(delta)} tokens (${fmtBytes(newTool.bytes)} now)`,
        })
      }
    }
  }

  const delta = after.manifestTokens - before.manifestTokens
  if (before.manifestTokens > 0 && Math.abs(delta) / before.manifestTokens > 0.15) {
    changes.push({
      level: delta > 0 ? 'compatible' : 'info',
      code: 'manifest-changed',
      message: `manifest is ${delta > 0 ? '+' : ''}${fmtNum(delta)} tokens (${fmtNum(
        before.manifestTokens,
      )} → ${fmtNum(after.manifestTokens)})`,
    })
  }

  changes.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])

  return {
    before: summarize(before),
    after: summarize(after),
    changes,
    breaking: changes.filter(c => c.level === 'breaking').length,
  }
}

function deltaLabel(diff: DiffResult): string {
  const delta = diff.after.manifestTokens - diff.before.manifestTokens
  if (delta === 0) return 'no change'
  return `${delta > 0 ? '+' : ''}${fmtNum(delta)} tokens`
}

export function renderDiff(diff: DiffResult, opts: { version: string; strict: boolean }): string {
  const out: string[] = []

  out.push(`${fmt.bold('mcpcheck')} ${opts.version} ${fmt.dim('· diff')}`)
  out.push('')
  out.push(`  ${fmt.dim('before')}   ${diff.before.server} · ${diff.before.tools} tools · ${fmtNum(diff.before.manifestTokens)} tokens`)
  out.push(`  ${fmt.dim('after')}    ${diff.after.server} · ${diff.after.tools} tools · ${fmtNum(diff.after.manifestTokens)} tokens`)
  out.push(`  ${fmt.dim('cost')}     ${deltaLabel(diff)}`)
  out.push('')

  if (diff.changes.length === 0) {
    out.push(fmt.green('  no changes'))
    out.push('')
  }

  const groups: { level: ChangeLevel; title: string; paint: (s: string) => string }[] = [
    { level: 'breaking', title: 'BREAKING', paint: fmt.red },
    { level: 'compatible', title: 'COMPATIBLE', paint: fmt.cyan },
    { level: 'info', title: 'INFO', paint: fmt.dim },
  ]

  for (const group of groups) {
    const items = diff.changes.filter(c => c.level === group.level)
    if (items.length === 0) continue
    out.push(fmt.bold(`${group.title} ${items.length}`))
    for (const change of items) {
      out.push(`  ${group.paint(change.code)}`)
      out.push(`        ${change.tool ? `${fmt.bold(change.tool)} — ` : ''}${change.message}`)
    }
    out.push('')
  }

  if (diff.breaking > 0) {
    out.push(`${fmt.bold('verdict')}  ${fmt.red(`${diff.breaking} breaking change(s)`)}`)
  } else if (diff.changes.length > 0) {
    out.push(`${fmt.bold('verdict')}  ${fmt.green('compatible')}`)
  } else {
    out.push(`${fmt.bold('verdict')}  ${fmt.green('identical')}`)
  }
  out.push('')

  return out.join('\n')
}
