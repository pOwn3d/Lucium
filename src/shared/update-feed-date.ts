// The anti-replay rule of the update feed: a copy never goes back to an older feed than the last one it accepted for the same address.
//
// The feed is signed (main/update-feed-signature.ts), and a signed file stays valid for ever: an attacker who controls the network or the server can serve
// an OLD feed again, with a good signature. It offers an older version than the current one (the check already offers only a version above the running one),
// but it also lacks the withdrawals written since (`withdrawn`), and a version above the running one that was withdrawn meanwhile would be offered again. The date of
// publication (`pub_date` of the entry of `currentRelease`, inside the signed bytes) says which feed is the more recent: a copy keeps the latest one it
// accepted for each address, and refuses a feed that is older. Equal is accepted (the same file read again, or two publications in the same second).
//
// Three properties are kept on purpose:
// - the clock of the machine is never read. Only two dates of the signed feeds are compared, so a clock that is fast or slow changes nothing: it can neither
//   refuse a good feed nor accept an old one;
// - nothing is asked of the network and nothing leaves the machine: the memory is a date per address, kept by the main process in its own small file
//   (main/update-feed-memory.ts), outside the profile's state, and never given to a page;
// - the memory is kept per address of feed (`feedMemoryKey`), so that the test channel and the stable one, each with its own address, never meet.
//
// What it does not do: the version offered is not compared with the one of the last feed (a rollback is a lower version under a later date, which the
// withdrawal writes: main/publish-update.ts, `feedWithWithdrawn`). And a date that is wrongly far ahead in a signed feed would hold every later feed back: the
// publication is where it is refused (`futureProblem`, which knows the clock of the maintainer's machine), not the copy, which never reads its clock.

import { t } from './i18n'
import type { FeedAnswer } from './update-check'
import { readFeedIdentity, type FeedTarget } from './update-target'

/** The date of publication as the feed writes it, the format Squirrel parses (update-feed-file.ts, `squirrelDate`): "2026-11-06T09:00:00Z", or with an offset. */
const PUB_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/

/** The most addresses the memory holds: the oldest one is forgotten past that (a feed address given by hand could otherwise grow the file). */
export const FEED_MEMORY_MAX = 32

/** The last date accepted per address of feed, in milliseconds since the epoch. */
export type FeedDates = Readonly<Record<string, number>>

/** What the entry of `currentRelease` says of its date: none, one that is not a date, or the instant. */
export type FeedDate = { kind: 'none' } | { kind: 'invalid' } | { kind: 'date'; at: number }

/** The instant of a `pub_date`, or null when the text is not a real date in that format (no month 13, no 31 February, no 24 o'clock). */
export function parsePubDate(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const parts = PUB_DATE.exec(text)
  if (!parts) return null
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number]
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null
  // Date.parse rolls 31 February over to March: the day is checked against the month first.
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : null
}

/** The `pub_date` of the release the feed names (`currentRelease`), read the way `parseFeed` finds that release. */
export function readFeedDate(feed: Record<string, unknown>): FeedDate {
  const releases = feed['releases']
  if (!Array.isArray(releases)) return { kind: 'none' }
  const entry = releases.find((release): release is Record<string, unknown> => typeof release === 'object' && release !== null && (release as Record<string, unknown>)['version'] === feed['currentRelease'])
  const updateTo = entry?.['updateTo']
  if (typeof updateTo !== 'object' || updateTo === null) return { kind: 'none' }
  const written = (updateTo as Record<string, unknown>)['pub_date']
  if (written === undefined) return { kind: 'none' }
  const at = parsePubDate(written)
  return at === null ? { kind: 'invalid' } : { kind: 'date', at }
}

/**
 * The key of an address in the memory: its origin and path, in lower case where the standard says so. The query and the fragment are left out
 * (an address given by hand may carry a token that has no place in a file), and so is any user name.
 */
export function feedMemoryKey(address: string): string {
  if (!URL.canParse(address.trim())) return ''
  const url = new URL(address.trim())
  return `${url.origin}${url.pathname}`
}

/** The memory as a file may hold it: only addresses with a date that is a plain positive integer, at most FEED_MEMORY_MAX of them; anything else is forgotten. */
export function cleanFeedDates(raw: unknown): FeedDates {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const kept: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(kept).length >= FEED_MEMORY_MAX) break
    if (key !== '' && key.length <= 600 && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) kept[key] = value
  }
  return kept
}

/** What the rule decided: the answer the rest of the check reads, the memory to keep, and — when the feed was refused — what to write to the log. */
export interface FeedFreshness {
  answer: FeedAnswer
  memory: FeedDates
  /** True when `memory` differs from the one given: it is to be kept. */
  changed: boolean
  /** Set when the feed was refused for its date: the line for the log, with the dates. */
  refusal?: string
}

/**
 * Applies the rule to what a feed answered. Only a release file that is for `running` is judged (anything else, a GitHub answer included, is left to `parseFeed`,
 * which refuses it or reads it as it always did: it has no date):
 * - a feed with a date that is older than the last one accepted for `address` becomes a failed answer, so that nothing of it is read, its `withdrawn` list included;
 * - an accepted date is kept (the memory only ever moves forward);
 * - a macOS file written before the keys of update-target.ts, with no usable `pub_date`, is left as it was read before (nothing remembered, nothing refused);
 * - a file that names its system (Windows, Linux) must give a date: without one it is not readable.
 * An answer that already failed is returned as it is.
 */
export function judgeFeedDate(answer: FeedAnswer, address: string, running: FeedTarget, memory: FeedDates): FeedFreshness {
  const unchanged: FeedFreshness = { answer, memory, changed: false }
  if (!answer.ok) return unchanged
  const feed = answer.json
  if (typeof feed !== 'object' || feed === null || Array.isArray(feed)) return unchanged
  const file = feed as Record<string, unknown>
  const identity = readFeedIdentity(file, running)
  if (!identity.ok) return unchanged
  const date = readFeedDate(file)
  if (date.kind !== 'date') {
    if (identity.legacy) return unchanged
    return { answer: { ok: false, reason: t('update-check.le-flux-de-mises-a-jour-n-est-pas-lisible') }, memory, changed: false, refusal: 'the feed names its system but gives no usable pub_date' }
  }
  const key = feedMemoryKey(address)
  // An address that cannot be read was never fetched: nothing can be said of the date of what it gave, so nothing is believed.
  if (key === '') return { answer: { ok: false, reason: t('update-check.le-flux-de-mises-a-jour-n-est-pas-lisible') }, memory, changed: false, refusal: 'the address of the feed cannot be read' }
  const last = memory[key]
  if (last !== undefined && date.at < last) {
    return {
      answer: { ok: false, reason: t('update-check.le-flux-de-mises-a-jour-est-plus-ancien-que-le-dernier-lu') },
      memory,
      changed: false,
      refusal: `the feed is dated ${new Date(date.at).toISOString()}, before the last one accepted for this address (${new Date(last).toISOString()})`
    }
  }
  if (last === date.at) return unchanged
  const { [key]: _forgotten, ...others } = memory
  // The address is put last: when the memory is full, the one that was not seen for the longest is the one that goes.
  const kept = Object.entries({ ...others, [key]: date.at }).slice(-FEED_MEMORY_MAX)
  return { answer, memory: Object.fromEntries(kept), changed: true }
}
