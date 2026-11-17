import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  APP_ENVIRONMENT,
  MOVE_POINTER_JXA,
  PREFLIGHT_JXA,
  WINDOW_LIST_JXA,
  assertThrowawayProfile,
  centered,
  devToolsEndpoint,
  encodePng,
  fits,
  flatCaptureMatches,
  hostRules,
  launchSwitches,
  parseMediaSourceId,
  parseScreens,
  parseWindowList,
  pickScreen,
  pickWindow,
  pngSize,
  pointerRestingPlace,
  screencaptureArgs,
  webpArgs,
  type Screen,
  type SystemWindow
} from './capture'

const REAL = '/Users/someone/Library/Application Support/Lucium'
const WORK = '/private/var/folders/xy/T/lucium-captures-abc'

describe('the switches Lucium is started with', () => {
  const switches = launchSwitches({ userDataDir: `${WORK}/profile-1`, serverPort: 4321, lang: 'en', devtools: false })

  it('give it the throw-away profile, a stand-in keychain and the local server for the demonstration domain only', () => {
    expect(switches).toContain(`--user-data-dir=${WORK}/profile-1`)
    expect(switches).toContain('--use-mock-keychain')
    expect(switches).toContain('--host-resolver-rules=MAP *.example 127.0.0.1:4321, MAP lucium.app 127.0.0.1:4321')
    expect(switches).toContain('--lang=en-US')
    expect(hostRules(80)).toBe('MAP *.example 127.0.0.1:80, MAP lucium.app 127.0.0.1:80')
  })

  it('give it, besides HOME, only the variable that keeps the names of the applications of /Applications out of the import sheet, which the application reads outside the built one', () => {
    expect(APP_ENVIRONMENT).toEqual({ LUCIUM_IMPORT_APP_FOLDERS: '' })
    const runtime = readFileSync(fileURLToPath(new URL('../../src/main/runtime.ts', import.meta.url)), 'utf8')
    for (const name of Object.keys(APP_ENVIRONMENT)) expect(runtime).toContain(`env['${name}']`)
  })

  it('open the DevTools protocol only for the packaged application', () => {
    expect(switches.some((s) => s.startsWith('--remote-debugging-port'))).toBe(false)
    expect(launchSwitches({ userDataDir: `${WORK}/p`, serverPort: 1, lang: 'fr', devtools: true })).toEqual(expect.arrayContaining(['--remote-debugging-port=0', '--lang=fr-FR']))
  })
})

describe('the guard of the real profile', () => {
  it('lets through a folder of the run', () => {
    expect(() => assertThrowawayProfile(`${WORK}/profile-fr-light-demo-1`, REAL, WORK)).not.toThrow()
    expect(() => assertThrowawayProfile(`${WORK}/profile-x/`, `${REAL}/`, `${WORK}/`)).not.toThrow()
  })

  it('refuses the real profile, a folder inside it and a folder that holds it', () => {
    expect(() => assertThrowawayProfile(REAL, REAL, WORK)).toThrow(/profil réel/)
    expect(() => assertThrowawayProfile(`${REAL}/`, REAL, WORK)).toThrow(/profil réel/)
    expect(() => assertThrowawayProfile(`${REAL}/Default`, REAL, WORK)).toThrow(/profil réel/)
    expect(() => assertThrowawayProfile('/Users/someone/Library/Application Support', REAL, WORK)).toThrow(/profil réel/)
  })

  it('refuses a folder outside the folder of the run, and an empty one', () => {
    expect(() => assertThrowawayProfile('/tmp/elsewhere', REAL, WORK)).toThrow(/dossier temporaire/)
    expect(() => assertThrowawayProfile(WORK, REAL, WORK)).toThrow(/dossier temporaire/)
    expect(() => assertThrowawayProfile('', REAL, WORK)).toThrow(/vide/)
  })
})

describe('the window to capture', () => {
  it('is the CGWindowID of the media source id of the window', () => {
    expect(parseMediaSourceId('window:12345:0')).toBe(12345)
    expect(parseMediaSourceId(' window:7:1 ')).toBe(7)
    for (const other of ['screen:1:0', 'window:abc:0', 'window:0:0', 'window:12', '']) expect(parseMediaSourceId(other), other).toBeNull()
  })

  it('is found among the windows of the process by its place and size, on screen and in the normal layer', () => {
    const windows: SystemWindow[] = [
      { id: 10, layer: 0, onscreen: true, bounds: { x: 100, y: 60, width: 1440, height: 900 } },
      { id: 11, layer: 0, onscreen: false, bounds: { x: 100, y: 60, width: 1440, height: 900 } },
      { id: 12, layer: 3, onscreen: true, bounds: { x: 100, y: 60, width: 1440, height: 900 } },
      { id: 13, layer: 0, onscreen: true, bounds: { x: 101, y: 61, width: 1440, height: 900 } },
      { id: 14, layer: 0, onscreen: true, bounds: { x: 500, y: 200, width: 780, height: 760 } }
    ]
    expect(pickWindow(windows, { x: 100, y: 60, width: 1440, height: 900 })).toBe(10)
    expect(pickWindow(windows, { x: 501, y: 199, width: 780, height: 760 })).toBe(14)
    expect(pickWindow(windows, { x: 500, y: 200, width: 900, height: 650 })).toBeNull()
    expect(pickWindow(windows.slice(1, 3), { x: 100, y: 60, width: 1440, height: 900 })).toBeNull()
  })

  it('is read from the list osascript prints, and a list that is not one is an error, not an empty list', () => {
    const text = JSON.stringify([{ id: 5, layer: 0, onscreen: true, bounds: { x: 1, y: 2, width: 3, height: 4 } }, { id: 'x' }, null])
    expect(parseWindowList(text)).toEqual([{ id: 5, layer: 0, onscreen: true, bounds: { x: 1, y: 2, width: 3, height: 4 } }])
    expect(() => parseWindowList('execution error: -1743')).toThrow(/liste des fenêtres illisible/)
    expect(() => parseWindowList('{}')).toThrow(/liste des fenêtres inattendue/)
  })

  it('takes the address of the DevTools protocol from the line Chromium writes', () => {
    expect(devToolsEndpoint('\nDevTools listening on ws://127.0.0.1:52123/devtools/browser/0a-1b\n')).toBe('ws://127.0.0.1:52123/devtools/browser/0a-1b')
    expect(devToolsEndpoint('[123:ERROR] something else')).toBeNull()
  })
})

describe('the screens', () => {
  // A laptop's Retina screen as the main one, with a 1× screen above it (AppKit counts y upwards from the bottom of the main screen).
  const appkit = JSON.stringify([
    { frame: { x: 0, y: 0, width: 1512, height: 982 }, visible: { x: 0, y: 0, width: 1512, height: 945 }, scale: 2 },
    { frame: { x: 0, y: 982, width: 2560, height: 1440 }, visible: { x: 0, y: 982, width: 2560, height: 1415 }, scale: 1 }
  ])

  it('are put in the space of Electron and of CoreGraphics, the origin at the top left of the main screen', () => {
    const [main, above] = parseScreens(appkit)
    expect(main).toEqual({ frame: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 }, scale: 2 })
    expect(above!.frame).toEqual({ x: 0, y: -1440, width: 2560, height: 1440 })
    expect(above!.workArea).toEqual({ x: 0, y: -1415, width: 2560, height: 1415 })
    expect(() => parseScreens('not json')).toThrow(/liste des écrans illisible/)
    expect(() => parseScreens('[]')).toThrow(/liste des écrans inattendue/)
  })

  it('give the shots a Retina screen with room for the main window, or a 1× one only when allowed', () => {
    const screens = parseScreens(appkit)
    const size = { width: 1440, height: 900 }
    expect(pickScreen(screens, size, false)?.scale).toBe(2)
    const wide: Screen[] = [{ frame: { x: 0, y: 0, width: 6720, height: 1890 }, workArea: { x: 0, y: 30, width: 6720, height: 1776 }, scale: 1 }]
    expect(pickScreen(wide, size, false)).toBeNull()
    expect(pickScreen(wide, size, true)?.scale).toBe(1)
    const small: Screen[] = [{ frame: { x: 0, y: 0, width: 1470, height: 956 }, workArea: { x: 0, y: 37, width: 1470, height: 849 }, scale: 2 }]
    expect(pickScreen(small, size, true)).toBeNull()
  })

  it('place a window in the middle of the work area', () => {
    expect(centered({ x: 0, y: 37, width: 1512, height: 945 }, { width: 1440, height: 900 })).toEqual({ x: 36, y: 60, width: 1440, height: 900 })
    expect(fits({ x: 0, y: 0, width: 1440, height: 900 }, { width: 1440, height: 900 })).toBe(true)
    expect(fits({ x: 0, y: 0, width: 1439, height: 900 }, { width: 1440, height: 900 })).toBe(false)
  })

  it('leave the pointer on a point that no window of the shot covers', () => {
    const area = { x: 0, y: 37, width: 1512, height: 945 }
    const window = { x: 36, y: 60, width: 1440, height: 900 }
    const spot = pointerRestingPlace(area, [window])
    expect(spot).toEqual({ x: 1, y: 510 })
    const covering = { x: 0, y: 37, width: 1512, height: 940 }
    const low = pointerRestingPlace(area, [covering])
    expect(low.y).toBeGreaterThanOrEqual(covering.y + covering.height)
  })
})

describe('the tools', () => {
  it('capture one window without the shutter sound, with the shadow or without it', () => {
    expect(screencaptureArgs(42, '/o/a.png', true)).toEqual(['-x', '-l42', '-t', 'png', '/o/a.png'])
    expect(screencaptureArgs(42, '/o/a-no-shadow.png', false)).toEqual(['-x', '-o', '-l42', '-t', 'png', '/o/a-no-shadow.png'])
    expect(() => screencaptureArgs(0, '/o/a.png', true)).toThrow(/identifiant de fenêtre invalide/)
    expect(() => screencaptureArgs(1.5, '/o/a.png', true)).toThrow(/identifiant de fenêtre invalide/)
  })

  it('make a WebP image no wider than the width asked, never enlarged', () => {
    const args = webpArgs('/o/a.png', '/o/web/a-1280.webp', 1280)
    expect(args[0]).toBe('/o/a.png')
    expect(args.at(-1)).toBe('/o/web/a-1280.webp')
    expect(args).toContain('1280x>')
  })

  it('read the size of a PNG from its header, and nothing from another file', () => {
    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    png.set([0, 0, 0x0b, 0x40], 16)
    png.set([0, 0, 0x07, 0x08], 20)
    expect(pngSize(png)).toEqual({ width: 2880, height: 1800 })
    expect(pngSize(new Uint8Array(10))).toBeNull()
    expect(pngSize(new TextEncoder().encode('GIF89a and some more bytes here'))).toBeNull()
  })

  it('judge a capture without shadow by the size of the window at the scale of the screen', () => {
    expect(flatCaptureMatches({ width: 2880, height: 1800 }, { width: 1440, height: 900 }, 2)).toBe(true)
    expect(flatCaptureMatches({ width: 2881, height: 1800 }, { width: 1440, height: 900 }, 2)).toBe(true)
    expect(flatCaptureMatches({ width: 1440, height: 900 }, { width: 1440, height: 900 }, 2)).toBe(false)
  })

  it('only ever ask macOS questions that open nothing: the preflight never requests the permission', () => {
    expect(PREFLIGHT_JXA).toContain('CGPreflightScreenCaptureAccess')
    expect(PREFLIGHT_JXA).not.toContain('CGRequestScreenCaptureAccess')
    expect(WINDOW_LIST_JXA).not.toContain('kCGWindowName')
    expect(MOVE_POINTER_JXA).toContain('CGWarpMouseCursorPosition')
    expect(MOVE_POINTER_JXA).not.toMatch(/CGEventPost|MouseDown|LeftMouse/)
  })
})

describe('the PNG of the icon of the extension', () => {
  it('is a PNG of its size whose pixels read back as given', () => {
    const width = 3
    const height = 2
    const rgba = new Uint8Array(width * height * 4).map((_, i) => (i * 37) % 256)
    const png = encodePng(width, height, rgba, (data) => deflateSync(data), (data) => crc32(data))
    expect(pngSize(png)).toEqual({ width, height })
    // IHDR: 8 bits per channel, RGBA, no interlace; then one IDAT whose rows each start with the filter 0.
    expect([...png.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0])
    const view = new DataView(png.buffer, png.byteOffset)
    const idatLength = view.getUint32(33)
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT')
    const raw = inflateSync(png.subarray(41, 41 + idatLength))
    for (let y = 0; y < height; y++) {
      expect(raw[y * (width * 4 + 1)]).toBe(0)
      expect([...raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))]).toEqual([...rgba.subarray(y * width * 4, (y + 1) * width * 4)])
    }
    // Each chunk ends with the CRC-32 of its type and data.
    expect(view.getUint32(41 + idatLength)).toBe(crc32(png.subarray(37, 41 + idatLength)))
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND')
  })

  it('refuses pixels that are not the size given', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15), deflateSync, crc32)).toThrow(/encodePng/)
  })
})
