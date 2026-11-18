// @vitest-environment happy-dom
// Bringing a row up in the page of Réglages (show-row.ts), on a document shaped like the window: the root element, a body, a title bar and a page.
// happy-dom lays nothing out, so the sizes the function reads are set by hand.

import { afterEach, describe, expect, it } from 'vitest'
import { showRowInPage } from './show-row'

/** `scrollHeight` and `clientHeight` of an element, which a document without layout always answers 0. */
function sized(element: HTMLElement, sizes: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: sizes.scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: sizes.clientHeight })
}

/** The window of Réglages: a page (`.settings-content`) holding a group with one row. */
function drawWindow(): { page: HTMLElement } {
  document.documentElement.removeAttribute('style')
  document.body.innerHTML = `
    <div class="settings-shell"><div class="settings-body">
      <main class="settings-content" style="overflow-y: auto">
        <section class="pref-section"><div class="pref-row" data-setting="dohCustom">Set up encrypted DNS myself</div></section>
      </main>
    </div></div>`
  return { page: document.querySelector<HTMLElement>('.settings-content') as HTMLElement }
}

afterEach(() => {
  document.documentElement.removeAttribute('style')
  document.body.innerHTML = ''
})

describe('showRowInPage', () => {
  it('leaves the root element alone when the page fits in its window and has no scroller', () => {
    drawWindow()
    expect(showRowInPage([['[data-setting~="dohCustom"]'], null])).toBe(true)
    // `html, body, #root { height: 100% }` and `* { box-sizing: border-box }` (styles.css): a padding on the root takes its height away from the page,
    // and the whole window falls to nothing under its title (the image of the encrypted DNS card showed a title and a blank page).
    expect(document.documentElement.style.paddingBottom).toBe('')
    expect(document.body.style.paddingBottom).toBe('')
  })

  it('gives blank room under the last group to a page that does scroll, so that a row near its end reaches the top', () => {
    const { page } = drawWindow()
    sized(page, { scrollHeight: 800, clientHeight: 300 })
    expect(showRowInPage([['[data-setting~="dohCustom"]'], null])).toBe(true)
    expect(page.style.paddingBottom).toBe('300px')
    expect(document.documentElement.style.paddingBottom).toBe('')
  })

  it('says so when no row is left, and passes over a row that only a search shows', () => {
    drawWindow()
    expect(showRowInPage([['[data-setting~="nothing"]'], null])).toBe(false)
    document.querySelector('.pref-row')?.setAttribute('data-search-only', '')
    expect(showRowInPage([['[data-setting~="dohCustom"]'], null])).toBe(false)
  })
})
