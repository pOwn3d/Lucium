// Writes the Homebrew cask of Lucium, Casks/lucium.rb, into the checkout of the tap pOwn3d/homebrew-lucium, from the disk image of a version
// published on the stable channel (docs/community/homebrew.md). It reads local files only: it downloads nothing, publishes nothing, commits nothing.
//
//   node scripts/make-cask.mjs --tap ../homebrew-lucium                                 the image of package.json's version, in dist-drm/
//   node scripts/make-cask.mjs --tap ../homebrew-lucium dist-drm/Lucium-1.0.0-arm64.dmg  that image
//
// Run it once the image is published on lucium.app (node scripts/publish-update.mjs --channel stable): the cask points at
// https://lucium.app/updates/darwin-arm64/Lucium-<version>-arm64.dmg, and a cask committed before the image is there fails every installation.
//
// It reads, beside the image, and refuses to write anything (each problem is said) when one of them is missing or wrong:
//   - Lucium-<version>-arm64.dmg.sha256, the sum scripts/make-dmg.mjs wrote: one line that names the image. The cask takes its SHA-256 from it;
//     the image is hashed here too, and a sum that is not the image's is refused;
//   - Lucium-<version>-arm64.build.json, the build record: scripts/build-drm-release.sh writes it only with --notarize, once Apple accepted the
//     app. It must be the record of this version and of its archive, built from a clean commit;
//   - Lucium-<version>-arm64.dmg.json, the record of the image: make-dmg.mjs writes it only once the image is notarized, stapled and accepted by
//     Gatekeeper. It must describe this very image (its version, name, SHA-256 and size).
// The version is the one the image's name carries. Then it writes <tap>/Casks/lucium.rb (the folder Casks/ is made when the tap has none).
//
// After it: in the tap, `brew style --cask Casks/lucium.rb`, commit, push; then `brew install --cask pOwn3d/lucium/lucium` on a Mac, as a trial.
//
// Options:
//   --tap <folder>   the checkout of the tap (required)
// Exit code: 0 written, 1 a file is missing or wrong (nothing written), 2 the arguments are wrong.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { CASK_FILE, dmgNameOf, makeCask, parseCaskArgs } = await import('../src/main/homebrew-cask.ts')
// The reader of the build record, handed over: Node resolves no import between two TypeScript files.
const { readBuildRecord } = await import('../src/main/release-gate.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage = () => console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))

const parsed = parseCaskArgs(process.argv.slice(2))
if (!parsed.ok) {
  console.error(`Error: ${parsed.message}`)
  usage()
  process.exit(2)
}
if (parsed.options.help) {
  usage()
  process.exit(0)
}
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const image = parsed.options.image === null ? resolve(root, 'dist-drm', dmgNameOf(version)) : resolve(process.cwd(), parsed.options.image)
const tap = resolve(process.cwd(), /** @type {string} */ (parsed.options.tap))

/** @type {(path: string) => Promise<{ sha256: string; size: number }>} */
const sha256File = (path) =>
  new Promise((done, fail) => {
    const hash = createHash('sha256')
    let size = 0
    createReadStream(path)
      .on('data', (chunk) => {
        hash.update(chunk)
        size += chunk.length
      })
      .on('error', fail)
      .on('end', () => done({ sha256: hash.digest('hex'), size }))
  })

const result = await makeCask(
  { image, tap },
  {
    exists: existsSync,
    readText: (path) => readFileSync(path, 'utf8'),
    sha256File,
    readBuildRecord,
    makeDir: (path) => mkdirSync(path, { recursive: true }),
    writeText: (path, text) => writeFileSync(path, text)
  }
)
if (!result.ok) {
  console.error(`❌ Nothing written:\n  ${result.problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`✅ ${result.caskFile}: Lucium ${result.version}`)
console.log(`   SHA-256 ${result.sha256}, read from ${dmgNameOf(result.version)}.sha256; the image hashed here (${result.size} bytes) has the same.`)
console.log(`   Next, in the tap: brew style --cask ${CASK_FILE.join('/')}, commit, push; then brew install --cask pOwn3d/lucium/lucium, as a trial.`)
