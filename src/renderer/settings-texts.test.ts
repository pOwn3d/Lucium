// @vitest-environment happy-dom
// The texts of the Settings: one line, one verb, the result. Every row says its help in one line (the « i » counted with it) and keeps the rest behind
// « En savoir plus »; a note of a group says one line too. The window is drawn whole, page by page, in both languages, and the words a person reads
// without a click are counted: the longest help, and the help of a row on average. Then the rows said in the affirmative over a setting stored the
// other way round (the history), and the short lines of the features, with their whole description kept.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { featureById, featureLine, featureSummary, FEATURES, firstSentence } from '@shared/features'
import { setLanguage, t } from '@shared/i18n'
import { SETTINGS_PAGES, type SettingsPage, type UiSnapshot } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { GUIDE_ROWS } from '@shared/settings-guide'
import { createInitialState } from '@shared/sidebar'
import { CategoryContent } from './SettingsCategories'
import { FeatureSwitch } from './FeaturesSettings'
import { FoldPassContext } from './settings-context'

// Every page drawn whole in two states and two languages: a few seconds of processor on a loaded machine.
vi.setConfig({ testTimeout: 30_000 })
afterAll(() => setLanguage('fr'))

/** The most words a row may say without a click (its line of help and its « i »), and the most a row says on average. */
const LONGEST_HELP = 30
const AVERAGE_HELP = 18

const noop = () => undefined

function snapshotWith(patch: Partial<Settings> = {}): UiSnapshot {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [] } as unknown as UiSnapshot
}

/** Every switch on: the rows that wait for one are drawn, with their help. */
function allOn(): Partial<Settings> {
  const on: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defaultSettings())) if (value === false) on[key] = true
  return on as Partial<Settings>
}

/** A page drawn whole (its top, its fold, its subpages), as a document. */
function page(pane: SettingsPage, snapshot: UiSnapshot): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(createElement(FoldPassContext.Provider, { value: 'all' }, createElement(CategoryContent, { pane, snapshot, update: noop, goTo: noop })))
  return root
}

/** The words of a text: what holds a letter or a figure (a « : » or a « › » alone is no word). */
const wordsOf = (text: string): number => text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length

/** The help a row shows without a click: its line of help and its « i » (the text behind « En savoir plus » is not shown). */
function helpOf(row: Element): string {
  const own = (selector: string): Element[] => [...row.querySelectorAll(selector)].filter((el) => el.closest('.pref-row') === row)
  return [...own('.pref-hint').map((hint) => hint.textContent ?? ''), ...own('.pref-info').map((info) => info.getAttribute('data-tip') ?? '')].join(' ')
}

/** The help of every row of the window, by page and setting, the longest seen over the states drawn. */
function helps(): Map<string, string> {
  const found = new Map<string, string>()
  for (const snapshot of [snapshotWith(), snapshotWith(allOn())]) {
    for (const pane of SETTINGS_PAGES) {
      for (const row of page(pane, snapshot).querySelectorAll('.pref-row[data-setting]:not([data-mirror])')) {
        const id = `${pane} › ${row.getAttribute('data-setting')}`
        const help = helpOf(row)
        if (wordsOf(help) > wordsOf(found.get(id) ?? '')) found.set(id, help)
      }
    }
  }
  return found
}

/** The notes of the groups as they are read without a click. */
function notes(): string[] {
  const said: string[] = []
  for (const pane of SETTINGS_PAGES) for (const note of page(pane, snapshotWith(allOn())).querySelectorAll('p.pref-note')) said.push(note.textContent ?? '')
  return said
}

describe('the help of the rows', () => {
  for (const language of ['fr', 'en'] as const) {
    it(`says one line a row, ${LONGEST_HELP} words at most and ${AVERAGE_HELP} on average, the rest behind « En savoir plus » (${language})`, () => {
      setLanguage(language)
      const all = helps()
      const long = [...all].filter(([, help]) => wordsOf(help) > LONGEST_HELP).map(([id, help]) => `${id}: ${wordsOf(help)} words`)
      expect(long).toEqual([])
      const said = [...all.values()].filter((help) => wordsOf(help) > 0)
      expect(said.length).toBeGreaterThan(120)
      const average = said.reduce((sum, help) => sum + wordsOf(help), 0) / said.length
      expect(average, `${average.toFixed(1)} words on average`).toBeLessThanOrEqual(AVERAGE_HELP)
    })

    it(`keeps the note of a group to one line too, ${LONGEST_HELP} words at most (${language})`, () => {
      setLanguage(language)
      expect(notes().filter((note) => wordsOf(note) > LONGEST_HELP)).toEqual([])
    })
  }
})

describe('the history, said in the affirmative', () => {
  /** The switch of the history in Vie privée et sécurité, as it is drawn and with the handler it is given. */
  function historyRow(patch: Partial<Settings>): { html: string; onChange: (on: boolean) => void; update: ReturnType<typeof vi.fn> } {
    setLanguage('fr')
    const update = vi.fn()
    const html = page('protection', snapshotWith(patch)).querySelector('.pref-row[data-setting="historyOff"]')!.outerHTML
    let found: ReactElement<Record<string, unknown>> | undefined
    const walk = (node: ReactNode): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!isValidElement(node)) return
      const element = node as ReactElement<Record<string, unknown>>
      if (found === undefined && element.props['settingKey'] === 'historyOff' && typeof element.props['onChange'] === 'function') found = element
      if (typeof element.type === 'function' && !(element.type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) walk((element.type as (props: unknown) => ReactNode)(element.props))
      walk(element.props['children'] as ReactNode)
    }
    const Probe = (): null => {
      walk(createElement(CategoryContent, { pane: 'protection', snapshot: snapshotWith(patch), update, goTo: noop }))
      return null
    }
    renderToStaticMarkup(createElement(FoldPassContext.Provider, { value: 'all' }, createElement(Probe)))
    return { html, onChange: found!.props['onChange'] as (on: boolean) => void, update }
  }

  it('is on while the history is kept, which is the default, and writes the stored setting the other way round', () => {
    const kept = historyRow({ historyOff: false })
    expect(kept.html).toContain(`aria-label="${t('privacy-extra-settings.garder-l-historique-des-pages-visitees')}"`)
    expect(kept.html).toMatch(/role="switch"[^>]*checked=""/)
    expect(historyRow({ historyOff: true }).html).not.toContain('checked=""')
    kept.onChange(false)
    kept.onChange(true)
    expect(kept.update.mock.calls).toEqual([[{ historyOff: true }], [{ historyOff: false }]])
  })

  it('is read the same way round in the recap of the guide, under the label the row has', () => {
    const row = GUIDE_ROWS['historyOff']!
    expect(row.label).toBe('privacy-extra-settings.garder-l-historique-des-pages-visitees')
    setLanguage('fr')
    expect(row.show(row.read!({ ...defaultSettings(), historyOff: false }))).toBe(t('guide.oui'))
    expect(row.show(row.read!({ ...defaultSettings(), historyOff: true }))).toBe(t('guide.non'))
  })
})

describe('the short line of a feature', () => {
  const summarized = FEATURES.filter((feature) => featureSummary(feature) !== null)

  for (const language of ['fr', 'en'] as const) {
    it(`is one sentence, shorter than the description it stands for (${language})`, () => {
      setLanguage(language)
      expect(summarized.length).toBeGreaterThan(20)
      for (const feature of summarized) {
        const summary = featureSummary(feature)!
        expect(firstSentence(summary), feature.id).toBe(summary)
        expect(wordsOf(summary), feature.id).toBeLessThan(wordsOf(feature.description))
        expect(wordsOf(summary), feature.id).toBeLessThanOrEqual(15)
      }
    })
  }

  it('is what « Fonctions en option » and the row of a category say, the first sentence of the description for a feature without one', () => {
    setLanguage('fr')
    expect(featureLine(featureById('tab-tree'))).toBe(featureSummary(featureById('tab-tree')))
    const plain = FEATURES.find((feature) => featureSummary(feature) === null)!
    expect(featureLine(plain)).toBe(firstSentence(plain.description))
  })

  it('leaves the whole description behind « En savoir plus » on the row of a category', () => {
    setLanguage('fr')
    const feature = featureById('compact-mode')
    const html = renderToStaticMarkup(createElement(FeatureSwitch, { id: 'compact-mode', snapshot: snapshotWith(), update: noop }))
    const hint = /<div class="pref-hint" id="[^"]+">([^<]*)<\/div>/.exec(html)?.[1]
    expect(hint).toBe(featureSummary(feature))
    expect(html).toContain('class="pref-more-toggle"')
    expect(html).toContain(`<p>${feature.description.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
  })
})
