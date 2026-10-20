'use strict'

/**
 * Generates assets/banner.svg, assets/banner-light.svg and assets/demo.svg.
 * Animated SVG instead of GIF: crisp text at any zoom, ~6 KB, theme-aware,
 * and it keeps animating when GitHub proxies it through camo.
 */

const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, '..', 'assets')

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const DUR = 10
const k = t => Math.min(0.95, Math.max(0, t / DUR)).toFixed(4)

const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"

/* ------------------------------------------------------------------ banner */

const THEMES = {
  dark: {
    bg: ['#0B0F19', '#111A2E'],
    grid: '#1B2436',
    title: '#E6EDF3',
    muted: '#8B949E',
    accent: '#818CF8',
    accent2: '#22D3EE',
    chipBg: '#151C2C',
    chipBorder: '#243044',
    cardBg: '#0D1117',
    cardBorder: '#253046',
    glow: '#6366F1',
  },
  light: {
    bg: ['#FFFFFF', '#EEF2FF'],
    grid: '#E5E9F2',
    title: '#0F172A',
    muted: '#64748B',
    accent: '#4F46E5',
    accent2: '#0891B2',
    chipBg: '#FFFFFF',
    chipBorder: '#D8DEE9',
    cardBg: '#0D1117',
    cardBorder: '#253046',
    glow: '#6366F1',
  },
}

function banner(themeName) {
  const t = THEMES[themeName]
  const chips = ['audit', 'diff', 'proxy']
  const chipWidths = [66, 58, 66]
  let chipX = 72
  const chipEls = chips
    .map((label, i) => {
      const w = chipWidths[i]
      const el = `<g>
      <rect x="${chipX}" y="236" width="${w}" height="30" rx="15" fill="${t.chipBg}" stroke="${t.chipBorder}"/>
      <text x="${chipX + w / 2}" y="256" text-anchor="middle" font-family="${FONT}" font-size="13" fill="${t.muted}">${label}</text>
    </g>`
      chipX += w + 10
      return el
    })
    .join('\n    ')

  const rows = [
    ['$ mcpcheck -- node server.js', '', '', '#E6EDF3'],
    ['tools/list', '14 tools', '3,141 tok', '#8B949E'],
    ['ISSUES', '9 warnings', '', '#D29922'],
    ['verdict', '2 errors', '', '#F85149'],
  ]
  const card = rows
    .map(([label, mid, right, color], i) => {
      const y = 122 + i * 30
      const parts = [
        `<text x="742" y="${y}" font-family="${FONT}" font-size="15" fill="${color}" xml:space="preserve">${esc(label)}</text>`,
      ]
      if (mid) {
        parts.push(
          `<text x="1030" y="${y}" text-anchor="end" font-family="${FONT}" font-size="15" fill="#C9D1D9">${esc(mid)}</text>`,
        )
      }
      if (right) {
        parts.push(
          `<text x="1166" y="${y}" text-anchor="end" font-family="${FONT}" font-size="15" fill="#6E7681">${esc(right)}</text>`,
        )
      }
      return parts.join('\n      ')
    })
    .join('\n      ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="320" viewBox="0 0 1280 320" role="img" aria-label="mcpcheck">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg[0]}"/>
      <stop offset="1" stop-color="${t.bg[1]}"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${t.accent}"/>
      <stop offset="1" stop-color="${t.accent2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${t.glow}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${t.glow}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="${t.grid}" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="1280" height="320" fill="url(#bg)"/>
  <rect width="1280" height="320" fill="url(#grid)" opacity="0.5"/>
  <circle cx="1080" cy="40" r="260" fill="url(#glow)"/>

  <rect x="72" y="70" width="6" height="80" rx="3" fill="url(#accent)"/>

  <text x="98" y="130" font-family="${FONT}" font-size="64" font-weight="700" letter-spacing="-1.5" fill="${t.title}">mcpcheck</text>
  <text x="100" y="172" font-family="Inter, -apple-system, Segoe UI, sans-serif" font-size="20" fill="${t.muted}">Audit an MCP server the way an agent experiences it.</text>

  ${chipEls}

  <rect x="700" y="62" width="508" height="196" rx="14" fill="${t.cardBg}" stroke="${t.cardBorder}"/>
  <circle cx="726" cy="88" r="5" fill="#F85149"/>
  <circle cx="746" cy="88" r="5" fill="#D29922"/>
  <circle cx="766" cy="88" r="5" fill="#3FB950"/>
  <line x1="700" y1="106" x2="1208" y2="106" stroke="${t.cardBorder}"/>
  ${card}
  <text x="742" y="236" font-family="${FONT}" font-size="13" fill="#4B5563">context cost, measured</text>
</svg>
`
}

/* -------------------------------------------------------------------- demo */

const LH = 24
const TOP = 112
const CMD_Y = 78
const LEFT = 36
const DEMO_W = 900
const DEMO_H = 548

/** [time, text, color, weight] */
const DEMO_LINES = [
  [1.60, 'mcpcheck 0.1.0 · audit', '#E6EDF3', 700],
  [1.85, '', '#E6EDF3', 400],
  [1.95, '  target   node ./my-server.js', '#8B949E', 400],
  [2.10, '  server   demo-server 1.0.0', '#8B949E', 400],
  [2.25, '  timing   init 34ms · total 210ms', '#8B949E', 400],
  [2.50, '', '#E6EDF3', 400],
  [2.60, 'CONTEXT MANIFEST', '#E6EDF3', 700],
  [2.75, '  surface           items      size   tokens   share', '#6E7681', 400],
  [2.90, '  tools/list            3    4.0 KB    1,037    0.5%', '#E6EDF3', 400],
  [3.05, '  total                      4.3 KB    1,097    0.5%', '#8B949E', 400],
  [3.30, '', '#E6EDF3', 400],
  [3.40, 'ISSUES 6', '#E6EDF3', 700],
  [3.55, '  ERR   tool-description-missing', '#F85149', 400],
  [3.70, '        no description, so the model can only guess', '#6E7681', 400],
  [3.85, '  WARN  tool-schema-deep', '#D29922', 400],
  [4.00, '        schema nests 8 levels deep', '#6E7681', 400],
  [4.25, '', '#E6EDF3', 400],
  [4.35, 'verdict  1 error(s), 5 warning(s)', '#F85149', 700],
  [5.60, '', '#E6EDF3', 400],
]

// "npm install -g mcpcheck" style prompt line, typed character by character
const PROMPT = '$ '
const COMMAND = 'mcpcheck -- node ./my-server.js'
const ADV = 8.4 // 0.6em at font-size 14
// The clip starts at the prompt, so its width must cover "$ " + the command.
const CMD_WIDTH = (PROMPT.length + COMMAND.length) * ADV + 4

function demo() {
  const body = DEMO_LINES.map(([t, text, color, weight], i) => {
    if (!text) return ''
    const y = TOP + i * LH
    return `    <text x="${LEFT}" y="${y}" font-family="${FONT}" font-size="14" font-weight="${weight}" fill="${color}" xml:space="preserve">${esc(
      text,
    )}<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;${k(t)};${k(t + 0.02)};0.955;1" dur="${DUR}s" repeatCount="indefinite"/></text>`
  })
    .filter(Boolean)
    .join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DEMO_W}" height="${DEMO_H}" viewBox="0 0 ${DEMO_W} ${DEMO_H}" role="img" aria-label="mcpcheck demo">
  <defs>
    <clipPath id="typing">
      <rect x="${LEFT}" y="${CMD_Y - 14}" width="0" height="22">
        <animate attributeName="width" values="0;0;${CMD_WIDTH};${CMD_WIDTH};0" keyTimes="0;0.01;0.15;0.955;1" dur="${DUR}s" repeatCount="indefinite"/>
      </rect>
    </clipPath>
  </defs>

  <rect width="${DEMO_W}" height="${DEMO_H}" rx="12" fill="#0D1117"/>
  <rect x="0.5" y="0.5" width="${DEMO_W - 1}" height="${DEMO_H - 1}" rx="12" fill="none" stroke="#30363D"/>

  <path d="M0 12a12 12 0 0 1 12-12h${DEMO_W - 24}a12 12 0 0 1 12 12v30H0z" fill="#161B22"/>
  <circle cx="26" cy="26" r="6" fill="#F85149"/>
  <circle cx="48" cy="26" r="6" fill="#D29922"/>
  <circle cx="70" cy="26" r="6" fill="#3FB950"/>
  <text x="${DEMO_W / 2}" y="31" text-anchor="middle" font-family="${FONT}" font-size="12" fill="#6E7681">mcpcheck — audit</text>
  <line x1="0" y1="42" x2="${DEMO_W}" y2="42" stroke="#30363D"/>

  <text x="${LEFT}" y="${CMD_Y}" font-family="${FONT}" font-size="14" fill="#3FB950" xml:space="preserve">${PROMPT}</text>
  <g clip-path="url(#typing)">
    <text x="${LEFT + PROMPT.length * ADV}" y="${CMD_Y}" font-family="${FONT}" font-size="14" fill="#E6EDF3">${esc(COMMAND)}</text>
  </g>
  <rect x="${LEFT + (PROMPT.length + COMMAND.length) * ADV + 3}" y="${CMD_Y - 11}" width="8" height="15" fill="#E6EDF3">
    <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.51;1" dur="1s" repeatCount="indefinite"/>
  </rect>

${body}
</svg>
`
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'banner.svg'), banner('dark'))
fs.writeFileSync(path.join(OUT, 'banner-light.svg'), banner('light'))
fs.writeFileSync(path.join(OUT, 'demo.svg'), demo())

for (const name of ['banner.svg', 'banner-light.svg', 'demo.svg']) {
  const size = fs.statSync(path.join(OUT, name)).size
  console.log(`  ${name.padEnd(18)} ${(size / 1024).toFixed(1)} KB`)
}
