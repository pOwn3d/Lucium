import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { ENTITLEMENTS_DRM, ENTITLEMENTS_HELPER, entitlementsFor, grantedEntitlements, isMachO, signingOrder } from './mac-sign-order'
import { tempDir } from './temp-dir'
import { posix } from './windows.test-support'

// The order of the Developer ID signature of scripts/package-drm.mjs, on a throw-away bundle shaped like Lucium's: Mach-O files are recognised by their first bytes.
const THIN_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01])
const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02])
const JAVA = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41])

function put(app: string, path: string, bytes: Buffer | string): void {
  mkdirSync(dirname(join(app, path)), { recursive: true })
  writeFileSync(join(app, path), bytes)
}

function fakeApp(): string {
  const app = join(tempDir('lucium-sign-'), 'Lucium.app')
  const file = (path: string, bytes: Buffer | string) => put(app, path, bytes)
  file('Contents/MacOS/Lucium', THIN_64)
  file('Contents/Info.plist', '<plist/>')
  file('Contents/Resources/app.asar', 'not code')
  file('Contents/Resources/app.asar.unpacked/node_modules/koffi/koffi.node', THIN_64)
  file('Contents/Resources/Some.class', JAVA)
  file('Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', FAT)
  file('Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib', THIN_64)
  file('Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Electron Framework.sig', 'vmp')
  symlinkSync('A', join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/Current'))
  symlinkSync('Versions/Current/Electron Framework', join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'))
  file('Contents/Frameworks/Lucium Helper (Plugin).app/Contents/MacOS/Lucium Helper (Plugin)', THIN_64)
  file('Contents/XPCServices/LuciumKeychain.xpc/Contents/MacOS/lucium-keychain', FAT)
  file('Contents/XPCServices/LuciumKeychain.xpc/Contents/embedded.provisionprofile', 'profile')
  file('Contents/Resources/vault-xpc.node', FAT)
  file('Contents/Helpers/LuciumTranslate.app/Contents/MacOS/lucium-translate', THIN_64)
  return app
}

describe('isMachO', () => {
  it('knows thin and universal Mach-O files, and not a Java class nor a text', () => {
    expect(isMachO(THIN_64)).toBe(true)
    expect(isMachO(FAT)).toBe(true)
    expect(isMachO(Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0]))).toBe(true)
    expect(isMachO(JAVA)).toBe(false)
    expect(isMachO(Buffer.from('#!/bin/sh\n'))).toBe(false)
    expect(isMachO(Buffer.from([0xcf, 0xfa]))).toBe(false)
  })
})

describe('signingOrder', () => {
  it('signs every piece of code, each bundle after what it holds, and the application last', () => {
    const app = fakeApp()
    // The pieces are named below the way a bundle writes them, with `/`.
    const order = signingOrder(app).map((path) => posix(relative(app, path)) || '.')
    expect(order.at(-1)).toBe('.')
    expect(new Set(order)).toEqual(
      new Set([
        'Contents/MacOS/Lucium',
        'Contents/Resources/app.asar.unpacked/node_modules/koffi/koffi.node',
        'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
        'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib',
        'Contents/Frameworks/Electron Framework.framework',
        'Contents/Frameworks/Lucium Helper (Plugin).app/Contents/MacOS/Lucium Helper (Plugin)',
        'Contents/Frameworks/Lucium Helper (Plugin).app',
        'Contents/Resources/vault-xpc.node',
        'Contents/XPCServices/LuciumKeychain.xpc/Contents/MacOS/lucium-keychain',
        'Contents/XPCServices/LuciumKeychain.xpc',
        'Contents/Helpers/LuciumTranslate.app/Contents/MacOS/lucium-translate',
        'Contents/Helpers/LuciumTranslate.app',
        '.'
      ])
    )
    for (const bundle of ['Contents/Frameworks/Electron Framework.framework', 'Contents/Frameworks/Lucium Helper (Plugin).app', 'Contents/XPCServices/LuciumKeychain.xpc']) {
      for (const [index, inner] of order.entries()) if (inner.startsWith(`${bundle}/`)) expect(index, `${inner} before ${bundle}`).toBeLessThan(order.indexOf(bundle))
    }
  })

  it('leaves out, with everything in it, a bundle signed with its own rights: the keychain helper keeps its entitlements and its profile', () => {
    const app = fakeApp()
    const helper = join(app, 'Contents/XPCServices/LuciumKeychain.xpc')
    const order = signingOrder(app, [helper])
    expect(order.filter((path) => path === helper || path.startsWith(`${helper}/`))).toEqual([])
    expect(order).toContain(join(app, 'Contents/MacOS/Lucium'))
    // Its addon is not part of it: the app's identity signs it, like any piece of the app.
    expect(order).toContain(join(app, 'Contents/Resources/vault-xpc.node'))
  })

  it('leaves out both helpers when both are kept: the translation helper is not given the app’s entitlements', () => {
    const app = fakeApp()
    const kept = [join(app, 'Contents/XPCServices/LuciumKeychain.xpc'), join(app, 'Contents/Helpers/LuciumTranslate.app')]
    const order = signingOrder(app, kept)
    expect(order.filter((path) => path.includes('/Contents/Helpers/') || path.includes('/Contents/XPCServices/'))).toEqual([])
    expect(order.at(-1)).toBe(app)
  })

  it('does not follow the links of a framework (Versions/Current names what is already listed)', () => {
    const order = signingOrder(fakeApp())
    expect(order.filter((path) => path.includes('/Versions/Current') || path.endsWith('Electron Framework.framework/Electron Framework'))).toEqual([])
  })
})

// One entitlements file per piece, then the Netflix failure of 8 Nov 2026 (M7702-1003, no CDM process started) on the build that kept library validation in the main process:
// Widevine, signed by its vendor, needs library validation off and the unsigned executable memory in the main process (where the module is registered), the plain
// helper and the plugin helper; the renderer and GPU helpers (the pages, the graphics) keep both restrictions. The app is shaped like the DRM variant's, the plists
// are the real ones.
const KEYS = { jit: 'com.apple.security.cs.allow-jit', memory: 'com.apple.security.cs.allow-unsigned-executable-memory', libraries: 'com.apple.security.cs.disable-library-validation' }
// The six keys of build/entitlements.drm.mac.plist, sorted.
const DRM_KEYS = [KEYS.jit, KEYS.memory, KEYS.libraries, 'com.apple.security.device.camera', 'com.apple.security.device.audio-input', 'com.apple.security.personal-information.location'].sort()
const plistKeys = (relativePath: string): string[] => grantedEntitlements(readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), 'utf8'))

/** The fake bundle with every helper of Electron and the nested code that is not a helper, the way castLabs' build lays them out. */
function fakeDrmApp(): string {
  const app = fakeApp()
  for (const variant of ['', ' (GPU)', ' (Renderer)']) put(app, `Contents/Frameworks/Lucium Helper${variant}.app/Contents/MacOS/Lucium Helper${variant}`, THIN_64)
  put(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler', THIN_64)
  put(app, 'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt', THIN_64)
  put(app, 'Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel', THIN_64)
  return app
}

describe('entitlementsFor', () => {
  // The bundle is made per test (temp-dir removes the folders after each); only its path is shared, and the pieces are read from it when a test needs them.
  let app = ''
  beforeEach(() => {
    app = fakeDrmApp()
  })
  const forPiece = (path: string) => entitlementsFor(app, path ? join(app, path) : app)

  it('gives the application, its executable, the plain helper and the plugin helper, with their executables, the DRM file', () => {
    expect(forPiece('')).toBe(ENTITLEMENTS_DRM)
    expect(forPiece('Contents/MacOS/Lucium')).toBe(ENTITLEMENTS_DRM)
    for (const variant of ['', ' (Plugin)']) {
      expect(forPiece(`Contents/Frameworks/Lucium Helper${variant}.app`)).toBe(ENTITLEMENTS_DRM)
      expect(forPiece(`Contents/Frameworks/Lucium Helper${variant}.app/Contents/MacOS/Lucium Helper${variant}`)).toBe(ENTITLEMENTS_DRM)
    }
  })

  it('gives the renderer and GPU helpers, with their executables, the JIT file', () => {
    for (const variant of [' (GPU)', ' (Renderer)']) {
      expect(forPiece(`Contents/Frameworks/Lucium Helper${variant}.app`)).toBe(ENTITLEMENTS_HELPER)
      expect(forPiece(`Contents/Frameworks/Lucium Helper${variant}.app/Contents/MacOS/Lucium Helper${variant}`)).toBe(ENTITLEMENTS_HELPER)
    }
  })

  it('names the helpers by their suffix, so that the name of the product (Lucium, Lucium DRM, a trial copy) does not matter', () => {
    const named = join(tempDir('lucium-sign-'), 'Lucium essai castlabs-set.app')
    expect(entitlementsFor(named, join(named, 'Contents/Frameworks/Lucium essai castlabs-set Helper (Plugin).app'))).toBe(ENTITLEMENTS_DRM)
    expect(entitlementsFor(named, join(named, 'Contents/Frameworks/Lucium essai castlabs-set Helper.app'))).toBe(ENTITLEMENTS_DRM)
    expect(entitlementsFor(named, join(named, 'Contents/Frameworks/Lucium essai castlabs-set Helper (GPU).app'))).toBe(ENTITLEMENTS_HELPER)
    expect(entitlementsFor(named, join(named, 'Contents/Frameworks/Lucium essai castlabs-set Helper (Renderer).app'))).toBe(ENTITLEMENTS_HELPER)
  })

  it('gives no entitlement to the frameworks, the libraries, the native modules, the crash handler and the updater', () => {
    for (const path of signingOrder(app)) {
      const rel = posix(relative(app, path))
      if (rel === '' || rel.startsWith('Contents/MacOS/') || /Helper( \((GPU|Renderer|Plugin)\))?\.app/.test(rel)) continue
      expect(entitlementsFor(app, path), rel).toBeNull()
    }
    expect(forPiece('Contents/Resources/vault-xpc.node')).toBeNull()
    expect(forPiece('Contents/Resources/app.asar.unpacked/node_modules/koffi/koffi.node')).toBeNull()
    expect(forPiece('Contents/Frameworks/Electron Framework.framework')).toBeNull()
    expect(forPiece('Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler')).toBeNull()
    expect(forPiece('Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt')).toBeNull()
  })

  it('refuses a helper bundle it does not know, instead of giving it the application’s entitlements', () => {
    expect(() => forPiece('Contents/Frameworks/Lucium Helper (Alerts).app')).toThrow(/does not know/)
    expect(() => forPiece('Contents/Frameworks/Lucium Helper (Alerts).app/Contents/MacOS/Lucium Helper (Alerts)')).toThrow(/does not know/)
    expect(() => forPiece('Contents/Frameworks/Something.app')).toThrow(/does not know/)
  })

  it('turns library validation off, with the unsigned executable memory, in the main process, the plain helper and the plugin helper, and keeps it on in the others', () => {
    // The six pieces that host or start Widevine (the app, its executable, the plain and plugin helpers and their executables), and the four of the renderer and GPU helpers.
    const drm = new Set(['.', 'Contents/MacOS/Lucium', ...['', ' (Plugin)'].flatMap((variant) => [`Contents/Frameworks/Lucium Helper${variant}.app`, `Contents/Frameworks/Lucium Helper${variant}.app/Contents/MacOS/Lucium Helper${variant}`])])
    const restricted = (rel: string) => /^Contents\/Frameworks\/Lucium Helper \((GPU|Renderer)\)\.app(\/|$)/.test(rel)
    let seen = 0
    for (const path of signingOrder(app)) {
      const plist = entitlementsFor(app, path)
      const keys = plist ? plistKeys(plist) : []
      const rel = posix(relative(app, path)) || '.'
      if (drm.has(rel)) {
        seen++
        expect([...keys].sort(), rel).toEqual(DRM_KEYS)
      } else if (restricted(rel)) {
        seen++
        // Renderers run the pages and the GPU process the graphics: no Widevine module, so library validation stays on and no memory is writable and executable.
        expect(keys, rel).toEqual([KEYS.jit])
      } else {
        expect(keys, rel).toEqual([])
      }
    }
    expect(seen).toBe(drm.size + 4)
    // The main process is where the CDM is registered: with library validation on there (and off in the plugin helper alone) Netflix answered M7702-1003.
    expect(plistKeys(entitlementsFor(app, app)!)).toContain(KEYS.libraries)
  })

  it('has one DRM file of exactly six keys: the JIT, the unsigned executable memory, library validation off and the three devices of a browser', () => {
    expect(ENTITLEMENTS_DRM).toBe('build/entitlements.drm.mac.plist')
    expect(plistKeys(ENTITLEMENTS_DRM).sort()).toEqual(DRM_KEYS)
    expect(DRM_KEYS).toHaveLength(6)
    // The renderer and GPU file is a different file, with the JIT alone.
    expect(ENTITLEMENTS_HELPER).not.toBe(ENTITLEMENTS_DRM)
    expect(plistKeys(ENTITLEMENTS_HELPER)).toEqual([KEYS.jit])
  })
})

describe('grantedEntitlements', () => {
  it('reads the keys set to true, in a plist or in what codesign prints, and not a key inside a comment or set to false', () => {
    const xml = '<plist><dict><!-- <key>commented</key><true/> --><key>a</key><true/><key>b</key>\n<false/><key>c</key>\n  <true/></dict></plist>'
    expect(grantedEntitlements(xml)).toEqual(['a', 'c'])
    expect(grantedEntitlements('')).toEqual([])
  })
})
