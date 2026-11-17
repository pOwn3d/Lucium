// The language of a page, read once per document while the translation is on (electron-page.ts): what is said when it cannot be read. The
// web contents are fakes (electron-page.test-support.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePage, settle } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

afterEach(() => vi.restoreAllMocks())

describe('the language of a page without a lang attribute', () => {
  it('says in the journal when its text could not be sampled, and offers no translation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const update = vi.fn()
    const { page, wc } = await makePage({ events: { readsLanguage: () => true, update } })
    wc.url = 'https://journal.example/'
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce('').mockRejectedValueOnce(new Error('the frame was disposed'))
    wc.emit('did-stop-loading')
    await settle()
    await settle()
    expect(warn.mock.calls.map((call) => `${String(call[0])} ${String(call[1])}`)).toContainEqual(`[engine] the text of page ${page.id} could not be sampled for its language; no translation is offered: the frame was disposed`)
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ pageLanguage: expect.stringMatching(/./) }))
  })
})

describe('the language read for a document the page has left', () => {
  /** A promise the test settles when it says so. */
  const deferred = () => {
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<unknown>((ok, fail) => ((resolve = ok), (reject = fail)))
    return { promise, resolve, reject }
  }
  const published = (update: ReturnType<typeof vi.fn>) => update.mock.calls.map(([patch]) => (patch as { pageLanguage?: string }).pageLanguage).filter((language) => language !== undefined)

  it('is not published for the next document: its answer came after the navigation', async () => {
    const update = vi.fn()
    const { wc } = await makePage({ events: { readsLanguage: () => true, translateTarget: () => 'fr', update } })
    wc.url = 'https://allemand.example/'
    const late = deferred()
    wc.executeJavaScriptInIsolatedWorld.mockReturnValueOnce(late.promise as never).mockResolvedValueOnce('en' as never)
    wc.emit('did-stop-loading')
    // The user goes on before the first page said its language.
    wc.url = 'https://anglais.example/'
    wc.emit('did-navigate', {}, wc.url)
    late.resolve('de')
    await settle()
    expect(published(update)).toEqual([])
    // The document on show is read in its turn, and its own language is the one published.
    wc.emit('did-stop-loading')
    await settle()
    expect(published(update)).toEqual(['en'])
  })

  it('is not published either when the late answer is the sample of its text', async () => {
    const update = vi.fn()
    const { wc } = await makePage({ events: { readsLanguage: () => true, translateTarget: () => 'fr', update } })
    wc.url = 'https://allemand.example/'
    const late = deferred()
    // No lang attribute: the text is sampled, and that answer comes after the navigation.
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce('' as never).mockReturnValueOnce(late.promise as never)
    wc.emit('did-stop-loading')
    await settle()
    wc.url = 'https://anglais.example/'
    wc.emit('did-navigate', {}, wc.url)
    late.resolve({ text: 'Die Bundesregierung hat heute in Berlin beschlossen, dass die neuen Regeln für alle Bürgerinnen und Bürger ab dem kommenden Jahr gelten werden. Das ist eine wichtige Entscheidung für das ganze Land und seine Menschen.' })
    await settle()
    expect(published(update)).toEqual([])
  })

  // The lang attribute could not be read; or it was empty and the sample of the text could not be made.
  it.each([
    ['lang', [] as unknown[], 'the language of page {id} could not be read; no translation is offered:'],
    ['sample', [''], 'the text of page {id} could not be sampled for its language; no translation is offered:']
  ] as const)('says in the journal that the reading of the document it left failed (%s), and leaves the new document to its own reading', async (_step, before, said) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const update = vi.fn()
    const { page, wc } = await makePage({ events: { readsLanguage: () => true, translateTarget: () => 'fr', update } })
    wc.url = 'https://allemand.example/'
    const late = deferred()
    for (const answer of before) wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(answer as never)
    wc.executeJavaScriptInIsolatedWorld.mockReturnValueOnce(late.promise as never).mockResolvedValueOnce('en' as never)
    wc.emit('did-stop-loading')
    await settle()
    wc.url = 'https://anglais.example/'
    wc.emit('did-navigate', {}, wc.url)
    // The new document is read, and said, before the failure of the old reading comes back.
    wc.emit('did-stop-loading')
    await settle()
    expect(published(update)).toEqual(['en'])
    late.reject(new Error('the frame was disposed'))
    await settle()
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(`[engine] ${said.replace('{id}', page.id)}`)
    // The language of the document on show stands, and it is not read again: a frame that ends its loading afterwards reads nothing more.
    expect(published(update)).toEqual(['en'])
    const reads = wc.executeJavaScriptInIsolatedWorld.mock.calls.length
    wc.emit('did-stop-loading')
    await settle()
    expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(reads)
  })
})
