// The licence texts and notices a built Lucium must carry, and the two that come from the engine.
//
// Electron (MIT) and Chromium (BSD and many others, LICENSES.chromium.html) ask that their notices travel with every copy of the binary. An Electron
// distribution ships them beside the binary: `LICENSE` and `LICENSES.chromium.html`. electron-builder moves them into the application when it unzips
// Electron itself, but when it is handed an unzipped engine (`electronDist`, the castLabs build of the DRM variant) it copies `Electron.app` alone:
// the two files stayed behind, and the build that was handed out had neither. They are put here, from the engine the build is made on, and a build
// without them stops.
//
// CommonJS: electron-builder loads scripts/after-pack.cjs with require(); scripts/package-drm.mjs loads it as well.
const { copyFileSync, existsSync, mkdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

/** The notices of the engine: the name in the Electron distribution, the name in the application, and a size under which the file is not the real one. */
const ELECTRON_NOTICES = [
  { source: 'LICENSE', shipped: 'LICENSE.electron.txt', minBytes: 500 },
  { source: 'LICENSES.chromium.html', shipped: 'LICENSES.chromium.html', minBytes: 1_000_000 }
]

/**
 * What electron-builder.yml copies (extraResources): the licence of Lucium, its notice, the additional permission for the Widevine module (GPL
 * section 7: a permission travels with the copies it covers) and the generated notices of the npm packages.
 */
const PROJECT_NOTICES = [
  { shipped: 'LICENSE', minBytes: 30_000 },
  { shipped: 'NOTICE', minBytes: 200 },
  { shipped: 'ADDITIONAL-PERMISSION.txt', minBytes: 1_500 },
  { shipped: 'THIRD-PARTY-NOTICES.txt', minBytes: 10_000 }
]

/**
 * Where the notices are in a build. On macOS, all in the resources of the bundle (the only thing handed out). Elsewhere the notices of the engine stay
 * beside the executable, where Electron's archive has them, and electron-builder copies the project's (extraResources) into `resources`.
 */
function noticesDirs(appOutDir, platform, productFilename) {
  if (platform === 'darwin') {
    const resources = join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    return { engine: resources, project: resources }
  }
  return { engine: appOutDir, project: join(appOutDir, 'resources') }
}

/** Why a file is not a notice one can ship (missing, or too small to be the text), or null. */
function fileProblem(path, minBytes) {
  if (!existsSync(path)) return 'missing'
  const size = statSync(path).size
  return size < minBytes ? `${size} bytes, less than the ${minBytes} the real text has` : null
}

/** The notices of the engine an Electron distribution lacks: checked before a build is started on it. */
function engineNoticeProblems(dist) {
  return ELECTRON_NOTICES.flatMap(({ source, minBytes }) => {
    const problem = fileProblem(join(dist, source), minBytes)
    return problem ? [`${source}: ${problem}`] : []
  })
}

/** The notices a built application lacks, the engine's and the project's, each looked for in its folder. Empty when it can be handed out. */
function shippedNoticeProblems({ engine, project }) {
  const lacking = (dir, notices) =>
    notices.flatMap(({ shipped, minBytes }) => {
      const problem = fileProblem(join(dir, shipped), minBytes)
      return problem ? [`${shipped}: ${problem}`] : []
    })
  return [...lacking(engine, ELECTRON_NOTICES), ...lacking(project, PROJECT_NOTICES)]
}

/**
 * Puts the two notices of the engine in `dir`, from the Electron distribution `dist`, unless the build already has them (electron-builder moved them).
 * Throws when the distribution does not have one: a build without the notices of what it redistributes is not made.
 * Returns the names it copied.
 */
function putElectronNotices(dist, dir) {
  const copied = []
  for (const { source, shipped, minBytes } of ELECTRON_NOTICES) {
    if (fileProblem(join(dir, shipped), minBytes) === null) continue
    const problem = fileProblem(join(dist, source), minBytes)
    if (problem) throw new Error(`the Electron distribution ${dist} has no usable ${source} (${problem}): the application cannot be shipped without the notices of its engine`)
    mkdirSync(dir, { recursive: true })
    copyFileSync(join(dist, source), join(dir, shipped))
    copied.push(shipped)
  }
  return copied
}

module.exports = { ELECTRON_NOTICES, PROJECT_NOTICES, engineNoticeProblems, noticesDirs, putElectronNotices, shippedNoticeProblems }
