// Engine checks for « Découvrir Lucium » (shared/discover.ts, renderer/Discover.tsx): what only a real application shows. The panel opens from Aide ›
// Découvrir Lucium with the focus in its search; its cards are there, every one named by a heading; a typed search narrows them; Tab goes from the search to
// a chip; « Essayer » of the command bar's card leaves the panel for the command bar, and « Régler » of a card for the Settings; Escape empties the search
// then closes the panel; and, in both schemes, the contour of the search field and of a chip is 3 : 1 against the nearest opaque colour behind it (WCAG
// 1.4.11; the header is a gradient, a picture the computed style cannot give, so its pairs are measured on the tokens: shared/design-tokens.ts). Real input (sendInputEvent) drives the keyboard and the buttons. The calls the buttons make that write a file or open a tab (a capture of the
// whole page, the save as Markdown, a private tab) are not pressed here: their effect is another suite's (`capture`, `markdown`, `webtools`).
// `LUCIUM_SMOKE_ONLY=discover pnpm test:engine` runs only this file. Written with the panel and never run by its author (AGENTS.md §1: a run opens windows).

import { Menu, nativeTheme, type MenuItem, type WebContents } from 'electron'
import { DISCOVER_ENTRIES } from '@shared/discover'
import { t } from '@shared/i18n'
import type { SmokeContext } from './smoke'
import { noteCheck, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const waitFor = waiterOf(6000, 50)

export async function smokeDiscover(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, overlayView } = ctx
  const ui = overlayView.webContents
  const evaluate = <T>(from: WebContents, script: string) => from.executeJavaScript(script) as Promise<T>
  const click = async (box: Box) => {
    const x = Math.round(box.x + box.w / 2)
    const y = Math.round(box.y + box.h / 2)
    // The events reach the page in the order they are sent: what a press does is waited for by the check that follows, never by a delay here.
    ui.sendInputEvent({ type: 'mouseMove', x, y })
    ui.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    ui.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }
  const key = (keyCode: string) => {
    ui.sendInputEvent({ type: 'keyDown', keyCode })
    ui.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const typeText = (text: string) => {
    for (const ch of text) {
      ui.sendInputEvent({ type: 'keyDown', keyCode: ch })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode: ch })
    }
  }
  const fieldValue = () => evaluate<string>(ui, `document.querySelector('input[type="search"]')?.value ?? ''`)
  const cardCount = () => evaluate<number>(ui, `document.querySelectorAll('article.dv-card').length`)
  /** The button of a card (by its heading) with this text, as a box to click. */
  const buttonOf = (heading: string, label: string) =>
    evaluate<Box | null>(
      ui,
      `(() => { const card = [...document.querySelectorAll('article.dv-card')].find((c) => c.querySelector('h4')?.textContent === ${JSON.stringify(heading)}); const b = card && [...card.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null })()`
    )
  const previousTheme = nativeTheme.themeSource

  try {
    // ---- 1. the entry of the Aide menu opens the panel, the focus in the search ----
    const help = Menu.getApplicationMenu()?.items.find((item) => item.role === 'help')
    const entry: MenuItem | undefined = help?.submenu?.items.find((item) => item.label === t('discover.titre'))
    check('menu: Aide has « Découvrir Lucium »', entry !== undefined, help?.submenu?.items.map((item) => item.label).join(' | '))
    check('menu: it comes right after « Premiers pas »', help?.submenu?.items.findIndex((item) => item.label === t('discover.titre')) === 1)
    entry?.click()
    check('menu: it opens the panel', await waitFor(() => browser.currentPanel() === 'discover'), JSON.stringify(browser.currentOverlay()))
    check('open: the focus is in the search field', await waitFor(async () => (await evaluate<string | undefined>(ui, `document.activeElement?.getAttribute('type')`)) === 'search', 3000))

    // ---- 2. the cards ----
    check('cards: every chosen function has its card', (await waitFor(async () => (await cardCount()) === DISCOVER_ENTRIES.length)) && (await cardCount()) === DISCOVER_ENTRIES.length, String(await cardCount()))
    check(
      'cards: each one is named by its heading, and each of its buttons says which card it is for',
      await evaluate<boolean>(ui, `[...document.querySelectorAll('article.dv-card')].every((c) => c.getAttribute('aria-labelledby') === c.querySelector('h4')?.id && [...c.querySelectorAll('button')].every((b) => b.getAttribute('aria-describedby') === c.querySelector('h4')?.id))`)
    )
    check('cards: every shortcut shown is a group named once, its capsules hidden from the screen reader', await evaluate<boolean>(ui, `[...document.querySelectorAll('.dv-keys')].every((g) => g.getAttribute('role') === 'group' && g.getAttribute('aria-label') && [...g.querySelectorAll('kbd')].every((k) => k.getAttribute('aria-hidden') === 'true'))`))
    check('cards: nothing is wider than the panel (no sideways scroll)', await evaluate<boolean>(ui, `(() => { const b = document.querySelector('.dv-body'); return b ? b.scrollWidth <= b.clientWidth + 1 : false })()`))

    // ---- 3. a typed search narrows them ----
    typeText('capture')
    const narrows = await waitFor(async () => (await fieldValue()) === 'capture' && (await cardCount()) < DISCOVER_ENTRIES.length)
    const narrowed = await cardCount()
    check('search: « capture » narrows the cards, and the status says how many are left', narrows && narrowed > 0 && (await evaluate<string>(ui, `document.querySelector('[role="status"]')?.textContent ?? ''`)).length > 0, String(narrowed))

    // ---- 4. the keyboard: Escape empties the search, Tab leaves it for the first chip ----
    key('Escape')
    check('Escape: the first press empties the search and keeps the panel', (await waitFor(async () => (await fieldValue()) === '' && (await cardCount()) === DISCOVER_ENTRIES.length)) && browser.currentPanel() === 'discover')
    key('Tab')
    check('Tab: the focus goes from the search to a chip', await waitFor(() => evaluate<boolean>(ui, `document.activeElement?.classList.contains('tk-chip') === true`)), await evaluate<string>(ui, `document.activeElement?.outerHTML.slice(0, 120) ?? ''`))
    check('Tab: the chip that has the focus has a visible ring (outline or shadow)', await evaluate<boolean>(ui, `(() => { const s = getComputedStyle(document.activeElement); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none' })()`))

    // ---- 5. « Essayer » of the command bar's card leaves the panel for the bar ----
    const barCard = t('discover.barre-nom')
    const tryBar = await buttonOf(barCard, t('discover.essayer'))
    check('Essayer: the card of the command bar has its button', tryBar !== null)
    if (tryBar) await click(tryBar)
    check('Essayer: the panel gives way to the command bar', await waitFor(() => browser.currentPanel() === 'commandbar'), JSON.stringify(browser.currentOverlay()))
    browser.closeOverlay()
    await waitFor(() => browser.currentPanel() === null)

    // ---- 6. « Régler » of a card opens the Settings ----
    entry?.click()
    await waitFor(() => browser.currentPanel() === 'discover')
    await waitFor(async () => (await cardCount()) === DISCOVER_ENTRIES.length)
    const adjust = await buttonOf(t('discover.protection-nom'), t('discover.regler'))
    if (adjust) await click(adjust)
    check('Régler: the card of the protection opens the Settings', adjust !== null && (await waitFor(() => browser.currentPanel() === 'settings')), JSON.stringify(browser.currentOverlay()))
    browser.closeOverlay()
    await waitFor(() => browser.currentPanel() === null)

    // ---- 7. Escape closes the panel when the search is empty ----
    entry?.click()
    await waitFor(() => browser.currentPanel() === 'discover')
    await waitFor(async () => (await evaluate<string | undefined>(ui, `document.activeElement?.getAttribute('type')`)) === 'search', 3000)
    key('Escape')
    check('Escape: with the search empty, it closes the panel', await waitFor(() => browser.currentPanel() === null), JSON.stringify(browser.currentOverlay()))

    // ---- 8. the contour of the search field and of a chip, 3 : 1, in both schemes ----
    for (const scheme of ['light', 'dark'] as const) {
      nativeTheme.themeSource = scheme
      entry?.click()
      await waitFor(() => browser.currentPanel() === 'discover')
      await waitFor(async () => (await cardCount()) === DISCOVER_ENTRIES.length)
      // The scheme reaches the page as the media query it answers.
      await waitFor(() => evaluate<boolean>(ui, `matchMedia('(prefers-color-scheme: dark)').matches === ${scheme === 'dark'}`))
      const ratios = await evaluate<{ field: number; chip: number }>(
        ui,
        `(() => {
          const rgb = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 4).map(Number)
          const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
          const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
          const behind = (el) => { for (let n = el.parentElement; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3] > 0.95)) return c } return [255, 255, 255] }
          const contour = (sel) => { const el = document.querySelector(sel); return ratio(rgb(getComputedStyle(el).borderTopColor), behind(el)) }
          return { field: contour('.dv .tk-field'), chip: contour('.dv .tk-chip[aria-pressed="false"]') }
        })()`
      )
      check(`${scheme}: the contour of the search field is 3 : 1 at least`, ratios.field >= 3, ratios.field.toFixed(2))
      check(`${scheme}: the contour of a chip is 3 : 1 at least`, ratios.chip >= 3, ratios.chip.toFixed(2))
      browser.closeOverlay()
      await waitFor(() => browser.currentPanel() === null)
    }
  } finally {
    nativeTheme.themeSource = previousTheme
    browser.closeOverlay()
  }
}

/** `LUCIUM_SMOKE_ONLY=discover`: only these checks, with their own report. */
export async function runDiscoverSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeDiscover(ctx, (name, ok, detail) => noteCheck(checks, name, ok, detail))
  } catch (error) {
    noteCheck(checks, 'smokeDiscover ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_DISCOVER ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
