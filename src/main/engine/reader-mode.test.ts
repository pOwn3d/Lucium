// The reader and the page under it (reader-mode.ts): the article shown is always the one of the document the tab shows. A navigation may be
// under way when the reader is asked for (a slow server, a redirect that takes its time): the page of before is still on screen, so it can be
// read, but the reader never outlives the arrival of the next document, whose address the bar would show over the text of the other.
// ReaderMode runs here without Electron: the web contents is an event emitter, the cover laid over the page is a fake.

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_ARTICLE_CHARS } from '@shared/reader'

class FakeCover {
  static made: FakeCover[] = []
  /** When set, `load` waits for the test to let it go. */
  static hold: Promise<void> | null = null
  readonly webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => undefined, isDestroyed: () => false, setZoomFactor: () => undefined })
  readonly loaded: string[] = []
  disposed = false
  placed = 0
  constructor() {
    FakeCover.made.push(this)
  }
  load(html: string): Promise<void> {
    this.loaded.push(html)
    return FakeCover.hold ?? Promise.resolve()
  }
  place(): void {
    this.placed++
  }
  focus(): void {}
  raise(): void {}
  dispose(): void {
    this.disposed = true
  }
}

vi.mock('./page-cover', () => ({ PageCover: FakeCover }))

const { ReaderMode } = await import('./reader-mode')

const ARTICLE = { title: 'Article de A', content: `<p>${'mot '.repeat(MIN_ARTICLE_CHARS)}</p>`, textLength: MIN_ARTICLE_CHARS * 4 }

class FakePage extends EventEmitter {
  readonly session = {}
  url = 'https://a.example/article'
  /** The extractions asked for, each answered when the test says. */
  readonly extractions: Array<(article: unknown) => void> = []
  getURL(): string {
    return this.url
  }
  isDestroyed(): boolean {
    return false
  }
  focus(): void {}
  executeJavaScriptInIsolatedWorld(): Promise<unknown> {
    return new Promise((resolve) => this.extractions.push(resolve))
  }
  /** A navigation of the main frame to another document starts: the page of before stays on screen. */
  starts(): void {
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  }
  /** The next document arrives: the address of the tab is now its own. */
  arrives(url: string): void {
    this.url = url
    this.emit('did-navigate', {}, url)
  }
}

function page() {
  const wc = new FakePage()
  const reader = new ReaderMode(wc as never, { win: {} as never, radius: 8, navigate: () => undefined })
  return { wc, reader }
}

beforeEach(() => {
  FakeCover.made = []
  FakeCover.hold = null
})

describe('the reader and the document under it', () => {
  it('closes when another document arrives, even when no navigation was seen to start since it opened', async () => {
    const { wc, reader } = page()
    // The navigation started before the reader was asked for: the server has not answered yet.
    wc.starts()
    const outcome = reader.open()
    wc.extractions[0]!(ARTICLE)
    expect(await outcome).toBe('opened')
    const cover = FakeCover.made[0]!
    expect(cover.loaded[0]).toContain('Article de A')
    wc.arrives('https://b.example/')
    expect(reader.isOpen()).toBe(false)
    expect(cover.disposed).toBe(true)
  })

  it('closes when a navigation starts while it is open, as before', async () => {
    const { wc, reader } = page()
    const outcome = reader.open()
    wc.extractions[0]!(ARTICLE)
    expect(await outcome).toBe('opened')
    wc.starts()
    expect(reader.isOpen()).toBe(false)
  })

  it('does not open over a document that arrived while the article of the one before was extracted', async () => {
    const { wc, reader } = page()
    const outcome = reader.open()
    wc.starts()
    wc.arrives('https://b.example/')
    wc.extractions[0]!(ARTICLE)
    expect(await outcome).toBe('unavailable')
    expect(FakeCover.made).toEqual([])
    expect(reader.isOpen()).toBe(false)
  })

  it('does not say it is open when the document arrived while its cover loaded', async () => {
    let release = (): void => undefined
    FakeCover.hold = new Promise<void>((resolve) => (release = resolve))
    const { wc, reader } = page()
    const outcome = reader.open()
    wc.extractions[0]!(ARTICLE)
    await vi.waitFor(() => expect(FakeCover.made).toHaveLength(1))
    wc.arrives('https://b.example/')
    release()
    expect(await outcome).toBe('unavailable')
    expect(FakeCover.made[0]!.disposed).toBe(true)
    expect(FakeCover.made[0]!.placed).toBe(0)
  })

  it('can be opened again on the document that arrived', async () => {
    const { wc, reader } = page()
    const first = reader.open()
    wc.arrives('https://b.example/')
    wc.extractions[0]!(ARTICLE)
    expect(await first).toBe('unavailable')
    const second = reader.open()
    wc.extractions[1]!({ ...ARTICLE, title: 'Article de B' })
    expect(await second).toBe('opened')
    expect(FakeCover.made).toHaveLength(1)
    expect(FakeCover.made[0]!.loaded[0]).toContain('Article de B')
    expect(FakeCover.made[0]!.loaded[0]).toContain('b.example')
  })
})
