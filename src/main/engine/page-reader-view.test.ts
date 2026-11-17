// The look at a watched page as the engine makes it (page-reader.ts), over a view that is an event emitter: where the script runs, and what
// is kept of its answer. The page is a page like any other: the bound on the text it gives is applied out of its reach (an isolated world),
// and once more in this process, so that no answer makes the main process work on more than the bound.

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAGE_WATCH_TEXT_MAX } from '@shared/page-watch'

interface FakeContents extends EventEmitter {
  id: number
  closed: boolean
  /** What the script is answered, in the isolated world. */
  answer: unknown
  isolated: Array<{ world: number; code: string }>
  pageWorld: string[]
}

const views = vi.hoisted(() => [] as Array<{ webContents: FakeContents }>)

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  let nextId = 700
  class WebContentsView {
    webContents = Object.assign(new EventEmitter(), {
      id: ++nextId,
      closed: false,
      answer: { text: 'le texte' } as unknown,
      isolated: [] as Array<{ world: number; code: string }>,
      pageWorld: [] as string[],
      setAudioMuted() {},
      setWindowOpenHandler() {},
      isDestroyed(): boolean {
        return this.closed
      },
      close() {
        this.closed = true
      },
      loadURL() {
        return Promise.resolve()
      },
      executeJavaScript(code: string) {
        this.pageWorld.push(code)
        return Promise.resolve({ text: 'what the page chose to answer' })
      },
      executeJavaScriptInIsolatedWorld(world: number, sources: Array<{ code: string }>) {
        this.isolated.push({ world, code: sources[0]!.code })
        return this.answer instanceof Error ? Promise.reject(this.answer) : Promise.resolve(this.answer)
      }
    })
    constructor() {
      views.push(this as never)
    }
  }
  return { WebContentsView, BrowserWindow: class {} }
})

const { PAGE_WATCH_WORLD, extractScript, isReading, readAnswer, readPageText } = await import('./page-reader')

/** Starts a look, lets the page load, and gives the outcome with the view it was made in. */
async function look(answer: unknown, selector?: string) {
  const outcome = readPageText({} as never, 'https://example.org/prix', { ...(selector ? { selector } : {}), settleMs: 0 })
  const wc = views.at(-1)!.webContents
  wc.answer = answer
  wc.emit('did-finish-load')
  return { outcome: await outcome, wc }
}

afterEach(() => {
  views.length = 0
})

describe('where the script that reads a watched page runs', () => {
  it('runs in an isolated world of its own, never in the world of the page', async () => {
    const { outcome, wc } = await look({ text: 'le texte' }, '#prix')
    expect(outcome).toEqual({ ok: true, text: 'le texte' })
    expect(wc.isolated).toEqual([{ world: PAGE_WATCH_WORLD, code: extractScript('#prix') }])
    expect(wc.pageWorld).toEqual([])
    expect(PAGE_WATCH_WORLD).toBeGreaterThan(1 << 20)
    expect(wc.closed).toBe(true)
    expect(isReading()).toBe(false)
  })

  it('says the page could not be read when the script is refused, and leaves nothing behind', async () => {
    const { outcome, wc } = await look(new Error('Script failed to execute'))
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('Script failed to execute') })
    expect(wc.closed).toBe(true)
    expect(isReading()).toBe(false)
  })
})

describe('what is kept of the answer of the page', () => {
  it('cuts in this process a text longer than the bound, whatever the script was meant to do', async () => {
    const { outcome } = await look({ text: 'x'.repeat(PAGE_WATCH_TEXT_MAX * 3) })
    expect(outcome.ok && outcome.text.length).toBe(PAGE_WATCH_TEXT_MAX)
  })

  it('keeps a text of exactly the bound whole', () => {
    const text = 'y'.repeat(PAGE_WATCH_TEXT_MAX)
    expect(readAnswer({ text }, undefined)).toEqual({ ok: true, text })
  })

  it('says what is missing, with the sentence of the page or of the zone', () => {
    expect(readAnswer({ missing: true }, undefined)).toEqual({ ok: false, error: 'La page est vide.' })
    expect(readAnswer({ missing: true }, '#prix').ok).toBe(false)
    expect(readAnswer({ missing: true }, '#prix')).not.toEqual(readAnswer({ missing: true }, undefined))
  })

  it('bounds the sentence of an error, and takes anything else for a page that gave no text', () => {
    const long = readAnswer({ error: 'e'.repeat(5_000_000) }, '#prix')
    expect(long.ok).toBe(false)
    expect(!long.ok && long.error.length).toBeLessThanOrEqual(160)
    for (const answer of [null, undefined, 12, 'text', { text: 12 }, { text: ['a'] }, []]) expect(readAnswer(answer, undefined), JSON.stringify(answer)).toEqual({ ok: false, error: 'La page n’a pas livré son texte.' })
  })
})
