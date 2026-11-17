// @vitest-environment happy-dom
// « En savoir plus » on a row of the Settings, a switch or any other row, and under the note of a group (settings-parts.tsx, `MoreText`): the row says one
// line of help, the rest of what it told waits folded under it. The button says what it is about to a screen reader, unfolds and folds the text, and
// never flips the switch of the row; the search still reads the folded text, as the long text of the row.

import { createElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { click, mount, type Mounted } from './dom.test-support'
import { collectUnits } from './settings-filter'
import { Check, Group, Row } from './settings-parts'

let mounted: Mounted | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})
setLanguage('fr')

const LONG = 'Le texte entier : le mécanisme, les limites et les cas à part, qui ne tiennent pas sur une ligne.'

function draw(element: ReactElement): HTMLElement {
  mounted = mount(element)
  return mounted.container
}

/** The button of « En savoir plus » of a part, and the text it unfolds. */
function learnMore(root: HTMLElement): { toggle: HTMLButtonElement; text: HTMLElement } {
  const toggle = root.querySelector<HTMLButtonElement>('button.pref-more-toggle')!
  return { toggle, text: root.querySelector<HTMLElement>(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)! }
}

/** What a screen reader says for an element named by `aria-labelledby`. */
const nameOf = (root: HTMLElement, el: Element): string =>
  (el.getAttribute('aria-labelledby') ?? '')
    .split(' ')
    .map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent ?? '')
    .join(' ')

describe('« En savoir plus » on a switch', () => {
  it('shows the one line of help and keeps the rest folded, then unfolds it and folds it again, without flipping the switch', async () => {
    const onChange = vi.fn()
    const root = draw(createElement(Check, { settingKey: 'historyOff', label: 'Garder l’historique', hint: 'Une ligne.', more: LONG, checked: true, onChange }))
    const { toggle, text } = learnMore(root)
    expect(root.querySelector('.pref-hint')?.textContent).toBe('Une ligne.')
    expect([toggle.textContent, toggle.getAttribute('aria-expanded'), text.hidden, text.textContent]).toEqual([t('settings.en-savoir-plus'), 'false', true, LONG])
    // The button names the row it is about.
    expect(nameOf(root, toggle)).toBe(`${t('settings.en-savoir-plus')} Garder l’historique`)
    await click(toggle)
    expect([toggle.getAttribute('aria-expanded'), text.hidden]).toEqual(['true', false])
    await click(text)
    await click(toggle)
    expect([toggle.getAttribute('aria-expanded'), text.hidden]).toEqual(['false', true])
    expect(onChange).not.toHaveBeenCalled()
    // The name of the row is the label of its switch: a click on it still flips it.
    await click(root.querySelector<HTMLLabelElement>('label[for]')!)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('gives a screen reader the line of help with the switch, not the folded text', () => {
    const root = draw(createElement(Check, { label: 'Nom', hint: 'Une ligne.', more: LONG, checked: false, onChange: () => undefined }))
    const input = root.querySelector('input[role="switch"]')!
    expect(input.getAttribute('aria-describedby')!.split(' ').map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent)).toEqual(['Une ligne.'])
  })

  it('draws a switch with nothing more as before: no button', () => {
    const root = draw(createElement(Check, { label: 'Nom', hint: 'Une ligne.', more: '', checked: false, onChange: () => undefined }))
    expect(root.querySelector('.pref-more-toggle')).toBeNull()
    expect(root.querySelector('label.pref-row')).not.toBeNull()
  })
})

describe('« En savoir plus » on another row and under the note of a group', () => {
  it('names the row it is about, and unfolds a paragraph each', async () => {
    const root = draw(createElement(Row, { label: 'Moteur de recherche', hint: 'Une ligne.', more: ['Premier.', 'Second.'] }))
    const { toggle, text } = learnMore(root)
    expect(nameOf(root, toggle)).toBe(`${t('settings.en-savoir-plus')} Moteur de recherche`)
    expect([...text.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Premier.', 'Second.'])
    await click(toggle)
    expect(text.hidden).toBe(false)
  })

  it('folds the rest of the note of a group under its one line, named by the title of the group', async () => {
    const root = draw(createElement(Group, { title: 'Verrouillage', footnote: 'Une ligne.', more: LONG, children: createElement(Row, { label: 'Ligne' }) }))
    const { toggle, text } = learnMore(root)
    expect(root.querySelector('p.pref-note')?.textContent).toBe('Une ligne.')
    expect(nameOf(root, toggle)).toBe(`${t('settings.en-savoir-plus')} Verrouillage`)
    expect(text.hidden).toBe(true)
    await click(toggle)
    expect(text.hidden).toBe(false)
  })
})

describe('the search', () => {
  it('reads the folded text as the long text of the row, never the words of the button, and keeps the line as its help', () => {
    const root = draw(createElement(Check, { settingKey: 'historyOff', label: 'Garder l’historique', hint: 'Une ligne.', more: LONG, checked: true, onChange: () => undefined }))
    const [unit] = collectUnits(root)
    expect(unit!.fields.label).toBe('Garder l’historique')
    expect(unit!.fields.hint).toBe('Une ligne.')
    expect(unit!.fields.more).toContain('cas à part')
    expect(unit!.fields.more).not.toContain(t('settings.en-savoir-plus'))
  })
})
