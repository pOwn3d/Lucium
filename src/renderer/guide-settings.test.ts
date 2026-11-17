// « Régler en quelques questions » in the Settings window, rendered to markup (no window): the card at the top of every category, the flow it opens
// in the pane (the answer the settings hold checked, « conseillé », « réglage personnalisé »), « Ce qui va changer », the complete configuration
// at its address and in the search, and what « Appliquer » and « Annuler » send. The rules of the table are in shared/settings-guide.test.ts.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t, tp } from '@shared/i18n'
import { SETTINGS_PAGES, type SettingsPane, type UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { queryWords, rankUnits } from '@shared/settings-search'
import { askedQuestions, guidePlan, guideQuestionsOf, type GuidePlan, type GuideRecord } from '@shared/settings-guide'
import { settingsAnchorLabel } from '@shared/settings-catalog'
import { SLEEP_LEVELS } from '@shared/sleep'
import { elementsOf, type Element } from './render.test-support'
import { frenchSpaces } from '@shared/french-typography'

const calls = vi.hoisted(() => ({ dispatched: [] as unknown[] }))
vi.mock('./api', () => ({
  api: () => ({ dispatch: (action: unknown) => void calls.dispatched.push(action), openOverlay: () => undefined, closeOverlay: () => undefined }),
  useSnapshot: () => null
}))

const { SettingsView } = await import('./SettingsWindow')
const { GuideCard, GuideFlow } = await import('./GuideSettings')

const ctx = { now: 1, newId: () => 'id' }
const snapshotWith = (patch: Partial<Settings> = {}): UiSnapshot => {
  const state = createInitialState(ctx)
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [] } as unknown as UiSnapshot
}
const settingsWith = (patch: Partial<Settings> = {}): Settings => snapshotWith(patch).state.settings

interface Options {
  query?: string
  guide?: SettingsPane | 'all'
  record?: GuideRecord
}
const view = (hash: string, patch: Partial<Settings> = {}, options: Options = {}) => {
  vi.stubGlobal('location', { hash })
  return createElement(SettingsView, { snapshot: snapshotWith(patch), initialQuery: options.query ?? '', initialGuide: options.guide ?? null, initialGuideRecord: options.record ?? null })
}
const draw = (hash: string, patch: Partial<Settings> = {}, options: Options = {}): string => renderToStaticMarkup(view(hash, patch, options))
const checkedValues = (markup: string): string[] =>
  [...markup.matchAll(/<input type="radio"[^>]*>/g)].filter((match) => match[0].includes('checked=""')).map((match) => /value="([^"]+)"/.exec(match[0])![1]!)
const textOf = (element: Element): string => renderToStaticMarkup(element as never).replace(/<[^>]+>/g, '')

beforeAll(() => {
  vi.stubGlobal('window', { lucium: {} })
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => run())
})
beforeEach(() => {
  setLanguage('fr')
  calls.dispatched.length = 0
})
afterEach(() => setLanguage('fr'))
afterAll(() => vi.unstubAllGlobals())

describe('the one entry of the guide, on « Pour commencer »', () => {
  it('is at the top of « Pour commencer », before the rows, with the number of the questions it asks now, and on no other page', () => {
    const markup = draw('#home')
    const asked = askedQuestions(guideQuestionsOf('all'), settingsWith(), {}).length
    expect(markup).toContain('>Régler en quelques questions</b>')
    expect(markup).toContain(tp('guide.recherche-aide', asked))
    expect(markup.indexOf('class="guide-card"')).toBeLessThan(markup.indexOf('class="pref-section'))
    for (const pane of SETTINGS_PAGES.filter((one) => one !== 'home')) expect(draw(`#${pane}`), pane).not.toContain('class="guide-card"')
    // The questions it asks now: without the sleep, fewer.
    expect(draw('#home', { sleepAfterMinutes: 0 })).toContain(tp('guide.recherche-aide', askedQuestions(guideQuestionsOf('all'), settingsWith({ sleepAfterMinutes: 0 }), {}).length))
  })

  it('draws no question while it is closed', () => {
    for (const pane of SETTINGS_PAGES) expect(draw(`#${pane}`), pane).not.toContain('guide-flow')
  })

  it('speaks English in English', () => {
    setLanguage('en')
    expect(draw('#home', { interfaceTranslated: true, language: 'en' })).toContain('>Set up in a few questions</b>')
  })
})

describe('the questions of a category', () => {
  it('take the place of the rows: one question at a time, its place in the flow, the answer the settings hold checked, one « conseillé »', () => {
    const markup = draw('#tabs', {}, { guide: 'tabs' })
    expect(markup).toContain('class="guide-flow"')
    expect(markup).not.toContain('class="reset-bar"')
    expect(markup).not.toContain('class="guide-card"')
    expect(markup).toContain('Question 1 sur 5')
    expect(markup).toContain(t('guide.veille'))
    expect(checkedValues(markup)).toEqual(['equilibre'])
    expect(markup.split('class="guide-badge"').length - 1).toBe(1)
    expect(markup).not.toContain(t('guide.personnalise'))
    // A screen reader reads the answer by its label and the effect as its description.
    expect(markup).toMatch(/<input type="radio" aria-labelledby="[^"]+-maximal-label" aria-describedby="[^"]+-maximal-effect"[^>]*value="maximal"/)
    expect(markup).toMatch(/role="progressbar"[^>]*aria-valuemin="1" aria-valuemax="5" aria-valuenow="1"/)
  })

  it('check nothing and say « réglage personnalisé » when the settings are none of the answers', () => {
    const markup = draw('#tabs', { sleepAfterMinutes: 15 }, { guide: 'tabs' })
    expect(checkedValues(markup)).toEqual([])
    expect(markup).toContain(t('guide.personnalise'))
    // Read with the question, as its description.
    const described = /<fieldset class="guide-question" aria-describedby="([^"]+)"/.exec(markup)![1]!
    expect(markup).toContain(`<p class="guide-note guide-custom" id="${described}">`)
  })

  it('count only the questions that are asked: nothing about the sleep once it is « Jamais »', () => {
    expect(draw('#tabs', { sleepAfterMinutes: 0 }, { guide: 'tabs' })).toContain('Question 1 sur 3')
  })

  it('say which profiles keep their own value', () => {
    const settings = settingsWith({ profiles: { work: { autoArchiveHours: 6 } }, profileNames: { work: 'Travail' } })
    const markup = renderToStaticMarkup(createElement(GuideFlow, { scope: 'tabs', settings, onApply: () => undefined, onClose: () => undefined, initialAt: 2 }))
    expect(markup).toContain(t('guide.archivage'))
    expect(markup).toContain(frenchSpaces('Le profil « Travail » garde son propre réglage (Réglages › Profils).'))
  })
})

describe('« Ce qui va changer »', () => {
  const review = (answers: Record<string, string | null>, onApply: (plan: GuidePlan) => void = () => undefined, scope: SettingsPane | 'all' = 'tabs') =>
    createElement(GuideFlow, { scope, settings: settingsWith(), onApply, onClose: () => undefined, initialAnswers: answers, initialReview: true })

  it('lists each setting that changes, before → after, with the label of its row, and reads it as one sentence', () => {
    const markup = renderToStaticMarkup(review({ veille: 'maximal', archivage: '12-heures' }))
    expect(markup).toContain('3 réglages vont changer')
    expect(markup).toContain(frenchSpaces('<span class="guide-change-label" aria-hidden="true">Mettre en veille les onglets inactifs</span><span class="guide-old" aria-hidden="true">30 min</span>'))
    expect(markup).toContain(frenchSpaces('<span class="sr-only">Geler d’abord les onglets cachés : Jamais, devient 5 min</span>'))
    // The archive was left as it is: not listed.
    expect(markup).not.toContain(t('guide.archivage'))
    expect(markup).toContain(t('guide.autres-reglages-intacts'))
  })

  it('« Appliquer » hands over the plan of the answers', () => {
    const onApply = vi.fn()
    const apply = elementsOf(review({ veille: 'maximal' }, onApply)).find((element) => element.type === 'button' && textOf(element) === t('guide.appliquer'))!
    ;(apply.props['onClick'] as () => void)()
    expect(onApply).toHaveBeenCalledTimes(1)
    expect((onApply.mock.calls[0]![0] as GuidePlan).patch).toEqual(SLEEP_LEVELS.maximum)
  })

  it('says that nothing changes, and offers no « Appliquer », when the answers are the settings', () => {
    const markup = renderToStaticMarkup(review({ veille: 'equilibre' }))
    expect(markup).toContain(t('guide.rien-ne-change'))
    expect(markup).not.toContain(`>${t('guide.appliquer')}<`)
  })

  it('in the complete configuration, groups the changes under their category', () => {
    const markup = renderToStaticMarkup(review({ apparence: 'sombre', veille: 'modere' }, undefined, 'all'))
    expect([...markup.matchAll(/<h4>([^<]+)<\/h4>/g)].map((match) => match[1])).toEqual(['Apparence', 'Onglets et fenêtres'])
  })
})

describe('the complete configuration', () => {
  it('opens at its address, in place of the category, with the name of the category of each question', () => {
    const markup = draw('#general/guide')
    const total = askedQuestions(guideQuestionsOf('all'), settingsWith(), {}).length
    expect(markup).toContain(`<h2 class="settings-pane-title" id="pane-heading">${t('guide.configuration-rapide')}</h2>`)
    // The questions of the category of the previous layout « Général » are named as the page that holds them now.
    expect(markup).toContain(`Pour commencer · </span>Question 1 sur ${total}`)
    expect(markup).not.toContain('class="guide-card"')
  })

  it('is found by the search, under its words and under the ones people use for it', () => {
    const markup = draw('#home', {}, { query: 'configuration rapide' })
    expect(markup).toMatch(/data-search="guidedSetup"[\s\S]*?>Commencer<\/button>/)
    const text = `${t('guide.configuration-rapide')} ${tp('guide.recherche-aide', 34)} ${t('guide.titre')}`
    // The row of the guide answers every word of each query, by its words or by the synonyms of its search id.
    const answers = (query: string) => rankUnits([{ fields: { label: text }, ownKeys: ['guidedSetup'] }], query)[0]?.matched === queryWords(query).length
    for (const query of ['configuration rapide', 'réglage guidé', 'quick setup']) expect(answers(query), query).toBe(true)
    expect(answers('proxy')).toBe(false)
  })
})

describe('what « Appliquer » and « Annuler » write', () => {
  it('« Appliquer » writes the patch of the plan through the ordinary change of the settings', () => {
    const flow = elementsOf(view('#tabs', {}, { guide: 'tabs' })).find((element) => element.type === GuideFlow)!
    const plan = guidePlan(guideQuestionsOf('tabs'), settingsWith(), { veille: 'maximal' })
    ;(flow.props['onApply'] as (plan: GuidePlan) => void)(plan)
    expect(calls.dispatched).toEqual([{ type: 'settings/update', patch: SLEEP_LEVELS.maximum }])
  })

  it('« Appliquer » with nothing to change writes nothing', () => {
    const flow = elementsOf(view('#tabs', {}, { guide: 'tabs' })).find((element) => element.type === GuideFlow)!
    ;(flow.props['onApply'] as (plan: GuidePlan) => void)(guidePlan(guideQuestionsOf('tabs'), settingsWith(), { veille: 'equilibre' }))
    expect(calls.dispatched).toEqual([])
  })

  const record: GuideRecord = { scope: 'tabs', patch: SLEEP_LEVELS.maximum, undo: SLEEP_LEVELS.balanced, count: 3 }

  it('« Annuler » stays on the card until other answers are applied, and puts the settings back', () => {
    const markup = draw('#home', SLEEP_LEVELS.maximum, { record })
    expect(markup).toContain('Vos réponses ont changé 3 réglages.')
    const card = elementsOf(view('#home', SLEEP_LEVELS.maximum, { record })).find((element) => element.type === GuideCard)!
    ;(card.props['onUndo'] as () => void)()
    expect(calls.dispatched).toEqual([{ type: 'settings/update', patch: SLEEP_LEVELS.balanced }])
  })

  it('« Annuler » leaves a setting changed by hand since as it is', () => {
    const card = elementsOf(view('#home', { ...SLEEP_LEVELS.maximum, sleepAwakeMax: 20 }, { record })).find((element) => element.type === GuideCard)!
    ;(card.props['onUndo'] as () => void)()
    expect(calls.dispatched).toEqual([{ type: 'settings/update', patch: { sleepAfterMinutes: 30, sleepFreezeAfterMinutes: 0 } }])
  })

  it('shows the « Annuler » of the answers on the one entry of the guide, whatever questions were answered, and on no other page', () => {
    expect(draw('#home', SLEEP_LEVELS.maximum, { record })).toContain('Vos réponses ont changé 3 réglages.')
    expect(draw('#home', SLEEP_LEVELS.maximum, { record: { ...record, scope: 'all' } })).toContain('Vos réponses ont changé 3 réglages.')
    expect(draw('#tabs', SLEEP_LEVELS.maximum, { record })).not.toContain('Vos réponses ont changé')
  })
})

describe('the name of the guide', () => {
  it('is one, wherever it is written: its card, its questions, the menu Aide, the sheet of the import and the command bar, in both languages', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      const name = t('guide.titre')
      const names = [t('guide.configuration-rapide'), t('menu.configuration-rapide'), t('import-sheet.configuration-rapide'), settingsAnchorLabel('guide')].map((text) => text.replace(/…$/, '').toLowerCase())
      expect(new Set(names), language).toEqual(new Set([name.toLowerCase()]))
    }
    setLanguage('fr')
  })
})
