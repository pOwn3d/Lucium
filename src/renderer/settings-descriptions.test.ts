// A row of the Settings says more than its label: a hint under it (« Le système le demande », what it costs, a restart) and sometimes an « i ».
// A screen reader that lands on the control must hear them: the control names them as its description. The « i » is reached with Tab, and shows
// its sentence when it has the focus (the bubble of a `title` only comes to a pointer).

import { createElement, Fragment, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Check, Choice, InfoTip, Row, describedControls } from './settings-parts'
import settingsCss from './settings.css?raw'

const noop = (): void => undefined
const html = (node: ReactNode): string => renderToStaticMarkup(node)
const css = settingsCss.replace(/\/\*[\s\S]*?\*\//g, '')

/** The opening tag of the first `tag` of a markup. */
const tagOf = (markup: string, tag: string): string => new RegExp(`<${tag}\\b[^>]*>`).exec(markup)?.[0] ?? ''
const describedBy = (tag: string): string[] => (/aria-describedby="([^"]*)"/.exec(tag)?.[1] ?? '').split(' ').filter(Boolean)
/** The text of the element of this id. */
const textOf = (markup: string, id: string): string => new RegExp(`id="${id}"[^>]*>([^<]*)`).exec(markup)?.[1] ?? ''
/** What the element of this id is named (its `aria-label`), for the « i », which holds no text. */
const labelOf = (markup: string, id: string): string => new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(markup)?.[0].match(/aria-label="([^"]*)"/)?.[1] ?? ''

describe('the switch of a row', () => {
  it('has the hint of the row for description', () => {
    const markup = html(createElement(Check, { label: 'Vérifier l’orthographe', hint: 'Le système le demande.', checked: true, onChange: noop }))
    const ids = describedBy(tagOf(markup, 'input'))
    expect(ids).toHaveLength(1)
    expect(textOf(markup, ids[0]!)).toBe('Le système le demande.')
  })

  it('has the « i » and the hint for description, the « i » first as on screen', () => {
    const markup = html(createElement(Check, { label: 'Mise à jour automatique', hint: 'Redémarrage requis.', info: 'Une fois par jour.', checked: false, onChange: noop }))
    const ids = describedBy(tagOf(markup, 'input'))
    expect(ids).toHaveLength(2)
    expect(labelOf(markup, ids[0]!)).toBe('Une fois par jour.')
    expect(textOf(markup, ids[1]!)).toBe('Redémarrage requis.')
  })

  it('has none when the row says nothing more than its label', () => {
    expect(tagOf(html(createElement(Check, { label: 'Seul', checked: true, onChange: noop })), 'input')).not.toContain('aria-describedby')
  })

  it('gives two rows ids of their own', () => {
    const markup = html(createElement(Fragment, null, createElement(Check, { label: 'A', hint: 'Un.', checked: true, onChange: noop }), createElement(Check, { label: 'B', hint: 'Deux.', checked: true, onChange: noop })))
    const ids = [...markup.matchAll(/aria-describedby="([^"]*)"/g)].map((found) => found[1])
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('the controls of a row', () => {
  const row = (children: ReactNode, props: { hint?: string; info?: string } = { hint: 'Appliqué au prochain lancement.' }) => html(createElement(Row, { label: 'Langue', ...props }, children))
  const controlPart = (markup: string): string => markup.slice(markup.indexOf('pref-control'))

  it('take the hint for description: a menu, a button, a field, a menu drawn with Choice', () => {
    for (const [tag, control] of [
      ['select', createElement('select', { 'aria-label': 'Langue' })],
      ['button', createElement('button', null, 'Choisir…')],
      ['input', createElement('input', { type: 'text', readOnly: true, value: '' })],
      ['select', createElement(Choice, { value: 1, choices: [[1, 'Un']], onChange: noop, label: 'Langue' })]
    ] as const) {
      const markup = row(control)
      const ids = describedBy(tagOf(controlPart(markup), tag))
      expect(ids, tag).toHaveLength(1)
      expect(textOf(markup, ids[0]!), tag).toBe('Appliqué au prochain lancement.')
    }
  })

  it('are found inside a plain element and a fragment, each of several controls', () => {
    const markup = row(createElement(Fragment, null, createElement('span', { className: 'pair' }, createElement('select', { 'aria-label': 'Un' })), createElement('button', null, 'Deux')))
    expect(describedBy(tagOf(controlPart(markup), 'select'))).toHaveLength(1)
    expect(describedBy(tagOf(controlPart(markup), 'button'))).toEqual(describedBy(tagOf(controlPart(markup), 'select')))
  })

  it('keep a description of their own', () => {
    const markup = row(createElement('button', { 'aria-describedby': 'note' }, 'Choisir…'))
    expect(describedBy(tagOf(controlPart(markup), 'button'))).toEqual(['note'])
  })

  it('have none in a row with no hint and no « i »', () => {
    expect(row(createElement('select', { 'aria-label': 'Langue' }), {})).not.toContain('aria-describedby')
  })

  it('keep the same keys whether the row has a hint or not: a hint that appears does not draw the control anew', () => {
    const keys = (described: string | undefined): unknown[] =>
      (describedControls([createElement('select', { key: 'a' }), createElement('span', { key: 'b' }, createElement('button'))], described) as Array<{ key: unknown }>).map((element) => element.key)
    expect(keys('x-hint')).toEqual(keys(undefined))
    expect(keys(undefined)).toHaveLength(2)
  })
})

describe('the « i » of a row', () => {
  const tip = tagOf(html(createElement(InfoTip, { text: 'Une fois par jour.', id: 'x' })), 'span')

  it('is a Tab stop, named by its sentence', () => {
    expect(tip).toContain('tabindex="0"')
    expect(tip).toContain('aria-label="Une fois par jour."')
    // The bubble of the pointer stays.
    expect(tip).toContain('title="Une fois par jour."')
  })

  it('shows its sentence and the ring of the focus when the keyboard reaches it', () => {
    expect(tip).toContain('data-tip="Une fois par jour."')
    expect(css).toMatch(/\.pref-info:focus-visible::after\s*\{[^}]*content:\s*attr\(data-tip\)/)
    expect(css).toMatch(/\.pref-info:focus-visible\s*\{[^}]*outline:\s*var\(--focus-width\) solid var\(--focus\)/)
  })
})

describe('the search of the shortcuts', () => {
  it('shows the focus: its field has no outline of its own, so the strip round it has one', () => {
    expect(css).toMatch(/\.shortcuts-search input\s*\{[^}]*outline:\s*none/)
    expect(css).toMatch(/\.shortcuts-search:focus-within\s*\{[^}]*outline:\s*var\(--focus-width\) solid var\(--focus\)/)
  })
})
