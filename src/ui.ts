export const isTTY = process.stdout.isTTY === true && !process.env.NO_COLOR

const wrap = (code: string) => (s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s)

export const fmt = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
  magenta: wrap('35'),
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

export function die(msg: string, code = 2): never {
  process.stderr.write(`${fmt.red('mcpcheck')}: ${msg}\n`)
  process.exit(code)
}

export function str(v: string | boolean | undefined, dflt = ''): string {
  return typeof v === 'string' && v.length > 0 ? v : dflt
}

export function numFlag(v: string | boolean | undefined, dflt: number): number {
  if (typeof v !== 'string') return dflt
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : dflt
}

export function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
}
