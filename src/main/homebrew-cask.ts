// The Homebrew cask of Lucium: `Casks/lucium.rb` of the project's own tap (`brew install --cask pOwn3d/lucium/lucium`), written by
// `node scripts/make-cask.mjs` once the disk image of a version is published on the stable channel (docs/community/homebrew.md). Not part of the
// application (nothing in it imports this file); the script reads it with Node's own TypeScript, like make-dmg.ts, so it imports nothing and uses
// nothing that type stripping cannot erase (no enum, no parameter property).
//
// What the cask says, and where each fact comes from:
//   - the version and the SHA-256 of the disk image: the sum make-dmg.mjs wrote beside the image (`Lucium-<version>-arm64.dmg.sha256`). The image
//     is hashed here too, and a sum that is not its own is refused: the cask carries the sum, never a hash made some other way;
//   - the address of the image: publish-update.mjs puts it in the folder of the stable channel, beside the archive, under a name that changes only
//     with the version (publish-update.ts `dmgNameOf`, `PUBLIC_CHANNELS.stable`);
//   - livecheck: the feed of the stable channel, whose `currentRelease` is the version installed copies are offered (update-feed-file.ts);
//   - `auto_updates true`: Lucium updates itself through Squirrel.Mac, so `brew upgrade` leaves it alone unless asked with `--greedy`;
//   - Apple silicon only, macOS 13 (Ventura) or later: the LSMinimumSystemVersion of the Electron inside (13.0 in the 0.3.0 app);
//   - `zap` trashes what Lucium, its updater and macOS write for this application alone, never a folder other applications share;
//   - no preflight, postflight or uninstall script, nothing that touches the quarantine mark: the cask copies the application, and Gatekeeper
//     checks the notarized image as it would a download from the site.
//
// The notarization is read from the two records the release leaves, neither of which carries a flag: their presence is the evidence. The build
// record (`Lucium-<version>-arm64.build.json`) is written by scripts/build-drm-release.sh only with `--notarize`, after Apple accepted the app and
// its ticket was stapled; the record of the image (`Lucium-<version>-arm64.dmg.json`) by make-dmg.mjs only after the image itself was notarized,
// stapled and accepted by Gatekeeper as "Notarized Developer ID". Both must describe this very version and image.
//
// The code is either pure (the names, the arguments, the text of the cask, the checks) or takes its effects as `CaskDeps`: the script gives the real
// ones, the tests fake ones.

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The names

/** The token of the cask: `brew install --cask pOwn3d/lucium/lucium`. No cask of homebrew/cask has it (checked on 2026-11-11). */
export const CASK_TOKEN = 'lucium'
/** Where the cask goes in the tap, relative to its root. */
export const CASK_FILE = ['Casks', `${CASK_TOKEN}.rb`] as const
/** The application the image holds and the cask copies to /Applications (make-dmg.ts `APP_FILE`). */
export const APP_FILE = 'Lucium.app'
/** The bundle identifier (electron-builder.yml `appId`): the names macOS and Squirrel.Mac give to the files of this application. */
export const BUNDLE_ID = 'app.lucium.browser'
/** The data folder under ~/Library/Application Support (package.json `productName`). */
export const DATA_FOLDER = 'Lucium'
/** The https folder of the stable channel, where the archive, the disk image and the feed are published (publish-update.ts `PUBLIC_CHANNELS`). */
export const STABLE_FOLDER = 'https://lucium.app/updates/darwin-arm64/'
/** The feed installed copies read on the stable channel. */
export const FEED_URL = `${STABLE_FOLDER}feed.json`
/** The key of the feed that names the version on offer (update-feed-file.ts `ReleaseFile`). */
export const FEED_VERSION_KEY = 'currentRelease'
export const HOMEPAGE = 'https://lucium.app/'
/** What `brew info` and `brew search --desc` show: what the software is, without praise (Homebrew's Description Guidelines). */
export const DESCRIPTION = 'Web browser with a vertical sidebar'
/** The oldest macOS Lucium runs on, as the symbol `depends_on macos:` takes (13). */
export const MIN_MACOS = 'ventura'

/** A release version: three numbers, as the names of the archive and of the image carry it (release-gate.ts). */
const VERSION = /^\d+\.\d+\.\d+$/
const SHA256 = /^[0-9a-f]{64}$/

export const dmgNameOf = (version: string): string => `Lucium-${version}-arm64.dmg`
/** The sum make-dmg.mjs writes beside the image: one line, `<sha256>  <name of the image>`, as `shasum -a 256` prints it. */
export const sumNameOf = (version: string): string => `${dmgNameOf(version)}.sha256`
/** The record of the image (make-dmg.ts `imageRecordNameOf`). */
export const imageRecordNameOf = (version: string): string => `${dmgNameOf(version)}.json`
/** The build record beside the archive (release-gate.ts `buildRecordNameOf`). */
export const buildRecordNameOf = (version: string): string => `Lucium-${version}-arm64.build.json`
export const archiveNameOf = (version: string): string => `Lucium-${version}-arm64.zip`

/** The version an image's name carries, or null when the name is not the one make-dmg.mjs writes. */
export function versionOfImageName(name: string): string | null {
  const found = /^Lucium-(\d+\.\d+\.\d+)-arm64\.dmg$/.exec(name)
  return found ? (found[1] as string) : null
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What `zap` may trash

/**
 * The folders of ~/Library that other applications write into too. A path of `zap` is one entry directly inside one of them, named after
 * Lucium: never one of these folders, never a folder of another application, never something deeper.
 */
export const SHARED_FOLDERS: readonly string[] = [
  '~/Library/Application Support',
  '~/Library/Caches',
  '~/Library/HTTPStorages',
  '~/Library/Preferences',
  '~/Library/Preferences/ByHost',
  '~/Library/Saved Application State'
]

/**
 * What `brew uninstall --zap --cask lucium` moves to the Trash. The first six were seen on the maintainer's Mac for the application (under the
 * identifier it had before the rename: the same files):
 *   - the data folder: the profile, the state, the history, the vault, the extensions (Electron's `userData`, package.json `productName`);
 *   - Squirrel.Mac's own: the cache of its download (`Caches/<id>`, `HTTPStorages/<id>`), the update it prepares (`Caches/<id>.ShipIt`, where
 *     shell/squirrel-staging.ts works) and the preferences ShipIt keeps per Mac (`Preferences/ByHost/<id>.ShipIt.<UUID of the Mac>.plist`);
 *   - the preferences macOS keeps for the application.
 * The seventh is where AppKit saves the state of the windows on macOS 13 to 15 (that Mac, on a later macOS, has no such folder).
 * Not trashed, because Homebrew cannot or must not: the items of the keychain (Electron's "Lucium Safe Storage", the key of the vault), the
 * downloads, and the crash reports macOS keeps in its own shared folders.
 */
export const ZAP_TRASH: readonly string[] = [
  `~/Library/Application Support/${DATA_FOLDER}`,
  `~/Library/Caches/${BUNDLE_ID}`,
  `~/Library/Caches/${BUNDLE_ID}.ShipIt`,
  `~/Library/HTTPStorages/${BUNDLE_ID}`,
  `~/Library/Preferences/${BUNDLE_ID}.plist`,
  `~/Library/Preferences/ByHost/${BUNDLE_ID}.ShipIt.*.plist`,
  `~/Library/Saved Application State/${BUNDLE_ID}.savedState`
]

/** Whether the last part of a path names Lucium: its data folder, or a file or folder of its identifier (`app.lucium.browser`, `.ShipIt`, `.plist` after it). */
const namesLucium = (name: string): boolean => name === DATA_FOLDER || name === BUNDLE_ID || name.startsWith(`${BUNDLE_ID}.`)

/** Why a list of paths may not be the `zap trash:` of the cask, or nothing. */
export function zapProblems(paths: readonly string[]): string[] {
  const problems: string[] = []
  if (paths.length === 0) problems.push('zap trashes nothing: the cask would leave every file of Lucium behind')
  for (const path of paths) {
    const cut = path.lastIndexOf('/')
    const parent = path.slice(0, cut)
    const name = path.slice(cut + 1)
    if (!SHARED_FOLDERS.includes(parent)) problems.push(`${path}: zap trashes only an entry directly inside ${SHARED_FOLDERS.join(', ')}`)
    else if (!namesLucium(name)) problems.push(`${path}: the entry is not named after Lucium (${DATA_FOLDER}, or ${BUNDLE_ID} and what follows it): it may belong to another application`)
    if (/["\\]/.test(path)) problems.push(`${path}: a quote or a backslash has no place in a path of the cask`)
  }
  if (new Set(paths).size !== paths.length) problems.push('zap names a path twice')
  return problems
}

/** The paths in the order `brew style` wants them (rubocop Cask/ArrayAlphabetization: each line, lower-cased). */
export const zapOrder = (paths: readonly string[]): string[] => [...paths].sort((a, b) => (`"${a}",`.toLowerCase() < `"${b}",`.toLowerCase() ? -1 : 1))

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The text of the cask

export interface CaskFacts {
  /** The version of the image, three numbers. */
  version: string
  /** The SHA-256 of the image, as its sum says it. */
  sha256: string
  /** The https folder the image is published in (default: the stable channel). */
  folder?: string
  /** The homepage (default: lucium.app). */
  homepage?: string
  /** The feed livecheck reads (default: the one of the stable channel). */
  feed?: string
  /** What zap trashes (default: ZAP_TRASH). */
  zap?: readonly string[]
}

/** An https address of plain characters (the cask writes it between double quotes): no user, no query, no fragment. Same shape as publish-update.ts. */
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._/-]*$/

/** What is wrong with the facts, every refusal at once; empty when the cask can be written. */
export function caskProblems(facts: CaskFacts): string[] {
  const problems: string[] = []
  if (!VERSION.test(facts.version)) problems.push(`the version "${facts.version}" is not three numbers`)
  if (!SHA256.test(facts.sha256)) problems.push('the SHA-256 is not 64 lowercase hexadecimal digits')
  const folder = facts.folder ?? STABLE_FOLDER
  if (!HTTPS.test(folder) || !folder.endsWith('/')) problems.push(`the folder of the image must be https and end with "/": ${folder}`)
  const homepage = facts.homepage ?? HOMEPAGE
  if (!HTTPS.test(homepage)) problems.push(`the homepage must be https: ${homepage}`)
  const feed = facts.feed ?? FEED_URL
  if (!HTTPS.test(feed)) problems.push(`the feed must be https: ${feed}`)
  problems.push(...zapProblems(facts.zap ?? ZAP_TRASH))
  return problems
}

/** The cask, as `Casks/lucium.rb` holds it. Throws the problems of `caskProblems`. */
export function caskText(facts: CaskFacts): string {
  const problems = caskProblems(facts)
  if (problems.length > 0) throw new Error(problems.join('\n'))
  const folder = facts.folder ?? STABLE_FOLDER
  // The lines stay within 118 characters: the limit `brew style` reads (Layout/LineLength), save for the url and the paths of zap.
  return [
    '# Written by scripts/make-cask.mjs of the Lucium repository, from the published disk image and its sum.',
    '# Do not edit by hand: run the script again (docs/community/homebrew.md in that repository).',
    `cask "${CASK_TOKEN}" do`,
    `  version "${facts.version}"`,
    `  sha256 "${facts.sha256}"`,
    '',
    // Ruby fills #{version} in: the address changes with the version alone, as publish-update.mjs names the image.
    `  url "${folder}${dmgNameOf('#{version}')}"`,
    '  name "Lucium"',
    `  desc "${DESCRIPTION}"`,
    `  homepage "${facts.homepage ?? HOMEPAGE}"`,
    '',
    '  livecheck do',
    `    url "${facts.feed ?? FEED_URL}"`,
    '    strategy :json do |json|',
    `      json["${FEED_VERSION_KEY}"]`,
    '    end',
    '  end',
    '',
    '  auto_updates true',
    '  depends_on arch: :arm64',
    `  depends_on macos: :${MIN_MACOS}`,
    '',
    `  app "${APP_FILE}"`,
    '',
    '  zap trash: [',
    ...zapOrder(facts.zap ?? ZAP_TRASH).map((path) => `    "${path}",`),
    '  ]',
    'end',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The sum and the records

/** The SHA-256 a sum file gives for the image `imageName`, or why it gives none. One line, as `shasum -a 256` prints it (make-dmg.ts `sumLineOf`). */
export function readSum(text: string, imageName: string): { sha256: string } | { problem: string } {
  const found = /^([0-9a-f]{64}) [ *](.+)$/.exec(text.trim())
  if (!found) return { problem: 'it is not one line "<sha256>  <name>", as shasum -a 256 prints it' }
  if (found[2] !== imageName) return { problem: `it names ${JSON.stringify(found[2])}, the image is ${imageName}` }
  return { sha256: found[1] as string }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Why the record of the image (make-dmg.mjs) does not describe the image at hand, or null. */
export function imageRecordProblem(text: string, image: { version: string; name: string; sha256: string; size: number }): string | null {
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch (error) {
    return `it is not JSON (${error instanceof Error ? error.message : String(error)})`
  }
  if (!isRecord(record) || !isRecord(record['image'])) return 'it names no image'
  if (record['version'] !== image.version) return `it is the record of version ${JSON.stringify(record['version'])}, the image is ${image.version}`
  const of = record['image']
  if (of['name'] !== image.name || of['sha256'] !== image.sha256 || of['size'] !== image.size) {
    return `it describes another image (${JSON.stringify(of['name'])}, SHA-256 ${JSON.stringify(of['sha256'])}, ${JSON.stringify(of['size'])} bytes), not the one at hand (${image.sha256}, ${image.size} bytes): the image was made again without its record`
  }
  return null
}

/** The build record as release-gate.ts `readBuildRecord` gives it (only what is read here). */
export interface BuildRecordSeen {
  version: string
  commit: string
  clean: boolean
  archive: { name: string }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The arguments

export interface CaskOptions {
  help: boolean
  /** The checkout of the tap (the repository pOwn3d/homebrew-lucium): the cask goes to its Casks/ folder. */
  tap: string | null
  /** The disk image (default: dist-drm/Lucium-<version of package.json>-arm64.dmg). */
  image: string | null
}

export type ParsedCaskArgs = { ok: true; options: CaskOptions } | { ok: false; message: string }

export function parseCaskArgs(args: readonly string[]): ParsedCaskArgs {
  const options: CaskOptions = { help: false, tap: null, image: null }
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--tap' || arg.startsWith('--tap=')) {
      // The next word is the value, unless it is another option: `--tap --help` must not take the flag for a folder.
      const next = args[at + 1]
      const value = arg.startsWith('--tap=') ? arg.slice('--tap='.length) : next !== undefined && !next.startsWith('-') ? args[++at] : undefined
      if (value === undefined || value === '') return { ok: false, message: '--tap needs the folder of the tap' }
      options.tap = value
    } else if (arg.startsWith('-')) return { ok: false, message: `Unknown option: ${arg}` }
    else if (options.image !== null) return { ok: false, message: `One disk image at a time: ${options.image}, then ${arg}` }
    else options.image = arg
  }
  if (!options.help && options.tap === null) return { ok: false, message: '--tap <folder> is required: the checkout of the tap pOwn3d/homebrew-lucium, where Casks/lucium.rb is written' }
  return { ok: true, options }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// From the files of a release to the cask

export interface CaskInput {
  /** The disk image, an absolute path; its sum and its two records are beside it. */
  image: string
  /** The checkout of the tap, an absolute path. */
  tap: string
}

export interface CaskDeps {
  exists: (path: string) => boolean
  readText: (path: string) => string
  sha256File: (path: string) => Promise<{ sha256: string; size: number }>
  /** release-gate.ts `readBuildRecord`, handed over by the script (Node resolves no import between two TypeScript files). */
  readBuildRecord: (text: string) => { record: BuildRecordSeen } | { problem: string }
  makeDir: (path: string) => void
  writeText: (path: string, text: string) => void
}

export type CaskResult = { ok: true; version: string; sha256: string; size: number; caskFile: string; text: string } | { ok: false; problems: string[] }

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Reads the image, its sum and its two records, checks them, and writes the cask into the tap. Every problem is said at once, and nothing is
 * written when there is one. A file that cannot be read is a problem with its reason, never skipped.
 */
export async function makeCask(input: CaskInput, deps: CaskDeps): Promise<CaskResult> {
  const problems: string[] = []
  const folder = parentOf(input.image)
  const imageName = nameOf(input.image)
  const version = versionOfImageName(imageName)
  if (version === null) return { ok: false, problems: [`${imageName} is not the name make-dmg.mjs gives an image (Lucium-<three numbers>-arm64.dmg)`] }
  const at = (name: string): string => `${folder}/${name}`
  const sumFile = at(sumNameOf(version))
  const recordFile = at(buildRecordNameOf(version))
  const imageRecordFile = at(imageRecordNameOf(version))
  const caskFile = [input.tap, ...CASK_FILE].join('/')

  const read = (path: string, what: string): string | null => {
    if (!deps.exists(path)) {
      problems.push(`${path} is missing: ${what}`)
      return null
    }
    try {
      return deps.readText(path)
    } catch (error) {
      problems.push(`cannot read ${path}: ${messageOf(error)}`)
      return null
    }
  }

  if (!deps.exists(input.tap)) problems.push(`${input.tap} does not exist: clone the tap pOwn3d/homebrew-lucium there first (or make it from packaging/homebrew-tap/)`)

  // The image and its sum: the cask carries the sum, and the sum must be the image's.
  let weighed: { sha256: string; size: number } | null = null
  if (!deps.exists(input.image)) problems.push(`${input.image} is missing: scripts/make-dmg.mjs makes it, and the cask describes the image that is published`)
  else {
    try {
      weighed = await deps.sha256File(input.image)
    } catch (error) {
      problems.push(`cannot read ${input.image}: ${messageOf(error)}`)
    }
  }
  const sumText = read(sumFile, 'scripts/make-dmg.mjs writes it with the image, and the cask takes its SHA-256 from it')
  let sha256: string | null = null
  if (sumText !== null) {
    const sum = readSum(sumText, imageName)
    if ('problem' in sum) problems.push(`${sumFile}: ${sum.problem}`)
    else {
      sha256 = sum.sha256
      if (weighed && weighed.sha256 !== sum.sha256) problems.push(`${sumFile} says ${sum.sha256}, the image has SHA-256 ${weighed.sha256}: the sum is not the image's. Make the image again (scripts/make-dmg.mjs)`)
    }
  }

  // The build: notarized (the record exists only then), of this version, from a clean commit.
  const recordText = read(recordFile, 'scripts/build-drm-release.sh --notarize writes it once Apple has notarized the app; without it nothing says the build was notarized')
  if (recordText !== null) {
    const seen = deps.readBuildRecord(recordText)
    if ('problem' in seen) problems.push(`${recordFile}: ${seen.problem}`)
    else {
      if (seen.record.version !== version) problems.push(`${recordFile} is the record of ${seen.record.version}, the image is ${version}`)
      if (seen.record.archive.name !== archiveNameOf(version)) problems.push(`${recordFile} names the archive ${seen.record.archive.name}, not ${archiveNameOf(version)}`)
      if (!seen.record.clean) problems.push(`${recordFile}: the working tree was modified when ${seen.record.commit.slice(0, 12)} was built; that build is published nowhere, and no cask describes it`)
    }
  }

  // The image: notarized and accepted by Gatekeeper (its record exists only then), and this very image.
  const imageRecordText = read(imageRecordFile, 'scripts/make-dmg.mjs writes it once the image is notarized, stapled and accepted by Gatekeeper')
  if (imageRecordText !== null && weighed) {
    // Compared with the image as it was just hashed: the record must describe the file at hand, whatever its sum says.
    const problem = imageRecordProblem(imageRecordText, { version, name: imageName, sha256: weighed.sha256, size: weighed.size })
    if (problem) problems.push(`${imageRecordFile}: ${problem}`)
  }

  if (problems.length > 0 || sha256 === null || weighed === null) return { ok: false, problems }
  let text: string
  try {
    text = caskText({ version, sha256 })
  } catch (error) {
    return { ok: false, problems: [messageOf(error)] }
  }
  try {
    deps.makeDir(parentOf(caskFile))
    deps.writeText(caskFile, text)
  } catch (error) {
    return { ok: false, problems: [`cannot write ${caskFile}: ${messageOf(error)}`] }
  }
  return { ok: true, version, sha256, size: weighed.size, caskFile, text }
}
