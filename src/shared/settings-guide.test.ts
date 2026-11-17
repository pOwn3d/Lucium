// « Régler en quelques questions »: the table of the questions is checked against the settings it writes (real keys, values the reducer keeps,
// answers that come back as the preselection), and the list of « Ce qui va changer », its « Annuler » and the order of the complete
// configuration are measured on it.

import { afterEach, describe, expect, it } from 'vitest'
import { en } from './i18n-en'
import { fr } from './i18n-fr'
import { setLanguage } from './i18n'
import { interfaceMayDispatch } from './ipc-policy'
import { SETTINGS_PANES } from './ipc'
import { defaultSettings, type Settings } from './model'
import { categoryOfKey } from './settings-catalog'
import {
  GUIDE_QUESTIONS,
  GUIDE_ROWS,
  GUIDED_SETUP_REQUEST,
  RECOMMENDED_AWAY_FROM_DEFAULTS,
  answerOf,
  askedQuestions,
  checkedOf,
  guidePlan,
  guideQuestionsOf,
  questionById,
  rowOfKey,
  stepForward,
  undoPatch,
  type GuideQuestion
} from './settings-guide'
import { settingsHash } from './settings-target'
import { clampSettings } from './sidebar-state'
import { SLEEP_LEVELS } from './sleep'
import { frenchSpaces } from './french-typography'

afterEach(() => setLanguage('fr'))

const defaults = (): Settings => defaultSettings()
const withPatch = (base: Settings, patch: Partial<Settings>): Settings => ({ ...base, ...patch })
const question = (id: string): GuideQuestion => questionById(id)!
const keysOf = (q: GuideQuestion): string[] => [...new Set(q.answers.flatMap((a) => Object.keys(a.patch)))]

describe('the table of the questions', () => {
  it('holds about thirty questions, three to five in each of the eight categories, each with two to four answers and one « conseillé »', () => {
    expect(GUIDE_QUESTIONS.length).toBeGreaterThanOrEqual(28)
    expect(GUIDE_QUESTIONS.length).toBeLessThanOrEqual(36)
    // The questions name the categories of the layout they were written for (`general` among them, which leads to « Pour commencer »).
    const panes = [...new Set(GUIDE_QUESTIONS.map((question) => question.pane))]
    expect(panes).toHaveLength(8)
    for (const pane of panes) {
      const count = guideQuestionsOf(pane).length
      expect(count, pane).toBeGreaterThanOrEqual(3)
      expect(count, pane).toBeLessThanOrEqual(5)
    }
    for (const q of GUIDE_QUESTIONS) {
      expect(q.answers.length, q.id).toBeGreaterThanOrEqual(2)
      expect(q.answers.length, q.id).toBeLessThanOrEqual(4)
      expect(q.answers.filter((a) => a.recommended).length, q.id).toBe(1)
      expect(new Set(q.answers.map((a) => a.id)).size, q.id).toBe(q.answers.length)
    }
    expect(new Set(GUIDE_QUESTIONS.map((q) => q.id)).size).toBe(GUIDE_QUESTIONS.length)
  })

  it('says everything through the two catalogues', () => {
    for (const q of GUIDE_QUESTIONS) {
      const keys = [q.title, q.topic, ...(q.hint ? [q.hint] : []), ...q.answers.flatMap((a) => [a.label, a.effect])]
      for (const key of keys) {
        expect((fr as Record<string, string>)[key], `${q.id} ${key}`).toBeTruthy()
        expect((en as Record<string, string>)[key], `${q.id} ${key}`).toBeTruthy()
      }
    }
  })

  it('writes only real settings, with values the reducer keeps as they are and the interface may send', () => {
    for (const q of GUIDE_QUESTIONS) {
      for (const a of q.answers) {
        for (const key of Object.keys(a.patch)) {
          expect(Object.hasOwn(defaults(), key), `${q.id}/${a.id}: ${key}`).toBe(true)
          // A setting with a row of its own, or the alias the switch of the ads writes with it.
          expect(categoryOfKey(key) !== null || key === 'blockTrackers', `${q.id}/${a.id}: ${key}`).toBe(true)
        }
        const cleaned = clampSettings(withPatch(defaults(), a.patch))
        for (const [key, value] of Object.entries(a.patch)) expect(cleaned[key as keyof Settings], `${q.id}/${a.id}: ${key}`).toEqual(value)
        expect(interfaceMayDispatch({ type: 'settings/update', patch: a.patch }, []), `${q.id}/${a.id}`).toBe(true)
      }
    }
  })

  it('has one row of « Ce qui va changer » for every setting it writes, and no row nothing writes', () => {
    const written = new Set(GUIDE_QUESTIONS.flatMap(keysOf))
    for (const key of written) expect(rowOfKey(key as keyof Settings), key).toBeDefined()
    for (const [id, row] of Object.entries(GUIDE_ROWS)) {
      expect(row.keys.some((key) => written.has(key)), id).toBe(true)
      expect((fr as Record<string, string>)[row.label], id).toBeTruthy()
      for (const key of row.keys) expect(Object.keys(GUIDE_ROWS).filter((other) => GUIDE_ROWS[other]!.keys.includes(key)), key).toEqual([id])
    }
  })

  it('never has two questions write the same setting: the preselection of one does not depend on the answer to another', () => {
    const owner = new Map<string, string>()
    for (const q of GUIDE_QUESTIONS) {
      for (const key of keysOf(q)) {
        expect(owner.get(key), `${key}: ${owner.get(key)} and ${q.id}`).toBeUndefined()
        owner.set(key, q.id)
      }
    }
  })
})

describe('the preselection', () => {
  // Every answer, applied over the defaults and over each other answer of its question, then cleaned as the reducer does, comes back as itself.
  it('gives back the answer just applied, whatever the settings were', () => {
    for (const q of GUIDE_QUESTIONS) {
      const bases = [defaults(), ...q.answers.map((a) => withPatch(defaults(), a.patch))]
      for (const a of q.answers) {
        for (const base of bases) {
          const applied = clampSettings(withPatch(base, a.patch))
          expect(answerOf(q, applied)?.id, `${q.id}/${a.id}`).toBe(a.id)
          // The answer the settings hold changes nothing.
          expect(guidePlan([q], applied, { [q.id]: a.id }).count, `${q.id}/${a.id}`).toBe(0)
        }
      }
    }
  })

  it('checks nothing when the settings are no answer (« réglage personnalisé »)', () => {
    expect(answerOf(question('veille'), withPatch(defaults(), { sleepAfterMinutes: 15 }))).toBeNull()
    expect(answerOf(question('taille'), withPatch(defaults(), { uiScale: 120 }))).toBeNull()
    expect(answerOf(question('moteur'), withPatch(defaults(), { searchUrlTemplate: 'https://search.example/?q=%s' }))).toBeNull()
    expect(answerOf(question('site-casse'), withPatch(defaults(), { blockMode: 'strict', blockScriptlets: false }))).toBeNull()
    expect(checkedOf(question('veille'), withPatch(defaults(), { sleepAfterMinutes: 15 }), {})).toBeNull()
  })

  it('reads the language and the ads as their rows read them: an alias or a French interface is the answer it means', () => {
    expect(answerOf(question('bloqueur'), withPatch(defaults(), { blockAds: false, blockTrackers: true }))?.id).toBe('cookies')
    expect(answerOf(question('bloqueur'), withPatch(defaults(), { blockAds: false, blockTrackers: true, blockCookieBanners: false }))?.id).toBe('pubs')
    expect(answerOf(question('langue'), withPatch(defaults(), { interfaceTranslated: false, language: 'en' }))?.id).toBe('francais')
    expect(answerOf(question('langue'), withPatch(defaults(), { interfaceTranslated: true, language: 'fr' }))?.id).toBe('francais')
  })

  it('checks the recommended answer on a new profile, but where the table says why it is not the default', () => {
    for (const q of GUIDE_QUESTIONS) {
      const recommended = q.answers.find((a) => a.recommended)!
      const held = answerOf(q, defaults())
      // The defaults are always one of the answers: a new profile never reads « réglage personnalisé ».
      expect(held, q.id).not.toBeNull()
      if (Object.hasOwn(RECOMMENDED_AWAY_FROM_DEFAULTS, q.id)) expect(held!.id, q.id).not.toBe(recommended.id)
      else expect(held!.id, q.id).toBe(recommended.id)
    }
    // The list does not outlive its questions.
    for (const id of Object.keys(RECOMMENDED_AWAY_FROM_DEFAULTS)) expect(questionById(id), id).toBeDefined()
    expect(Object.keys(RECOMMENDED_AWAY_FROM_DEFAULTS).sort()).toEqual(['reprise'])
  })

  it('is what « Suivant » keeps when nothing was clicked', () => {
    const tabs = guideQuestionsOf('tabs')
    const step = stepForward(tabs, defaults(), {}, 'veille')
    expect(step.answers).toEqual({ veille: 'equilibre' })
    expect(step.next).toBe(1)
    expect(stepForward(tabs, withPatch(defaults(), { sleepAfterMinutes: 15 }), {}, 'veille').answers).toEqual({ veille: null })
  })
})

describe('« Ce qui va changer »', () => {
  it('lists the settings that change, before and after, in the words of their rows, and keeps what puts them back', () => {
    const plan = guidePlan(guideQuestionsOf('tabs'), defaults(), { veille: 'maximal' })
    expect(plan.items.map((item) => item.question.id)).toEqual(['veille'])
    expect(plan.items[0]!.changes).toEqual([
      { row: 'sleepAfterMinutes', label: 'Mettre en veille les onglets inactifs', before: frenchSpaces('30 min'), after: frenchSpaces('10 min') },
      { row: 'sleepAwakeMax', label: 'Onglets éveillés en arrière-plan, au plus', before: '12', after: '6' },
      { row: 'sleepFreezeAfterMinutes', label: 'Geler d’abord les onglets cachés', before: 'Jamais', after: frenchSpaces('5 min') }
    ])
    expect(plan.patch).toEqual(SLEEP_LEVELS.maximum)
    expect(plan.undo).toEqual(SLEEP_LEVELS.balanced)
    expect(plan.count).toBe(3)
  })

  it('leaves out a question whose answer changes nothing, or that has no answer', () => {
    const plan = guidePlan(guideQuestionsOf('tabs'), defaults(), { veille: 'equilibre', 'veille-mode': null, archivage: '7-jours' })
    expect(plan.items.map((item) => item.question.id)).toEqual(['archivage'])
    expect(plan.items[0]!.changes).toEqual([{ row: 'autoArchiveHours', label: 'Archiver les onglets du jour inactifs', before: frenchSpaces('12 h'), after: '7 jours' }])
    expect(plan.patch).toEqual({ autoArchiveHours: 168 })
    expect(guidePlan(guideQuestionsOf('tabs'), defaults(), {}).count).toBe(0)
  })

  it('writes only the settings that change: a part of an answer the settings hold already is not in the patch', () => {
    const plan = guidePlan(guideQuestionsOf('protection'), withPatch(defaults(), { blockMode: 'strict' }), { 'site-casse': 'plus-fort' })
    expect(plan.patch).toEqual({ blockScriptlets: true })
    expect(plan.undo).toEqual({ blockScriptlets: false })
  })

  it('shows the ads and their alias as the one row of the switch, and the language as the row of the language', () => {
    const blocker = guidePlan(guideQuestionsOf('protection'), defaults(), { bloqueur: 'rien' })
    expect(blocker.items[0]!.changes).toEqual([
      { row: 'blockAds', label: 'Bloquer les publicités et les traqueurs', before: 'oui', after: 'non' },
      { row: 'blockCookieBanners', label: 'Bloquer les bannières de cookies', before: 'oui', after: 'non' }
    ])
    expect(blocker.patch).toEqual({ blockAds: false, blockTrackers: false, blockCookieBanners: false })
    // The alias alone out of step changes nothing a person sees: nothing is listed, nothing written.
    expect(guidePlan(guideQuestionsOf('protection'), withPatch(defaults(), { blockTrackers: false }), { bloqueur: 'cookies' }).count).toBe(0)
    const language = guidePlan(guideQuestionsOf('general'), defaults(), { langue: 'francais' })
    expect(language.items[0]!.changes).toEqual([{ row: 'language', label: 'Langue de l’interface', before: 'Automatique (langue du système)', after: 'Français' }])
    // Only what the answer says: a key of the row it does not name stays out (undefined would put the language back to « auto »).
    expect(language.patch).toStrictEqual({ interfaceTranslated: false })
    expect(language.undo).toStrictEqual({ interfaceTranslated: true })
  })

  it('drops the answer to a question no longer asked: the kind of sleep after « Jamais »', () => {
    const tabs = guideQuestionsOf('tabs')
    const answers = { veille: 'jamais', 'veille-mode': 'garder', epingles: 'eveilles' }
    expect(askedQuestions(tabs, defaults(), answers).map((q) => q.id)).toEqual(['veille', 'archivage', 'lancement'])
    const plan = guidePlan(tabs, defaults(), answers)
    expect(plan.patch).toEqual({ sleepAfterMinutes: 0 })
    expect(stepForward(tabs, defaults(), { veille: 'jamais' }, 'veille').next).toBe(1)
    // Without the sleep, no question about the suggestions of an engine that has none either.
    expect(askedQuestions(guideQuestionsOf('navigation'), defaults(), { moteur: 'qwant' }).map((q) => q.id)).not.toContain('suggestions')
  })

  it('names the profiles that keep their own value of what a question writes', () => {
    const settings = withPatch(defaults(), { profiles: { work: { autoArchiveHours: 6 } }, profileNames: { work: 'Travail' } })
    const plan = guidePlan(guideQuestionsOf('tabs'), settings, { archivage: 'jamais' })
    expect(plan.items[0]!.profiles).toEqual(['Travail'])
    expect(guidePlan(guideQuestionsOf('tabs'), defaults(), { archivage: 'jamais' }).items[0]!.profiles).toEqual([])
  })

  it('speaks the language of the interface', () => {
    setLanguage('en')
    const plan = guidePlan(guideQuestionsOf('tabs'), defaults(), { veille: 'jamais' })
    expect(plan.items[0]!.changes).toEqual([{ row: 'sleepAfterMinutes', label: 'Put inactive tabs to sleep', before: '30 min', after: 'Never' }])
  })
})

describe('« Annuler »', () => {
  it('puts back the settings the answers changed', () => {
    const plan = guidePlan(guideQuestionsOf('tabs'), defaults(), { veille: 'maximal' })
    const after = clampSettings(withPatch(defaults(), plan.patch))
    expect(undoPatch(plan, after)).toEqual(SLEEP_LEVELS.balanced)
  })

  it('leaves alone a setting changed by hand since: undoing the answers never undoes a later choice', () => {
    const plan = guidePlan(guideQuestionsOf('tabs'), defaults(), { veille: 'maximal' })
    const later = withPatch(clampSettings(withPatch(defaults(), plan.patch)), { sleepAwakeMax: 20 })
    expect(undoPatch(plan, later)).toEqual({ sleepAfterMinutes: 30, sleepFreezeAfterMinutes: 0 })
  })
})

describe('the complete configuration', () => {
  it('asks every question of every category, in the order of the window', () => {
    const all = guideQuestionsOf('all')
    expect(all.map((q) => q.id)).toEqual(SETTINGS_PANES.flatMap((pane) => guideQuestionsOf(pane).map((q) => q.id)))
    expect(all.length).toBe(GUIDE_QUESTIONS.length)
    // « Suivant » on each question, as preselected, leads through all of them, then to the one summary.
    let answers = {}
    const visited: string[] = []
    let at: number | null = 0
    while (at !== null) {
      const current = askedQuestions(all, defaults(), answers)[at]!
      visited.push(current.id)
      const step = stepForward(all, defaults(), answers, current.id)
      answers = step.answers
      at = step.next
    }
    expect(visited).toEqual(all.map((q) => q.id))
    expect(guidePlan(all, defaults(), answers).count).toBe(0)
  })

  it('ends with one summary of the changes of every category, in their order', () => {
    const plan = guidePlan(guideQuestionsOf('all'), defaults(), { 'onglets-prives': 'non', apparence: 'sombre', pistage: 'rien', veille: 'modere' })
    expect(plan.items.map((item) => item.question.id)).toEqual(['apparence', 'veille', 'pistage', 'onglets-prives'])
    expect(plan.items.map((item) => item.question.pane)).toEqual(['appearance', 'tabs', 'protection', 'profiles'])
    expect(plan.count).toBe(1 + 2 + 3 + 1)
  })

  it('opens from the menu and the sheets at an address the Settings window knows', () => {
    expect(settingsHash(GUIDED_SETUP_REQUEST.pane!, GUIDED_SETUP_REQUEST.anchor)).toBe('home/guide')
  })
})
