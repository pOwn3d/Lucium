// Run by electron-builder after the Electron application was copied and renamed, before it is signed.
//
// 1. The languages. macOS, and Chromium after it, read the languages an application speaks from the *.lproj folders of its Resources: Electron ships
//    one empty folder per language. A copy of Electron that leaves empty folders out (a local `electronDist`, some archive tools) leaves the application
//    with none, and it then calls itself English: the pages it shows (navigator.language), the extensions (Dashlane in English in a French application)
//    and the system's own menus follow.
// 2. The notices. The licence of Electron and the notices of Chromium are put in the application from the engine it is built on, and the build stops
//    when one of the texts it must carry is not there (scripts/notices/shipped-notices.cjs). Done here, before any signature, so that the signature seals them.
// 3. Electron's own demonstration application. An engine handed over as a folder (`electronDist`) is copied whole, `default_app.asar`
//    with it: the application Electron starts when it is given none. Lucium has its own (app.asar) and never loads that one, so it is
//    taken out before the signature seals it: the package carries no code that is not Lucium's or its engine's.
// 4. The modes of a Linux package. The Electron archive carries 0666 and 0777; they are put back to 0644 and 0755 (scripts/linux-modes.cjs).
const { existsSync, mkdirSync, readdirSync, rmSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { noticesDirs, putElectronNotices, shippedNoticeProblems } = require('./notices/shipped-notices.cjs')
const { normalizeLinuxModes } = require('./linux-modes.cjs')

/** The Electron distribution the build is made on: the one handed to electron-builder (`electronDist`, the castLabs build), else the package's. */
function engineDist(context) {
  const custom = context.packager.config.electronDist
  // A custom engine carries its own notices: the ones of the stock Electron are never put in their place.
  if (typeof custom === 'string' && custom !== '') return resolve(context.packager.projectDir, custom)
  return join(dirname(require.resolve('electron/package.json')), 'dist')
}

exports.default = async function afterPack(context) {
  const product = context.packager.appInfo.productFilename
  const notices = noticesDirs(context.appOutDir, context.electronPlatformName, product)
  const copied = putElectronNotices(engineDist(context), notices.engine)
  if (copied.length > 0) console.log(`after-pack: ${copied.join(', ')} copied from the Electron distribution`)
  const problems = shippedNoticeProblems(notices)
  if (problems.length > 0) throw new Error(`after-pack: the application lacks licence texts it must carry (${context.appOutDir}): ${problems.join('; ')}`)

  // Beside app.asar on every system: the folder of the resources.
  const demo = join(notices.project, 'default_app.asar')
  if (existsSync(demo)) {
    rmSync(demo)
    console.log('after-pack: default_app.asar, the demonstration application of Electron, taken out of the package')
  }

  // The modes of a Linux package (scripts/linux-modes.cjs): the Electron archive carries 0666 and 0777, which the package must not.
  if (context.electronPlatformName === 'linux') {
    const changed = normalizeLinuxModes(context.appOutDir)
    console.log(`after-pack: the modes of ${changed} file(s) and folder(s) set to those of a package (nothing writable by group or others)`)
  }

  if (context.electronPlatformName !== 'darwin') return
  const resources = join(context.appOutDir, `${product}.app`, 'Contents', 'Resources')
  const original = join(dirname(require.resolve('electron/package.json')), 'dist', 'Electron.app', 'Contents', 'Resources')
  const languages = existsSync(original) ? readdirSync(original).filter((name) => name.endsWith('.lproj')) : []
  // Without the original folders, the two languages of the application are enough to tell macOS what it speaks.
  for (const name of languages.length > 0 ? languages : ['fr.lproj', 'en.lproj']) mkdirSync(join(resources, name), { recursive: true })
}
