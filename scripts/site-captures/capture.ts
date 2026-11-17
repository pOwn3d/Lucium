// The rules of the captures of scripts/site-captures.mjs that need no machine: the switches Lucium is started with, the guard that keeps the
// real profile out of reach, the window id that `BrowserWindow.getMediaSourceId()` gives, the choice of a window among those macOS lists, the
// arguments of `screencapture` and of ImageMagick, the size written in a PNG, and the JavaScript for Automation the script hands `osascript`.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The reserved top-level domain of the demonstration pages (RFC 2606): no name under it exists on the Internet. */
export const DEMO_TLD = 'example'

/**
 * The address of the public site, whose Community page the shots `community` and `community-voted` show (community.ts): mapped to the local
 * server too, so that the tab shows the real address while the page and its API are the local copy and its stand-in. Never the real service.
 */
export const SITE_HOST = 'lucium.app'

/**
 * Every name under the demonstration domain, and the site's own name, go to the local server, whatever the port the address names:
 * `https://carnet.example/` and `https://lucium.app/communaute/` reach `127.0.0.1:<port>`. Nothing else is mapped, so the application reaches the
 * rest of the network as it always does.
 */
export const hostRules = (port: number): string => `MAP *.${DEMO_TLD} 127.0.0.1:${port}, MAP ${SITE_HOST} 127.0.0.1:${port}`

/**
 * The variables the script gives the application, besides HOME. `LUCIUM_IMPORT_APP_FOLDERS` empty: the import sheet and the first-launch guide
 * read no application's name in /Applications, so every browser keeps its generic label (« Navigateur de macOS ») and no shot shows another
 * browser's name. The built application ignores it (src/main/runtime.ts): the shots of the import are taken with the development build.
 */
export const APP_ENVIRONMENT: Readonly<Record<string, string>> = { LUCIUM_IMPORT_APP_FOLDERS: '' }

export interface LaunchSwitches {
  userDataDir: string
  serverPort: number
  lang: 'fr' | 'en'
  /** Started without Playwright's loader (the packaged application): the DevTools protocol on a port the system chooses. */
  devtools: boolean
}

/**
 * The switches of Chromium Lucium is started with, after the application folder or the executable. The keychain is a stand-in
 * (`--use-mock-keychain`, which Playwright's own loader also adds to the development build): the key that encrypts the cookies of the profile
 * (fuse EnableCookieEncryption of the packaged application) never comes from the macOS keychain, so no « Lucium Safe Storage » prompt can
 * open. The certificate of the local server is the script's own, accepted for this run only. `--lang` makes the system's language, which the
 * setting « automatique » and the texts of the main process follow, the one of the shot.
 */
export function launchSwitches(options: LaunchSwitches): string[] {
  return [
    `--user-data-dir=${options.userDataDir}`,
    '--use-mock-keychain',
    `--host-resolver-rules=${hostRules(options.serverPort)}`,
    '--ignore-certificate-errors',
    `--lang=${options.lang === 'fr' ? 'fr-FR' : 'en-US'}`,
    ...(options.devtools ? ['--remote-debugging-port=0'] : [])
  ]
}

const trimSlashes = (path: string): string => path.replace(/\/+$/, '')

/**
 * Refuses a data folder that is, or is inside, or holds the real profile (`~/Library/Application Support/Lucium`), and
 * one that is not inside the temporary folder of this run. Throws with the reason.
 */
export function assertThrowawayProfile(userDataDir: string, realProfile: string, workDir: string): void {
  const dir = trimSlashes(userDataDir)
  const real = trimSlashes(realProfile)
  const work = trimSlashes(workDir)
  if (dir === '' || real === '' || work === '') throw new Error('dossier de profil vide')
  if (dir === real || dir.startsWith(`${real}/`) || real.startsWith(`${dir}/`)) throw new Error(`refus : ${dir} est le profil réel de Lucium, ou le contient`)
  if (!dir.startsWith(`${work}/`)) throw new Error(`refus : ${dir} n’est pas dans le dossier temporaire de ce passage (${work})`)
}

/** The CGWindowID in `window:<id>:<other>`, the form `BrowserWindow.getMediaSourceId()` gives on macOS; null for anything else. */
export function parseMediaSourceId(id: string): number | null {
  const match = /^window:(\d+):\d+$/.exec(id.trim())
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** The address of the DevTools protocol in a line Chromium writes on its error output, or null. */
export function devToolsEndpoint(line: string): string | null {
  const match = /DevTools listening on (ws:\/\/\S+)/.exec(line)
  return match ? match[1]! : null
}

/** A window as `CGWindowListCopyWindowInfo` describes it (WINDOW_LIST_JXA keeps these fields). */
export interface SystemWindow {
  id: number
  layer: number
  onscreen: boolean
  bounds: Rect
}

/**
 * The window of the list whose place and size are the ones the page reports (`screenX`, `screenY`, `outerWidth`, `outerHeight`: points, the
 * origin at the top left of the main screen, as macOS lists them). Only windows of the normal layer that are on screen, within `tolerance`
 * points on each side; the closest one wins. Null when none is close enough.
 */
export function pickWindow(windows: readonly SystemWindow[], wanted: Rect, tolerance = 3): number | null {
  let best: { id: number; gap: number } | null = null
  for (const window of windows) {
    if (window.layer !== 0 || !window.onscreen) continue
    const gaps = [window.bounds.x - wanted.x, window.bounds.y - wanted.y, window.bounds.width - wanted.width, window.bounds.height - wanted.height].map(Math.abs)
    if (gaps.some((gap) => gap > tolerance)) continue
    const gap = gaps.reduce((sum, value) => sum + value, 0)
    if (best === null || gap < best.gap) best = { id: window.id, gap }
  }
  return best?.id ?? null
}

/** A window of `size` in the middle of `area` (the work area of the screen), in whole points. */
export function centered(area: Rect, size: { width: number; height: number }): Rect {
  return { x: Math.round(area.x + (area.width - size.width) / 2), y: Math.round(area.y + (area.height - size.height) / 2), width: size.width, height: size.height }
}

/** The window fits in the work area of the screen. */
export const fits = (area: Rect, size: { width: number; height: number }): boolean => size.width <= area.width && size.height <= area.height

/**
 * Where to leave the pointer while capturing, so that no row is hovered and no tooltip waits: on the left edge of the screen, half way down, unless a
 * window covers that point (then one point to the left of the leftmost window, or the bottom left corner of the area above the Dock).
 */
export function pointerRestingPlace(area: Rect, windows: readonly Rect[]): { x: number; y: number } {
  const inside = (point: { x: number; y: number }) => windows.some((w) => point.x >= w.x && point.x < w.x + w.width && point.y >= w.y && point.y < w.y + w.height)
  const candidates = [
    { x: area.x + 1, y: Math.round(area.y + area.height / 2) },
    ...windows.map((w) => ({ x: Math.max(area.x, w.x - 2), y: Math.round(w.y + w.height / 2) })),
    { x: area.x + 1, y: area.y + area.height - 2 }
  ]
  return candidates.find((point) => !inside(point)) ?? candidates[candidates.length - 1]!
}

/** `screencapture` of one window, without the shutter sound: with the shadow of macOS (transparent around it), or without (`-o`). */
export function screencaptureArgs(windowId: number, file: string, shadow: boolean): string[] {
  if (!Number.isSafeInteger(windowId) || windowId <= 0) throw new Error(`identifiant de fenêtre invalide : ${windowId}`)
  return ['-x', ...(shadow ? [] : ['-o']), `-l${windowId}`, '-t', 'png', file]
}

/** ImageMagick: a WebP image of at most `width` pixels across (never enlarged), its transparency kept. */
export function webpArgs(input: string, output: string, width: number): string[] {
  return [input, '-resize', `${width}x>`, '-strip', '-quality', '86', '-define', 'webp:method=6', '-define', 'webp:alpha-quality=95', output]
}

/** The width and height written in the header of a PNG file, or null for anything that is not one. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte)) return null
  // The first chunk is IHDR: its length (4 bytes), its type (4 bytes), then the width and the height, big-endian.
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return null
  const read = (at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  return { width: read(16), height: read(20) }
}

/**
 * A PNG of `width` × `height` RGBA pixels (8 bits per channel, no interlace), given the deflate and the CRC-32 to use (node:zlib's in the
 * script): the icon of the demonstration extension, which the application reads with `nativeImage`.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array, deflate: (data: Uint8Array) => Uint8Array, crc32: (data: Uint8Array) => number): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error(`encodePng : ${rgba.length} octets pour ${width}×${height} pixels RGBA`)
  // Each row starts with its filter (0: none).
  const raw = new Uint8Array(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0)
    return out
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 6, 0, 0, 0], 8)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflate(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * Whether a capture without its shadow has the size of the window at the scale of the screen (a pixel of slack: macOS rounds). The capture with the
 * shadow is larger by the shadow, which this does not judge.
 */
export const flatCaptureMatches = (size: { width: number; height: number }, window: { width: number; height: number }, scale: number): boolean =>
  Math.abs(size.width - window.width * scale) <= 1 && Math.abs(size.height - window.height * scale) <= 1

// ---------- JavaScript for Automation (osascript -l JavaScript -e …) ----------

/**
 * Prints `true` when macOS lets the process that runs the script record the screen, `false` otherwise. The preflight never asks the user: it only reads
 * the answer the system already has for the application the script runs in (the terminal).
 */
export const PREFLIGHT_JXA = `ObjC.import('CoreGraphics')
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []])
function run() { return String($.CGPreflightScreenCaptureAccess() === true) }`

/** Prints the windows of the process `argv[0]` as JSON (`SystemWindow`), without their titles. */
export const WINDOW_LIST_JXA = `ObjC.import('CoreGraphics')
function run(argv) {
  const pid = Number(argv[0])
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID))) || []
  return JSON.stringify(list.filter((w) => w.kCGWindowOwnerPID === pid).map((w) => ({
    id: w.kCGWindowNumber,
    layer: w.kCGWindowLayer,
    onscreen: w.kCGWindowIsOnscreen === true || w.kCGWindowIsOnscreen === 1,
    bounds: { x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height }
  })))
}`

/** Prints the screens as AppKit describes them (points, origin at the bottom left of the main screen) with their scale, as JSON. */
export const SCREENS_JXA = `ObjC.import('AppKit')
function run() {
  const screens = $.NSScreen.screens
  const list = []
  for (let i = 0; i < screens.count; i++) {
    const s = screens.objectAtIndex(i)
    const f = s.frame
    const v = s.visibleFrame
    list.push({ frame: { x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height }, visible: { x: v.origin.x, y: v.origin.y, width: v.size.width, height: v.size.height }, scale: s.backingScaleFactor })
  }
  return JSON.stringify(list)
}`

export interface Screen {
  /** The whole screen and the part that the menu bar and the Dock leave, in points from the top left of the main screen (Electron's and CoreGraphics' space). */
  frame: Rect
  workArea: Rect
  /** Pixels per point: 2 on a Retina screen. */
  scale: number
}

/**
 * The screens of SCREENS_JXA in the space of Electron and of CoreGraphics: AppKit counts y upwards from the bottom of the main screen (the first one),
 * the others count it downwards from its top. Throws when the text is not a list of screens.
 */
export function parseScreens(text: string): Screen[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`liste des écrans illisible (${error instanceof Error ? error.message : String(error)}) : ${text.slice(0, 120)}`)
  }
  type Box = { x: number; y: number; width: number; height: number }
  const isBox = (value: unknown): value is Box => typeof value === 'object' && value !== null && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite((value as Record<string, unknown>)[key]))
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((s) => isBox(s?.frame) && isBox(s?.visible) && Number.isFinite(s?.scale))) throw new Error(`liste des écrans inattendue : ${text.slice(0, 120)}`)
  const mainHeight = (raw[0].frame as Box).height
  const flip = (box: Box): Rect => ({ x: box.x, y: mainHeight - (box.y + box.height), width: box.width, height: box.height })
  return raw.map((s) => ({ frame: flip(s.frame), workArea: flip(s.visible), scale: Number(s.scale) }))
}

/**
 * The screen to take the shots on: the first one that is a Retina screen (scale 2 or more) with room for the main window, else, when `allowLowScale`,
 * the first one with room for it. Null when none fits.
 */
export function pickScreen(screens: readonly Screen[], size: { width: number; height: number }, allowLowScale: boolean): Screen | null {
  const roomy = screens.filter((screen) => fits(screen.workArea, size))
  return roomy.find((screen) => screen.scale >= 2) ?? (allowLowScale ? (roomy[0] ?? null) : null)
}

/** Moves the pointer to `argv[0]`, `argv[1]` (points, from the top left of the main screen), without a click. */
export const MOVE_POINTER_JXA = `ObjC.import('CoreGraphics')
function run(argv) { $.CGWarpMouseCursorPosition({ x: Number(argv[0]), y: Number(argv[1]) }); return 'ok' }`

/** Parses what WINDOW_LIST_JXA printed: throws when it is not a list, and leaves out an entry that is malformed. */
export function parseWindowList(text: string): SystemWindow[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`liste des fenêtres illisible (${error instanceof Error ? error.message : String(error)}) : ${text.slice(0, 120)}`)
  }
  if (!Array.isArray(raw)) throw new Error(`liste des fenêtres inattendue : ${text.slice(0, 120)}`)
  const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  return raw.flatMap((entry): SystemWindow[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const w = entry as { id?: unknown; layer?: unknown; onscreen?: unknown; bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } }
    const b = w.bounds
    if (!number(w.id) || !number(w.layer) || !b || !number(b.x) || !number(b.y) || !number(b.width) || !number(b.height)) return []
    return [{ id: w.id, layer: w.layer, onscreen: w.onscreen === true, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } }]
  })
}
