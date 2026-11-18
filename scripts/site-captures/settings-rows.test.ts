// @vitest-environment happy-dom
// The rows of Réglages the images of the features page show (features.ts, `setting`), drawn the way the window draws them, with the settings of the
// demonstration: each is in the part of its page its scenario says (the top, « Plus de réglages », its subpage), it is the first row the script
// brings up there (scripts/site-captures.mjs, `showSettingsRow`), and it bears the name and the option its alternative text quotes.
//
// The interface is typed by tsconfig.web.json (DOM, JSX) and this file by tsconfig.node.json: its modules are loaded by their path, when the test runs.

import { createElement, type ComponentType, type Context } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../../src/shared/i18n'
import type { UiSnapshot } from '../../src/shared/ipc'
import type { Settings } from '../../src/shared/model'
import { createInitialState } from '../../src/shared/sidebar'
import { savedStateOf } from '../../src/shared/sidebar-state'
import { demoState } from './demo'
import { FEATURE_SCENARIOS, rowSelectors, showsQuote, type FeatureScenario } from './features'
import { sameText } from './labels'
import { namesShown } from './names'
import type { Lang } from './shots'

// Every page drawn in its parts, in two languages: a few seconds of processor on a loaded machine.
vi.setConfig({ testTimeout: 60_000 })

// A path from the root of the project (`/src/…`), the form Vite gives every import of a test: on Windows the module runner did not find these files by the
// absolute path `fileURLToPath` gave (`D:\src\renderer\…`, seen in the first run of windows.yml).
const fromRenderer = (name: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ `/src/renderer/${name}`)

let CategoryContent: ComponentType<Record<string, unknown>>
let FoldPassContext: Context<string>

beforeAll(async () => {
  CategoryContent = (await fromRenderer('SettingsCategories.tsx'))['CategoryContent'] as ComponentType<Record<string, unknown>>
  FoldPassContext = (await fromRenderer('settings-context.ts'))['FoldPassContext'] as Context<string>
})
afterAll(() => setLanguage('fr'))

const NOW = Date.UTC(2026, 10, 4, 10, 0, 0)

/** The settings of the demonstration profile as the application reads them from its state file, with the scene's own changes. */
function settingsOf(scenario: FeatureScenario, lang: Lang): Settings {
  const saved = savedStateOf(JSON.parse(JSON.stringify(demoState(lang, 'light', NOW))))
  return { ...saved.settings, ...(scenario.scene?.patch ?? {}) } as Settings
}

/** A part of a page (`page`, `more`, `sub:<id>`) as the window draws it. */
function part(scenario: FeatureScenario, lang: Lang, pass: string): HTMLElement {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const snapshot = { state: { ...state, settings: settingsOf(scenario, lang) }, extensions: [], downloads: [] } as unknown as UiSnapshot
  const root = document.createElement('div')
  const pane = scenario.scene!.settings!.pane
  root.innerHTML = renderToStaticMarkup(createElement(FoldPassContext.Provider, { value: pass }, createElement(CategoryContent, { pane, snapshot, update: () => undefined, goTo: () => undefined })))
  return root
}

/** The row the script brings up: the first one the selectors find, a row only a search shows or one « Pour commencer » draws again aside. */
const firstRow = (root: ParentNode, row: string): Element | null =>
  rowSelectors(row)
    .map((selector) => [...root.querySelectorAll(selector)].find((element) => element.closest('[data-search-only], [data-mirror]') === null) ?? null)
    .find((element) => element !== null) ?? null

/** The least an image keeps beside its row: the two rows under it (a row at the top of the image), or the two above it (a row at the foot, `place: 'bottom'`). */
const ROWS_IN_SIGHT = 2

/** The rows of a part of a page, in the order the window draws them (a row only a search shows, or « Pour commencer » draws again, aside). */
const rowsOf = (root: ParentNode): Element[] => [...root.querySelectorAll('.pref-row')].filter((row) => row.closest('[data-search-only], [data-mirror]') === null)

/** The text a row shows: what waits folded under « En savoir plus » (`hidden`) is not on screen, so not in the image. */
function shownText(row: Element): string {
  const copy = row.cloneNode(true) as HTMLElement
  copy.querySelectorAll('[hidden]').forEach((folded) => folded.remove())
  return copy.textContent ?? ''
}

/** The names the image of a row shows:the label of the row (or of the rows of a group), the title of a group, the words of its buttons. */
function namesOf(target: Element): string[] {
  const rows = [...(target.matches('.pref-row') ? [target] : []), ...target.querySelectorAll('.pref-row')]
  return [
    ...rows.map((row) => row.querySelector('.pref-label')?.firstChild?.textContent ?? ''),
    ...[...target.querySelectorAll('h3 .pref-title, button')].map((element) => element.textContent ?? '')
  ].map((name) => name.trim())
}

const settingScenarios = FEATURE_SCENARIOS.filter((s) => s.evidence === 'setting' && s.scene?.settings?.row)

describe('the rows of Réglages the images of the features page show', () => {
  it('are drawn where the scenario says, first of their part, with the name and the option the alternative text quotes, in both languages', () => {
    const wrong: string[] = []
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang)
      for (const s of settingScenarios) {
        const { row, sub, fold } = s.scene!.settings!
        const pass = sub ? `sub:${sub}` : fold ? 'more' : 'page'
        const target = firstRow(part(s, lang, pass), row!)
        if (!target) {
          wrong.push(`${s.card} ${lang}: no row ${row} in « ${pass} »`)
          continue
        }
        // The window draws the top of the page before the fold: a row said to wait in the fold must have nothing above it the script would take.
        if (fold && firstRow(part(s, lang, 'page'), row!)) wrong.push(`${s.card} ${lang}: ${row} is found at the top of the page before « Plus de réglages »`)
        const quote = s.quote?.[lang]
        if (quote !== undefined && !namesOf(target).some((name) => sameText(name, quote))) wrong.push(`${s.card} ${lang}: « ${quote} » is not a name the row shows (${namesOf(target).filter(Boolean).slice(0, 4).join(' | ')})`)
        if (quote !== undefined && !showsQuote(target.textContent ?? '', quote)) wrong.push(`${s.card} ${lang}: the text of the row does not hold « ${quote} »`)
        const choice = s.choice?.[lang]
        if (choice !== undefined) {
          const chosen = target.querySelector('option[selected], [role="radio"][aria-checked="true"]')?.textContent ?? ''
          if (!sameText(chosen, choice)) wrong.push(`${s.card} ${lang}: the row is set to « ${chosen} », not « ${choice} »`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  // The demonstration profile has the protection of a new profile (« Renforcée »): the rows of its four settings are on with no change, as the text says.
  it('are on when the alternative text says so, in the settings of the demonstration', () => {
    const wrong: string[] = []
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang)
      for (const s of settingScenarios.filter((one) => /, (activée|switched on)$/.test(one.alt[lang]))) {
        const { row, sub, fold } = s.scene!.settings!
        const target = firstRow(part(s, lang, sub ? `sub:${sub}` : fold ? 'more' : 'page'), row!)
        const box = target?.querySelector<HTMLInputElement>('input[type="checkbox"]')
        if (!box?.hasAttribute('checked')) wrong.push(`${s.card} ${lang}: the text says it is on, the row is off`)
      }
    }
    setLanguage('fr')
    expect(wrong).toEqual([])
  })

  // The site names no other browser nor its maker (names.ts), and the capture refuses an image whose text does: a row followed by one that does must
  // not have it in its image, so it is shown at the foot of the image (`place: 'bottom'`). The test finds that in the sources, before a run on the Mac.
  it('keep the names of other browsers and of their makers out of the rows an image keeps beside its row', () => {
    const wrong: string[] = []
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang)
      for (const s of settingScenarios) {
        const { row, sub, fold, place } = s.scene!.settings!
        const root = part(s, lang, sub ? `sub:${sub}` : fold ? 'more' : 'page')
        // « Plus de réglages » is drawn after the rows of the page.
        const rows = fold ? [...rowsOf(part(s, lang, 'page')), ...rowsOf(root)] : rowsOf(root)
        const at = rows.findIndex((one) => one === firstRow(root, row!))
        // A group or a form, not a row: its image is the element itself.
        if (at < 0) continue
        const beside = place === 'bottom' ? rows.slice(Math.max(0, at - ROWS_IN_SIGHT), at) : rows.slice(at + 1, at + 1 + ROWS_IN_SIGHT)
        const named = namesShown(beside.map(shownText).join('\n'))
        if (named.length > 0) wrong.push(`${s.card} ${lang}: the ${ROWS_IN_SIGHT} rows ${place === 'bottom' ? 'above' : 'under'} the row name ${named.join(', ')}`)
      }
    }
    setLanguage('fr')
    expect(wrong).toEqual([])
  })

  it('quote a name for every row that has one, and say what the image shows for the others', () => {
    const unquoted = settingScenarios.filter((s) => !s.quote).map((s) => s.card)
    // A list and a form: no row of theirs has a name to quote.
    expect(unquoted).toEqual(['fn-routage', 'fn-raccourcis'])
  })
})
