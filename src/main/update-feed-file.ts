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
// The file this writer makes is the one of macOS, with none of `platform`, `arch` and `kind`, the keys by which the feeds of Windows and Linux say which system they are
// for (shared/update-target.ts): the publication that writes those is not written yet, and a Mac reads this file as it always did.

/** A version both readers compare the same way: digits and dots only (no "v", no suffix). */
export const RELEASE_VERSION = /^\d+(?:\.\d+){0,3}$/

/** The notes the box of the offer shows: a sentence or two. */
export const NOTES_MAX = 300

export interface ReleaseFacts {
  /** The version of the archive's app (its CFBundleShortVersionString). */
  version: string
  /** Where the archive is published: an https folder ending with "/". */
  base: string
  /** The archive's file name (Lucium-<version>-arm64.zip). */
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
}

export interface ReleaseFile {
  currentRelease: string
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

/** What is wrong with the facts, or null: every refusal is said at once, before anything is written. */
export function releaseProblems(facts: ReleaseFacts): string[] {
  const problems: string[] = []
  if (!RELEASE_VERSION.test(facts.version)) problems.push(`the version "${facts.version}" is not digits and dots only: Squirrel and Lucium would compare it differently`)
  const base = httpsUrl(facts.base)
  if (!base || base.search || base.hash || !facts.base.endsWith('/')) problems.push(`the address of the folder must be https and end with "/": ${facts.base}`)
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(facts.fileName)) problems.push(`the archive must be a .zip with a plain name: ${facts.fileName}`)
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
