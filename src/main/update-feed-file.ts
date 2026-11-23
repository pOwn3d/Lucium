// The release file of the update feed (Squirrel.Mac's `serverType: 'json'`), written by `node scripts/make-update-feed.mjs` from the notarized
// archive. Not part of the application (nothing in it imports this file); the script reads it with Node's own TypeScript, like drm-fuse-trial.ts,
// so it imports nothing but Node's modules.
//
// Two readers, one file: Lucium's check (shared/update-check.ts, `parseFeed`) and Squirrel.Mac, which takes the entry whose `version` is exactly
// `currentRelease`, compares it with the running CFBundleShortVersionString (`NSNumericSearch`), then downloads `updateTo.url` and discards a file
// whose `size` or `sha256` differ. `pub_date` is read as "yyyy-MM-dd'T'HH:mm:ssZZZZZ" (no fraction of a second). `page` is Lucium's own key,
// the page that "Télécharger manuellement" opens; Squirrel ignores it. `en` is Lucium's own too: the page and the notes an interface in
// English shows in place of the French ones (a Lucium that does not know the key keeps the French ones).
//
// The file this writer makes for macOS carries none of `platform`, `arch` and `kind`, the keys by which the feeds of Windows and Linux say which system they are
// for (shared/update-target.ts), and a Mac reads it as it always did. Given a `target`, it writes those three keys, in the bytes the key signs, for the installer of
// Windows (NSIS) or of Linux (AppImage, .deb); the same tables as shared/update-target.ts are kept here by hand (this file imports nothing), and a test keeps them equal.

/** A version both readers compare the same way: digits and dots only (no "v", no suffix). */
export const RELEASE_VERSION = /^\d+(?:\.\d+){0,3}$/

/** The notes the box of the offer shows: a sentence or two. */
export const NOTES_MAX = 300

/** The installers a feed for Windows or Linux may name, by system (`<platform>-<arch>`): shared/update-target.ts, `INSTALLER_KINDS`, without macOS. */
export const TARGET_KINDS: Readonly<Record<string, readonly string[]>> = {
  'win32-x64': ['nsis'],
  'linux-x64': ['appimage', 'deb'],
  'linux-arm64': ['appimage', 'deb']
}

/** The extension of the file each installer is: the one a name that says otherwise is refused for. */
export const KIND_EXTENSIONS: Readonly<Record<string, string>> = { nsis: '.exe', appimage: '.AppImage', deb: '.deb' }

/** How the builds spell an architecture in a file name (`electron-builder.yml`, `artifactName`): a name that spells another one is not the installer of this system. */
export const ARCH_WORDS: Readonly<Record<string, readonly string[]>> = { x64: ['x64', 'amd64'], arm64: ['arm64', 'aarch64'] }

/** The system a feed for Windows or Linux is for, and the installer it names. */
export interface ReleaseTarget {
  platform: string
  arch: string
  kind: string
}

export interface ReleaseFacts {
  /** The version of the archive's app (its CFBundleShortVersionString). */
  version: string
  /** Where the archive is published: an https folder ending with "/". */
  base: string
  /** The archive's file name (Lucium-<version>-arm64.zip), or the installer's when there is a `target`. */
  fileName: string
  /** Its SHA-256, hexadecimal. */
  sha256: string
  /** Its size in bytes. */
  size: number
  /** When it is published. */
  date: Date
  /** The notes, in French. */
  notes: string
  /** The same notes in English, for an interface in English. */
  notesEn?: string
  /** The page "Télécharger manuellement" opens; by default the download page of the site that serves the archive. */
  page?: string
  /** That page in English; by default the English download page of the same site. */
  pageEn?: string
  /** The system the file is for, when it is not the Mac (no `target`: the file of Squirrel.Mac, as it always was). */
  target?: ReleaseTarget
}

export interface ReleaseFile {
  currentRelease: string
  /** Only the file of an installer of Windows or Linux carries these three (see `ReleaseFacts.target`). */
  platform?: string
  arch?: string
  kind?: string
  page: string
  en: { page: string; notes: string }
  releases: Array<{
    version: string
    updateTo: { version: string; name: string; notes: string; pub_date: string; url: string; sha256: string; size: number }
  }>
}

const httpsUrl = (text: string): URL | null => {
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

/** "2026-11-06T09:00:00Z": the format Squirrel parses (`toISOString` adds milliseconds it would not read). */
export const squirrelDate = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * What is wrong with the installer a feed for Windows or Linux names: a system there is a build for (never macOS: its feed carries no target), an installer that
 * system takes, a plain file name that ends with the extension of that installer (an .exe is not an AppImage), carries the version and the architecture of the
 * system. A name that cannot be told from the installer of another system is refused rather than guessed.
 */
export function installerProblems(fileName: string, version: string, target: ReleaseTarget): string[] {
  const kinds = Object.prototype.hasOwnProperty.call(TARGET_KINDS, `${target.platform}-${target.arch}`) ? (TARGET_KINDS[`${target.platform}-${target.arch}`] as readonly string[]) : null
  if (!kinds) return [`no installer is published for ${JSON.stringify(`${target.platform}-${target.arch}`)} (known: ${Object.keys(TARGET_KINDS).join(', ')}): the feed of macOS carries no platform`]
  if (!kinds.includes(target.kind)) return [`${target.platform}-${target.arch} does not take an installer of the kind ${JSON.stringify(target.kind)} (it takes: ${kinds.join(', ')})`]
  const extension = KIND_EXTENSIONS[target.kind] as string
  const problems: string[] = []
  if (!/^[A-Za-z0-9._-]+$/.test(fileName) || !fileName.endsWith(extension)) problems.push(`the installer of the kind ${target.kind} must be a ${extension} with a plain name: ${fileName}`)
  else {
    if (!fileName.includes(`-${version}-`)) problems.push(`the name of the installer does not carry its version ${version}: ${fileName}`)
    const words = ARCH_WORDS[target.arch] ?? []
    if (!words.some((word) => fileName.includes(`-${word}.`) || fileName.includes(`-${word}-`))) problems.push(`the name of the installer does not carry the architecture ${target.arch} (${words.join(' or ')}): ${fileName}`)
  }
  return problems
}

/** What is wrong with the facts, or null: every refusal is said at once, before anything is written. */
export function releaseProblems(facts: ReleaseFacts): string[] {
  const problems: string[] = []
  if (!RELEASE_VERSION.test(facts.version)) problems.push(`the version "${facts.version}" is not digits and dots only: Squirrel and Lucium would compare it differently`)
  const base = httpsUrl(facts.base)
  if (!base || base.search || base.hash || !facts.base.endsWith('/')) problems.push(`the address of the folder must be https and end with "/": ${facts.base}`)
  const target = facts.target
  if (target) problems.push(...installerProblems(facts.fileName, facts.version, target))
  else if (!/^[A-Za-z0-9._-]+\.zip$/.test(facts.fileName)) problems.push(`the archive must be a .zip with a plain name: ${facts.fileName}`)
  else if (!facts.fileName.includes(`-${facts.version}-`)) problems.push(`the name of the archive does not carry its version ${facts.version}: ${facts.fileName}`)
  if (!/^[0-9a-f]{64}$/.test(facts.sha256)) problems.push('the SHA-256 is not 64 hexadecimal digits')
  if (!Number.isSafeInteger(facts.size) || facts.size <= 0) problems.push('the size is not a positive number of bytes')
  if (Number.isNaN(facts.date.getTime())) problems.push('the date is not a date')
  if (facts.page !== undefined && !httpsUrl(facts.page)) problems.push(`the page must be https: ${facts.page}`)
  if (facts.pageEn !== undefined && !httpsUrl(facts.pageEn)) problems.push(`the page in English must be https: ${facts.pageEn}`)
  return problems
}

/**
 * Notes that fit in `max` characters. Longer ones are cut where a reader would stop: after the last whole title of a list of titles
 * ("A ; B ; C"), else after the last whole word, and "…" says that more follows. Never in the middle of a word.
 */
export function shortNotes(notes: string, max: number = NOTES_MAX): string {
  if (notes.length <= max) return notes
  const kept = notes.slice(0, max - 1)
  // The character after the kept part tells whether its last word is whole.
  const wholeWord = /\s/.test(notes[max - 1] ?? '') ? kept.length : kept.search(/\s\S*$/)
  const wholeTitle = Math.max(kept.lastIndexOf(' ; '), kept.lastIndexOf('; '))
  const end = wholeTitle > 0 ? wholeTitle : wholeWord > 0 ? wholeWord : kept.length
  return `${kept.slice(0, end).trimEnd()}…`
}

/** The notes as the file carries them: on one line, short, and never empty. */
const fileNotes = (notes: string, version: string): string => shortNotes(notes.trim().replace(/\s+/g, ' ')) || `Lucium ${version}.`

/** The release file: one release, the current one. Throws the problems of `releaseProblems`. */
export function releaseFile(facts: ReleaseFacts): ReleaseFile {
  const problems = releaseProblems(facts)
  if (problems.length > 0) throw new Error(problems.join('\n'))
  const base = new URL(facts.base)
  return {
    currentRelease: facts.version,
    ...(facts.target ? { platform: facts.target.platform, arch: facts.target.arch, kind: facts.target.kind } : {}),
    page: facts.page ?? new URL('/telecharger/', base.origin).href,
    en: { page: facts.pageEn ?? new URL('/en/download/', base.origin).href, notes: fileNotes(facts.notesEn ?? '', facts.version) },
    releases: [
      {
        version: facts.version,
        updateTo: {
          version: facts.version,
          name: `Lucium ${facts.version}`,
          notes: fileNotes(facts.notes, facts.version),
          pub_date: squirrelDate(facts.date),
          url: new URL(facts.fileName, base).href,
          sha256: facts.sha256,
          size: facts.size
        }
      }
    ]
  }
}

/**
 * Short notes from a changelog (CHANGELOG.fr.md, or CHANGELOG.md for the notes in English): the first paragraph of the section of this
 * version (`## [0.2.1] …`), else the bold titles of its entries joined by `separator` (French puts a space before the semicolon, English
 * does not); empty when the changelog has no such section.
 */
export function notesFromChangelog(changelog: string, version: string, separator: string = ' ; '): string {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start < 0) return ''
  const end = lines.findIndex((line, at) => at > start && line.startsWith('## '))
  const section = lines.slice(start + 1, end < 0 ? undefined : end)
  const paragraph: string[] = []
  for (const line of section) {
    if (line.trim() === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (line.startsWith('#') || line.startsWith('- ')) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(line.trim())
  }
  if (paragraph.length > 0) return paragraph.join(' ')
  const titles = section.map((line) => /^- \*\*(.+?)\*\*/.exec(line)?.[1]).filter((title): title is string => !!title)
  return titles.join(separator)
}
