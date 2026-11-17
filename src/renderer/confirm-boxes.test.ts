// The boxes of the interface that ask before something is erased: "Annuler" is the default button, the one that has the focus when the box
// opens. Rendered to markup (no window), as settings-r11.test.ts does: what is checked is what the person would find on screen.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArcDialog } from './ArcDialog'
import { ConfirmActions } from './ConfirmActions'
import { listenReviewKeys } from './ExtensionReview'
import extensionReviewSource from './ExtensionReview.tsx?raw'
import { focusNextIn } from './templates/useFocusScope'
import arcDialogCss from './arc-dialog.css?raw'
import authPanelCss from './auth-panel.css?raw'
import promptPanelCss from './prompt-panel.css?raw'
import extensionReviewCss from './extension-review.css?raw'

const noop = () => undefined
const box = (props: { danger?: boolean; items?: string[] } = {}): string =>
  renderToStaticMarkup(createElement(ArcDialog, { title: 'Supprimer ?', message: 'Irréversible.', confirmLabel: 'Supprimer', onCancel: noop, onConfirm: noop, ...props }))

/** The opening tag of the first button whose class list holds `className`. */
const buttonTag = (markup: string, className: string): string => {
  const found = new RegExp(`<button[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`).exec(markup)
  if (!found) throw new Error(`no button of class ${className} in ${markup}`)
  return found[0]
}

describe('ArcDialog', () => {
  it('opens on "Annuler" when it erases or deletes (the default), so that Return keeps things', () => {
    const markup = box()
    expect(buttonTag(markup, 'adlg-cancel')).toContain('autofocus')
    expect(buttonTag(markup, 'adlg-danger')).not.toContain('autofocus')
  })

  it('writes no Return key on the red button, which Return does not press; Escape stays written on "Annuler"', () => {
    const markup = box()
    expect(markup).toContain('<kbd>ESC</kbd>')
    expect(markup).not.toContain('↩')
  })

  it('opens on the confirmation, with its Return key written, when the question costs nothing', () => {
    const markup = box({ danger: false })
    expect(buttonTag(markup, 'adlg-confirm')).toContain('autofocus')
    expect(buttonTag(markup, 'adlg-cancel')).not.toContain('autofocus')
    expect(markup).toContain('↩')
  })

  it('lists what it will erase under the message, in a taller box', () => {
    const markup = box({ items: ['Travail', 'Clients'] })
    expect(markup).toContain('adlg-list')
    expect(markup).toMatch(/<ul class="adlg-items"><li[^>]*>Travail<\/li><li[^>]*>Clients<\/li><\/ul>/)
    expect(box()).not.toContain('adlg-list')
    expect(box({ items: [] })).not.toContain('adlg-items')
  })

  it('reads "Cancel" in English by default', async () => {
    const { setLanguage } = await import('@shared/i18n')
    setLanguage('en')
    try {
      expect(box()).toContain('Cancel<kbd>ESC</kbd>')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('Tab in a confirmation box', () => {
  // The box as the handler finds it: its two buttons, in the order of the document. A control of the host under the dimmed layer is not one of them.
  const part = (name: string) => ({ name, hidden: false, getAttribute: () => null, focus: () => void focused.push(name) })
  const focused: string[] = []
  const cancel = part('cancel')
  const confirm = part('confirm')
  const under = part('a switch of the settings, under the layer')
  const root = { querySelectorAll: () => [cancel, confirm] } as unknown as HTMLElement
  const tab = (from: unknown, backwards = false) => (focusNextIn(root, from as Element | null, backwards) as unknown as { name: string } | null)?.name

  it('goes round the two buttons, both ways', () => {
    expect(tab(cancel)).toBe('confirm')
    expect(tab(confirm)).toBe('cancel')
    expect(tab(cancel, true)).toBe('confirm')
    expect(tab(confirm, true)).toBe('cancel')
  })

  it('comes back into the box when the focus was under the dimmed layer or nowhere, and gives the focus for real', () => {
    focused.length = 0
    expect(tab(under)).toBe('cancel')
    expect(tab(under, true)).toBe('confirm')
    expect(tab(null)).toBe('cancel')
    expect(focused).toEqual(['cancel', 'confirm', 'cancel'])
  })

  it('answers null for a box with nothing to focus', () => {
    expect(focusNextIn({ querySelectorAll: () => [] } as unknown as HTMLElement, null, false)).toBeNull()
  })
})

describe('the keys of the sheet that reviews an extension (aria-modal)', () => {
  const part = (name: string) => ({ name, hidden: false, getAttribute: () => null, focus: () => void focused.push(name) })
  const focused: string[] = []
  const cancel = part('cancel')
  const confirm = part('confirm')
  const under = part('a button of the toolbar, under the dimmed layer')
  const box = { querySelectorAll: () => [cancel, confirm] } as unknown as HTMLElement

  /** The sheet open over a window whose focus is on `active`: what a key does, and whether it was taken from what lies below. */
  function open(active: unknown, withBox = true) {
    const listeners: Array<{ listener: (event: never) => void; capture: boolean }> = []
    let refused = 0
    const close = listenReviewKeys(
      { addEventListener: (_type, listener, capture) => void listeners.push({ listener: listener as never, capture }), removeEventListener: (_type, listener) => void listeners.splice(listeners.findIndex((kept) => kept.listener === (listener as never)), 1) },
      { box: () => (withBox ? box : null), active: () => active as Element | null, refuse: () => void refused++ }
    )
    const press = (key: string, shiftKey = false) => {
      const event = { key, repeat: false, shiftKey, prevented: 0, stopped: 0, preventDefault: () => void event.prevented++, stopImmediatePropagation: () => void event.stopped++ }
      for (const { listener } of [...listeners]) listener(event as never)
      return { taken: event.prevented === 1 && event.stopped === 1, untouched: event.prevented === 0 && event.stopped === 0 }
    }
    return { listeners, press, close, refused: () => refused }
  }

  it('hears the keys on the window before anything below it, and lets go when the sheet closes', () => {
    const sheet = open(cancel)
    expect(sheet.listeners.map((kept) => kept.capture)).toEqual([true])
    sheet.close()
    expect(sheet.listeners).toEqual([])
  })

  it('keeps Tab inside the sheet: round its two buttons, both ways, and never to a control of the host', () => {
    focused.length = 0
    expect(open(cancel).press('Tab').taken).toBe(true)
    expect(open(confirm).press('Tab').taken).toBe(true)
    expect(open(cancel).press('Tab', true).taken).toBe(true)
    expect(focused).toEqual(['confirm', 'cancel', 'confirm'])
  })

  it('brings the focus back into the sheet when it was under the dimmed layer, or nowhere', () => {
    focused.length = 0
    expect(open(under).press('Tab').taken).toBe(true)
    expect(open(under).press('Tab', true).taken).toBe(true)
    expect(open(null).press('Tab').taken).toBe(true)
    expect(focused).toEqual(['cancel', 'confirm', 'cancel'])
  })

  it('still takes Tab from the host while the sheet has no box yet', () => {
    focused.length = 0
    expect(open(under, false).press('Tab').taken).toBe(true)
    expect(focused).toEqual([])
  })

  it('refuses on Escape, and leaves every other key alone: Return presses the button that has the focus', () => {
    const sheet = open(confirm)
    expect(sheet.press('Escape').taken).toBe(true)
    expect(sheet.refused()).toBe(1)
    for (const key of ['Enter', ' ', 'a', 'ArrowDown']) expect(sheet.press(key).untouched, key).toBe(true)
    expect(sheet.refused()).toBe(1)
  })

  it('is what the sheet listens with, on its own box', () => {
    expect(extensionReviewSource).toContain('useEffect(() => listenReviewKeys(window, { box: () => box.current, active: () => document.activeElement,')
    expect(extensionReviewSource).toMatch(/<div ref=\{box\} className="adlg adlg-ext" role="alertdialog" aria-modal="true"/)
  })
})

describe('the layout of the box (arc-dialog.css and the boxes drawn like it)', () => {
  const rules = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector!.trim(), body: body! }))
  const all = [arcDialogCss, authPanelCss, promptPanelCss, extensionReviewCss].flatMap(rules).filter((rule) => /\.adlg(?![-\w]*scrim)/.test(rule.selector) && !rule.selector.includes('.adlg-scrim'))

  it('has no fixed height: a message of four lines (the deletion of a container with open tabs) makes the box taller', () => {
    const fixed = all.filter((rule) => /(?:^|[;\s])height:\s*\d/.test(rule.body) && /\.adlg(?:\.adlg-[\w-]+)?\s*$/.test(rule.selector))
    expect(fixed.map((rule) => rule.selector)).toEqual([])
    expect(rules(arcDialogCss).find((rule) => rule.selector === '.adlg')!.body).toMatch(/min-height:\s*273px/)
  })

  it('lays the icon, the title, the message, the list and the buttons in the flow: none sits at a fixed offset over another', () => {
    const absolute = all.filter((rule) => /position:\s*absolute/.test(rule.body))
    expect(absolute.map((rule) => rule.selector)).toEqual([])
    const actions = rules(arcDialogCss).find((rule) => rule.selector === '.adlg-actions')!.body
    // The buttons stay at the foot of a box whose text is short, and keep clear of the text of one whose text is long.
    expect(actions).toMatch(/margin-top:\s*auto/)
    expect(actions).toMatch(/padding-top:\s*12px/)
  })
})

describe('ConfirmActions (the clearing panels)', () => {
  const actions = renderToStaticMarkup(createElement(ConfirmActions, { cancelLabel: 'Annuler', cancelClass: 'sitedata-cancel', confirmLabel: 'Effacer', confirmClass: 'sitedata-clear', onCancel: noop, onConfirm: noop }))

  it('puts the focus on "Annuler", not on the button that erases', () => {
    expect(buttonTag(actions, 'sitedata-cancel')).toContain('autofocus')
    expect(buttonTag(actions, 'sitedata-clear')).not.toContain('autofocus')
  })

  it('keeps the classes the stylesheet and the engine tests reach the buttons by, and the order Annuler then Effacer', () => {
    expect(buttonTag(actions, 'sitedata-clear')).toContain('primary')
    expect(actions.indexOf('Annuler')).toBeLessThan(actions.indexOf('Effacer'))
  })

  it('greys the red button while it cannot act', () => {
    const busy = renderToStaticMarkup(createElement(ConfirmActions, { cancelLabel: 'Annuler', confirmLabel: 'Nettoyer', confirmClass: 'sitedata-clear', confirmDisabled: true, onCancel: noop, onConfirm: noop }))
    expect(buttonTag(busy, 'sitedata-clear')).toContain('disabled')
    expect(buttonTag(busy, 'button')).not.toContain('disabled')
  })
})
