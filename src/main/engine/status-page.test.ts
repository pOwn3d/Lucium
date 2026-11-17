// How the engine puts the page of an error status over a blank document (PageErrors in error-pages.ts), run on a page without Electron: the
// web contents is an event emitter (page-errors.test-support.ts) and the cover laid over the page is a fake.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeContents, FakeCover, fakeHost, settle } from './page-errors.test-support'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('./page-cover', async () => ({ PageCover: (await import('./page-errors.test-support')).FakeCover }))

const { PageErrors } = await import('./error-pages')

const BLANK = { textLength: 0, hasContent: false, hasScript: false }

function page() {
  const wc = new FakeContents()
  const host = fakeHost()
  new PageErrors(wc as never, host as never)
  return { wc, host }
}

/** The page commits `url` with `status`, then finishes loading. */
async function load(wc: FakeContents, url: string, status: number): Promise<void> {
  wc.commit(url, status)
  wc.emit('did-finish-load')
  await settle()
}

beforeEach(() => {
  FakeCover.made = []
})
afterEach(() => vi.restoreAllMocks())

describe('a document that answered an error status', () => {
  it('is noted when it commits (a status of 4xx or 5xx on a web address), and forgotten when another one commits', async () => {
    const { wc } = page()
    await load(wc, 'https://site.example/absent', 404)
    expect(wc.looks()).toBe(1)
    await load(wc, 'https://site.example/panne', 503)
    expect(wc.looks()).toBe(2)

    // A status that is not an error, an address that is not on the web: nothing to look at.
    await load(wc, 'https://site.example/', 200)
    await load(wc, 'file:///tmp/absent.html', 404)
    expect(wc.looks()).toBe(2)

    // An error status, then another document commits before the load ends: the first one is forgotten.
    wc.commit('https://site.example/absent', 404)
    wc.commit('https://site.example/', 200)
    wc.emit('did-finish-load')
    await settle()
    expect(wc.looks()).toBe(2)
  })

  it('is looked at once it has loaded, and only once', async () => {
    const { wc } = page()
    wc.facts = { textLength: 12, hasContent: false, hasScript: false }
    wc.commit('https://site.example/absent', 404)
    expect(wc.looks()).toBe(0)
    wc.emit('did-finish-load')
    await settle()
    wc.emit('did-finish-load')
    await settle()
    expect(wc.looks()).toBe(1)
  })

  it('is covered only if it is still the document on screen, nothing else is loading, and it shows nothing', async () => {
    const said = page()
    said.wc.facts = { textLength: 40, hasContent: false, hasScript: false }
    await load(said.wc, 'https://site.example/absent', 404)
    expect(FakeCover.made).toHaveLength(0)

    const loading = page()
    loading.wc.facts = BLANK
    loading.wc.commit('https://site.example/absent', 404)
    loading.wc.loading = true
    loading.wc.emit('did-finish-load')
    await settle()
    expect(FakeCover.made).toHaveLength(0)

    const left = page()
    left.wc.facts = BLANK
    left.wc.commit('https://site.example/absent', 404)
    left.wc.url = 'https://site.example/ailleurs'
    left.wc.emit('did-finish-load')
    await settle()
    expect(FakeCover.made).toHaveLength(0)

    const blank = page()
    blank.wc.facts = BLANK
    await load(blank.wc, 'https://site.example/absent', 404)
    expect(FakeCover.made).toHaveLength(1)
    expect(FakeCover.made[0]!.loaded[0]).toContain('404')
  })

  it('says why when the page could not be looked at, and leaves it as it was', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { wc } = page()
    wc.facts = new Error('the frame went away')
    await load(wc, 'https://site.example/absent', 500)
    expect(warn).toHaveBeenCalledWith('[engine] cannot tell whether the page of an HTTP 500 is blank:', 'the frame went away')
    expect(FakeCover.made).toHaveLength(0)
  })

  it('is covered by a view of ours, with the same retry as a failed load, and the cover goes with the next navigation', async () => {
    const { wc, host } = page()
    wc.facts = BLANK
    await load(wc, 'https://site.example/absent', 404)
    const cover = FakeCover.made[0]!

    // A button that does not carry the nonce of the page on screen is not a click on it.
    cover.click('retry', 'forged')
    expect(host.reload).not.toHaveBeenCalled()
    cover.click('retry')
    expect(host.reload).toHaveBeenCalledTimes(1)

    wc.emit('did-start-loading')
    expect(cover.disposed).toBe(true)
    // The page of the status went with its cover: its buttons answer nothing any more.
    cover.click('retry')
    expect(host.reload).toHaveBeenCalledTimes(1)
  })

  it('does not retry a crashed page: its button is "reload", which takes the cover away first', () => {
    const { wc, host } = page()
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    const cover = FakeCover.made[0]!
    cover.click('retry')
    expect(host.reload).not.toHaveBeenCalled()
    cover.click('reload')
    expect(cover.disposed).toBe(true)
    expect(host.reload).toHaveBeenCalledTimes(1)
  })
})
