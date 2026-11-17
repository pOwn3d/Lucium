// "Copier" and "Coller" on the row of the genres of the command bar: what is put in the field from the clipboard, what is put on the
// clipboard from the field, and what crosses between the interface and the main process.

import { describe, expect, it } from 'vitest'
import { BAR_PASTE_MAX, pasteIntoBar, textToCopy } from './command-bar'
import { CLIPBOARD_TEXT_MAX, isClipboardTextReply, isClipboardWrite } from './clipboard-text'
import { TAB_URL_MAX } from './state-clean'

const text = (value: string) => ({ ok: true, text: value })

describe('pasteIntoBar', () => {
  it('keeps a one-line text as it is, and an address whole', () => {
    expect(pasteIntoBar('https://example.org/a?b=c#d')).toEqual(text('https://example.org/a?b=c#d'))
    expect(pasteIntoBar('planète 2026')).toEqual(text('planète 2026'))
  })

  it('trims the ends: spaces, tabs and line breaks around the text go', () => {
    expect(pasteIntoBar('  \t https://example.org/ \n ')).toEqual(text('https://example.org/'))
  })

  it.each([
    ['LF', 'une\nligne'],
    ['CRLF', 'une\r\nligne'],
    ['CR', 'une\rligne'],
    ['NEL (U+0085)', 'une\u0085ligne'],
    ['line separator (U+2028)', 'une ligne'],
    ['paragraph separator (U+2029)', 'une ligne'],
    ['vertical tab and form feed', 'une\u000b\u000cligne'],
    ['tab', 'une\tligne'],
    ['no-break space', 'une ligne'],
    ['a blank line between', 'une\n\n\nligne'],
    ['spaces and a break', 'une \n  ligne']
  ])('brings %s down to one space, on one line', (_name, raw) => {
    expect(pasteIntoBar(raw)).toEqual(text('une ligne'))
  })

  it('brings a text of several lines to one line, the lines in order', () => {
    expect(pasteIntoBar('a\nb\r\nc\rd')).toEqual(text('a b c d'))
    expect(pasteIntoBar('https://example.org/\nhttps://example.net/')).toEqual(text('https://example.org/ https://example.net/'))
  })

  it('removes the control characters that are not white space, and leaves no double space where they were', () => {
    expect(pasteIntoBar('a\u0000b\u0007c\u001bd\u007fe\u009ff')).toEqual(text('abcdef'))
    expect(pasteIntoBar('un \u0001 deux')).toEqual(text('un deux'))
    expect(pasteIntoBar('\u0000\u0001https://example.org/\u0002')).toEqual(text('https://example.org/'))
  })

  it('drops what draws nothing or reverses the reading, so that a pasted address cannot read as another one', () => {
    expect(pasteIntoBar('https://exam\u200Bple.com/\u202Efdp.exe\u2066x\u2069\uFEFF\u200E\u200F')).toEqual({ ok: true, text: 'https://example.com/fdp.exex' })
    // The joiner of the emoji sequences stays: a search for a family emoji is not broken.
    expect(pasteIntoBar('👨\u200D👩\u200D👧')).toEqual({ ok: true, text: '👨\u200D👩\u200D👧' })
    expect(pasteIntoBar('\u200B\u202E')).toEqual({ ok: false, reason: 'empty' })
  })

  it('says there is nothing to put when the clipboard holds nothing, or nothing but white space and control characters', () => {
    for (const raw of ['', ' ', '\n', ' \r\n\t ', '  ', '\u0000\u0001', ' \u0000 \n']) expect(pasteIntoBar(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: 'empty' })
  })

  it('says there is nothing to put for what is not a text', () => {
    for (const raw of [undefined, null, 0, 42, true, [], ['a'], {}, { text: 'a' }]) expect(pasteIntoBar(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: 'empty' })
  })

  it('takes a text of exactly BAR_PASTE_MAX characters and refuses one more, without cutting it', () => {
    expect(BAR_PASTE_MAX).toBe(4096)
    const longest = 'a'.repeat(BAR_PASTE_MAX)
    expect(pasteIntoBar(longest)).toEqual(text(longest))
    expect(pasteIntoBar(longest + 'a')).toEqual({ ok: false, reason: 'too-long' })
    expect(pasteIntoBar('a'.repeat(1_000_000))).toEqual({ ok: false, reason: 'too-long' })
  })

  it('measures the text once it is on one line, not as the clipboard holds it', () => {
    // 1 000 words separated by long runs of line breaks: over the limit as written, a text within it once on one line.
    const spaced = Array.from({ length: 1000 }, () => 'mot').join('\n\n\n\n\n\n\n')
    expect(spaced.length).toBeGreaterThan(BAR_PASTE_MAX)
    expect(pasteIntoBar(spaced)).toEqual(text(Array.from({ length: 1000 }, () => 'mot').join(' ')))
    // The other way round: many short words, whose spaces count.
    expect(pasteIntoBar('a '.repeat(BAR_PASTE_MAX))).toEqual({ ok: false, reason: 'too-long' })
  })

  it('does not read anything as markup: a text with tags comes back character for character', () => {
    expect(pasteIntoBar('<img src=x onerror=alert(1)> & <b>gras</b>')).toEqual(text('<img src=x onerror=alert(1)> & <b>gras</b>'))
    expect(pasteIntoBar('javascript:alert(1)')).toEqual(text('javascript:alert(1)'))
  })
})

describe('textToCopy', () => {
  it('copies what the field holds, as it is', () => {
    expect(textToCopy('https://example.org/', 'https://tab.example/')).toBe('https://example.org/')
    expect(textToCopy('planète  2026 ', 'https://tab.example/')).toBe('planète  2026 ')
  })

  it('copies the address of the tab when the field is empty, or has nothing but white space in it', () => {
    for (const field of ['', ' ', '\t', ' \n ']) expect(textToCopy(field, 'https://tab.example/'), JSON.stringify(field)).toBe('https://tab.example/')
  })

  it('has nothing to copy when the field is empty and there is no tab address', () => {
    for (const tab of [null, undefined, '']) expect(textToCopy('', tab), String(tab)).toBeNull()
    expect(textToCopy('  ', null)).toBeNull()
  })

  it('prefers the field to the tab when there is something in it', () => {
    expect(textToCopy('a', null)).toBe('a')
    expect(textToCopy('a', 'https://tab.example/')).toBe('a')
  })
})

describe('what crosses to the main process (shared/clipboard-text.ts)', () => {
  it('allows a text of 1 to CLIPBOARD_TEXT_MAX characters to be written, and nothing else', () => {
    expect(isClipboardWrite('a')).toBe(true)
    expect(isClipboardWrite('a'.repeat(CLIPBOARD_TEXT_MAX))).toBe(true)
    for (const bad of ['', 'a'.repeat(CLIPBOARD_TEXT_MAX + 1), undefined, null, 1, true, [], ['a'], {}, { toString: () => 'a' }]) expect(isClipboardWrite(bad), JSON.stringify(bad)?.slice(0, 20)).toBe(false)
  })

  it('is as long as an address a tab can hold, since "Copier" on an empty field copies that address', () => {
    expect(CLIPBOARD_TEXT_MAX).toBeGreaterThanOrEqual(TAB_URL_MAX)
    expect(CLIPBOARD_TEXT_MAX).toBeGreaterThan(BAR_PASTE_MAX)
  })

  it('recognises the three answers of the main process to a read, and no other shape', () => {
    expect(isClipboardTextReply({ ok: true, text: '' })).toBe(true)
    expect(isClipboardTextReply({ ok: true, text: 'a' })).toBe(true)
    expect(isClipboardTextReply({ ok: false, reason: 'unreadable' })).toBe(true)
    expect(isClipboardTextReply({ ok: false, reason: 'too-long' })).toBe(true)
    for (const bad of [null, undefined, 'a', 1, [], {}, { ok: true }, { ok: true, text: 1 }, { ok: false }, { ok: false, reason: 'other' }, { ok: 'true', text: 'a' }]) expect(isClipboardTextReply(bad), JSON.stringify(bad)).toBe(false)
  })
})
