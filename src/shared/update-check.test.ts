import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { FEED_MAX_BYTES, downloadedVersion, feedAnswer, feedFetchInit, parseFeed, updateOutcome, withdrawnVersions } from './update-check'

// The order of the versions is tested in versions.test.ts.

describe('parseFeed', () => {
  it('reads a GitHub latest-release answer', () => {
    expect(parseFeed({ tag_name: 'v0.2.0', html_url: 'https://example.org/releases/v0.2.0', body: 'Notes' })).toEqual({ version: '0.2.0', url: 'https://example.org/releases/v0.2.0', notes: 'Notes' })
  })

  it('refuses a feed whose download page is not https, or whose version is not one', () => {
    expect(parseFeed({ tag_name: 'v0.2.0', html_url: 'http://example.org/x' })).toBeNull()
    expect(parseFeed({ tag_name: 'v0.2.0', html_url: 'javascript:alert(1)' })).toBeNull()
    expect(parseFeed({ tag_name: 'latest', html_url: 'https://example.org/x' })).toBeNull()
    expect(parseFeed(null)).toBeNull()
    expect(parseFeed([])).toBeNull()
  })
})

describe('parseFeed, the release file of Squirrel.Mac', () => {
  const ZIP = 'https://test.lucium.app/updates/darwin-arm64/Lucium-0.2.1-arm64.zip'
  const entry = (version: string, url = ZIP) => ({ version, updateTo: { version, name: `Lucium ${version}`, notes: 'Essai.', pub_date: '2026-11-06T09:00:00Z', url, sha256: 'a'.repeat(64), size: 128172732 } })
  const file = (over: Record<string, unknown> = {}) => ({ currentRelease: '0.2.1', page: 'https://test.lucium.app/telecharger/', releases: [entry('0.2.0', 'https://test.lucium.app/old.zip'), entry('0.2.1')], ...over })

  it('reads the entry of currentRelease, as Squirrel does: the archive it installs, its size, the notes and the page', () => {
    expect(parseFeed(file())).toEqual({ version: '0.2.1', url: 'https://test.lucium.app/telecharger/', notes: 'Essai.', archive: ZIP, size: 128172732 })
  })

  it('gives an interface in English the page and the notes written for it, and the French ones for whatever is missing', () => {
    const en = { page: 'https://test.lucium.app/en/download/', notes: 'A trial.' }
    try {
      // In French the key is not read at all.
      setLanguage('fr')
      expect(parseFeed(file({ en }))).toMatchObject({ url: 'https://test.lucium.app/telecharger/', notes: 'Essai.' })
      setLanguage('en')
      expect(parseFeed(file({ en }))).toEqual({ version: '0.2.1', url: en.page, notes: en.notes, archive: ZIP, size: 128172732 })
      // A file of before the key, a part missing, a page that is not https, a key of another shape: the French part stands in.
      expect(parseFeed(file())).toMatchObject({ url: 'https://test.lucium.app/telecharger/', notes: 'Essai.' })
      expect(parseFeed(file({ en: { page: en.page, notes: '  ' } }))).toMatchObject({ url: en.page, notes: 'Essai.' })
      expect(parseFeed(file({ en: { page: 'http://test.lucium.app/en/download/', notes: en.notes } }))).toMatchObject({ url: 'https://test.lucium.app/telecharger/', notes: en.notes })
      for (const odd of [null, 'en', 3, [en]]) expect(parseFeed(file({ en: odd })), String(odd)).toMatchObject({ url: 'https://test.lucium.app/telecharger/', notes: 'Essai.' })
    } finally {
      setLanguage('fr')
    }
  })

  it('opens the archive itself when the file names no page', () => {
    const { page: _page, ...withoutPage } = file()
    expect(parseFeed(withoutPage)).toMatchObject({ url: ZIP, archive: ZIP })
  })

  it('refuses an archive that is not https, a missing entry, and a version Squirrel would read differently', () => {
    expect(parseFeed(file({ releases: [entry('0.2.1', 'http://test.lucium.app/Lucium.zip')] }))).toBeNull()
    expect(parseFeed(file({ releases: [entry('0.2.0')] }))).toBeNull()
    expect(parseFeed(file({ releases: 'none' }))).toBeNull()
    for (const version of ['v0.2.1', '0.2.1-beta', ' 0.2.1', '']) expect(parseFeed(file({ currentRelease: version, releases: [entry(version)] })), version).toBeNull()
  })

  it('offers the archive only when the feed is newer than the running version, compared as Squirrel compares them (numbers, not text)', () => {
    const answer = (json: unknown) => ({ ok: true as const, json })
    expect(updateOutcome('0.2.0', 'https://f', answer(file()))).toMatchObject({ kind: 'available', offer: { version: '0.2.1', archive: ZIP } })
    expect(updateOutcome('0.2.1', 'https://f', answer(file()))).toEqual({ kind: 'up-to-date', current: '0.2.1' })
    expect(updateOutcome('0.3.0', 'https://f', answer(file()))).toEqual({ kind: 'up-to-date', current: '0.3.0' })
    // "0.2.10" is newer than "0.2.9" for NSNumericSearch, and here too.
    expect(updateOutcome('0.2.9', 'https://f', answer(file({ currentRelease: '0.2.10', releases: [entry('0.2.10')] })))).toMatchObject({ kind: 'available', offer: { version: '0.2.10' } })
    expect(updateOutcome('0.2.10', 'https://f', answer(file({ currentRelease: '0.2.9', releases: [entry('0.2.9')] })))).toMatchObject({ kind: 'up-to-date' })
  })
})

describe('updateOutcome', () => {
  const feed = { ok: true as const, json: { tag_name: 'v0.2.0', html_url: 'https://example.org/r' } }

  it('says so when no feed is configured, without asking anything', () => {
    expect(updateOutcome('0.1.0', '  ', feed)).toEqual({ kind: 'not-configured' })
  })

  it('offers a newer version and calls an equal or older one up to date', () => {
    expect(updateOutcome('0.1.0', 'https://f', feed)).toMatchObject({ kind: 'available', offer: { version: '0.2.0' } })
    expect(updateOutcome('0.2.0', 'https://f', feed)).toEqual({ kind: 'up-to-date', current: '0.2.0' })
    expect(updateOutcome('0.3.0', 'https://f', feed)).toEqual({ kind: 'up-to-date', current: '0.3.0' })
  })

  it('refuses a feed that is not https', () => {
    expect(updateOutcome('0.1.0', 'http://example.org/latest', feed)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('https') })
    expect(updateOutcome('0.1.0', 'file:///etc/passwd', feed)).toMatchObject({ kind: 'failed' })
  })

  it('reports a feed that failed or cannot be read instead of pretending to be up to date', () => {
    expect(updateOutcome('0.1.0', 'https://f', { ok: false, reason: 'HTTP 404' })).toEqual({ kind: 'failed', reason: 'HTTP 404' })
    expect(updateOutcome('0.1.0', 'https://f', { ok: true, json: { nothing: true } })).toMatchObject({ kind: 'failed' })
    expect(updateOutcome('0.1.0', 'https://f', null)).toMatchObject({ kind: 'failed' })
  })
})

describe('the versions the feed lists as withdrawn', () => {
  const ZIP = 'https://lucium.app/updates/darwin-arm64/Lucium-0.3.1-arm64.zip'
  const file = (current: string, withdrawn?: unknown) => ({
    ok: true as const,
    json: { currentRelease: current, page: 'https://lucium.app/telecharger/', releases: [{ version: current, updateTo: { version: current, url: ZIP.replace('0.3.1', current), notes: '', sha256: 'a'.repeat(64), size: 5 } }], ...(withdrawn === undefined ? {} : { withdrawn }) }
  })

  it('tells a copy that runs one of them, with the version to install below it: the feed went back', () => {
    expect(updateOutcome('0.3.2', 'https://f', file('0.3.1', ['0.3.2']))).toEqual({
      kind: 'withdrawn',
      current: '0.3.2',
      newer: false,
      offer: { version: '0.3.1', url: 'https://lucium.app/telecharger/', notes: '', archive: ZIP, size: 5 }
    })
  })

  it('tells it with the version to install above it: a fix was published since', () => {
    expect(updateOutcome('0.3.2', 'https://f', file('0.3.3', ['0.3.4', '0.3.2']))).toMatchObject({ kind: 'withdrawn', current: '0.3.2', newer: true, offer: { version: '0.3.3' } })
  })

  it('changes nothing for the copies on another version, nor for a feed without a list', () => {
    expect(updateOutcome('0.3.1', 'https://f', file('0.3.1', ['0.3.2']))).toEqual({ kind: 'up-to-date', current: '0.3.1' })
    expect(updateOutcome('0.3.0', 'https://f', file('0.3.1', ['0.3.2']))).toMatchObject({ kind: 'available', offer: { version: '0.3.1' } })
    expect(updateOutcome('0.3.3', 'https://f', file('0.3.1', ['0.3.2']))).toEqual({ kind: 'up-to-date', current: '0.3.3' })
    expect(updateOutcome('0.3.2', 'https://f', file('0.3.1'))).toEqual({ kind: 'up-to-date', current: '0.3.2' })
  })

  it('never calls withdrawn the version the feed offers: the feed in place is the last word of the channel', () => {
    expect(updateOutcome('0.3.1', 'https://f', file('0.3.1', ['0.3.1']))).toEqual({ kind: 'up-to-date', current: '0.3.1' })
  })

  it('believes the list whole or not at all: anything else than versions of digits and dots, and nothing of it is read', () => {
    expect(withdrawnVersions({ withdrawn: ['0.3.2', '0.3.10'] })).toEqual(['0.3.2', '0.3.10'])
    for (const list of ['0.3.2', { '0.3.2': true }, ['0.3.2', 'v0.3.3'], ['0.3.2', 7], ['0.3.2', '0.3.3-beta'], ['0.3.2', null], [['0.3.2']]]) {
      expect(withdrawnVersions({ withdrawn: list })).toEqual([])
      expect(updateOutcome('0.3.2', 'https://f', file('0.3.1', list))).toEqual({ kind: 'up-to-date', current: '0.3.2' })
    }
    expect(withdrawnVersions(null)).toEqual([])
    expect(withdrawnVersions(['0.3.2'])).toEqual([])
    expect(withdrawnVersions({})).toEqual([])
  })

  it('compares the running version as versions are compared, and never matches a running version that is not one', () => {
    expect(updateOutcome('0.3.2', 'https://f', file('0.3.1', ['0.3.2.0']))).toMatchObject({ kind: 'withdrawn' })
    expect(updateOutcome('dev', 'https://f', file('0.3.1', ['0.3.2']))).toEqual({ kind: 'up-to-date', current: 'dev' })
  })

  it('is still a feed that cannot be read when it offers nothing a reader would take', () => {
    expect(updateOutcome('0.3.2', 'https://f', { ok: true, json: { withdrawn: ['0.3.2'], releases: [] } })).toMatchObject({ kind: 'failed' })
  })
})

// A feed of several gigabytes was read whole, once a day, by the main process.
/** The check of a test that is not about the signature: every byte is taken as signed. */
const asIs = (bytes: Uint8Array): Uint8Array => bytes
const encoded = (value: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer

describe('feedAnswer and the size of the feed', () => {
  const FEED = 'https://api.example.com/latest'
  // A Response made here has no address of its own (''): it is the one that was asked for, with no redirect.
  const real = (body: BodyInit, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers })

  it('reads a release file of a few kilobytes from its body', async () => {
    expect(await feedAnswer(FEED, real(JSON.stringify({ tag_name: 'v2.0.0', html_url: 'https://example.com/r' })), asIs)).toEqual({ ok: true, json: { tag_name: 'v2.0.0', html_url: 'https://example.com/r' } })
  })

  it('refuses a body larger than the bound, valid as it may be, without reading it to the end', async () => {
    // A release file padded to 1 MB, served in pieces of 16 KB.
    const text = new TextEncoder().encode(JSON.stringify({ tag_name: 'v9.0.0', html_url: 'https://example.com/r', body: ' '.repeat(1024 * 1024) }))
    let pulled = 0
    const pieces = new ReadableStream<Uint8Array>({
      pull(controller) {
        const piece = text.subarray(pulled * 16 * 1024, (pulled + 1) * 16 * 1024)
        pulled++
        if (piece.byteLength === 0) controller.close()
        else controller.enqueue(piece)
      }
    })
    expect(await feedAnswer(FEED, real(pieces), asIs)).toMatchObject({ ok: false })
    expect(pulled * 16 * 1024).toBeLessThan(FEED_MAX_BYTES + 64 * 1024)
  })

  it('refuses a body that declares a size larger than the bound, before reading it', async () => {
    const response = { ok: true, status: 200, url: FEED, headers: { get: (name: string) => (name === 'content-length' ? String(10 * 1024 ** 3) : null) }, body: null, arrayBuffer: async () => { throw new Error('read') } }
    expect(await feedAnswer(FEED, response, asIs)).toMatchObject({ ok: false })
  })

  it('refuses a body without a stream that turns out larger than the bound', async () => {
    const response = { ok: true, status: 200, url: FEED, arrayBuffer: async () => new ArrayBuffer(FEED_MAX_BYTES + 1) }
    expect(await feedAnswer(FEED, response, asIs)).toEqual({ ok: false, reason: expect.stringMatching(/^Le flux de mises à jour dépasse 64\sKo/) })
  })
})

describe('feedAnswer', () => {
  const response = (over: Partial<Parameters<typeof feedAnswer>[1]> = {}) => ({ ok: true, status: 200, url: 'https://api.example.com/latest', arrayBuffer: async () => encoded({ tag_name: 'v2.0.0' }), ...over })

  it('reads the body of an answer that stayed on https', async () => {
    expect(await feedAnswer('https://api.example.com/latest', response(), asIs)).toEqual({ ok: true, json: { tag_name: 'v2.0.0' } })
    // A redirect from one https address to another (a release host) is fine.
    expect(await feedAnswer('https://api.example.com/latest', response({ url: 'https://cdn.example.net/release.json' }), asIs)).toMatchObject({ ok: true })
  })

  it('refuses an answer that a redirect brought from https to plain http, which could have been swapped on the way', async () => {
    const answer = await feedAnswer('https://api.example.com/latest', response({ url: 'http://api.example.com/latest' }), asIs)
    expect(answer).toMatchObject({ ok: false })
    expect((answer as { reason: string }).reason).toMatch(/http/)
  })

  it('says the status of an answer that is not ok', async () => {
    expect(await feedAnswer('https://api.example.com/latest', response({ ok: false, status: 404 }), asIs)).toEqual({ ok: false, reason: 'Réponse 404' })
  })

  it('lets a body that cannot be read reach the caller, which reports the failure', async () => {
    await expect(feedAnswer('https://api.example.com/latest', response({ arrayBuffer: async () => Promise.reject(new Error('cut short')) }), asIs)).rejects.toThrow('cut short')
    await expect(feedAnswer('https://api.example.com/latest', response({ arrayBuffer: async () => new TextEncoder().encode('<html>').buffer as ArrayBuffer }), asIs)).rejects.toThrow(SyntaxError)
  })
})

describe('feedFetchInit', () => {
  it('asks for the feed with no credential of the session and without the cache on the disk, in either direction', () => {
    const signal = new AbortController().signal
    expect(feedFetchInit(signal)).toEqual({ cache: 'no-store', credentials: 'omit', headers: { accept: 'application/json' }, signal })
  })
})

// The server is not the party that is believed: a feed says something only once a key of the application signed it.
describe('feedAnswer and the signature of the feed', () => {
  const FEED = 'https://lucium.app/updates/darwin-arm64/feed.json'
  const offering = { currentRelease: '9.9.9', releases: [{ version: '9.9.9', updateTo: { url: 'https://lucium.app/updates/darwin-arm64/Lucium-9.9.9-arm64.zip' } }], withdrawn: ['0.3.1'] }
  const response = () => ({ ok: true, status: 200, url: FEED, arrayBuffer: async () => encoded(offering) })

  it('refuses a feed the check does not take, with one sober sentence', async () => {
    const seen: Uint8Array[] = []
    const answer = await feedAnswer(FEED, response(), (bytes) => (seen.push(bytes), null))
    expect(answer).toEqual({ ok: false, reason: expect.stringMatching(/^Le flux de mises à jour n’a pas de signature valide\s: aucune mise à jour n’est proposée\.$/) })
    // The check was given the very bytes the server sent.
    expect(new TextDecoder().decode(seen[0])).toBe(JSON.stringify(offering))
  })

  it('then offers no version and says of no version that it was withdrawn', async () => {
    const answer = await feedAnswer(FEED, response(), () => null)
    expect(updateOutcome('0.3.1', FEED, answer)).toEqual({ kind: 'failed', reason: expect.stringMatching(/^Le flux de mises à jour n’a pas de signature valide\s: aucune mise à jour n’est proposée\.$/) })
    // The same feed, signed, would have said both.
    expect(updateOutcome('0.3.1', FEED, await feedAnswer(FEED, response(), asIs))).toMatchObject({ kind: 'withdrawn' })
  })

  it('reads only the bytes the check says were signed, never the rest of the body', async () => {
    const signedPart = new TextEncoder().encode(JSON.stringify({ tag_name: 'v1.0.0', html_url: 'https://example.com/signed' }))
    expect(await feedAnswer(FEED, response(), () => signedPart)).toEqual({ ok: true, json: { tag_name: 'v1.0.0', html_url: 'https://example.com/signed' } })
  })

  it('is in English for an interface in English', async () => {
    setLanguage('en')
    try {
      expect(await feedAnswer(FEED, response(), () => null)).toEqual({ ok: false, reason: 'The update feed has no valid signature: no update is offered.' })
    } finally {
      setLanguage('fr')
    }
  })
})

describe('downloadedVersion: the version in the release name Squirrel gives', () => {
  it('reads the version of « Lucium X.Y.Z » (the name of the release file), up to four numbers', () => {
    expect(downloadedVersion('Lucium 1.1.3')).toBe('1.1.3')
    expect(downloadedVersion('Lucium 0.2')).toBe('0.2')
    expect(downloadedVersion('Lucium 1.2.3.4')).toBe('1.2.3.4')
  })

  it('reads nothing that is not exactly that: no name, a "v", a suffix, a blank, five numbers, another name, not a text', () => {
    for (const name of [undefined, null, 42, {}, '', 'Lucium', 'Lucium ', '1.1.3', 'lucium 1.1.3', 'Other 1.1.3', 'Lucium v1.1.3', 'Lucium 1.1.3-beta', 'Lucium 1.1.3+wvcus', 'Lucium 1.1.3 ', ' Lucium 1.1.3', 'Lucium  1.1.3', 'Lucium 1.1.3\n', 'Lucium 1.2.3.4.5', 'Lucium 1..3', 'Lucium 1.1.3 beta']) {
      expect(downloadedVersion(name)).toBeNull()
    }
  })
})
