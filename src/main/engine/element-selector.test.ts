// @vitest-environment happy-dom
// The CSS selector written for an element pointed at in a page (shared/element-selector.ts): the text is run here on a document, as the page
// runs it, and the two scripts that carry it (the eraser of a Tweak, the picker of an element of the real ElectronPage) are read for it.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zapScript, zapStopName } from '@shared/boost'
import { SELECTOR_FOR } from '@shared/element-selector'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

await import('./electron-page')

// The text declares `selectorFor` and reads the document of the page it runs in.
const selectorFor = new Function(`${SELECTOR_FOR}; return selectorFor`)() as (element: Element) => string

const page = (html: string): void => {
  document.body.innerHTML = html
}
const at = (query: string): Element => document.querySelector(query)!

beforeEach(() => page(''))

describe('the selector of an element pointed at in a page', () => {
  it('stops at the first element that has a plain id, itself included', () => {
    page('<main id="contenu"><div class="pub large"><span>x</span></div></main>')
    expect(selectorFor(at('#contenu'))).toBe('#contenu')
    expect(selectorFor(at('span'))).toBe('#contenu > div.pub.large > span')
  })

  it('writes the tag, the first two plain classes, and the place among siblings of the same tag', () => {
    page('<section><p class="a b c">un</p><p class="a">deux</p><i>trois</i></section>')
    expect(selectorFor(at('p + p'))).toBe('body > section > p.a:nth-of-type(2)')
    expect(selectorFor(at('p'))).toBe('body > section > p.a.b:nth-of-type(1)')
    expect(selectorFor(at('i'))).toBe('body > section > i')
  })

  it('leaves out a name that would need escaping, an id as well as a class', () => {
    page('<div id="1er"><div id="a:b" class="md:flex 2xl ok"><b>x</b></div></div>')
    expect(selectorFor(at('b'))).toBe('body > div > div.ok > b')
  })

  it('goes up four levels at most', () => {
    page('<div><ul><li><a><em>x</em></a></li></ul></div>')
    expect(selectorFor(at('em'))).toBe('ul > li > a > em')
  })

  it('finds, in the page it was written for, the element that was pointed at and no other', () => {
    page('<div class="col"><p>un</p><p class="pub">deux</p></div><div class="col"><p>trois</p><p class="pub">quatre</p></div>')
    const pointed = document.querySelectorAll('p.pub')[1]!
    expect([...document.querySelectorAll(selectorFor(pointed))]).toEqual([pointed])
  })
})

describe('the scripts that write such a selector', () => {
  it('carry the same text: the eraser of a Tweak and the picker of an element', async () => {
    const stop = zapStopName(() => new Uint8Array(12))
    expect(zapScript(stop)).toContain(SELECTOR_FOR)
    const { page: picked, wc } = await makePage()
    wc.executeJavaScript.mockResolvedValueOnce('#contenu > p')
    expect(await picked.pickElement()).toBe('#contenu > p')
    const script = wc.executeJavaScript.mock.calls.at(-1)![0]
    expect(script).toContain(SELECTOR_FOR)
    expect(script).toContain('selectorFor(')
    // One definition in each script, not a second one beside the shared text.
    for (const text of [script, zapScript(stop)]) expect(text.split('const selectorFor =').length - 1).toBe(1)
  })
})
