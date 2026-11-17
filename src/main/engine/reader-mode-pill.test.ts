// The pill of the reader lives in the cover of the page: it is there while the reader is open and goes with the cover when the reader is left.
// The document and the script are tested in src/shared/reader-pill.test.ts; here ReaderMode (reader-mode.ts) runs on a page without Electron: the
// web contents is an event emitter that answers the extraction with an article, and the cover laid over the page is a fake.

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_ARTICLE_CHARS } from '@shared/reader'

class FakeCoverContents extends EventEmitter {
  zoom = 1
  setWindowOpenHandler(): void {}
  isDestroyed(): boolean {
    return false
  }
  setZoomFactor(factor: number): void {
    this.zoom = factor
  }
}

class FakeCover {
  static made: FakeCover[] = []
  readonly webContents = new FakeCoverContents()
  readonly loaded: string[] = []
  disposed = false
  constructor() {
    FakeCover.made.push(this)
  }
  load(html: string): Promise<void> {
    this.loaded.push(html)
    return Promise.resolve()
  }
  place(): void {}
  focus(): void {}
  raise(): void {}
  dispose(): void {
    this.disposed = true
  }
  /** The nonce the document of this cover runs its one script under (written into its policy). */
  nonce(): string {
    return /'nonce-([^']+)'/.exec(this.loaded.at(-1) ?? '')![1]!
  }
}

vi.mock('./page-cover', () => ({ PageCover: FakeCover }))

const { ReaderMode } = await import('./reader-mode')

class FakePage extends EventEmitter {
  readonly session = {}
  focused = 0
  getURL(): string {
    return 'https://journal.example/article'
  }
  isDestroyed(): boolean {
    return false
  }
  focus(): void {
    this.focused++
  }
  executeJavaScriptInIsolatedWorld(): Promise<unknown> {
    return Promise.resolve({ title: 'Un article', content: `<p>${'mot '.repeat(MIN_ARTICLE_CHARS)}</p>`, textLength: MIN_ARTICLE_CHARS * 4 })
  }
}

async function opened() {
  const wc = new FakePage()
  const reader = new ReaderMode(wc as never, { win: {} as never, radius: 8, navigate: () => undefined })
  expect(await reader.open()).toBe('opened')
  return { wc, reader, cover: FakeCover.made.at(-1)! }
}

beforeEach(() => {
  FakeCover.made = []
})

describe('the pill of the reader', () => {
  it('is made with the cover of the reader, with the choices it opens with, and under the nonce of that document', async () => {
    const first = await opened()
    const nonce = first.cover.nonce()
    expect(first.cover.loaded[0]).toContain(`const NONCE = ${JSON.stringify(nonce)}`)
    expect(first.cover.loaded[0]).toContain('data-font="serif"')

    // A choice of the pill (its title, under the nonce of the document) is kept for the next article; a title without it is the article's own.
    first.cover.webContents.emit('page-title-updated', {}, `${nonce}:${JSON.stringify({ font: 'sans', size: 2, width: 'wide', theme: 'sepia' })}`)
    first.cover.webContents.emit('page-title-updated', {}, `autre:${JSON.stringify({ font: 'serif', size: 0, width: 'narrow', theme: 'night' })}`)
    first.reader.close()

    const second = await opened()
    expect(second.cover.nonce()).not.toBe(nonce)
    expect(second.cover.loaded[0]).toContain('data-font="sans" data-width="wide" data-theme="sepia" style="--step:2"')
    second.reader.close()
  })

  it('goes with the cover: leaving the reader disposes of the cover and forgets it', async () => {
    const { wc, reader, cover } = await opened()
    expect(reader.isOpen()).toBe(true)
    reader.close()
    expect(cover.disposed).toBe(true)
    expect(reader.isOpen()).toBe(false)
    expect(wc.focused).toBe(1)
    // The next request opens a new cover, not the one that went.
    expect(await reader.toggle()).toBe('opened')
    expect(FakeCover.made).toHaveLength(2)
  })

  it('is left by Escape, by its quit button (the title with the nonce), and by any navigation of the page', async () => {
    const escape = await opened()
    const preventDefault = vi.fn()
    escape.cover.webContents.emit('before-input-event', { preventDefault }, { type: 'keyDown', key: 'a' })
    expect(escape.reader.isOpen()).toBe(true)
    escape.cover.webContents.emit('before-input-event', { preventDefault }, { type: 'keyDown', key: 'Escape' })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(escape.reader.isOpen()).toBe(false)

    const quit = await opened()
    quit.cover.webContents.emit('page-title-updated', {}, 'quit')
    expect(quit.reader.isOpen()).toBe(true)
    quit.cover.webContents.emit('page-title-updated', {}, `${quit.cover.nonce()}:quit`)
    expect(quit.reader.isOpen()).toBe(false)

    const navigation = await opened()
    navigation.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    navigation.wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(navigation.reader.isOpen()).toBe(true)
    navigation.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(navigation.reader.isOpen()).toBe(false)
    expect(navigation.cover.disposed).toBe(true)
  })
})
