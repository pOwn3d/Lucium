import { describe, expect, it } from 'vitest'
import { suggestedFileName } from './file-names'

const bytes = (text: string): number => new TextEncoder().encode(text).length

describe('suggestedFileName', () => {
  it('keeps an ordinary name', () => {
    expect(suggestedFileName('Rapport 2026.pdf')).toBe('Rapport 2026.pdf')
  })

  it('keeps only the last part of a path of either kind', () => {
    expect(suggestedFileName('../../etc/passwd')).toBe('passwd')
    expect(suggestedFileName('C:\\Windows\\evil.txt')).toBe('evil.txt')
    expect(suggestedFileName('/abs/olute/name.bin')).toBe('name.bin')
  })

  it('never answers a dot name or an empty one', () => {
    for (const raw of ['', '.', '..', '...', '   ', '/', undefined, null, 42, '\u0000']) expect(suggestedFileName(raw)).toBe('téléchargement')
  })

  it('drops the control characters and the characters that reorder the text on screen', () => {
    expect(suggestedFileName('fi\u202Efdp.exe')).toBe('fifdp.exe')
    expect(suggestedFileName('a\u0000b\nc.txt')).toBe('abc.txt')
  })

  it('does not start with a dot (a hidden file) nor end with a dot or a space', () => {
    expect(suggestedFileName('.bashrc')).toBe('bashrc')
    expect(suggestedFileName('name. ')).toBe('name')
  })

  it('is not slowed down by a name of a million characters', () => {
    const started = Date.now()
    expect(bytes(suggestedFileName(`${'a'.repeat(1_000_000)}.pdf`))).toBeLessThanOrEqual(240)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('reads only the first 4096 characters of what a page says, whatever follows', () => {
    expect(suggestedFileName(`${'a'.repeat(10_000)}/tail.pdf`)).toBe('a'.repeat(240))
  })

  it('cuts a very long name in bytes, keeping its extension', () => {
    const long = `${'é'.repeat(300)}.pdf`
    const out = suggestedFileName(long)
    // "é" is two bytes: 118 of them and ".pdf" fill the 240 bytes exactly, and no character is split.
    expect(out).toBe(`${'é'.repeat(118)}.pdf`)
    expect(bytes(out)).toBe(240)
  })

  it('drops an "extension" too long to be one, rather than let it carry the name past the bound', () => {
    const out = suggestedFileName(`${'a'.repeat(300)}.${'b'.repeat(300)}`)
    expect(bytes(out)).toBeLessThanOrEqual(240)
    expect(out).toBe('a'.repeat(240))
  })
})

describe('suggestedFileName on Windows (rules written from the documentation, not tried on a Windows machine)', () => {
  const win = { platform: 'win32' } as const

  it('leaves macOS and Linux as they were: a colon, a question mark and a device name are kept', () => {
    for (const options of [{}, { platform: 'darwin' as const }, { platform: 'linux' as const }]) {
      expect(suggestedFileName('a:b?c*d.txt', options)).toBe('a:b?c*d.txt')
      expect(suggestedFileName('CON.txt', options)).toBe('CON.txt')
      expect(suggestedFileName(`${'é'.repeat(300)}.pdf`, options)).toBe(`${'é'.repeat(118)}.pdf`)
    }
  })

  it('replaces the characters the file systems of Windows refuse', () => {
    expect(suggestedFileName('Rapport: <final> "v2" | a?b*c.pdf', win)).toBe('Rapport_ _final_ _v2_ _ a_b_c.pdf')
    expect(suggestedFileName('12:30.txt', win)).toBe('12_30.txt')
  })

  it('puts an underscore in front of a device name, with or without an extension, in any case', () => {
    for (const device of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'COM0', 'LPT1', 'lpt9', 'LPT0', 'COM\u00b2', 'LPT\u00b3']) {
      expect(suggestedFileName(device, win)).toBe(`_${device}`)
      expect(suggestedFileName(`${device}.txt`, win)).toBe(`_${device}.txt`)
    }
    // The device is what comes before the first dot, and spaces before that dot do not save it.
    expect(suggestedFileName('nul.tar.gz', win)).toBe('_nul.tar.gz')
    expect(suggestedFileName('CON .txt', win)).toBe('_CON .txt')
  })

  it('does not touch a name that only looks like a device', () => {
    for (const name of ['CONSOLE.txt', 'communique.pdf', 'COM10.txt', 'COM.txt', 'aux-notes.md', 'xcon.txt', 'LPT.txt', 'my.con']) expect(suggestedFileName(name, win)).toBe(name)
  })

  it('drops the dots and spaces at the end, which Windows silently removes', () => {
    expect(suggestedFileName('name. . ', win)).toBe('name')
    expect(suggestedFileName('rapport?.', win)).toBe('rapport_')
  })

  it('counts the length in UTF-16 units: a long accented name is not cut as early as in bytes, and an emoji counts for two', () => {
    expect(suggestedFileName(`${'é'.repeat(300)}.pdf`, win)).toBe(`${'é'.repeat(236)}.pdf`)
    const emoji = suggestedFileName(`${'😀'.repeat(200)}.png`, win)
    expect(emoji).toBe(`${'😀'.repeat(118)}.png`)
    expect(emoji.length).toBe(240)
  })

  it('keeps the whole path under MAX_PATH when it is told the folder', () => {
    const root = 'C:\\Users\\Christophe\\Downloads'
    const folder = `${root}\\`
    const name = suggestedFileName(`${'a'.repeat(300)}.pdf`, { platform: 'win32', folder })
    // 259 - the folder (its last separator is not counted twice) - one separator - the room of " (12345)" for a duplicate.
    expect(name.length).toBe(259 - root.length - 1 - 8)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(`${folder}${name}`.length + 8).toBeLessThanOrEqual(259)
    // The folder given without its last separator makes the same name.
    expect(suggestedFileName(`${'a'.repeat(300)}.pdf`, { platform: 'win32', folder: root })).toBe(name)
  })

  it('never goes below a readable length, and never above 240 for a short folder', () => {
    expect(suggestedFileName('b'.repeat(300), { platform: 'win32', folder: `C:\\${'d'.repeat(250)}` })).toBe('b'.repeat(32))
    expect(suggestedFileName('b'.repeat(300), { platform: 'win32', folder: 'C:\\' })).toBe('b'.repeat(240))
  })

  it('does not cut a character in two when the folder is deep', () => {
    const name = suggestedFileName(`${'😀'.repeat(100)}.png`, { platform: 'win32', folder: `C:\\${'d'.repeat(190)}` })
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    expect(name.endsWith('.png')).toBe(true)
  })

  it('keeps a name made of "CON" cut by the length unchanged in kind: a long stem is not a device', () => {
    expect(suggestedFileName(`CON${'x'.repeat(300)}.txt`, win).startsWith('CONx')).toBe(true)
  })
})
