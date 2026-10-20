'use strict'

const { spawnSync } = require('node:child_process')
const assert = require('node:assert')
const path = require('node:path')

const root = path.join(__dirname, '..')
const entry = path.join(root, 'dist', 'index.js')
const demo = path.join(__dirname, 'demo-server.js')

let failures = 0

function run(args, input) {
  const res = spawnSync(process.execPath, [entry, ...args], {
    input,
    encoding: 'utf8',
    cwd: root,
    timeout: 30000,
  })
  if (res.error) throw res.error
  return res
}

function check(name, fn) {
  try {
    fn()
    console.log(`  ok    ${name}`)
  } catch (err) {
    failures++
    console.error(`  FAIL  ${name}\n        ${err.message}`)
  }
}

console.log('mcpcheck smoke')

const audit = run(['audit', '--json', '--', process.execPath, demo])

check('audit exits 1 when the server has errors', () => {
  assert.strictEqual(audit.status, 1, audit.stderr || audit.stdout)
})

let report = null
check('audit emits parseable JSON', () => {
  report = JSON.parse(audit.stdout)
})

check('audit lists every tool', () => {
  assert.ok(report, 'no report')
  assert.strictEqual(report.tools.length, 3)
})

check('audit detects the missing description', () => {
  assert.ok(report.issues.some(i => i.code === 'tool-description-missing'), 'expected tool-description-missing')
})

check('audit detects the nested schema', () => {
  assert.ok(report.issues.some(i => i.code === 'tool-schema-deep'), 'expected tool-schema-deep')
})

check('audit detects stdout pollution', () => {
  assert.ok(report.hygiene.nonJson.length >= 1, 'expected non-JSON stdout')
})

check('audit measures the manifest', () => {
  assert.ok(report.manifestTokens > 0, 'expected a non-zero manifest cost')
})

const input =
  [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }),
  ].join('\n') + '\n'

const proxy = run(['proxy', '--max-chars', '300', '--', process.execPath, demo], input)

check('proxy keeps the exit code', () => {
  assert.strictEqual(proxy.status, 0, proxy.stderr)
})

check('proxy truncates oversized tool output', () => {
  assert.ok(proxy.stdout.includes('mcpcheck truncated'), `got: ${proxy.stdout.slice(0, 300)}`)
})

check('proxy keeps responses parseable', () => {
  const responses = proxy.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(msg => msg && msg.id === 2)

  assert.strictEqual(responses.length, 1, 'expected exactly one response for id 2')
  const text = responses[0].result.content[0].text
  assert.ok(text.length < 1000, `text was not shortened (${text.length} chars)`)
})

const help = run(['--help'])
check('--help prints usage', () => {
  assert.strictEqual(help.status, 0)
  assert.ok(help.stdout.includes('USAGE'))
})

// ---- diff ----------------------------------------------------------------

const fs = require('node:fs')
const os = require('node:os')
const tmp = (name) => path.join(os.tmpdir(), `mcpcheck-${process.pid}-${name}`)
const baselinePath = tmp('baseline.json')
const mutatedPath = tmp('mutated.json')

const saved = run(['audit', '--json', '--save', baselinePath, '--', process.execPath, demo])
check('--save writes a baseline report', () => {
  assert.ok(saved.status === 1, saved.stderr)
  assert.ok(fs.existsSync(baselinePath), 'baseline file missing')
})

const stable = run(['diff', baselinePath, '--', process.execPath, demo])
check('diff against an unchanged server is clean', () => {
  assert.strictEqual(stable.status, 0, stable.stdout + stable.stderr)
  assert.ok(stable.stdout.includes('no changes'), stable.stdout)
})

check('diff detects breaking changes in a modified report', () => {
  const report = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  report.tools = report.tools.filter(t => t.name !== 'no_description_here')
  const query = report.tools.find(t => t.name === 'query_database')
  query.requiredNames = ['sql', 'mode']
  query.enums.mode = ['read']
  fs.writeFileSync(mutatedPath, JSON.stringify(report))

  const diff = run(['diff', baselinePath, mutatedPath])
  assert.strictEqual(diff.status, 1, diff.stdout + diff.stderr)

  const parsed = run(['diff', '--json', baselinePath, mutatedPath])
  const result = JSON.parse(parsed.stdout)
  const codes = result.changes.map(c => c.code)
  assert.ok(codes.includes('tool-removed'), `expected tool-removed, got ${codes.join(',')}`)
  assert.ok(codes.includes('param-required'), `expected param-required, got ${codes.join(',')}`)
  assert.ok(codes.includes('enum-narrowed'), `expected enum-narrowed, got ${codes.join(',')}`)
  assert.ok(result.breaking >= 3, `expected >= 3 breaking changes, got ${result.breaking}`)
})

for (const file of [baselinePath, mutatedPath]) {
  try {
    fs.unlinkSync(file)
  } catch {
    // best effort
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
