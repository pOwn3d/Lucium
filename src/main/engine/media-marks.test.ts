// The scripts of the media player that run in a page with the page's own scripts (media-scripts.ts): pause, play, and the level of a frame.
// They remember, on the media elements, which ones the player paused and the level the page had set. The page can list those marks and read
// their names: they must not name the browser. Run here against a made-up document.

import { describe, expect, it, vi } from 'vitest'
import { MEDIA_PAUSE, MEDIA_PLAY, frameVolumeScript } from './media-scripts'

interface FakeMedia {
  paused: boolean
  ended: boolean
  currentSrc: string
  volume: number
  pause(): void
  play(): Promise<void>
}

function media(over: Partial<FakeMedia> = {}): FakeMedia {
  const element: FakeMedia = {
    paused: false,
    ended: false,
    currentSrc: 'https://media.example/a.mp4',
    volume: 1,
    pause() {
      this.paused = true
    },
    play() {
      this.paused = false
      return Promise.resolve()
    },
    ...over
  }
  return element
}

/** Runs a script in a document that holds these media. */
function run(script: string, elements: FakeMedia[]): unknown {
  const document = { querySelectorAll: (query: string) => (query === '*' ? [] : elements) }
  return new Function('document', `return ${script}`)(document)
}

/** The names of the marks the page can read on an element. */
const marksOf = (element: FakeMedia): string[] => Object.getOwnPropertySymbols(element).map((symbol) => Symbol.keyFor(symbol) ?? String(symbol.description))

describe('pause and play from the media player', () => {
  it('pauses what plays, and play resumes those and not the media the page had paused itself', async () => {
    const playing = media()
    const other = media()
    const pausedByThePage = media({ paused: true })
    expect(run(MEDIA_PAUSE, [playing, other, pausedByThePage])).toBe(true)
    expect([playing.paused, other.paused, pausedByThePage.paused]).toEqual([true, true, true])
    expect(await run(MEDIA_PLAY, [pausedByThePage, playing, other])).toBe(true)
    expect([playing.paused, other.paused, pausedByThePage.paused]).toEqual([false, false, true])
    // Resumed: the mark is gone.
    expect(marksOf(playing)).toEqual([])
  })

  it('plays the first media that has a source when the player paused none', async () => {
    const empty = media({ paused: true, currentSrc: '' })
    const ready = media({ paused: true })
    expect(run(MEDIA_PAUSE, [empty, ready])).toBe(false)
    expect(await run(MEDIA_PLAY, [empty, ready])).toBe(true)
    expect([empty.paused, ready.paused]).toEqual([true, false])
  })
})

describe('the level of a frame', () => {
  it('turns the level the page set by the level of the tab, and takes a level the page changed since as its new one', () => {
    const element = media({ volume: 0.8 })
    expect(run(frameVolumeScript(0.5), [element])).toBe(1)
    expect(element.volume).toBeCloseTo(0.4)
    // The slider moves again: from the level of the page, not from the level it was turned to.
    run(frameVolumeScript(0.25), [element])
    expect(element.volume).toBeCloseTo(0.2)
    // The page sets its own level: that is the one the next move starts from.
    element.volume = 0.6
    run(frameVolumeScript(0.5), [element])
    expect(element.volume).toBeCloseTo(0.3)
  })
})

describe('what these scripts leave for the page to read', () => {
  it('marks the elements under names that say nothing: no name of the browser, of the player or of what was done', () => {
    const element = media({ volume: 0.8 })
    run(MEDIA_PAUSE, [element])
    run(frameVolumeScript(0.5), [element])
    const names = marksOf(element)
    expect(names).toHaveLength(3)
    expect(new Set(names).size).toBe(3)
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(Object.keys(element).some((key) => /lucium/i.test(key))).toBe(false)
  })

  it('never write the name of the browser in the text of a script', () => {
    for (const script of [MEDIA_PAUSE, MEDIA_PLAY, frameVolumeScript(0.5)]) expect(script).not.toMatch(/lucium/i)
  })

  it('draws the names again at each launch: they are not something a page can learn once', async () => {
    const element = media()
    run(MEDIA_PAUSE, [element])
    vi.resetModules()
    const again = await import('./media-scripts')
    const later = media()
    run(again.MEDIA_PAUSE, [later])
    expect(marksOf(later)).toHaveLength(1)
    expect(marksOf(later)).not.toEqual(marksOf(element))
  })
})
