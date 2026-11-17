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

/** The names the image of a row shows: the label of the row (or of the rows of a group), the title of a group, the words of its buttons. */
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

  it('quote a name for every row that has one, and say what the image shows for the others', () => {
    const unquoted = settingScenarios.filter((s) => !s.quote).map((s) => s.card)
    // A list and a form: no row of theirs has a name to quote.
    expect(unquoted).toEqual(['fn-routage', 'fn-raccourcis'])
  })
})
