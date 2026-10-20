#!/usr/bin/env node
import fs from 'node:fs'
import { DEFAULT_OPTIONS, audit, type AuditOptions, type AuditResult } from './audit'
import { parseArgs } from './args'
import { diffReports, renderDiff } from './diff'
import { runProxy } from './proxy'
import { renderText } from './report'
import { numFlag, str } from './ui'
import { VERSION } from './version'

const USAGE = `mcpcheck ${VERSION} — audit an MCP server the way an agent experiences it

USAGE
  mcpcheck [audit] [options] -- <command> [args...]
  mcpcheck proxy [options] -- <command> [args...]
  mcpcheck diff <baseline.json> [-- <command> [args...]]

AUDIT OPTIONS
  --json                     machine-readable report
  --save <path>              also write the report to a file (use it as a baseline)
  --strict                   exit 1 on warnings too
  --timeout <ms>             per-request timeout (default ${DEFAULT_OPTIONS.timeoutMs})
  --max-manifest-tokens <n>  context budget for the whole manifest (default ${DEFAULT_OPTIONS.maxManifestTokens})
  --max-tool-bytes <n>       per-tool size budget (default ${DEFAULT_OPTIONS.maxToolBytes})
  --max-tool-depth <n>       schema nesting budget (default ${DEFAULT_OPTIONS.maxToolDepth})
  --context-window <n>       denominator for the share column (default 200000)

PROXY OPTIONS
  --max-chars <n>            cap each text block of a tool result (default 8000, 0 = off)
  --stats-file <path>        write final usage stats as JSON
  --quiet                    suppress the stats summary

DIFF
  Compares a saved baseline against the current server (or another report file).
  Breaking = removed tool, removed/now-required parameter, narrowed enum, new required param.

EXAMPLES
  mcpcheck -- node ./my-server.js
  mcpcheck audit --json --save baseline.json -- node ./my-server.js
  mcpcheck diff baseline.json -- node ./my-server.js
  mcpcheck proxy --max-chars 4000 -- node ./my-server.js

EXIT CODES
  0  clean            1  errors / breaking changes            2  could not run
`

function auditOptions(flags: Record<string, string | boolean>): Partial<AuditOptions> {
  return {
    timeoutMs: numFlag(flags.timeout, DEFAULT_OPTIONS.timeoutMs),
    maxManifestTokens: numFlag(flags['max-manifest-tokens'], DEFAULT_OPTIONS.maxManifestTokens),
    maxToolBytes: numFlag(flags['max-tool-bytes'], DEFAULT_OPTIONS.maxToolBytes),
    maxToolDepth: numFlag(flags['max-tool-depth'], DEFAULT_OPTIONS.maxToolDepth),
  }
}

function readReport(file: string): AuditResult {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`cannot read report: ${file}`)
  }
  try {
    return JSON.parse(raw) as AuditResult
  } catch {
    throw new Error(`${file} is not a mcpcheck JSON report`)
  }
}

async function main(): Promise<number> {
  const { _, flags } = parseArgs(process.argv.slice(2))

  if (flags.version || flags.v) {
    process.stdout.write(`mcpcheck ${VERSION}\n`)
    return 0
  }
  if (flags.help || flags.h) {
    process.stdout.write(USAGE)
    return 0
  }

  const known = new Set(['audit', 'proxy', 'diff', 'help'])
  let command = 'audit'
  let rest = _
  if (_[0] && known.has(_[0])) {
    command = _[0]
    rest = _.slice(1)
  }
  if (command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (rest.length === 0) {
    process.stderr.write(USAGE)
    return 2
  }

  if (command === 'proxy') {
    return runProxy({
      spec: { command: rest[0], args: rest.slice(1) },
      maxChars: numFlag(flags['max-chars'], 8000),
      statsFile: str(flags['stats-file']) || undefined,
      quiet: flags.quiet === true || flags.q === true,
    })
  }

  if (command === 'diff') {
    const before = readReport(rest[0])
    let after: AuditResult
    if (rest.length === 2 && /\.json$/i.test(rest[1])) {
      after = readReport(rest[1])
    } else {
      const cmd = rest.slice(1)
      if (cmd.length === 0) {
        process.stderr.write('mcpcheck: diff needs a command after the baseline report\n')
        return 2
      }
      after = await audit({ command: cmd[0], args: cmd.slice(1) }, auditOptions(flags))
    }

    const result = diffReports(before, after)
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      process.stdout.write(renderDiff(result, { version: VERSION, strict: flags.strict === true }))
    }
    return result.breaking > 0 ? 1 : 0
  }

  const result = await audit({ command: rest[0], args: rest.slice(1) }, auditOptions(flags))

  const savePath = str(flags.save)
  if (savePath) {
    try {
      fs.writeFileSync(savePath, `${JSON.stringify(result, null, 2)}\n`)
    } catch (err) {
      process.stderr.write(`mcpcheck: cannot write ${savePath}: ${(err as Error).message}\n`)
      return 2
    }
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(
      renderText(result, {
        version: VERSION,
        contextWindow: numFlag(flags['context-window'], 200_000),
        strict: flags.strict === true,
      }),
    )
  }

  const errors = result.issues.filter(i => i.level === 'error').length
  const warnings = result.issues.filter(i => i.level === 'warn').length
  if (errors > 0) return 1
  if (flags.strict === true && warnings > 0) return 1
  return 0
}

main()
  .then(code => {
    process.exitCode = code
  })
  .catch(err => {
    process.stderr.write(`mcpcheck: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 2
  })
