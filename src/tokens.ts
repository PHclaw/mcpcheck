/** Cheap, dependency-free size math. Everything reported is an estimate, not a tokenizer. */

export function strBytes(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return 0
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Rough token estimate: ~4 ASCII chars or ~1.5 CJK chars per token.
 * Good enough to compare two servers against each other, which is the point.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x80) ascii += 1
    else if (cp < 0x800) ascii += 0.5
    else wide += 1
  }
  return Math.ceil(ascii / 4 + wide / 1.5)
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

export function fmtShare(part: number, whole: number): string {
  if (whole <= 0) return '-'
  const pct = (part / whole) * 100
  if (pct > 0 && pct < 0.1) return '<0.1%'
  return `${pct.toFixed(1)}%`
}
