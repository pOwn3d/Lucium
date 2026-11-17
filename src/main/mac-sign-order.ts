// The pure part of the Developer ID signature of `scripts/package-drm.mjs`: which pieces of code of a macOS application are signed, and in which order.
// Not part of the application (nothing in it imports this file); the script reads it with Node's own TypeScript, like electron-watch.ts.
//
// Why not `codesign --deep`: it signs every nested bundle again with the entitlements of the application. The keychain helper of the password vault
// (Contents/XPCServices/LuciumKeychain.xpc, native/vault-keychain/build.sh) has entitlements of its own, authorized by its provisioning profile, which
// --deep would replace: Touch ID would then be refused. The helper of the system's translation (Contents/Helpers/LuciumTranslate.app,
// native/system-translate/build.sh) is signed with no entitlement at all, and must not get the app's either. So each piece is signed on its own, the
// deepest first (a bundle seals the signatures of the code it holds, so they must exist before it is signed), the application last, and what is
// already signed with its own rights is left out.
// The same order as @electron/osx-sign 1.3.3 (the signer of electron-builder): files that are Mach-O, then .app and .framework bundles, by depth.
//
// Which entitlements each piece gets (`entitlementsFor`): the same split as Chromium's own signing and the defaults of @electron/osx-sign, and not one file
// for every piece. The unsigned executable memory and the loading of libraries signed by another team are only for the helper that hosts the Widevine
// module; the main process, which loads our own native modules, keeps library validation on (docs/drm.md section 8).

import { closeSync, openSync, readdirSync, readSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** The bundles that carry a signature of their own. */
const BUNDLE = /\.(app|framework|appex|xpc)$/

/**
 * Whether the file starts like a Mach-O program or library: thin (32 or 64 bits, either byte order) or universal. The universal magic is also Java's: a
 * universal file has a handful of architectures where a class file has its version (45 and more) in the same place.
 */
export function isMachO(head: Buffer): boolean {
  if (head.length < 8) return false
  const magic = head.readUInt32BE(0)
  if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe) return true
  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    const count = magic === 0xcafebabe ? head.readUInt32BE(4) : head.readUInt32LE(4)
    return count > 0 && count < 20
  }
  return false
}

function readHead(path: string): Buffer {
  const head = Buffer.alloc(8)
  const fd = openSync(path, 'r')
  try {
    return head.subarray(0, readSync(fd, head, 0, 8, 0))
  } finally {
    closeSync(fd)
  }
}

/**
 * The pieces of `app` to sign, in order: every Mach-O file and every nested bundle under Contents/, deepest first, then the application itself.
 * Links are not followed (a framework's `Versions/Current` and its top-level links name what is already listed). `keep` are the paths of bundles that
 * are already signed with their own rights: neither they nor anything in them is signed again (codesign checks them when it seals the application).
 */
export function signingOrder(app: string, keep: readonly string[] = []): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (keep.includes(path) || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(path)
        if (BUNDLE.test(entry.name)) found.push(path)
      } else if (entry.isFile() && isMachO(readHead(path))) found.push(path)
    }
  }
  walk(join(app, 'Contents'))
  const depth = (path: string): number => path.split(sep).length
  return [...found.sort((a, b) => depth(b) - depth(a) || a.localeCompare(b)), app]
}

/** The plists of the entitlements, relative to the root of the repository. */
export const ENTITLEMENTS_APP = 'build/entitlements.mac.plist'
export const ENTITLEMENTS_HELPER = 'build/entitlements.drm.helper.mac.plist'
export const ENTITLEMENTS_DRM = 'build/entitlements.drm.mac.plist'

/**
 * The plist of entitlements `piece` (a path returned by `signingOrder`) is signed with, or null for none:
 * - the application and its executable, the plain helper (utility processes: network, audio, Node) and the plugin helper: `ENTITLEMENTS_DRM`, the
 *   keys of `ENTITLEMENTS_APP` plus library validation off and the unsigned executable memory, which Widevine needs (with them on the plugin helper alone,
 *   Netflix refused to play on 8 Nov 2026: the module is registered by the main process);
 * - the renderer and GPU helpers: `ENTITLEMENTS_HELPER` (the JIT only): they keep library validation;
 * - everything else (frameworks, libraries, the native modules, the crash handler, the updater): none. Entitlements are not read from a library, and the
 *   executables among them have no use for any.
 * A helper bundle with a name this does not know throws: a new Electron helper must be given its entitlements on purpose, not the app's by default.
 */
export function entitlementsFor(app: string, piece: string): string | null {
  const parts = relative(app, piece).split(sep)
  if (parts[0] === '') return ENTITLEMENTS_DRM
  if (parts[0] !== 'Contents') return null
  if (parts[1] === 'MacOS') return ENTITLEMENTS_DRM
  if (parts[1] !== 'Frameworks' || !parts[2]?.endsWith('.app')) return null
  const variant = /^.+ Helper(?: \((GPU|Renderer|Plugin)\))?\.app$/.exec(parts[2])
  if (!variant) throw new Error(`${parts[2]} is a helper bundle this signer does not know: decide its entitlements in entitlementsFor (src/main/mac-sign-order.ts)`)
  return variant[1] === 'GPU' || variant[1] === 'Renderer' ? ENTITLEMENTS_HELPER : ENTITLEMENTS_DRM
}

/** The entitlements a plist, or the XML `codesign -d --entitlements - --xml` prints, grants (`<key>…</key><true/>`); XML comments are not read. */
export function grantedEntitlements(xml: string): string[] {
  return [...xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((match) => match[1]!)
}
