// What a page says of its unread messages in its title, and for how long a tab keeps saying it. Sites write the count in several ways: "(3) Gmail" is the
// common one; others say "Slack | 3 new items" or "3 unread messages". Slack also says it without a number, with a mark in front of the title ("* " for
// unread messages, "! " for a mention or a direct message). Read from the title only, so nothing is asked of the page.
//
// A title is not a state: a page that has a message to tell changes its title again and again (the count, then none, then the count), and a row that follows
// every change blinks. The tab keeps what it last read for `UNREAD_HOLD_MS`, and the badge goes when the title has stayed silent for that long, or at once
// when someone is looking at the tab (`nextUnread`).

const PATTERNS: readonly RegExp[] = [
  /^\((\d{1,5})\)/,
  /\[(\d{1,5})\]/,
  /\b(\d{1,5})\s+(?:unread|new|non[\s-]lus?|nouveaux?|messages?|notifications?)\b/i
]

/** The count of unread items in a page title, or null when the title shows none. */
export function unreadCount(title: string): number | null {
  for (const pattern of PATTERNS) {
    const match = pattern.exec(title)
    if (match?.[1] !== undefined) {
      const count = Number(match[1])
      if (count > 0) return count
    }
  }
  return null
}

/**
 * What a title says is unread: a `count`, or only a `mark` (the sites that say it without a number). `!` is a mention or a direct message, `*` is any
 * unread message.
 */
export interface UnreadReading {
  count?: number
  mark?: '!' | '*'
}

/** The sites whose mark in front of the title means « unread »: a `*` or a `!` in front of a title is nothing of the kind anywhere else (an editor marks a document not saved with a `*`). */
const MARKING_HOSTS: readonly string[] = ['slack.com']

const marksUnread = (url: string): boolean => {
  if (!URL.canParse(url)) return false
  const host = new URL(url).hostname.toLowerCase()
  return MARKING_HOSTS.some((site) => host === site || host.endsWith(`.${site}`))
}

/** What the title of the page at `url` says is unread, or null when it says nothing. A count wins over a mark (a title can have both). */
export function readUnread(title: string, url: string): UnreadReading | null {
  const count = unreadCount(title)
  if (count !== null) return { count }
  const mark = /^([*!])\s/.exec(title.trimStart())?.[1]
  return mark !== undefined && marksUnread(url) ? { mark: mark as '!' | '*' } : null
}

/** How long a tab keeps its unread after a title that said nothing: longer than the pauses of a page that changes its title to catch the eye. */
export const UNREAD_HOLD_MS = 15_000

/** What a tab remembers: the last thing a title said, when it said it, and whether the title has said nothing since (the unread is then only held). */
export interface UnreadMemory {
  reading: UnreadReading
  at: number
  held: boolean
}

/**
 * The memory of a tab after a title. `reading` is what the title said (null: nothing), `attended` that someone is looking at the tab (shown, in the
 * window in front). Answers the new memory (undefined: nothing to show) and, when a silence is being held, in how many ms to look again.
 *
 *  - a count replaces what was there; a mark alone keeps the count a title said before (it still says there is something to read);
 *  - a title that says nothing takes the badge away at once when the tab is attended (the user read it), else the badge is held until `UNREAD_HOLD_MS`
 *    after the last title that said something.
 */
export function nextUnread(previous: UnreadMemory | undefined, reading: UnreadReading | null, now: number, attended: boolean): { memory: UnreadMemory | undefined; recheckInMs: number | null } {
  if (reading !== null) {
    const kept = reading.count === undefined && previous?.reading.count !== undefined ? previous.reading : reading
    return { memory: { reading: kept, at: now, held: false }, recheckInMs: null }
  }
  if (previous === undefined || attended || now - previous.at >= UNREAD_HOLD_MS) return { memory: undefined, recheckInMs: null }
  return { memory: { ...previous, held: true }, recheckInMs: Math.max(0, previous.at + UNREAD_HOLD_MS - now) }
}
