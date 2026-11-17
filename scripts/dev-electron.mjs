// Runs `electron-vite <command>` (dev, preview) with a copy of Electron.app that is called "Lucium".
// Without it, the crash dialog of macOS says "Electron a quitté de manière imprévue", and the Dock and the app switcher say Electron.
// The copy lives in .dev-electron/ (ignored by git), is made with copy-on-write clones (no extra disk space), is renamed the way
// electron-packager does it (the application, its executable, and the four helper apps), gets the icon of the application, and is signed
// ad hoc again (a changed bundle invalidates the signature, which Apple silicon refuses). The bundle identifier stays Electron's: the
// permissions macOS remembers for it, and the data folder (named after package.json, not after the bundle), are the same as before.
// Usage: node scripts/dev-electron.mjs <dev|preview|...>. If the copy cannot be made, the plain Electron runs and the reason is printed.
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const NAME = 'Lucium'
/** Bump when this script changes what the copy contains: the copy is made again. */
const RECIPE = 4
const LOCAL_NETWORK_REASON = 'Lucium ouvre les pages des appareils de votre réseau local (domotique, NAS, imprimante, serveur de la maison).'

const dist = join(root, '.dev-electron')
const app = join(dist, `${NAME}.app`)
const executable = join(app, 'Contents/MacOS', NAME)
const stampFile = join(dist, 'stamp.json')
const icon = join(root, 'build/icon.icns')

const PLIST_BUDDY = '/usr/libexec/PlistBuddy'

/** Sets a string of an Info.plist, adding the key when the file does not have it (the helper apps of Electron have no CFBundleExecutable). */
function setKey(plist, key, value) {
  let present = true
  try {
    execFileSync(PLIST_BUDDY, ['-c', `Print :${key}`, plist], { stdio: 'pipe' })
  } catch {
    present = false
  }
  execFileSync(PLIST_BUDDY, ['-c', present ? `Set :${key} ${value}` : `Add :${key} string ${value}`, plist], { stdio: 'pipe' })
}

/** The stamp the copy must carry to be reused. */
function wantedStamp() {
  const electronDist = dirname(require.resolve('electron/package.json'))
  return {
    recipe: RECIPE,
    electron: JSON.parse(readFileSync(join(electronDist, 'package.json'), 'utf8')).version,
    icon: existsSync(icon) ? statSync(icon).mtimeMs : 0
  }
}

/** Renames a bundle whose executable carries the name of the bundle ("Electron Helper.app" holds MacOS/Electron Helper). */
function renameBundle(bundleDir, from, to) {
  const folder = dirname(bundleDir)
  const renamed = join(folder, `${to}.app`)
  renameSync(join(bundleDir, 'Contents/MacOS', from), join(bundleDir, 'Contents/MacOS', to))
  renameSync(bundleDir, renamed)
  const plist = join(renamed, 'Contents/Info.plist')
  setKey(plist, 'CFBundleExecutable', to)
  setKey(plist, 'CFBundleName', to)
  setKey(plist, 'CFBundleDisplayName', to)
}

/** Turns on the cookie encryption fuse of the copy, with the fuses library electron-builder ships (the one scripts/package-drm.mjs reads them with). */
function flipCookieEncryption(bundle) {
  const builder = createRequire(realpathSync(join(root, 'node_modules', 'electron-builder', 'package.json')))
  const fuses = createRequire(builder.resolve('app-builder-lib/package.json')).resolve('@electron/fuses')
  const script = `const f = require(${JSON.stringify(fuses)}); f.flipFuses(${JSON.stringify(bundle)}, { version: f.FuseVersion.V1, [f.FuseV1Options.EnableCookieEncryption]: true }).catch((e) => { console.error(e); process.exit(1) })`
  execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' })
}

function makeCopy(stamp) {
  const source = join(dirname(require.resolve('electron/package.json')), 'dist', 'Electron.app')
  rmSync(dist, { recursive: true, force: true })
  const original = join(dist, 'Electron.app')
  // `cp -c` clones on APFS (instant, shares the data blocks); a plain copy is the fallback on any other volume.
  try {
    execFileSync('mkdir', ['-p', dist])
    execFileSync('cp', ['-cR', source, original], { stdio: 'pipe' })
  } catch (error) {
    console.warn(`[dev-electron] cannot clone Electron.app (${error instanceof Error ? error.message.split('\n')[0] : String(error)}), copying it instead: this takes a while`)
    cpSync(source, original, { recursive: true, verbatimSymlinks: true })
  }
  // The helpers first (Chromium finds them by "<name of the app> Helper"), then the application.
  const frameworks = join(original, 'Contents/Frameworks')
  for (const entry of readdirSync(frameworks)) {
    const match = /^Electron Helper(.*)\.app$/.exec(entry)
    if (match) renameBundle(join(frameworks, entry), `Electron Helper${match[1]}`, `${NAME} Helper${match[1]}`)
  }
  renameBundle(original, 'Electron', NAME)
  if (existsSync(icon)) cpSync(icon, join(app, 'Contents/Resources/electron.icns'))
  // Without this key macOS never offers the application the permission "Réseau local": the pages of the devices of the home fail (electron-builder.yml says the same).
  setKey(join(app, 'Contents/Info.plist'), 'NSLocalNetworkUsageDescription', LOCAL_NETWORK_REASON)
  // The installed builds encrypt the cookies of the shared data folder (fuse EnableCookieEncryption, the castLabs set of docs/drm.md): the copy
  // encrypts them too, or a development session could no longer read the cookies the installed browser wrote. Only this fuse: the others of the
  // set (load from app.asar only) would stop electron-vite, which serves the app unpacked. Before the signature: flipping the fuses changes the binary.
  flipCookieEncryption(app)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' })
  writeFileSync(stampFile, JSON.stringify(stamp))
}

function ensureCopy() {
  const stamp = wantedStamp()
  const current = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : ''
  if (existsSync(executable) && current === JSON.stringify(stamp)) return true
  try {
    makeCopy(stamp)
    return true
  } catch (error) {
    // Nothing is half-made: the plain Electron is used, which works as before but is named Electron in the crash dialog.
    rmSync(dist, { recursive: true, force: true })
    console.warn(`[dev-electron] cannot make the copy named ${NAME}, running the plain Electron: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

const env = { ...process.env }
// electron-vite reads ELECTRON_EXEC_PATH (not the variable of the electron package).
if (process.platform === 'darwin' && !process.env.ELECTRON_EXEC_PATH && ensureCopy()) env.ELECTRON_EXEC_PATH = executable

const args = process.argv.slice(2)
const child = spawn(join(root, 'node_modules/.bin/electron-vite'), args, { stdio: 'inherit', env, cwd: root })
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
