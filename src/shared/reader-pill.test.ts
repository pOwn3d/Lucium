// The pill of the reader: what the page may tell the shell, the document it is part of, and the script that runs in it (against a stand-in for the page).

import { beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { cleanArticle, readerDocument } from './reader'
import { ASSISTED_READER_PREFS, DEFAULT_READER_PREFS, READER_PILL_STYLE, READER_SIZE_MAX, READER_SIZE_MIN, parseReaderPrefs, readerMessage, readerPillScript, type ReaderPrefs } from './reader-pill'

const NONCE = 'AbCdEfGhIjKlMnOpQrStUv=='
const article = cleanArticle({ title: 'Un titre', content: '<p>Du texte.</p>', byline: null, siteName: 'Le Journal', lang: 'fr', dir: 'ltr', textLength: 1200 })!

beforeEach(() => setLanguage('fr'))

describe('what the page tells the shell', () => {
  it('takes the choices only when every one is a value the pill offers', () => {
    expect(parseReaderPrefs(DEFAULT_READER_PREFS)).toEqual(DEFAULT_READER_PREFS)
    expect(parseReaderPrefs({ ...DEFAULT_READER_PREFS, font: 'sans', size: READER_SIZE_MIN, width: 'wide', theme: 'night' })).toEqual({ ...DEFAULT_READER_PREFS, font: 'sans', size: READER_SIZE_MIN, width: 'wide', theme: 'night' })
    expect(parseReaderPrefs({ ...DEFAULT_READER_PREFS, size: READER_SIZE_MAX })).toEqual({ ...DEFAULT_READER_PREFS, size: READER_SIZE_MAX })
    // Only the choices of the pill are kept: anything else the page adds is left behind.
    expect(parseReaderPrefs({ ...DEFAULT_READER_PREFS, style: 'x' })).toEqual(DEFAULT_READER_PREFS)
    for (const bad of [null, 'x', {}, { ...DEFAULT_READER_PREFS, font: 'comic' }, { ...DEFAULT_READER_PREFS, size: READER_SIZE_MIN - 1 }, { ...DEFAULT_READER_PREFS, size: READER_SIZE_MAX + 1 }, { ...DEFAULT_READER_PREFS, size: 1.5 }, { ...DEFAULT_READER_PREFS, width: 'huge' }, { ...DEFAULT_READER_PREFS, theme: 'neon' }, { ...DEFAULT_READER_PREFS, lineHeight: 'huge' }, { ...DEFAULT_READER_PREFS, letters: 2 }, { ...DEFAULT_READER_PREFS, words: null }, { ...DEFAULT_READER_PREFS, focus: 2 }, { ...DEFAULT_READER_PREFS, focus: '3' }, { font: 'serif', size: 0, width: 'normal', theme: 'auto' }]) {
      expect(parseReaderPrefs(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('takes the two new backgrounds, the readable font, the spacings and the focus, and nothing beyond their lists', () => {
    for (const theme of ['contrast', 'gray']) expect(parseReaderPrefs({ ...DEFAULT_READER_PREFS, theme })?.theme).toBe(theme)
    expect(parseReaderPrefs({ ...DEFAULT_READER_PREFS, font: 'readable' })?.font).toBe('readable')
    const spaced = { ...DEFAULT_READER_PREFS, lineHeight: 'wider', letters: 'wide', words: 'wider', focus: 5 }
    expect(parseReaderPrefs(spaced)).toEqual(spaced)
    for (const focus of [0, 1, 3, 5]) expect(parseReaderPrefs({ ...DEFAULT_READER_PREFS, focus })?.focus).toBe(focus)
  })

  it('hears a title that begins with the nonce of the document, and no other: the title of the article is not a message', () => {
    const prefs: ReaderPrefs = { ...DEFAULT_READER_PREFS, font: 'sans', size: 2, width: 'narrow', theme: 'sepia' }
    expect(readerMessage(`${NONCE}:quit`, NONCE)).toEqual({ kind: 'quit' })
    expect(readerMessage(`${NONCE}:${JSON.stringify(prefs)}`, NONCE)).toEqual({ kind: 'prefs', prefs })
    expect(readerMessage('quit', NONCE)).toBeNull()
    expect(readerMessage(`Autre:quit`, NONCE)).toBeNull()
    expect(readerMessage(`${NONCE}:${JSON.stringify({ ...prefs, size: 99 })}`, NONCE)).toBeNull()
    expect(readerMessage(`${NONCE}:{pas du json`, NONCE)).toBeNull()
    // Same length as the nonce and its colon, but not the nonce.
    expect(readerMessage(`${'z'.repeat(NONCE.length)}:quit`, NONCE)).toBeNull()
  })
})

describe('the reader with a pill', () => {
  it('has the pill, the line of progress and one script, allowed by the nonce of the document; the choices it opens with are pressed', () => {
    const html = readerDocument(article, 'https://example.org/a', undefined, { nonce: NONCE, prefs: { ...DEFAULT_READER_PREFS, font: 'sans', size: 1, width: 'wide', theme: 'sepia' } })
    expect(html).toContain('class="rbar"')
    expect(html).toContain('role="toolbar" aria-label="Réglages de lecture"')
    expect(html).toContain('data-font="sans" data-width="wide" data-theme="sepia" data-lh="normal" data-ls="normal" data-ws="normal" data-focus="0" style="--step:1"')
    expect(html).toMatch(/data-k="font" data-v="sans" aria-pressed="true"/)
    expect(html).toMatch(/data-k="width" data-v="wide" aria-pressed="true"/)
    expect(html).toMatch(/data-k="theme" data-v="sepia" aria-pressed="true"/)
    expect(html).toMatch(/data-k="theme" data-v="night" aria-pressed="false"/)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).toContain(`script-src 'nonce-${NONCE}'`)
    // A way out is on the pill, so the page does not need the hint under the title.
    expect(html).not.toContain('Échap pour quitter')
    expect(html).toContain('Quitter <kbd>Échap</kbd>')
    // The article comes before the script, so that nothing it holds can come first.
    expect(html.indexOf('<article>')).toBeLessThan(html.indexOf('<script nonce='))
  })

  it('shares its nonce with the voice when both are on: two scripts, one policy', () => {
    const html = readerDocument(article, 'https://example.org/a', NONCE, { nonce: NONCE, prefs: DEFAULT_READER_PREFS })
    expect(html.match(/<script nonce="/g)).toHaveLength(2)
    expect(html.match(/script-src/g)).toHaveLength(1)
    expect(html).toContain('listen-play')
  })

  it('has no pill and no script for a nonce that could leave the policy', () => {
    const html = readerDocument(article, 'https://example.org/a', undefined, { nonce: "x'; script-src *", prefs: DEFAULT_READER_PREFS })
    expect(html).not.toContain('<script')
    expect(html).not.toContain('rbar')
    expect(html).toContain('Échap pour quitter')
  })
})

/** A stand-in for the page, as far as the script of the pill touches it. */
function pageFor(prefs: ReaderPrefs) {
  class FakeElement {
    attrs: Record<string, string> = {}
    constructor(public dataset: Record<string, string>) {}
    setAttribute(name: string, value: string) {
      this.attrs[name] = value
    }
    closest() {
      return this
    }
    mark = { textContent: '' }
    querySelector() {
      return this.mark
    }
  }
  const button = (k: string, data: Record<string, string> = {}) => new FakeElement({ k, ...data })
  const buttons = [
    button('font', { v: 'serif' }),
    button('font', { v: 'sans' }),
    button('size', { s: '-1' }),
    button('size', { s: '1' }),
    button('theme', { v: 'sepia' }),
    button('quit'),
    button('lineHeight', { cycle: '1' }),
    button('focus', { cycle: '1' }),
    button('assist')
  ]
  const listeners: Record<string, (event: unknown) => void> = {}
  const pill = { addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn), querySelectorAll: () => buttons }
  const root = { dataset: {} as Record<string, string>, style: { props: {} as Record<string, string>, setProperty(name: string, value: string) { this.props[name] = value } }, scrollHeight: 1000, clientHeight: 500, scrollTop: 250 }
  const bar = { style: { transform: '' } }
  const hint = { textContent: '' }
  const focusBox = {}
  const document = { documentElement: root, body: {}, title: '', querySelector: (selector: string) => (selector === '.rp' ? pill : selector === '.rbar' ? bar : selector === '.rfocus' ? focusBox : hint) }
  const scroll: Record<string, (event?: unknown) => void> = {}
  // 30 px a line, a window 500 px high (root.clientHeight).
  new Function('document', 'addEventListener', 'Element', 'getComputedStyle', readerPillScript(NONCE, prefs, 'Lu à {percent} %'))(document, (type: string, fn: () => void) => (scroll[type] = fn), FakeElement, () => ({ lineHeight: '30px' }))
  const click = (b: FakeElement) => listeners['click']!({ target: b })
  return { buttons, click, document, root, bar, hint, scroll }
}

describe('the script of the pill', () => {
  it('compiles', () => {
    expect(() => new Function(readerPillScript(NONCE, DEFAULT_READER_PREFS, 'Lu à {percent} %'))).not.toThrow()
  })

  it('applies a choice at once and tells the shell the new choices', () => {
    const page = pageFor(DEFAULT_READER_PREFS)
    page.click(page.buttons[1]!)
    expect(page.root.dataset['font']).toBe('sans')
    expect(page.buttons[1]!.attrs['aria-pressed']).toBe('true')
    expect(page.buttons[0]!.attrs['aria-pressed']).toBe('false')
    expect(readerMessage(page.document.title, NONCE)).toEqual({ kind: 'prefs', prefs: { ...DEFAULT_READER_PREFS, font: 'sans' } })
  })

  it('steps the size and stops at the ends', () => {
    const page = pageFor({ ...DEFAULT_READER_PREFS, size: READER_SIZE_MAX })
    page.click(page.buttons[3]!)
    expect(page.root.style.props['--step']).toBe(String(READER_SIZE_MAX))
    page.click(page.buttons[2]!)
    expect(page.root.style.props['--step']).toBe(String(READER_SIZE_MAX - 1))
  })

  it('gives a background back to the system when its button is pressed again', () => {
    const page = pageFor(DEFAULT_READER_PREFS)
    page.click(page.buttons[4]!)
    expect(page.root.dataset['theme']).toBe('sepia')
    page.click(page.buttons[4]!)
    expect(page.root.dataset['theme']).toBe('auto')
  })

  it('asks to leave with the nonce, and follows the scroll with its line and its figure', () => {
    const page = pageFor(DEFAULT_READER_PREFS)
    page.click(page.buttons[5]!)
    expect(page.document.title).toBe(`${NONCE}:quit`)
    expect(page.hint.textContent).toBe('Lu à 50 %')
    expect(page.bar.style.transform).toBe('scaleX(0.5)')
    page.root.scrollTop = 500
    page.scroll['scroll']!()
    expect(page.hint.textContent).toBe('Lu à 100 %')
  })

  it('goes round the steps of a spacing and gives them to the page', () => {
    const page = pageFor(DEFAULT_READER_PREFS)
    const steps: string[] = []
    for (let i = 0; i < 4; i++) {
      page.click(page.buttons[6]!)
      steps.push(page.root.dataset['lh']!)
    }
    expect(steps).toEqual(['wide', 'wider', 'normal', 'wide'])
    expect(readerMessage(page.document.title, NONCE)).toEqual({ kind: 'prefs', prefs: { ...DEFAULT_READER_PREFS, lineHeight: 'wide' } })
    expect(page.buttons[6]!.attrs['aria-pressed']).toBe('true')
  })

  it('goes round the focus 1, 3, 5 lines then off, and lights a band of that many lines around the pointer', () => {
    const page = pageFor(DEFAULT_READER_PREFS)
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      page.click(page.buttons[7]!)
      seen.push(page.root.dataset['focus']!)
    }
    expect(seen).toEqual(['1', '3', '5', '0', '1'])
    // On one line (30 px) with the pointer at y = 200: the band is 185..215.
    page.scroll['pointermove']!({ clientY: 200 })
    expect(page.root.style.props['--fy1']).toBe('185px')
    expect(page.root.style.props['--fy2']).toBe('215px')
    // On three lines: 90 px around the pointer; at the top of the window the band stops at the edge.
    page.click(page.buttons[7]!)
    page.scroll['pointermove']!({ clientY: 10 })
    expect(page.root.style.props['--fy1']).toBe('0px')
    expect(page.root.style.props['--fy2']).toBe('90px')
    // The reader's choice always reaches the shell as a message it accepts.
    expect(readerMessage(page.document.title, NONCE)?.kind).toBe('prefs')
  })

  it('sets the assisted reading in one press and gives it back in the next', () => {
    const page = pageFor(DEFAULT_READER_PREFS)
    page.click(page.buttons[8]!)
    expect(page.root.dataset['font']).toBe('readable')
    expect(page.root.dataset['lh']).toBe(ASSISTED_READER_PREFS.lineHeight)
    expect(page.root.dataset['ls']).toBe('wide')
    expect(page.root.dataset['ws']).toBe('wide')
    expect(page.buttons[8]!.attrs['aria-pressed']).toBe('true')
    page.click(page.buttons[8]!)
    expect(page.root.dataset['font']).toBe('serif')
    expect(page.root.dataset['lh']).toBe('normal')
    expect(page.buttons[8]!.attrs['aria-pressed']).toBe('false')
  })
})

describe('the style and the markup of the new choices', () => {
  it('writes every choice on <html> and offers a button for each', () => {
    const prefs: ReaderPrefs = { font: 'readable', size: 0, width: 'normal', theme: 'contrast', lineHeight: 'wider', letters: 'wide', words: 'wider', focus: 3 }
    const html = readerDocument(article, 'https://example.org/a', undefined, { nonce: NONCE, prefs })
    expect(html).toContain('data-font="readable" data-width="normal" data-theme="contrast" data-lh="wider" data-ls="wide" data-ws="wider" data-focus="3"')
    for (const k of ['lineHeight', 'letters', 'words', 'focus']) expect(html).toContain(`data-k="${k}" data-cycle="1"`)
    expect(html).toMatch(/data-k="theme" data-v="gray"/)
    expect(html).toMatch(/data-k="theme" data-v="contrast" aria-pressed="true"/)
    expect(html).toMatch(/data-k="assist" aria-pressed="false"/)
    expect(html).toContain('class="rfocus"')
  })

  it('dims no line without the focus, and does not animate it when the system asks for less motion', () => {
    expect(READER_PILL_STYLE).toContain('html[data-focus="0"] .rfocus{display:none}')
    expect(READER_PILL_STYLE).toMatch(/@media \(prefers-reduced-motion:no-preference\)\{\.rfocus i\{transition/)
    expect(READER_PILL_STYLE).not.toMatch(/animation/)
  })

  it('keeps the policy as narrow as before: one script by nonce, no font, no connection, no frame', () => {
    const prefs: ReaderPrefs = { ...DEFAULT_READER_PREFS, focus: 5, font: 'readable' }
    const html = readerDocument(article, 'https://example.org/a', undefined, { nonce: NONCE, prefs })
    const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!
    expect(policy).toBe(`default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; script-src 'nonce-${NONCE}'`)
    expect(READER_PILL_STYLE).not.toMatch(/@font-face|@import|url\(/)
  })
})
