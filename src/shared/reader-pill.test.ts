// The pill of the reader: what the page may tell the shell, the document it is part of, and the script that runs in it (against a stand-in for the page).

import { beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { cleanArticle, readerDocument } from './reader'
import { DEFAULT_READER_PREFS, READER_SIZE_MAX, READER_SIZE_MIN, parseReaderPrefs, readerMessage, readerPillScript, type ReaderPrefs } from './reader-pill'

const NONCE = 'AbCdEfGhIjKlMnOpQrStUv=='
const article = cleanArticle({ title: 'Un titre', content: '<p>Du texte.</p>', byline: null, siteName: 'Le Journal', lang: 'fr', dir: 'ltr', textLength: 1200 })!

beforeEach(() => setLanguage('fr'))

describe('what the page tells the shell', () => {
  it('takes the choices only when every one is a value the pill offers', () => {
    expect(parseReaderPrefs(DEFAULT_READER_PREFS)).toEqual(DEFAULT_READER_PREFS)
    expect(parseReaderPrefs({ font: 'sans', size: READER_SIZE_MIN, width: 'wide', theme: 'night' })).toEqual({ font: 'sans', size: READER_SIZE_MIN, width: 'wide', theme: 'night' })
    expect(parseReaderPrefs({ ...DEFAULT_READER_PREFS, size: READER_SIZE_MAX })).toEqual({ ...DEFAULT_READER_PREFS, size: READER_SIZE_MAX })
    // Only the four choices are kept: anything else the page adds is left behind.
    expect(parseReaderPrefs({ ...DEFAULT_READER_PREFS, style: 'x' })).toEqual(DEFAULT_READER_PREFS)
    for (const bad of [null, 'x', {}, { ...DEFAULT_READER_PREFS, font: 'comic' }, { ...DEFAULT_READER_PREFS, size: READER_SIZE_MIN - 1 }, { ...DEFAULT_READER_PREFS, size: READER_SIZE_MAX + 1 }, { ...DEFAULT_READER_PREFS, size: 1.5 }, { ...DEFAULT_READER_PREFS, width: 'huge' }, { ...DEFAULT_READER_PREFS, theme: 'neon' }]) {
      expect(parseReaderPrefs(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('hears a title that begins with the nonce of the document, and no other: the title of the article is not a message', () => {
    const prefs: ReaderPrefs = { font: 'sans', size: 2, width: 'narrow', theme: 'sepia' }
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
    const html = readerDocument(article, 'https://example.org/a', undefined, { nonce: NONCE, prefs: { font: 'sans', size: 1, width: 'wide', theme: 'sepia' } })
    expect(html).toContain('class="rbar"')
    expect(html).toContain('role="toolbar" aria-label="Réglages de lecture"')
    expect(html).toContain('data-font="sans" data-width="wide" data-theme="sepia" style="--step:1"')
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
  }
  const button = (k: string, data: Record<string, string> = {}) => new FakeElement({ k, ...data })
  const buttons = [button('font', { v: 'serif' }), button('font', { v: 'sans' }), button('size', { s: '-1' }), button('size', { s: '1' }), button('theme', { v: 'sepia' }), button('quit')]
  const listeners: Record<string, (event: unknown) => void> = {}
  const pill = { addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn), querySelectorAll: () => buttons }
  const root = { dataset: {} as Record<string, string>, style: { props: {} as Record<string, string>, setProperty(name: string, value: string) { this.props[name] = value } }, scrollHeight: 1000, clientHeight: 500, scrollTop: 250 }
  const bar = { style: { transform: '' } }
  const hint = { textContent: '' }
  const document = { documentElement: root, title: '', querySelector: (selector: string) => (selector === '.rp' ? pill : selector === '.rbar' ? bar : hint) }
  const scroll: Record<string, () => void> = {}
  new Function('document', 'addEventListener', 'Element', readerPillScript(NONCE, prefs, 'Lu à {percent} %'))(document, (type: string, fn: () => void) => (scroll[type] = fn), FakeElement)
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
})
