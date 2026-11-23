// The anti-replay rule of the update feed (update-feed-date.ts): what a copy does with the date of publication of a feed, with no clock, no disk and no network.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from './i18n'
import { FEED_MEMORY_MAX, cleanFeedDates, feedMemoryKey, judgeFeedDate, parsePubDate, readFeedDate, type FeedDates } from './update-feed-date'
import { updateOutcome, withdrawnVersions, type FeedAnswer } from './update-check'
import type { FeedTarget } from './update-target'

const MAC: FeedTarget = { platform: 'darwin', arch: 'arm64' }
const WINDOWS: FeedTarget = { platform: 'win32', arch: 'x64' }
const STABLE = 'https://lucium.app/updates/win32-x64/feed.json'
const TEST = 'https://test.lucium.app/updates/win32-x64/feed.json'
const SUM = 'a'.repeat(64)

/** A release file of macOS (no `platform`: the files written before the keys existed). */
const macFile = (version: string, pub_date: string | undefined, extra: Record<string, unknown> = {}) => ({
  currentRelease: version,
  releases: [{ version, updateTo: { url: `https://lucium.app/updates/darwin-arm64/Lucium-${version}-arm64.zip`, notes: '', ...(pub_date === undefined ? {} : { pub_date }) } }],
  ...extra
})
/** A release file of Windows, which says it is for it. */
const windowsFile = (version: string, pub_date: string | undefined, extra: Record<string, unknown> = {}) => ({
  currentRelease: version,
  platform: 'win32',
  arch: 'x64',
  kind: 'nsis',
  releases: [{ version, updateTo: { url: `https://lucium.app/updates/win32-x64/Lucium-${version}-setup.exe`, notes: '', sha256: SUM, size: 1000, ...(pub_date === undefined ? {} : { pub_date }) } }],
  ...extra
})
const answer = (json: unknown): FeedAnswer => ({ ok: true, json })
const at = (text: string): number => Date.parse(text)

afterEach(() => vi.useRealTimers())

describe('the date of publication of a feed', () => {
  it('is read in the format Squirrel parses, with a Z or an offset', () => {
    expect(parsePubDate('2026-11-23T09:00:00Z')).toBe(Date.UTC(2026, 10, 23, 9, 0, 0))
    // The same instant written with an offset is the same date: the order of two feeds does not depend on how each one was written.
    expect(parsePubDate('2026-11-23T10:00:00+01:00')).toBe(parsePubDate('2026-11-23T09:00:00Z'))
    expect(parsePubDate('2026-11-23T04:00:00-05:00')).toBe(parsePubDate('2026-11-23T09:00:00Z'))
  })

  it.each([
    ['a date with a fraction of a second, which Squirrel would not read', '2026-11-23T09:00:00.000Z'],
    ['a date with no zone', '2026-11-23T09:00:00'],
    ['a day with no time', '2026-11-23'],
    ['a month 13', '2026-13-01T00:00:00Z'],
    ['31 February, which Date.parse would roll over into March', '2026-02-31T00:00:00Z'],
    ['24 o’clock', '2026-11-23T24:00:00Z'],
    ['a leap second', '2026-11-23T09:00:60Z'],
    ['text around a date', ' 2026-11-23T09:00:00Z'],
    ['words', 'yesterday']
  ])('is not one when it is %s', (_name, text) => {
    expect(parsePubDate(text)).toBeNull()
  })

  it('is not one when it is not text', () => {
    for (const value of [undefined, null, 1795420800000, {}, ['2026-11-23T09:00:00Z']]) expect(parsePubDate(value)).toBeNull()
  })

  it('29 February exists in a leap year only', () => {
    expect(parsePubDate('2028-02-29T00:00:00Z')).not.toBeNull()
    expect(parsePubDate('2027-02-29T00:00:00Z')).toBeNull()
  })

  it('is the one of the release `currentRelease` names, whatever the other entries say', () => {
    const file = macFile('1.2.0', '2026-11-23T09:00:00Z')
    file.releases.unshift({ version: '1.1.0', updateTo: { url: 'https://lucium.app/x.zip', notes: '', pub_date: '2030-01-01T00:00:00Z' } })
    expect(readFeedDate(file)).toEqual({ kind: 'date', at: at('2026-11-23T09:00:00Z') })
  })

  it('is told apart when missing, not a date, or the release has no body', () => {
    expect(readFeedDate(macFile('1.2.0', undefined))).toEqual({ kind: 'none' })
    expect(readFeedDate(macFile('1.2.0', 'soon'))).toEqual({ kind: 'invalid' })
    expect(readFeedDate({ currentRelease: '1.2.0', releases: [{ version: '1.2.0' }] })).toEqual({ kind: 'none' })
    expect(readFeedDate({ currentRelease: '9.9.9', releases: macFile('1.2.0', '2026-11-23T09:00:00Z').releases })).toEqual({ kind: 'none' })
    expect(readFeedDate({ currentRelease: '1.2.0' })).toEqual({ kind: 'none' })
  })
})

describe('the memory of the dates', () => {
  it('names an address by its origin and path, with no query, fragment or user name', () => {
    expect(feedMemoryKey('https://lucium.app/updates/win32-x64/feed.json')).toBe('https://lucium.app/updates/win32-x64/feed.json')
    expect(feedMemoryKey('https://user:secret@Lucium.app/updates/feed.json?token=abc#top')).toBe('https://lucium.app/updates/feed.json')
    expect(feedMemoryKey('not an address')).toBe('')
  })

  it('keeps only an address with a date that is a plain positive integer, and no more than FEED_MEMORY_MAX of them', () => {
    expect(cleanFeedDates({ [STABLE]: 5, a: -1, b: 1.5, c: '7', d: null, '': 9, e: Number.MAX_SAFE_INTEGER + 2 })).toEqual({ [STABLE]: 5 })
    for (const junk of [null, undefined, 'x', 3, [], [STABLE]]) expect(cleanFeedDates(junk)).toEqual({})
    const many = Object.fromEntries(Array.from({ length: FEED_MEMORY_MAX + 8 }, (_, index) => [`https://x.example/${index}`, index + 1]))
    expect(Object.keys(cleanFeedDates(many))).toHaveLength(FEED_MEMORY_MAX)
  })
})

describe('the feed of a system that names itself (Windows)', () => {
  it('the first feed ever read is accepted, and its date is remembered', () => {
    const feed = answer(windowsFile('1.2.0', '2026-11-23T09:00:00Z'))
    const judged = judgeFeedDate(feed, STABLE, WINDOWS, {})
    expect(judged.answer).toBe(feed)
    expect(judged.changed).toBe(true)
    expect(judged.memory).toEqual({ [STABLE]: at('2026-11-23T09:00:00Z') })
    expect(judged.refusal).toBeUndefined()
  })

  it('a newer feed is accepted and moves the date forward', () => {
    const judged = judgeFeedDate(answer(windowsFile('1.2.1', '2026-11-24T09:00:00Z')), STABLE, WINDOWS, { [STABLE]: at('2026-11-23T09:00:00Z') })
    expect(judged.answer.ok).toBe(true)
    expect(judged.memory[STABLE]).toBe(at('2026-11-24T09:00:00Z'))
    expect(judged.changed).toBe(true)
  })

  it('the same feed read again is accepted and changes nothing', () => {
    const memory: FeedDates = { [STABLE]: at('2026-11-23T09:00:00Z') }
    const judged = judgeFeedDate(answer(windowsFile('1.2.0', '2026-11-23T09:00:00Z')), STABLE, WINDOWS, memory)
    expect(judged.answer.ok).toBe(true)
    expect(judged.changed).toBe(false)
    expect(judged.memory).toBe(memory)
  })

  it('an OLDER feed, validly signed or not, is refused whole: it offers nothing and its withdrawals are not believed', () => {
    const replay = answer(windowsFile('1.2.0', '2026-11-23T09:00:00Z', { withdrawn: ['1.1.9'] }))
    const memory: FeedDates = { [STABLE]: at('2026-11-24T09:00:00Z') }
    const judged = judgeFeedDate(replay, STABLE, WINDOWS, memory)
    expect(judged.answer).toEqual({ ok: false, reason: t('update-check.le-flux-de-mises-a-jour-est-plus-ancien-que-le-dernier-lu') })
    expect(judged.changed).toBe(false)
    expect(judged.memory).toBe(memory)
    expect(judged.refusal).toContain('2026-11-23T09:00:00.000Z')
    // Nothing of it reaches the check: the outcome is a failure, not an offer.
    expect(updateOutcome('1.1.0', STABLE, judged.answer, WINDOWS).kind).toBe('failed')
  })

  it('one second older is already refused', () => {
    const judged = judgeFeedDate(answer(windowsFile('1.2.0', '2026-11-23T09:00:00Z')), STABLE, WINDOWS, { [STABLE]: at('2026-11-23T09:00:01Z') })
    expect(judged.answer.ok).toBe(false)
  })

  it('compares instants, not texts: an older instant written with a later-looking offset is refused', () => {
    // 11:00 at +05:00 is 06:00 UTC, which is before 09:00 UTC although "11:00" is after "09:00" as text.
    const judged = judgeFeedDate(answer(windowsFile('1.2.0', '2026-11-23T11:00:00+05:00')), STABLE, WINDOWS, { [STABLE]: at('2026-11-23T09:00:00Z') })
    expect(judged.answer.ok).toBe(false)
  })

  it('the test channel and the stable one are remembered apart', () => {
    const memory: FeedDates = { [STABLE]: at('2026-11-30T09:00:00Z') }
    // The test channel is published earlier than the stable one: its feed is older than the stable date, and is not judged against it.
    const judged = judgeFeedDate(answer(windowsFile('1.2.1', '2026-11-25T09:00:00Z')), TEST, WINDOWS, memory)
    expect(judged.answer.ok).toBe(true)
    expect(judged.memory).toEqual({ [STABLE]: at('2026-11-30T09:00:00Z'), [TEST]: at('2026-11-25T09:00:00Z') })
    // And the other way: an old stable feed is still refused whatever the test channel has seen.
    expect(judgeFeedDate(answer(windowsFile('1.2.0', '2026-11-29T09:00:00Z')), STABLE, WINDOWS, judged.memory).answer.ok).toBe(false)
  })

  it('an address read with another query is the same address', () => {
    const memory: FeedDates = { [STABLE]: at('2026-11-24T09:00:00Z') }
    expect(judgeFeedDate(answer(windowsFile('1.2.0', '2026-11-23T09:00:00Z')), `${STABLE}?x=1`, WINDOWS, memory).answer.ok).toBe(false)
  })

  it('without a date, or with one that is not a date, it is not readable and nothing is remembered', () => {
    for (const bad of [undefined, 'soon', '2026-02-31T00:00:00Z']) {
      const memory: FeedDates = { [STABLE]: 1 }
      const judged = judgeFeedDate(answer(windowsFile('1.2.0', bad)), STABLE, WINDOWS, memory)
      expect(judged.answer).toEqual({ ok: false, reason: t('update-check.le-flux-de-mises-a-jour-n-est-pas-lisible') })
      expect(judged.changed).toBe(false)
      expect(judged.refusal).toBeDefined()
    }
  })

  it('a feed that is for another system is not judged, and moves no date', () => {
    const memory: FeedDates = { [STABLE]: at('2026-11-24T09:00:00Z') }
    // A macOS feed (signed with the same key) served at the Windows address: older than the memory, and left to `parseFeed`, which refuses it as another system's.
    const judged = judgeFeedDate(answer(macFile('1.2.0', '2026-11-20T09:00:00Z')), STABLE, WINDOWS, memory)
    expect(judged.changed).toBe(false)
    expect(judged.memory).toBe(memory)
    // A far-future date in a feed of another system cannot move the memory ahead either.
    const future = judgeFeedDate(answer({ ...windowsFile('1.2.0', '2999-01-01T00:00:00Z'), platform: 'linux', arch: 'x64', kind: 'appimage' }), STABLE, WINDOWS, memory)
    expect(future.changed).toBe(false)
    expect(future.memory).toBe(memory)
  })

  it('the clock of the machine is never read: a fast or a slow one changes nothing', () => {
    const memory: FeedDates = { [STABLE]: at('2026-11-23T09:00:00Z') }
    for (const clock of ['1999-01-01T00:00:00Z', '2026-11-23T09:00:00Z', '2099-01-01T00:00:00Z']) {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(clock))
      expect(judgeFeedDate(answer(windowsFile('1.2.1', '2026-11-24T09:00:00Z')), STABLE, WINDOWS, memory).answer.ok).toBe(true)
      expect(judgeFeedDate(answer(windowsFile('1.2.0', '2026-11-22T09:00:00Z')), STABLE, WINDOWS, memory).answer.ok).toBe(false)
      // The first feed is accepted whatever the clock says, even one dated after the machine's "now".
      expect(judgeFeedDate(answer(windowsFile('1.2.0', '2026-11-24T09:00:00Z')), STABLE, WINDOWS, {}).answer.ok).toBe(true)
      vi.useRealTimers()
    }
  })

  it('the memory only moves forward, and when it is full the address seen longest ago is the one forgotten', () => {
    let memory: FeedDates = {}
    for (let index = 0; index < FEED_MEMORY_MAX; index++) memory = { ...memory, [`https://x.example/${index}.json`]: index + 1 }
    const judged = judgeFeedDate(answer(windowsFile('1.2.0', '2026-11-23T09:00:00Z')), STABLE, WINDOWS, memory)
    expect(Object.keys(judged.memory)).toHaveLength(FEED_MEMORY_MAX)
    expect(judged.memory[STABLE]).toBe(at('2026-11-23T09:00:00Z'))
    expect(judged.memory['https://x.example/0.json']).toBeUndefined()
    expect(judged.memory[`https://x.example/${FEED_MEMORY_MAX - 1}.json`]).toBe(FEED_MEMORY_MAX)
  })

  it('an address that cannot be read is believed in nothing: the feed is refused and the memory is left alone', () => {
    const memory: FeedDates = { [STABLE]: 1 }
    const judged = judgeFeedDate(answer(windowsFile('1.2.0', '2026-11-23T09:00:00Z')), 'not an address', WINDOWS, memory)
    expect(judged.answer.ok).toBe(false)
    expect(judged.changed).toBe(false)
    expect(judged.refusal).toContain('cannot be read')
  })

  it('an answer that already failed goes through as it was', () => {
    const failed: FeedAnswer = { ok: false, reason: 'no signature' }
    const judged = judgeFeedDate(failed, STABLE, WINDOWS, { [STABLE]: 9 })
    expect(judged.answer).toBe(failed)
    expect(judged.changed).toBe(false)
  })
})

describe('the feed of macOS, which sees no change unless an older feed is played again', () => {
  it('a file written before the keys existed, with a date, is read as before and remembered', () => {
    const feed = answer(macFile('1.2.0', '2026-11-23T09:00:00Z'))
    const judged = judgeFeedDate(feed, 'https://lucium.app/updates/darwin-arm64/feed.json', MAC, {})
    expect(judged.answer).toBe(feed)
    expect(updateOutcome('1.1.0', STABLE, judged.answer, MAC).kind).toBe('available')
  })

  it('a file with no date, or a date that is not one, is read exactly as before: nothing remembered, nothing refused', () => {
    for (const bad of [undefined, 'soon', '2026-11-23T09:00:00.000Z']) {
      const feed = answer(macFile('1.2.0', bad))
      const memory: FeedDates = { 'https://lucium.app/updates/darwin-arm64/feed.json': at('2030-01-01T00:00:00Z') }
      const judged = judgeFeedDate(feed, 'https://lucium.app/updates/darwin-arm64/feed.json', MAC, memory)
      expect(judged.answer).toBe(feed)
      expect(judged.changed).toBe(false)
      expect(judged.refusal).toBeUndefined()
    }
  })

  it('a feed in the shape of a GitHub answer carries no date and is left alone', () => {
    const feed = answer({ tag_name: 'v1.2.0', html_url: 'https://github.com/pOwn3d/Lucium/releases/tag/v1.2.0', body: '' })
    const judged = judgeFeedDate(feed, 'https://api.github.com/repos/pOwn3d/Lucium/releases/latest', MAC, { 'https://api.github.com/repos/pOwn3d/Lucium/releases/latest': 1 })
    expect(judged.answer).toBe(feed)
    expect(judged.changed).toBe(false)
  })

  it('anything that is not a release file goes through to be refused by the check as it always was', () => {
    for (const json of [null, 'text', 4, [], {}]) {
      const feed = answer(json)
      expect(judgeFeedDate(feed, STABLE, MAC, {}).answer).toBe(feed)
    }
  })

  it('an older file is refused on macOS as on any system: that is the replay the rule is for', () => {
    const address = 'https://lucium.app/updates/darwin-arm64/feed.json'
    const judged = judgeFeedDate(answer(macFile('1.1.5', '2026-11-01T09:00:00Z')), address, MAC, { [address]: at('2026-11-23T09:00:00Z') })
    expect(judged.answer.ok).toBe(false)
  })
})

describe('what the rule leaves as it was', () => {
  const address = 'https://lucium.app/updates/darwin-arm64/feed.json'

  it('a newer feed that lists the running version as withdrawn still tells it, with the version to install', () => {
    const judged = judgeFeedDate(answer(macFile('1.2.1', '2026-11-25T09:00:00Z', { withdrawn: ['1.2.0'] })), address, MAC, { [address]: at('2026-11-23T09:00:00Z') })
    expect(withdrawnVersions(judged.answer.ok ? judged.answer.json : null)).toEqual(['1.2.0'])
    expect(updateOutcome('1.2.0', address, judged.answer, MAC)).toMatchObject({ kind: 'withdrawn', newer: true })
  })

  it('a rollback published under a later date is accepted: a LOWER version offered to a copy that runs the withdrawn one', () => {
    const judged = judgeFeedDate(answer(macFile('1.2.0', '2026-11-25T09:00:00Z', { withdrawn: ['1.2.1'] })), address, MAC, { [address]: at('2026-11-24T09:00:00Z') })
    expect(judged.answer.ok).toBe(true)
    expect(updateOutcome('1.2.1', address, judged.answer, MAC)).toMatchObject({ kind: 'withdrawn', newer: false })
  })

  it('a feed that offers a version that is not above the running one still offers nothing, whatever its date', () => {
    const judged = judgeFeedDate(answer(macFile('1.2.0', '2026-11-25T09:00:00Z')), address, MAC, { [address]: at('2026-11-24T09:00:00Z') })
    expect(updateOutcome('1.2.0', address, judged.answer, MAC)).toEqual({ kind: 'up-to-date', current: '1.2.0' })
    expect(updateOutcome('1.3.0', address, judged.answer, MAC)).toEqual({ kind: 'up-to-date', current: '1.3.0' })
  })
})
