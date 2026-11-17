// @vitest-environment happy-dom
// The script the engine suites run in the Settings window to open « Plus de réglages » (smoke-kit.ts, OPEN_MORE_SETTINGS), run here on a document as the
// window draws it: empty at first (the window has its title before its page is drawn), then a page with its fold, or one without.

import { afterEach, describe, expect, it } from 'vitest'
import { OPEN_MORE_SETTINGS } from './smoke-kit'

/** Runs the script as the window does: an expression whose value is the answer. */
const run = (): boolean => (0, eval)(OPEN_MORE_SETTINGS) as boolean

/** A page of the Settings with a group at its top and, when asked, its fold « Plus de réglages », closed; the button opens it as the window does. */
function page(withFold: boolean): HTMLButtonElement | null {
  document.body.innerHTML = `<main class="settings-content"><section class="pref-section"><div class="pref-row"></div></section>${withFold ? '<div class="more-settings"><h2><button class="more-settings-toggle" aria-expanded="false"></button></h2><div class="more-settings-body" hidden><section class="pref-section"></section></div></div>' : ''}</main>`
  const toggle = document.querySelector<HTMLButtonElement>('.more-settings-toggle')
  toggle?.addEventListener('click', () => toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true')))
  return toggle
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the script that opens « Plus de réglages »', () => {
  // Guard: the suites wait on this script; true on a page not drawn yet let them read a row that was still hidden in the closed fold, and click nothing.
  it('is false while the window has drawn no page yet', () => {
    expect(run()).toBe(false)
    document.body.innerHTML = '<main class="settings-content"></main>'
    expect(run()).toBe(false)
  })

  it('opens the closed fold of the page shown, and is true once it is open', () => {
    const toggle = page(true)!
    expect(run()).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // Run again, it leaves an open fold open.
    expect(run()).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('is true on a drawn page that has no fold (« Fonctions en option », a subpage)', () => {
    page(false)
    expect(run()).toBe(true)
  })
})
