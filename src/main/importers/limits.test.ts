import { describe, expect, it } from 'vitest'
import { TITLE_MAX } from '@shared/state-clean'
import { MAX_URL_LENGTH, displayText, folderName, isWebUrl, linkTitle } from './limits'

describe('isWebUrl', () => {
  it('accepts web addresses the engine can open', () => {
    for (const ok of ['https://a.example/', 'HTTP://A.EXAMPLE/x?y=1#z', 'http://localhost:3000/', 'https://a.example/chemin%20avec%20espace']) expect(isWebUrl(ok), ok).toBe(true)
  })

  it('refuses what only looks like one: a prefix with nothing the URL parser accepts after it', () => {
    for (const bad of ['https://', 'http://', 'http://exa mple/', 'https://a b.example/', 'http://[::1']) expect(isWebUrl(bad), bad).toBe(false)
  })

  it('refuses every other scheme, including those the command bar opens (file, about)', () => {
    for (const bad of ['file:///etc/passwd', 'about:blank', 'javascript:alert(1)', 'chrome://settings', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html', 'data:text/html,hi', 'view-source:https://a.example/', 'place:sort=8']) {
      expect(isWebUrl(bad), bad).toBe(false)
    }
  })

  it('refuses a control character: a newline in an address is never what the bookmark held', () => {
    expect(isWebUrl('https://a.example/\n<x>')).toBe(false)
    expect(isWebUrl('https://a.example/\u0000')).toBe(false)
  })

  it('refuses a value that is not text', () => {
    for (const bad of [undefined, null, 42, {}, ['https://a.example/']]) expect(isWebUrl(bad)).toBe(false)
  })

  it('refuses an address longer than the limit (2 MB were accepted), and accepts one that just fits', () => {
    const prefix = 'https://a.example/'
    expect(isWebUrl(prefix + 'a'.repeat(2_000_000))).toBe(false)
    expect(isWebUrl(prefix + 'a'.repeat(MAX_URL_LENGTH - prefix.length))).toBe(true)
    expect(isWebUrl(prefix + 'a'.repeat(MAX_URL_LENGTH - prefix.length + 1))).toBe(false)
  })
})

describe('linkTitle and folderName', () => {
  it('cut a title at the state’s limit, turn control characters into spaces, and fall back when nothing is left', () => {
    expect(linkTitle('x'.repeat(5000), 'https://a.example/')).toHaveLength(TITLE_MAX)
    expect(linkTitle('a\nb\u0000c', 'https://a.example/')).toBe('a b c')
    expect(linkTitle('   ', 'https://a.example/')).toBe('https://a.example/')
    expect(linkTitle(undefined, 'https://a.example/')).toBe('https://a.example/')
    expect(linkTitle(7, 'https://a.example/')).toBe('https://a.example/')
    expect(folderName('  ')).toBe('Dossier')
    expect(folderName('y'.repeat(5000))).toHaveLength(200)
  })

  it('never takes as a title more of an address than a title may hold', () => {
    expect(linkTitle('', 'https://a.example/' + 'a'.repeat(5000))).toHaveLength(TITLE_MAX)
  })
})

describe('text shown in the sidebar from a file nobody here wrote (R22.8)', () => {
  it('drops the characters that reorder what is around them, and keeps right-to-left text, emoji and the direction marks', () => {
    expect(linkTitle('photo.\u202Egpj.exe', 'https://a.example/')).toBe('photo.gpj.exe')
    expect(folderName('\u2066Dossier\u2069 \u202Dx\u202C')).toBe('Dossier x')
    expect(linkTitle('שלום עולם ☕ 😀 \u200Fx', 'https://a.example/')).toBe('שלום עולם ☕ 😀 \u200Fx')
  })

  it('does not leave half of an emoji at the end of a title that was cut', () => {
    const title = `${'a'.repeat(TITLE_MAX - 1)}😀`
    const cut = linkTitle(title, 'https://a.example/')
    expect(cut).toBe('a'.repeat(TITLE_MAX - 1))
    expect(displayText('😀😀', 1)).toBe('')
    expect(displayText('x😀', 3)).toBe('x😀')
  })

  it('still falls back to the address or the default name when nothing readable is left', () => {
    expect(linkTitle('\u202E\u202D', 'https://a.example/x')).toBe('https://a.example/x')
    expect(folderName('\u202E')).toBe('Dossier')
  })
})
