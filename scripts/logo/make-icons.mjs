// Builds every icon of Lucium from the ONE drawing of scripts/logo/fan-logo.ts (« les espaces en éventail »), with a Chromium-based browser and
// no window: each picture is the SVG rendered at its own size (never a big picture shrunk), on a transparent background outside the tile.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/logo/make-icons.mjs [--site DIR] [--out DIR]
//   pnpm icons:logo [--site DIR]
//
// Written in the repository:
//   build/icon.icns               the icon of the application (the default version, Clair), every size from 16 to 1024 at 1x and 2x
//   resources/app-icons/<id>.png  the 512 px icon of each choice of Settings › Icône (ids of shared/icons.ts)
//   ios/Lucium/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png  the icon of the iPhone and iPad application: the default version as a full-bleed
//                                 opaque square of 1024 px (App Store Connect refuses transparency and the system rounds the corners itself)
// Written outside it (out-icons/ by default, which Git ignores; `--out` changes it):
//   lucium-<id>.png               the same icons at 1024 px
//   planche.png                   a contact sheet: each version at 256, 64, 32 and 16 px, on a light and on a dark background
//   site/ (or `--site DIR`)       what the website takes: its icons (256 px, the file names of its assets/icons/) and its favicon set (see README.md)
// Needs macOS (iconutil) and Google Chrome (or another browser Playwright knows as the `chrome` channel). No dependency is added: Playwright is the one of the repository.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAN_THEMES, fanLogo } from './fan-logo.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { chromium } = createRequire(join(root, 'package.json'))('@playwright/test')

const APP_ICNS = join(root, 'build/icon.icns')
const APP_ICONS = join(root, 'resources/app-icons')
const IOS_ICON = join(root, 'ios/Lucium/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png')
/** The version the application ships by default (DEFAULT_APP_ICON of shared/icons.ts): the icon of the bundle, the favicons of the site. */
const DEFAULT_ID = 'clair'

const argument = (name, fallback) => {
  const at = process.argv.indexOf(name)
  const value = at > 0 ? process.argv[at + 1] : undefined
  if (at > 0 && (value === undefined || value.startsWith('--'))) throw new Error(`${name} needs a folder`)
  return value === undefined ? fallback : resolve(value)
}
const out = argument('--out', join(root, 'out-icons'))
const siteDir = argument('--site', join(out, 'site'))

const defaultTheme = FAN_THEMES.find((theme) => theme.id === DEFAULT_ID)
if (!defaultTheme) throw new Error(`no theme has the id "${DEFAULT_ID}"`)

/** The sizes of an iconset, as iconutil names them: [file, pixels]. */
/** @type {[string, number][]} */
const ICONSET = [16, 32, 128, 256, 512].flatMap((px) => [
  [`icon_${px}x${px}.png`, px],
  [`icon_${px}x${px}@2x.png`, px * 2]
])

/** A PNG of an SVG at its own size; transparent where the drawing is. The viewport stays large so that no minimum size of a window gets in the way. */
async function renderSvg(page, svg, size) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg}`)
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}

/**
 * The size and the colour type of a PNG (6: RGBA), to refuse a picture that would lose its transparency. A full-bleed square (`opaque`) has no
 * transparent pixel, and the browser then writes it without an alpha channel (colour type 2).
 */
function checkPng(bytes, size, what, opaque = false) {
  const ok = bytes.subarray(1, 4).toString('latin1') === 'PNG' && bytes.readUInt32BE(16) === size && bytes.readUInt32BE(20) === size && bytes[24] === 8 && bytes[25] === (opaque ? 2 : 6)
  if (!ok) throw new Error(`${what} is not an 8-bit ${opaque ? 'RGB' : 'RGBA'} PNG of ${size} x ${size} px`)
  return bytes
}

/** A .ico of PNG pictures (the format since Windows Vista, and what browsers read): the header, one entry per picture, then the pictures. */
function icoOf(pictures) {
  const header = Buffer.alloc(6 + 16 * pictures.length)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pictures.length, 4)
  let offset = header.length
  pictures.forEach(({ size, bytes }, index) => {
    const entry = 6 + 16 * index
    header[entry] = size >= 256 ? 0 : size
    header[entry + 1] = size >= 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4) // planes
    header.writeUInt16LE(32, entry + 6) // bits per pixel
    header.writeUInt32LE(bytes.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += bytes.length
  })
  return Buffer.concat([header, ...pictures.map((picture) => picture.bytes)])
}

/** The contact sheet: each version at 256, 64, 32 and 16 px on a light then a dark background, to judge the small sizes by eye. */
function sheetHtml() {
  const rows = ['#f2f2f5', '#1e1e22'].map((background, row) => {
    const cells = FAN_THEMES.map((theme, index) => {
      const uid = `s${row}-${index}`
      const logo = (size, suffix) => fanLogo(theme, size, `${uid}${suffix}`)
      return `<div class="cell">${logo(256, 'a')}<div class="small">${logo(64, 'b')}${logo(32, 'c')}${logo(16, 'd')}</div></div>`
    }).join('')
    return `<div class="row" style="background:${background}">${cells}</div>`
  })
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}.row{display:flex;gap:20px;padding:10px 20px}.cell{width:256px}svg{display:block}.small{display:flex;gap:12px;align-items:flex-end;margin-top:6px}</style>${rows.join('')}`
}

const work = mkdtempSync(join(tmpdir(), 'lucium-logo-'))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 2400, height: 1200 }, deviceScaleFactor: 1 })
  const png = async (theme, size, options, opaque = false) => checkPng(await renderSvg(page, fanLogo(theme, size, 'x', options), size), size, `${theme.id} at ${size} px`, opaque)

  // The icon of each choice: 512 px for the application (Settings and the Dock), 1024 px kept beside the contact sheet.
  mkdirSync(APP_ICONS, { recursive: true })
  mkdirSync(out, { recursive: true })
  for (const theme of FAN_THEMES) {
    writeFileSync(join(APP_ICONS, `${theme.id}.png`), await png(theme, 512))
    writeFileSync(join(out, `lucium-${theme.id}.png`), await png(theme, 1024))
  }

  // The .icns of the application: every size once, as the iconset names them at 1x and 2x.
  const iconset = join(work, 'lucium.iconset')
  mkdirSync(iconset)
  const sizes = new Map()
  for (const [file, px] of ICONSET) {
    if (!sizes.has(px)) sizes.set(px, await png(defaultTheme, px))
    writeFileSync(join(iconset, file), sizes.get(px))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', APP_ICNS])

  // The iOS application: one full-bleed square with no alpha channel (colour type 2), no shadow and no rounded corner, which the system masks itself.
  writeFileSync(IOS_ICON, await png(defaultTheme, 1024, { view: 'tile', shadow: false, corner: 0 }, true))

  // The website: the icons at 256 px under their ids, the names of its assets/icons/, then the favicon set from the default version (the tile fills the picture, no shadow).
  mkdirSync(siteDir, { recursive: true })
  for (const theme of FAN_THEMES) writeFileSync(join(siteDir, `${theme.id}.png`), await png(theme, 256))
  const tile = /** @type {const} */ ({ view: 'tile', shadow: false })
  const favicons = new Map()
  for (const px of [16, 32, 48, 192, 512]) {
    favicons.set(px, await png(defaultTheme, px, tile))
    writeFileSync(join(siteDir, `favicon-${px}.png`), favicons.get(px))
  }
  writeFileSync(join(siteDir, 'favicon.ico'), icoOf([16, 32, 48].map((size) => ({ size, bytes: favicons.get(size) }))))
  writeFileSync(join(siteDir, 'favicon.svg'), `${fanLogo(defaultTheme, 64, 'f', tile)}\n`)
  // The icon of the home screen of a phone: a full-bleed square, the system rounds it itself.
  writeFileSync(join(siteDir, 'apple-touch-icon.png'), await png(defaultTheme, 180, { view: 'tile', shadow: false, corner: 0 }, true))

  // The sheet is as wide as its rows (a cell is 256 px, the gap 20, the padding 20 on each side) and as high as its content.
  const sheetWidth = FAN_THEMES.length * 276 + 20
  await page.setViewportSize({ width: sheetWidth, height: 100 })
  await page.setContent(sheetHtml())
  const sheetHeight = await page.evaluate(() => document.documentElement.scrollHeight)
  await page.setViewportSize({ width: sheetWidth, height: sheetHeight })
  await page.screenshot({ path: join(out, 'planche.png'), clip: { x: 0, y: 0, width: sheetWidth, height: sheetHeight } })

  console.log(`make-icons: build/icon.icns, the icon of the iOS application and resources/app-icons/ (${FAN_THEMES.length} versions) written; the 1024 px versions and planche.png are in ${out}, the site's files in ${siteDir}`)
} finally {
  await browser.close()
  rmSync(work, { recursive: true, force: true })
}
