// What "Copier" and "Coller" do in the command bar, with a bridge that is a fake: every way it can go wrong ends in a sentence on screen and the field as it was.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipboardTextReply } from '@shared/clipboard-text'
import { setLanguage } from '@shared/i18n'
import { BAR_NOTICE_MS, copyFromBar, noticeClock, pasteToBar, type BarClipboardBridge, type BarClipNotice } from './bar-clipboard'

/** A bridge that answers what it is told to, and keeps what was asked of it. */
function bridge(over: Partial<{ read: () => Promise<ClipboardTextReply>; write: (text: string) => Promise<boolean> }> = {}) {
  const written: string[] = []
  const fake: BarClipboardBridge = {
    readClipboardText: over.read ?? (() => Promise.resolve({ ok: true, text: 'https://example.org/' })),
    writeClipboardText: (text) => {
      written.push(text)
      return (over.write ?? (() => Promise.resolve(true)))(text)
    }
  }
  return { fake, written }
}

const problem = (notice: BarClipNotice): string => (notice.kind === 'problem' ? notice.message : `(${notice.kind})`)

beforeEach(() => {
  setLanguage('fr')
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  setLanguage('fr')
})

describe('"Copier"', () => {
  it('puts the text of the field on the clipboard, and says it was copied', async () => {
    const { fake, written } = bridge()
    expect(await copyFromBar(fake, 'https://example.org/page', 'https://tab.example/')).toEqual({ kind: 'copied' })
    expect(written).toEqual(['https://example.org/page'])
  })

  it('puts the address of the tab on the clipboard when the field is empty', async () => {
    const { fake, written } = bridge()
    expect(await copyFromBar(fake, '', 'https://tab.example/')).toEqual({ kind: 'copied' })
    expect(await copyFromBar(fake, '   ', 'https://tab.example/')).toEqual({ kind: 'copied' })
    expect(written).toEqual(['https://tab.example/', 'https://tab.example/'])
  })

  it('says there is nothing to copy, and writes nothing, when the field is empty and there is no tab', async () => {
    const { fake, written } = bridge()
    const notice = await copyFromBar(fake, '', null)
    expect(problem(notice)).toBe('Rien à copier.')
    expect(written).toEqual([])
  })

  it('says the copy failed when the main process refuses the text', async () => {
    const { fake } = bridge({ write: () => Promise.resolve(false) })
    expect(problem(await copyFromBar(fake, 'a', null))).toBe('Copie impossible.')
  })

  it('says the copy failed, and logs why, when the clipboard throws', async () => {
    const { fake } = bridge({ write: () => Promise.reject(new TypeError('the clipboard is busy')) })
    expect(problem(await copyFromBar(fake, 'a', null))).toBe('Copie impossible.')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('the copy failed'), 'TypeError')
  })

  it('says it in English when the interface is in English', async () => {
    setLanguage('en')
    const { fake } = bridge({ write: () => Promise.resolve(false) })
    expect(problem(await copyFromBar(fake, 'a', null))).toBe('Copy failed.')
    expect(problem(await copyFromBar(fake, '', null))).toBe('Nothing to copy.')
  })
})

describe('"Coller"', () => {
  const clipboardHolds = (value: ClipboardTextReply) => bridge({ read: () => Promise.resolve(value) }).fake

  it('gives the text of the clipboard, on one line', async () => {
    expect(await pasteToBar(clipboardHolds({ ok: true, text: '  https://example.org/\r\nsuite  ' }))).toEqual({ text: 'https://example.org/ suite' })
  })

  it('leaves the field as it is, and says why, when the clipboard has no text', async () => {
    for (const text of ['', '   ', '\n\r\n', '\u0000']) {
      const out = await pasteToBar(clipboardHolds({ ok: true, text }))
      expect('notice' in out && problem(out.notice), JSON.stringify(text)).toBe('Aucun texte à coller.')
    }
  })

  it('leaves the field as it is, and says why, when the text is too long', async () => {
    const tooLongForTheBar = await pasteToBar(clipboardHolds({ ok: true, text: 'a'.repeat(5000) }))
    expect('notice' in tooLongForTheBar && problem(tooLongForTheBar.notice)).toBe('Texte trop long à coller.')
    const tooLongForTheChannel = await pasteToBar(clipboardHolds({ ok: false, reason: 'too-long' }))
    expect('notice' in tooLongForTheChannel && problem(tooLongForTheChannel.notice)).toBe('Texte trop long à coller.')
  })

  it('leaves the field as it is, and says the clipboard cannot be read, when the main process could not read it', async () => {
    const out = await pasteToBar(clipboardHolds({ ok: false, reason: 'unreadable' }))
    expect('notice' in out && problem(out.notice)).toBe('Lecture du presse-papiers impossible.')
  })

  it('leaves the field as it is, says so, and logs why, when the clipboard throws', async () => {
    const fake = bridge({ read: () => Promise.reject(new Error('no clipboard')) }).fake
    const out = await pasteToBar(fake)
    expect('notice' in out && problem(out.notice)).toBe('Lecture du presse-papiers impossible.')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('the paste failed'), 'Error')
  })

  it('does not take an answer that is not of the shape promised for a text', async () => {
    for (const garbage of [undefined, null, 'https://example.org/', 42, {}, { ok: true }, { ok: true, text: 7 }, { ok: false, reason: 'other' }, { text: 'a' }]) {
      const out = await pasteToBar(clipboardHolds(garbage as never))
      expect('notice' in out && problem(out.notice), JSON.stringify(garbage)).toBe('Lecture du presse-papiers impossible.')
    }
  })

  it('says it in English when the interface is in English', async () => {
    setLanguage('en')
    const empty = await pasteToBar(clipboardHolds({ ok: true, text: '' }))
    expect('notice' in empty && problem(empty.notice)).toBe('No text to paste.')
    const unreadable = await pasteToBar(clipboardHolds({ ok: false, reason: 'unreadable' }))
    expect('notice' in unreadable && problem(unreadable.notice)).toBe('Cannot read the clipboard.')
  })
})

describe('the clock of the notice', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps "Copié" for 1.5 seconds, then takes it away', () => {
    const shown: Array<BarClipNotice | null> = []
    const clock = noticeClock((notice) => shown.push(notice))
    clock.say({ kind: 'copied' })
    expect(BAR_NOTICE_MS.copied).toBe(1500)
    vi.advanceTimersByTime(1499)
    expect(shown).toEqual([{ kind: 'copied' }])
    vi.advanceTimersByTime(1)
    expect(shown).toEqual([{ kind: 'copied' }, null])
  })

  it('keeps the sentence of a problem longer, so that it can be read', () => {
    const shown: Array<BarClipNotice | null> = []
    const clock = noticeClock((notice) => shown.push(notice))
    clock.say({ kind: 'problem', message: 'Aucun texte à coller.' })
    vi.advanceTimersByTime(BAR_NOTICE_MS.copied + 1)
    expect(shown).toHaveLength(1)
    vi.advanceTimersByTime(BAR_NOTICE_MS.problem)
    expect(shown.at(-1)).toBeNull()
    expect(BAR_NOTICE_MS.problem).toBeGreaterThan(BAR_NOTICE_MS.copied)
  })

  it('starts the count again when a second notice comes: the first one cannot take the second away', () => {
    const shown: Array<BarClipNotice | null> = []
    const clock = noticeClock((notice) => shown.push(notice))
    clock.say({ kind: 'copied' })
    vi.advanceTimersByTime(1000)
    clock.say({ kind: 'copied' })
    vi.advanceTimersByTime(1000)
    // 2 s after the first, 1 s after the second: still there.
    expect(shown.at(-1)).toEqual({ kind: 'copied' })
    vi.advanceTimersByTime(500)
    expect(shown.at(-1)).toBeNull()
  })

  it('leaves nothing running once stopped (the bar closed)', () => {
    const shown: Array<BarClipNotice | null> = []
    const clock = noticeClock((notice) => shown.push(notice))
    clock.say({ kind: 'copied' })
    clock.stop()
    vi.advanceTimersByTime(10_000)
    expect(shown).toEqual([{ kind: 'copied' }])
    expect(vi.getTimerCount()).toBe(0)
  })
})
