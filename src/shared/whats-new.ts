// "Quoi de neuf" after an update (N9): the sheet that lists what a version changed. Nothing is fetched: the text is the changelog (CHANGELOG.md, "Keep a
// Changelog" format) that the build puts in the application, and this file reads it. Pure: main/shell/whats-new.ts holds the changelog and decides when to show.

/** One change: the bold title of its line in the changelog, and what follows it, as plain text. */
export interface NewsPoint {
  title: string
  text: string
}

/** What the sheet shows. */
export interface WhatsNewSheet {
  /** The version of the application. */
  version: string
  /** Every change of the version, in the order of the changelog. */
  points: NewsPoint[]
  /** How many of them the sheet lists before "Voir tout". */
  featured: number
  /** Opened by the update itself (the sheet then offers "Ne plus montrer"), not by Aide › Nouveautés. */
  fromUpdate: boolean
}

/** The points the first view of the sheet lists: three to five, per the design (n04). */
export const NEWS_FEATURED = 4
/**
 * The most points a sheet carries, and the longest title and text of one. A line of the changelog is meant to show whole (the longest are
 * about 260 characters); the bound only keeps a paragraph pasted by mistake from making the sheet.
 */
export const NEWS_MAX_POINTS = 60
export const NEWS_TITLE_MAX = 90
export const NEWS_TEXT_MAX = 320

interface Section {
  name: string
  lines: string[]
}

/** The sections of a changelog by heading (`## [0.1.0] - date`, `## [Unreleased]`): the heading's name between the brackets, and the lines under it. */
function sections(changelog: string): Section[] {
  const out: Section[] = []
  for (const line of changelog.split(/\r?\n/)) {
    const heading = /^## \[([^\]]+)\]/.exec(line)
    if (heading) out.push({ name: heading[1]!, lines: [] })
    else out[out.length - 1]?.lines.push(line)
  }
  return out
}

const cut = (text: string, max: number): string => {
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:(]+$/, '')}…`
}

/** A line of the changelog as a point: `**Title** rest` gives the title and the rest; a line with no bold title gives its first sentence. Markdown marks are taken out. */
export function newsPointOf(line: string): NewsPoint | null {
  const body = line.replace(/^\s*[-*]\s+/, '').trim()
  if (body === '') return null
  const plain = (text: string): string => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
  const bold = /^\*\*([^*]+)\*\*\s*(.*)$/.exec(body)
  if (bold) {
    let title = plain(bold[1]!).replace(/[.:]$/, '')
    let rest = bold[2]!
    // A parenthesis right after the title belongs to it: "**Command bar** (⌘T, ⌘L): addresses…" reads "Command bar (⌘T, ⌘L)" then "Addresses…".
    const aside = /^\(([^)]*)\)(.*)$/.exec(rest)
    if (aside) {
      title = `${title} (${plain(aside[1]!)})`
      rest = aside[2]!
    }
    // What joined the text to the title (a colon, a comma, a dash) goes, and the text starts as a sentence, unless it starts with a name
    // that is not a word (`chrome://history`, `.lucium-theme`), which keeps its case.
    const joined = plain(rest).replace(/^[\s,;:–—-]+/, '')
    const text = /^\p{Ll}[\p{L}'’-]*(?=[\s,.;!?]|$)/u.test(joined) ? joined.charAt(0).toLocaleUpperCase() + joined.slice(1) : joined
    return title === '' ? null : { title: cut(title, NEWS_TITLE_MAX), text: cut(text, NEWS_TEXT_MAX) }
  }
  const all = plain(body)
  const sentence = /^(.{12,}?[.:;])(\s|$)/.exec(all)?.[1] ?? all
  return { title: cut(sentence.replace(/[.:;]$/, ''), NEWS_TITLE_MAX), text: sentence.length < all.length ? cut(all.slice(sentence.length).trim(), NEWS_TEXT_MAX) : '' }
}

/**
 * The changes of a version: the section of that version, else `[Unreleased]` (a build ahead of its release notes), else nothing. The lines that start with
 * "- " are the changes; the "###" headings and the text between them are not.
 */
export function newsOf(changelog: string, version: string): NewsPoint[] {
  const all = sections(changelog)
  const section = all.find((one) => one.name === version) ?? all.find((one) => one.name.toLowerCase() === 'unreleased')
  if (!section) return []
  const points: NewsPoint[] = []
  for (const line of section.lines) {
    if (!/^\s*[-*]\s+/.test(line)) continue
    const point = newsPointOf(line)
    if (point) points.push(point)
    if (points.length >= NEWS_MAX_POINTS) break
  }
  return points
}

/** The sheet for a version, from the changelog's text. */
export function whatsNewSheetOf(changelog: string, version: string, fromUpdate: boolean): WhatsNewSheet {
  return { version, points: newsOf(changelog, version), featured: NEWS_FEATURED, fromUpdate }
}

/** The version a state file records: a plain version number (or a pre-release tag) of at most 64 characters, else nothing ('' is "none recorded"). */
export function cleanVersion(raw: unknown): string {
  return typeof raw === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(raw) ? raw : ''
}

/**
 * What a launch does about the news. `last` is the version the previous launch recorded ('' when it recorded none).
 * - `none`: the function is off, or the version is the one already seen. Off means nothing is compared and nothing is written.
 * - `record`: no version was recorded (a state from before this function): there is no "before" to compare to, so the version is noted and no sheet opens.
 * - `show`: the version changed since the last launch.
 */
export function whatsNewDecision(args: { enabled: boolean; last: string; current: string }): 'none' | 'record' | 'show' {
  if (!args.enabled || args.last === args.current) return 'none'
  return args.last === '' ? 'record' : 'show'
}
