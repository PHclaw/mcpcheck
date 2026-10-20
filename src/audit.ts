import { McpClient, PROTOCOL_VERSION, RpcError, type SpawnSpec } from './client'
import { estimateTokens, fmtBytes, strBytes } from './tokens'
import { VERSION } from './version'

export type Level = 'error' | 'warn' | 'info'

export interface Issue {
  level: Level
  code: string
  message: string
  /** Set when the finding belongs to a single tool, so reports can group them. */
  tool?: string
}

/** One tool, measured by what it costs an agent rather than by what it does. */
export interface Entry {
  name: string
  descChars: number
  description: string
  descBytes: number
  schemaBytes: number
  bytes: number
  tokens: number
  params: number
  /** Parameter names in declaration order — the shape a diff has to compare. */
  paramNames: string[]
  requiredNames: string[]
  /** Only for params that declare an enum; used to spot narrowed value sets. */
  enums: Record<string, string[]>
  undocumented: number
  required: number
  depth: number
}

export interface Surface {
  surface: string
  count: number
  bytes: number
  tokens: number
  supported: boolean
  note?: string
}

export interface Hygiene {
  stdoutLines: number
  nonJson: string[]
  orphanResponses: number
  stderrTail: string
  exitedEarly: string | null
}

export interface AuditResult {
  target: string
  protocolVersion: string | null
  serverInfo: { name: string; version: string } | null
  initMs: number
  totalMs: number
  surfaces: Surface[]
  tools: Entry[]
  manifestBytes: number
  manifestTokens: number
  issues: Issue[]
  hygiene: Hygiene
}

export interface AuditOptions {
  timeoutMs: number
  maxManifestTokens: number
  maxToolBytes: number
  maxToolDepth: number
}

export const DEFAULT_OPTIONS: AuditOptions = {
  timeoutMs: 10_000,
  maxManifestTokens: 10_000,
  maxToolBytes: 4_096,
  maxToolDepth: 4,
}

const LEVEL_ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2 }

function errMessage(err: unknown): string {
  if (err instanceof RpcError) return `${err.message} (code ${err.code})`
  return err instanceof Error ? err.message : String(err)
}

function isUnsupported(err: unknown): boolean {
  if (err instanceof RpcError && err.code === -32601) return true
  return /method not found|not supported|unsupported/i.test(errMessage(err))
}

interface Param {
  name: string
  schema: Record<string, unknown>
}

function topLevelParams(schema: unknown): Param[] {
  if (!schema || typeof schema !== 'object') return []
  const props = (schema as Record<string, unknown>).properties
  if (!props || typeof props !== 'object') return []
  return Object.entries(props as Record<string, unknown>)
    .filter((entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === 'object')
    .map(([name, value]) => ({ name, schema: value }))
}

function schemaDepth(schema: unknown, depth = 0): number {
  if (!schema || typeof schema !== 'object' || depth > 16) return depth
  const node = schema as Record<string, unknown>
  let max = depth
  const props = node.properties
  if (props && typeof props === 'object') {
    for (const value of Object.values(props as Record<string, unknown>)) {
      max = Math.max(max, schemaDepth(value, depth + 1))
    }
  }
  if (node.items) max = Math.max(max, schemaDepth(node.items, depth))
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const arr = node[key]
    if (Array.isArray(arr)) for (const value of arr) max = Math.max(max, schemaDepth(value, depth))
  }
  return max
}

function toEntry(tool: Record<string, unknown>): Entry {
  const name = typeof tool.name === 'string' ? tool.name : '(unnamed)'
  const description = typeof tool.description === 'string' ? tool.description : ''
  const schema = tool.inputSchema
  const schemaText = schema === undefined ? '' : JSON.stringify(schema)
  const whole = JSON.stringify(tool)
  const props = topLevelParams(schema)
  let undocumented = 0
  const enums: Record<string, string[]> = {}
  for (const param of props) {
    const d = param.schema.description
    if (typeof d !== 'string' || d.trim().length === 0) undocumented++
    const values = param.schema.enum
    if (Array.isArray(values)) {
      const strings = values.filter((v): v is string => typeof v === 'string')
      if (strings.length > 0) enums[param.name] = strings
    }
  }
  const rawRequired = (schema as Record<string, unknown> | undefined)?.required
  const requiredNames = Array.isArray(rawRequired) ? rawRequired.filter((v): v is string => typeof v === 'string') : []
  return {
    name,
    descChars: description.length,
    description,
    descBytes: strBytes(description),
    schemaBytes: strBytes(schemaText),
    bytes: strBytes(whole),
    tokens: estimateTokens(whole),
    params: props.length,
    paramNames: props.map(p => p.name),
    requiredNames,
    enums,
    undocumented,
    required: requiredNames.length,
    depth: schemaDepth(schema),
  }
}

interface Collected {
  supported: boolean
  items: Record<string, unknown>[]
  bytes: number
  tokens: number
  note?: string
}

async function collect(
  client: McpClient,
  method: string,
  key: string,
  opts: AuditOptions,
  issues: Issue[],
): Promise<Collected> {
  const items: Record<string, unknown>[] = []
  let raw = ''
  let cursor: string | undefined
  try {
    for (let page = 0; page < 20; page++) {
      const res = await client.request<Record<string, unknown>>(method, cursor ? { cursor } : {}, opts.timeoutMs)
      raw += JSON.stringify(res)
      const arr = res[key]
      if (Array.isArray(arr)) {
        for (const item of arr) if (item && typeof item === 'object') items.push(item as Record<string, unknown>)
      }
      const next = res.nextCursor
      cursor = typeof next === 'string' && next.length > 0 ? next : undefined
      if (!cursor) break
    }
    return { supported: true, items, bytes: strBytes(raw), tokens: estimateTokens(raw) }
  } catch (err) {
    if (isUnsupported(err)) {
      return { supported: false, items: [], bytes: 0, tokens: 0, note: 'not implemented by server' }
    }
    issues.push({
      level: method === 'tools/list' ? 'error' : 'warn',
      code: 'surface-error',
      message: `${method} failed: ${errMessage(err)}`,
    })
    return { supported: false, items: [], bytes: 0, tokens: 0, note: errMessage(err) }
  }
}

function reviewTools(tools: Entry[], opts: AuditOptions, issues: Issue[]): void {
  const seen = new Set<string>()
  for (const tool of tools) {
    const flag = (level: Level, code: string, message: string): void => {
      issues.push({ level, code, message: `${tool.name}: ${message}`, tool: tool.name })
    }

    if (seen.has(tool.name)) flag('warn', 'tool-duplicate-name', 'is listed more than once')
    seen.add(tool.name)

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
      flag('warn', 'tool-name-charset', 'stick to letters, digits, _ or - — agents copy this name verbatim')
    }
    if (tool.descChars === 0) {
      flag('error', 'tool-description-missing', 'no description, so the model can only guess when to call it')
    } else if (tool.descChars < 12) {
      flag('warn', 'tool-description-thin', `description is ${tool.descChars} chars — say what it does and when not to`)
    }
    if (tool.schemaBytes > opts.maxToolBytes) {
      flag(
        'warn',
        'tool-schema-large',
        `inputSchema is ${fmtBytes(tool.schemaBytes)} (~${tool.tokens} tokens) and ships in every prompt`,
      )
    }
    if (tool.depth > opts.maxToolDepth) {
      flag('warn', 'tool-schema-deep', `schema nests ${tool.depth} levels deep; flatten it or accept flat JSON`)
    }
    if (tool.params > 0 && tool.undocumented * 2 > tool.params) {
      flag('warn', 'tool-params-undocumented', `${tool.undocumented}/${tool.params} parameters have no description`)
    }
  }
}

export async function audit(spec: SpawnSpec, options: Partial<AuditOptions> = {}): Promise<AuditResult> {
  const opts: AuditOptions = { ...DEFAULT_OPTIONS, ...options }
  const target = [spec.command, ...spec.args].join(' ')
  const client = new McpClient(spec)
  const started = Date.now()
  const issues: Issue[] = []

  await client.start()

  let protocolVersion: string | null = null
  let serverInfo: AuditResult['serverInfo'] = null
  let initMs = 0

  const initStart = Date.now()
  try {
    const init = await client.request<Record<string, unknown>>(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mcpcheck', version: VERSION },
      },
      opts.timeoutMs,
    )
    initMs = Date.now() - initStart
    if (typeof init.protocolVersion === 'string') protocolVersion = init.protocolVersion
    const info = init.serverInfo
    if (info && typeof info === 'object') {
      const rec = info as Record<string, unknown>
      serverInfo = {
        name: typeof rec.name === 'string' ? rec.name : '(unnamed)',
        version: typeof rec.version === 'string' ? rec.version : '?',
      }
    }
    client.notify('notifications/initialized')
  } catch (err) {
    await client.close()
    throw new Error(`initialize failed: ${errMessage(err)}`)
  }

  if (!serverInfo) {
    issues.push({ level: 'warn', code: 'server-info-missing', message: 'initialize response carries no serverInfo' })
  }
  if (protocolVersion && protocolVersion !== PROTOCOL_VERSION) {
    issues.push({
      level: 'info',
      code: 'protocol-version',
      message: `server negotiated ${protocolVersion}; mcpcheck speaks ${PROTOCOL_VERSION}`,
    })
  }
  if (initMs > 3000) {
    issues.push({ level: 'warn', code: 'init-slow', message: `initialize took ${initMs}ms before anything was usable` })
  }

  const surfaces: Surface[] = []
  const tools: Entry[] = []

  const toolList = await collect(client, 'tools/list', 'tools', opts, issues)
  surfaces.push({
    surface: 'tools/list',
    count: toolList.items.length,
    bytes: toolList.bytes,
    tokens: toolList.tokens,
    supported: toolList.supported,
    note: toolList.note,
  })
  for (const item of toolList.items) tools.push(toEntry(item))
  if (toolList.supported && toolList.items.length === 0) {
    issues.push({ level: 'info', code: 'no-tools', message: 'server exposes no tools at all' })
  }

  for (const [method, key] of [
    ['resources/list', 'resources'],
    ['prompts/list', 'prompts'],
  ] as const) {
    const res = await collect(client, method, key, opts, issues)
    surfaces.push({
      surface: method,
      count: res.items.length,
      bytes: res.bytes,
      tokens: res.tokens,
      supported: res.supported,
      note: res.note,
    })
  }

  reviewTools(tools, opts, issues)

  const manifestBytes = surfaces.reduce((n, s) => n + s.bytes, 0)
  const manifestTokens = surfaces.reduce((n, s) => n + s.tokens, 0)

  if (manifestTokens > opts.maxManifestTokens * 2) {
    issues.push({
      level: 'error',
      code: 'manifest-budget',
      message: `the manifest costs ~${manifestTokens} tokens, 2x over the ${opts.maxManifestTokens} budget — it is paid on every single turn`,
    })
  } else if (manifestTokens > opts.maxManifestTokens) {
    issues.push({
      level: 'warn',
      code: 'manifest-budget',
      message: `the manifest costs ~${manifestTokens} tokens, over the ${opts.maxManifestTokens} budget`,
    })
  }

  const diedEarly = client.exitInfo
  const hygiene: Hygiene = {
    stdoutLines: client.stats.stdoutLines,
    nonJson: [...client.stats.nonJson],
    orphanResponses: client.stats.orphanResponses,
    stderrTail: client.stderr.trim().split('\n').slice(-3).join('\n'),
    exitedEarly: diedEarly ? `exited (${diedEarly.code ?? diedEarly.signal}) before mcpcheck shut it down` : null,
  }
  await client.close()

  if (hygiene.nonJson.length > 0) {
    issues.push({
      level: 'warn',
      code: 'stdout-pollution',
      message: `${hygiene.nonJson.length} non-JSON line(s) on stdout, e.g. ${JSON.stringify(hygiene.nonJson[0].slice(0, 60))}`,
    })
  }
  if (hygiene.orphanResponses > 0) {
    issues.push({
      level: 'warn',
      code: 'orphan-responses',
      message: `${hygiene.orphanResponses} response(s) arrived with an unknown id and were dropped`,
    })
  }
  if (hygiene.stderrTail) {
    issues.push({
      level: 'info',
      code: 'stderr-output',
      message: `stderr is noisy: ${hygiene.stderrTail.split('\n')[0].slice(0, 80)}`,
    })
  }
  if (hygiene.exitedEarly) {
    issues.push({ level: 'error', code: 'server-exited', message: hygiene.exitedEarly })
  }

  issues.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])

  return {
    target,
    protocolVersion,
    serverInfo,
    initMs,
    totalMs: Date.now() - started,
    surfaces,
    tools,
    manifestBytes,
    manifestTokens,
    issues,
    hygiene,
  }
}
