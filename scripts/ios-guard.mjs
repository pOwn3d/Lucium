// Writes the page guard of the iOS application (docs/ios.md, section 6.4): the runtime that runs scriptlets and style sheets in a page before its own
// scripts, and the YouTube and consent-wall rules, all taken from the Mac's own sources so that they are written once.
//
//   node scripts/ios-guard.mjs               writes ios/Lucium/Guard/ (generated, not committed)
//   node scripts/ios-guard.mjs --out DIR     writes elsewhere
//
// A build step (scripts/ios-check.sh runs it, and so does the archive step of the maintainer): the application embeds the two files and downloads
// nothing. Nothing is written unless every file was made: the previous folder stays as it was.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Node reads the TypeScript of the file builder by itself; its notice that the package has no "type" is not news.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON' && warning.name !== 'ExperimentalWarning') console.error(`${warning.name}: ${warning.message}`)
})
const { guardFiles } = await import('./ios-filter-lists/guard-files.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const at = args.indexOf('--out')
const out = resolve(at === -1 ? join(root, 'ios/Lucium/Guard') : args[at + 1])

// The Mac's sources are TypeScript with imports Node does not follow: Vite reads them, as for the application. `guardWorld` is handed to the page
// as text (`Function.prototype.toString`), which is how the Mac hands it to Electron: it is self-contained by design.
const { createServer } = await import('vite')
const server = await createServer({ root, configFile: false, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
let files
try {
  const guard = await server.ssrLoadModule('/src/preload/guard-world.ts')
  const youtube = await server.ssrLoadModule('/src/shared/youtube-rules.ts')
  const blocker = await server.ssrLoadModule('/src/shared/blocker.ts')
  const scriptlets = await server.ssrLoadModule('/src/shared/scriptlets.ts')
  files = guardFiles({
    guardWorldSource: guard.guardWorld.toString(),
    youtube: { domain: youtube.YOUTUBE, scriptlets: youtube.YOUTUBE_SCRIPTLETS, css: youtube.YOUTUBE_COSMETIC_CSS, adPaths: youtube.AD_PATHS },
    consentWallCss: blocker.consentWallCss(),
    parse: scriptlets.parseScriptletCall
  })
} finally {
  await server.close()
}

// Written beside the target and moved into place: a run that stops half-way leaves the previous folder.
mkdirSync(dirname(out), { recursive: true })
const staging = mkdtempSync(`${out}.tmp-`)
try {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(staging, name), content)
  rmSync(out, { recursive: true, force: true })
  renameSync(staging, out)
} catch (error) {
  rmSync(staging, { recursive: true, force: true })
  throw error
}
console.log(`ios-guard: ${Object.keys(files).join(', ')} written in ${out}`)
