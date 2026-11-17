// Draws the icons of the context menus (one monochrome icon of 16 pt per entry) and writes src/main/shell/menu-icons-data.ts.
// Electron's nativeImage reads PNG and JPEG, not SVG: the icons are drawn here as SVG (one family, 1.5 stroke on a 24 grid, the table below is the
// source), rendered by a Chromium-based browser in headless mode at 32 px (the @2x of 16 pt) on a transparent page, cut out of one sheet and stored as base64 PNG in a
// TypeScript module, so that nothing is read from the disk when the menu opens and no binary file is kept in the repository.
//
//   node scripts/make-menu-icons.mjs        (needs a Chromium-based browser: /Applications/Google Chrome.app by default, CHROME=/path/to/chrome for another one)
//
// A plain icon is black on transparent: the menu uses it as a template image and macOS draws it in the colour of the text (light, dark, selected).
// An icon of an entry that erases or closes also has a red version, which is not a template (it keeps its colour in every appearance).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CELL = 32
const COLUMNS = 8
const RED = '#e0453a' // readable on the light and on the dark menu: a template cannot be red, so this one is fixed

/** The icons by name: the inside of a 24 x 24 SVG (stroke only). The names are the ones src/main/shell/context-menus.ts asks for. */
const ICONS = {
  copy: '<path d="M9 9h10v10H9z"/><path d="M5 15V5h10"/>',
  share: '<path d="M12 4v11"/><path d="m8 8 4-4 4 4"/><path d="M5 13v6h14v-6"/>',
  icon: '<circle cx="12" cy="12" r="8"/><path d="M9 10h.01M15 10h.01M9 14c1 1.3 5 1.3 6 0"/>',
  rename: '<path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m12 8 4 4"/>',
  mute: '<path d="M4 10v4h3l5 4V6L7 10H4Z"/><path d="m16 9 5 6M21 9l-5 6"/>',
  split: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/>',
  dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>',
  archive: '<rect x="3" y="5" width="18" height="4" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  pin: '<path d="M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6Z"/><path d="M12 14v6"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"/>',
  move: '<path d="M4 7h11l-3-3M20 17H9l3 3"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  sleep: '<path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z"/>',
  freeze: '<path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  aside: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16M18 9l-1 1 1 1"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2 1.5-2h1.5a4 4 0 0 0 4-4 10 10 0 0 0-8.5-10Z"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  export: '<path d="M12 16V4m0 0 4 4m-4-4-4 4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  import: '<path d="M12 4v12m0 0 4-4m-4 4-4-4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  header: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>',
  broom: '<path d="M14 3l7 7-8 8-7-7 8-8Z"/><path d="M6 11 3 20l9-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4V4Z"/>',
  space: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M5 9h2M5 12h2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  mini: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11" y="10" width="8" height="7" rx="1.5"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2"/>',
  // Entries Lucium adds to the usual menus, and the arrows of the split menu.
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  app: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01"/>',
  container: '<path d="m3 8 9-5 9 5v8l-9 5-9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  branch: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v4a4 4 0 0 0 4 4h6"/>',
  save: '<path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z"/><path d="M8 7h8M8 11h6"/>',
  left: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  right: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  up: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  down: '<path d="M12 5v14m-6-6 6 6 6-6"/>',
  stack: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/>',
  sync: '<path d="M4 9a8 8 0 0 1 14-3l2 2M20 15a8 8 0 0 1-14 3l-2-2"/><path d="M20 4v4h-4M4 20v-4h4"/>'
}

/** The icons that also have a red version: the ones an entry that erases, closes or removes wears. */
const WITH_RED = ['trash', 'broom', 'close', 'star']

const svg = (inside, color) =>
  `<svg width="${CELL}" height="${CELL}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inside}</svg>`

/** A page with every icon in a grid of 32 px cells, on a transparent ground. */
const sheet = (names, color) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}body{display:grid;grid-template-columns:repeat(${COLUMNS},${CELL}px)}svg{display:block}</style></head><body>${names.map((name) => svg(ICONS[name], color)).join('')}</body></html>`

// ---- a minimal PNG reader and writer (8-bit RGBA, no interlacing: what Chromium writes) ----
function readPng(buffer) {
  let at = 8
  let width = 0
  let height = 0
  const data = []
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error('expected an 8-bit RGBA PNG without interlacing')
    } else if (type === 'IDAT') data.push(body)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * 4
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]
      if (predictor === undefined) throw new Error(`unknown PNG filter ${filter}`)
      pixels[y * stride + x] = (line[x] + predictor) & 255
    }
  }
  return { width, height, pixels }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const CRC = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (bytes) => {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, body) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, tail])
}
function writePng(width, height, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** Cuts the icons out of a rendered sheet: one 32 x 32 PNG per name, as base64. */
function cut(names, png) {
  const sheetImage = readPng(png)
  const out = {}
  names.forEach((name, index) => {
    const x0 = (index % COLUMNS) * CELL
    const y0 = Math.floor(index / COLUMNS) * CELL
    const pixels = Buffer.alloc(CELL * CELL * 4)
    let inked = 0
    for (let y = 0; y < CELL; y++) {
      sheetImage.pixels.copy(pixels, y * CELL * 4, ((y0 + y) * sheetImage.width + x0) * 4, ((y0 + y) * sheetImage.width + x0 + CELL) * 4)
    }
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) inked++
    // A blank cell would be a menu entry with an invisible icon: stop rather than write it.
    if (inked < 20) throw new Error(`the icon "${name}" came out empty`)
    out[name] = writePng(CELL, CELL, pixels).toString('base64')
  })
  return out
}

function render(names, color, work, label) {
  const page = join(work, `${label}.html`)
  const shot = join(work, `${label}.png`)
  writeFileSync(page, sheet(names, color))
  const rows = Math.ceil(names.length / COLUMNS)
  execFileSync(
    CHROME,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(work, 'profile')}`, '--default-background-color=00000000', '--force-device-scale-factor=1', `--window-size=${COLUMNS * CELL},${rows * CELL}`, `--screenshot=${shot}`, `file://${page}`],
    { stdio: 'ignore' }
  )
  return cut(names, readFileSync(shot))
}

// The temporary folder is left to the system (it is small, and this script never deletes recursively).
const work = mkdtempSync(join(tmpdir(), 'lucium-menu-icons-'))
const names = Object.keys(ICONS)
const plain = render(names, '#000000', work, 'plain')
const red = render(WITH_RED, RED, work, 'red')

const lines = (table) => Object.entries(table).map(([name, base64]) => `  ${/^[a-z]+$/.test(name) ? name : `'${name}'`}: '${base64}'`).join(',\n')
const source = `// The icons of the context menus, as 32 x 32 PNG (the @2x of 16 pt) in base64: black on transparent for the template images, and the red versions of the
// icons an entry that erases or closes wears. GENERATED by scripts/make-menu-icons.mjs (\`node scripts/make-menu-icons.mjs\`) from the table of SVG drawings in that script:
// change the drawings there, not these lines.

export const MENU_ICON_PNG = {
${lines(plain)}
} as const

export const MENU_ICON_RED_PNG = {
${lines(red)}
} as const
`
writeFileSync(join(root, 'src/main/shell/menu-icons-data.ts'), source)
console.log(`${names.length} icons and ${WITH_RED.length} red ones written to src/main/shell/menu-icons-data.ts (${(source.length / 1024).toFixed(1)} KB)`)
