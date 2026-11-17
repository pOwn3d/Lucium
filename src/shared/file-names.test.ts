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
