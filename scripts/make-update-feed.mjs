// Writes the release file of the update feed (feed.json, the format of Squirrel.Mac's `serverType: 'json'`) from the notarized archive that
// `scripts/build-drm-release.sh --notarize` makes. It reads the archive and the changelog, prints the file, and publishes nothing.
//
//   node scripts/make-update-feed.mjs dist-drm/Lucium-0.2.1-arm64.zip https://test.lucium.app/updates/darwin-arm64/ > dist-drm/feed.json
//
// Arguments: the archive, then the https folder where it is published (the address of the archive is that folder and the name of the file).
// Options:
//   --notes "…"         the notes the offer shows, in French (by default the first paragraph of the version's section of CHANGELOG.fr.md)
//   --notes-en "…"      the same notes for an interface in English (by default the same paragraph of CHANGELOG.md)
//   --page https://…    the page "Télécharger manuellement" opens (by default the site's /telecharger/ page, on the host of the folder)
//   --page-en https://… that page for an interface in English (by default the site's /en/download/ page)
//   --date 2026-11-06T09:00:00Z   the publication date (by default now)
//
// The version is the CFBundleShortVersionString of the app inside the archive, the one Squirrel compares; it must be the one of package.json
// and of the archive's name. Publish the archive first, then this file (docs/drm.md, « Mise à jour »): a feed that names a missing archive fails
// every installation until the archive arrives.
//
// Exit code: 0 written, 1 the archive cannot be read or the facts are wrong (each problem is said), 2 the arguments are wrong.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { notesFromChangelog, releaseFile } = await import('../src/main/update-feed-file.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage = () => console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))

const positional = []
const options = {}
const args = process.argv.slice(2)
for (let at = 0; at < args.length; at++) {
  const arg = args[at]
  const named = /^--(notes-en|page-en|notes|page|date)(?:=(.*))?$/s.exec(arg)
  if (named) {
    const value = named[2] ?? args[++at]
    if (value === undefined) {
      console.error(`❌ --${named[1]} needs a value`)
      process.exit(2)
    }
    options[named[1]] = value
  } else if (arg === '--help' || arg === '-h') {
    usage()
    process.exit(0)
  } else if (arg.startsWith('--')) {
    console.error(`❌ Unknown option: ${arg}`)
    usage()
    process.exit(2)
  } else positional.push(arg)
}
if (positional.length !== 2) {
  usage()
  process.exit(2)
}
const [archive, base] = positional

/** The CFBundleShortVersionString of the app in the archive, read without unpacking it (unzip -p, then plutil). */
function archiveVersion(path) {
  const listed = spawnSync('/usr/bin/unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (listed.status !== 0) throw new Error(`cannot list ${path}: ${listed.stderr.trim()}`)
  const plist = listed.stdout.split('\n').find((entry) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(entry))
  if (!plist) throw new Error(`${path} has no application at its root (…app/Contents/Info.plist)`)
  const content = spawnSync('/usr/bin/unzip', ['-p', path, plist], { maxBuffer: 16 * 1024 * 1024 })
  if (content.status !== 0) throw new Error(`cannot read ${plist} in ${path}`)
  const version = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', '-'], { input: content.stdout, encoding: 'utf8' })
  if (version.status !== 0) throw new Error(`no CFBundleShortVersionString in ${plist}`)
  return version.stdout.trim()
}

const sha256Of = (path) =>
  new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')))
  })

try {
  const version = archiveVersion(archive)
  const packageVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  if (version !== packageVersion) throw new Error(`the app in the archive is ${version}, package.json says ${packageVersion}: build the archive again, or check out the right version`)
  const notes = options.notes ?? notesFromChangelog(readFileSync(resolve(root, 'CHANGELOG.fr.md'), 'utf8'), version)
  const notesEn = options['notes-en'] ?? notesFromChangelog(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'), version, '; ')
  const date = options.date === undefined ? new Date() : new Date(options.date)
  const file = releaseFile({ version, base, fileName: basename(archive), sha256: await sha256Of(archive), size: statSync(archive).size, date, notes, notesEn, ...(options.page ? { page: options.page } : {}), ...(options['page-en'] ? { pageEn: options['page-en'] } : {}) })
  process.stdout.write(`${JSON.stringify(file, null, 2)}\n`)
  console.error(`✅ Lucium ${version}: ${file.releases[0].updateTo.url} (${file.releases[0].updateTo.size} bytes). Publish the archive first, then this file.`)
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
