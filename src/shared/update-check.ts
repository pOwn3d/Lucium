// "Check for Updates…": the check reads a feed, compares versions, and says what it found. Two shapes of feed are read:
// - the release file of Squirrel.Mac (`serverType: 'json'`), the one a build with a built-in feed installs from (shell/app-update.ts): the same
//   file is read here first, so that what the check offers is what Squirrel downloads;
// - a GitHub "latest release" answer, for an address given by hand: Lucium then only opens the download page.

import { joinPieces, readPiecesWithin } from './bounded-stream'
import { getLanguage, t, type Language } from './i18n'
import { compareVersions, isDottedVersion } from './versions'

export interface UpdateOffer {
  version: string
  /** The page to download it by hand (opened in the browser): the feed's `page`, else the archive itself. */
  url: string
  notes: string
  /** The .zip Squirrel.Mac installs (Squirrel's release file only): its presence is what allows "Télécharger et installer". */
  archive?: string
  /** Its size in bytes, when the feed gives it (shown before the download). */
  size?: number
}

const https = (url: unknown): url is string => typeof url === 'string' && /^https:\/\/\S+$/i.test(url)

/**
 * The page of the site where the latest version is downloaded by hand, in the language of the interface. It is where Windows and Linux, whose builds carry no
 * update address and install nothing (`updatesByHand`, shared/platform.ts), send a person who asks for updates.
 */
export const DOWNLOAD_PAGES: Readonly<Record<Language, string>> = { fr: 'https://lucium.app/telecharger/', en: 'https://lucium.app/en/download/' }

export const downloadPageUrl = (language: Language): string => DOWNLOAD_PAGES[language]

/**
 * A version as Squirrel.Mac compares it with the running one (`NSNumericSearch` on the text, after an exact match of `currentRelease`): digits
 * and dots only. A "v" or a suffix would be read one way here and another way by Squirrel, so such a file is refused.
 */
export const SQUIRREL_VERSION = /^\d+(?:\.\d+){0,3}$/

/**
 * The version Squirrel.Mac really downloaded, read from the `releaseName` of its `update-downloaded` event: the `name` of the release file,
 * "Lucium X.Y.Z" (update-feed-file.ts). Read strictly: that exact shape with a version of `SQUIRREL_VERSION` after the name, so that no other text
 * (a missing name, a blank, a "v", a suffix) is taken for a version. Null when it is not one; the caller says why it falls back.
 */
export function downloadedVersion(releaseName: unknown): string | null {
  if (typeof releaseName !== 'string') return null
  const version = /^Lucium (\S+)$/.exec(releaseName)?.[1]
  return version !== undefined && SQUIRREL_VERSION.test(version) ? version : null
}

/**
 * Squirrel.Mac's release file: `{ currentRelease, releases: [{ version, updateTo: { url, notes, name, pub_date, sha256, size } }] }`. Squirrel
 * reads only the entry whose `version` is exactly `currentRelease`, and downloads its `updateTo.url`; `page` is Lucium's own key (Squirrel
 * ignores it), the page that "Télécharger manuellement" opens. `en: { page, notes }` is Lucium's own as well: what an interface in English
 * shows in place of the French page and notes. A file without it, or with a part of it missing, gives the French ones.
 */
function parseSquirrelFeed(feed: Record<string, unknown>): UpdateOffer | null {
  const current = feed['currentRelease']
  const releases = feed['releases']
  if (typeof current !== 'string' || !SQUIRREL_VERSION.test(current) || !Array.isArray(releases)) return null
  const entry = releases.find((release): release is Record<string, unknown> => typeof release === 'object' && release !== null && (release as Record<string, unknown>)['version'] === current)
  const updateTo = entry?.['updateTo']
  if (typeof updateTo !== 'object' || updateTo === null) return null
  const target = updateTo as Record<string, unknown>
  const archive = target['url']
  if (!https(archive)) return null
  const size = target['size']
  const page = feed['page']
  const en = feed['en']
  const english: Record<string, unknown> = getLanguage() === 'en' && typeof en === 'object' && en !== null ? (en as Record<string, unknown>) : {}
  const englishPage = english['page']
  const englishNotes = english['notes']
  return {
    version: current,
    url: https(englishPage) ? englishPage : https(page) ? page : archive,
    notes: typeof englishNotes === 'string' && englishNotes.trim() !== '' ? englishNotes : typeof target['notes'] === 'string' ? target['notes'] : '',
    archive,
    ...(typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? { size } : {})
  }
}

export type UpdateOutcome =
  | { kind: 'not-configured' }
  | { kind: 'up-to-date'; current: string }
  | { kind: 'available'; current: string; offer: UpdateOffer }
  /** The running version was withdrawn; `newer` says whether the version to install is above it (the only direction Squirrel.Mac installs in). */
  | { kind: 'withdrawn'; current: string; offer: UpdateOffer; newer: boolean }
  | { kind: 'failed'; reason: string }

/**
 * Reads Squirrel.Mac's release file (`currentRelease`, `releases`), or a feed in the shape of a GitHub "latest release" answer (`tag_name`,
 * `html_url`, `body`). Anything else is a feed we cannot read: null.
 */
export function parseFeed(raw: unknown): UpdateOffer | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const feed = raw as Record<string, unknown>
  if ('currentRelease' in feed || 'releases' in feed) return parseSquirrelFeed(feed)
  const version = typeof feed['tag_name'] === 'string' ? feed['tag_name'] : typeof feed['version'] === 'string' ? feed['version'] : null
  const url = typeof feed['html_url'] === 'string' ? feed['html_url'] : typeof feed['url'] === 'string' ? feed['url'] : null
  if (!version || !url || !/^https:\/\//i.test(url) || !isDottedVersion(version)) return null
  return { version: version.trim().replace(/^v/, ''), url, notes: typeof feed['body'] === 'string' ? feed['body'] : '' }
}

/**
 * The versions the release file says were withdrawn (`withdrawn`, Lucium's own key, written by `publish-update.mjs --withdraw` and carried by every
 * later publication; Squirrel ignores it). It travels in the file the check reads anyway: no other request tells a copy that its version is
 * withdrawn. The list is taken whole or not at all: an array of versions of digits and dots, and anything else in it means the file was not
 * written by the publication, so nothing of the list is believed. A feed in the shape of a GitHub answer carries none.
 */
export function withdrawnVersions(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  const list = (raw as Record<string, unknown>)['withdrawn']
  if (!Array.isArray(list) || !list.every((version): version is string => typeof version === 'string' && SQUIRREL_VERSION.test(version))) return []
  return list
}

/**
 * How the feed is asked for: no cookie or HTTP credential of the application's session goes with the request (`net.fetch` sends them by
 * default), and neither the request nor the answer touches the cache on the disk, so that a check always reads what the server says now.
 */
export function feedFetchInit(signal: AbortSignal): { cache: 'no-store'; credentials: 'omit'; headers: { accept: string }; signal: AbortSignal } {
  return { cache: 'no-store', credentials: 'omit', headers: { accept: 'application/json' }, signal }
}

/** What the feed answered, as `updateOutcome` reads it. */
export type FeedAnswer = { ok: true; json: unknown } | { ok: false; reason: string }

/** The part of a fetch `Response` the check reads. */
export interface FeedResponse {
  ok: boolean
  status: number
  /** The address the answer came from, after any redirect. */
  url: string
  /** The size the server declares (`content-length`), when it does. */
  headers?: { get(name: string): string | null }
  /** The body as it arrives: read up to FEED_MAX_BYTES, never more. A response without one (a test's) is read by `arrayBuffer()`. */
  body?: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * The check of the signature of a feed (main/update-feed-signature.ts, with the public keys built into the application): the bytes that a key
 * signed, which are the only ones read, or null when the feed is refused. It says why in the log; the user is told one sober sentence.
 */
export type FeedSignatureCheck = (feed: Uint8Array) => Uint8Array | null

/**
 * The most a release file may weigh. Squirrel's file and a "latest release" answer are a few kilobytes; a feed that answers more is not
 * one, and a body of gigabytes read whole would hold the main process once a day.
 */
export const FEED_MAX_BYTES = 64 * 1024

/** The bytes of the feed, read up to FEED_MAX_BYTES; `TOO_LARGE` when it is larger (declared or counted). */
async function boundedBytes(response: FeedResponse): Promise<Uint8Array | typeof TOO_LARGE> {
  const declared = Number(response.headers?.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > FEED_MAX_BYTES) return TOO_LARGE
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer())
    return whole.byteLength > FEED_MAX_BYTES ? TOO_LARGE : whole
  }
  const reader = response.body.getReader()
  const pieces = await readPiecesWithin(reader, FEED_MAX_BYTES)
  if (pieces === null) {
    // The refusal is the answer either way (the caller reports it); a stream that cannot even be cancelled is only logged.
    await reader.cancel().catch((error: unknown) => console.warn('[update] cannot cancel the body of a feed that is too large:', error))
    return TOO_LARGE
  }
  return joinPieces(pieces)
}

const TOO_LARGE: unique symbol = Symbol('too large')

/**
 * The answer of a feed that was asked for over https. A redirect to plain http is refused: that hop could be swapped on the way, and
 * so could the download page the feed names. A feed that no key of the application signed is refused whatever it says and wherever it comes
 * from (the stable channel, the test one, an address given by hand): it offers nothing and withdraws nothing. Only the signed bytes are read as
 * JSON. A failure to read the body is thrown, for the caller to report.
 */
export async function feedAnswer(requested: string, response: FeedResponse, signedBy: FeedSignatureCheck): Promise<FeedAnswer> {
  if (/^https:\/\//i.test(requested.trim()) && response.url && !/^https:\/\//i.test(response.url)) {
    return { ok: false, reason: t('update-check.le-flux-de-mises-a-jour-a-redirige-vers-une') }
  }
  if (!response.ok) return { ok: false, reason: t('update-check.reponse-status', { status: response.status }) }
  const bytes = await boundedBytes(response)
  if (bytes === TOO_LARGE) return { ok: false, reason: t('update-check.le-flux-de-mises-a-jour-est-trop-gros', { size: String(FEED_MAX_BYTES / 1024) }) }
  const signed = signedBy(bytes)
  if (signed === null) return { ok: false, reason: t('update-check.le-flux-de-mises-a-jour-n-a-pas-de-signature-valide') }
  return { ok: true, json: JSON.parse(new TextDecoder().decode(signed)) as unknown }
}

/**
 * The result of a check, given the running version and what the feed answered (`feed` undefined: no feed configured). A running version the
 * feed lists as withdrawn is told so, whether the version the feed offers is above it or below it.
 */
export function updateOutcome(current: string, feedUrl: string, answer: FeedAnswer | null): UpdateOutcome {
  if (!feedUrl.trim()) return { kind: 'not-configured' }
  // A feed read over plain http could be swapped on the way: the download page it names would be too.
  if (!/^https:\/\//i.test(feedUrl.trim())) return { kind: 'failed', reason: t('update-check.l-adresse-du-flux-de-mises-a-jour-doit-commencer') }
  if (!answer) return { kind: 'failed', reason: t('update-check.aucune-reponse') }
  if (!answer.ok) return { kind: 'failed', reason: answer.reason }
  const offer = parseFeed(answer.json)
  if (!offer) return { kind: 'failed', reason: t('update-check.le-flux-de-mises-a-jour-n-est-pas-lisible') }
  const order = compareVersions(offer.version, current)
  // The version the file offers is never a withdrawn one for the copies that run it: the file in place is the last word of the channel.
  if (order !== 0 && withdrawnVersions(answer.json).some((version) => compareVersions(version, current) === 0)) {
    return { kind: 'withdrawn', current, offer, newer: order > 0 }
  }
  return order > 0 ? { kind: 'available', current, offer } : { kind: 'up-to-date', current }
}
