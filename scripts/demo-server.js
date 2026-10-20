'use strict'

// Deliberately imperfect MCP server used to prove mcpcheck catches real problems:
// stdout pollution, a missing description, an oversized/nested schema, slow init.

const readline = require('node:readline')

process.stdout.write('demo-server booting...\n')

const nested = (() => {
  let node = { type: 'object', properties: { value: { type: 'string', description: 'leaf value' } } }
  for (let i = 0; i < 6; i++) {
    node = {
      type: 'object',
      description: 'padding '.repeat(40),
      properties: {
        [`level${i}`]: node,
        [`note${i}`]: { type: 'string', description: 'padding '.repeat(20) },
      },
    }
  }
  return node
})()

const tools = [
  {
    name: 'echo',
    description: 'Echo the given text back to the caller. Useful for connectivity tests.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo back' } },
      required: ['text'],
    },
  },
  {
    name: 'query_database',
    description: 'Run SQL.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        params: nested,
        mode: { type: 'string', enum: ['read', 'write'] },
        timeout: { type: 'number' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'no_description_here',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  },
]

const resources = [
  { uri: 'demo://readme', name: 'readme', mimeType: 'text/markdown' },
  { uri: 'demo://schema', name: 'schema', mimeType: 'application/json' },
]

const prompts = [{ name: 'summarize', description: 'Summarize a document', arguments: [] }]

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', line => {
  const text = line.trim()
  if (!text) return
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  const { id, method, params } = msg
  if (method === 'initialize') {
    // pretend to be slow so the timing column has something to show
    setTimeout(() => {
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'demo-server', version: '1.0.0' },
      })
    }, 30)
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') return reply(id, { tools })
  if (method === 'resources/list') return reply(id, { resources })
  if (method === 'prompts/list') return reply(id, { prompts })
  if (method === 'tools/call') {
    const name = params && params.name
    const text = name === 'echo' ? 'x'.repeat(1000) : `ran ${name}`
    return reply(id, { content: [{ type: 'text', text }, { type: 'text', text: 'done' }] })
  }
  if (method === 'shutdown') {
    reply(id, {})
    return
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`)
})

rl.on('close', () => process.exit(0))
