// The four presets of the Settings, measured on the table of the guide they are made of: what each option writes, when the settings read
// « Personnalisé », what « Annuler » puts back, and what the notice counts.

import { afterEach, describe, expect, it } from 'vitest'
import { frenchSpaces } from './french-typography'
import { en } from './i18n-en'
import { fr } from './i18n-fr'
import { setLanguage } from './i18n'
import { defaultSettings, type Settings } from './model'
import { PROTECTION_OF_EARLIER_PROFILES, PROTECTION_OF_NEW_PROFILES } from './model-defaults'
import { isModified, resetPlanOf, type SettingKey } from './settings-catalog'
import { answerOf, questionById, undoPatch } from './settings-guide'
import { inFold, placementOf } from './settings-placement'
import { PRESETS, presetChange, presetKeys, presetNotice, presetNoticeText, presetOf, type Preset, type PresetId, type PresetRecord } from './settings-presets'
import { clampSettings } from './sidebar-state'
import { SLEEP_LEVELS } from './sleep'

afterEach(() => setLanguage('fr'))

const defaults = (): Settings => defaultSettings()
const withPatch = (base: Settings, patch: Partial<Settings>): Settings => clampSettings({ ...base, ...patch })
const PRESET_IDS = Object.keys(PRESETS) as PresetId[]
const optionIds = (preset: Preset): string[] => preset.options.map((option) => option.id)
/** Every setting an option is made of, read in the table of the guide: the patches of its answers, together. */
const presetValues = (preset: Preset, optionId: string): Partial<Settings> => {
  const option = preset.options.find((candidate) => candidate.id === optionId)
  if (!option) return {}
  return Object.assign({}, ...preset.questions.map((questionId) => questionById(questionId)!.answers.find((answer) => answer.id === option.answers[questionId])!.patch)) as Partial<Settings>
}
/** The settings once an option is chosen over `base`, written as the window writes them (through the reducer's cleaning). */
const chosen = (preset: Preset, base: Settings, optionId: string): Settings => withPatch(base, presetChange(preset, base, optionId)?.patch ?? {})

const STANDARD = { blockAds: true, blockTrackers: true, blockCookieBanners: false, blockMode: 'standard', blockCosmetic: true, blockScriptlets: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false, reduceFingerprint: false }
const RENFORCEE = { ...STANDARD, blockCookieBanners: true, sendGpc: true, stripTrackingParams: true, stripCopiedLinks: true }
const STRICTE = { ...RENFORCEE, blockMode: 'strict', blockScriptlets: true, reduceFingerprint: true }

describe('what each option writes', () => {
  it('writes, for the protection, Standard then each level on top of the one before', () => {
    expect(presetValues(PRESETS.protection, 'standard')).toEqual(STANDARD)
    expect(presetValues(PRESETS.protection, 'renforcee')).toEqual(RENFORCEE)
    expect(presetValues(PRESETS.protection, 'stricte')).toEqual(STRICTE)
  })

  it('writes the delay alone for « Jamais » and the three values of a level for the others, as the menu of the sleep did', () => {
    expect(optionIds(PRESETS.veille)).toEqual(['jamais', 'modere', 'equilibre', 'maximal'])
    expect(presetValues(PRESETS.veille, 'jamais')).toEqual({ sleepAfterMinutes: 0 })
    expect(presetValues(PRESETS.veille, 'modere')).toEqual(SLEEP_LEVELS.moderate)
    expect(presetValues(PRESETS.veille, 'equilibre')).toEqual(SLEEP_LEVELS.balanced)
    expect(presetValues(PRESETS.veille, 'maximal')).toEqual(SLEEP_LEVELS.maximum)
  })

  it('writes the two settings of the launch and the two of the links, and nothing for an option a preset does not have', () => {
    expect(presetValues(PRESETS.lancement, 'affiches')).toEqual({ restoreWindows: true, loadAllTabsAtLaunch: false })
    expect(presetValues(PRESETS.lancement, 'tous')).toEqual({ restoreWindows: true, loadAllTabsAtLaunch: true })
    expect(presetValues(PRESETS.lancement, 'une-fenetre')).toEqual({ restoreWindows: false, loadAllTabsAtLaunch: false })
    expect(presetValues(PRESETS.liens, 'mini')).toEqual({ externalLinksInLittleArc: true, littleArcNewTabLinks: true })
    expect(presetValues(PRESETS.liens, 'onglet')).toEqual({ externalLinksInLittleArc: false, littleArcNewTabLinks: false })
    for (const unknown of ['custom', 'ailleurs', '', 'toString', '__proto__']) expect(presetChange(PRESETS.liens, defaults(), unknown), unknown).toBeNull()
  })

  it('leaves every option as itself once chosen, whatever the settings were: the defaults, each other option, or settings of no option', () => {
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id]
      const custom = withPatch(defaults(), { sleepAwakeMax: 20, restoreWindows: false, loadAllTabsAtLaunch: true, externalLinksInLittleArc: false, blockScriptlets: true, blockAds: false, blockTrackers: false })
      const bases = [defaults(), custom, ...optionIds(preset).map((other) => chosen(preset, defaults(), other))]
      for (const optionId of optionIds(preset)) {
        for (const base of bases) {
          const after = chosen(preset, base, optionId)
          expect(presetOf(preset, after), `${id}/${optionId}`).toBe(optionId)
          for (const [key, value] of Object.entries(presetValues(preset, optionId))) expect(after[key as keyof Settings], `${id}/${optionId}: ${key}`).toEqual(value)
        }
      }
    }
  })
})

describe('« Personnalisé »', () => {
  /** A value that is not `value`: the other boolean, the other mode, a number one more. */
  const other = (value: unknown): unknown => (typeof value === 'boolean' ? !value : typeof value === 'number' ? value + 1 : value === 'standard' ? 'strict' : 'standard')

  it('shows as soon as one value leaves the option: the settings are then another option to the letter, or none', () => {
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id]
      for (const optionId of optionIds(preset)) {
        const base = chosen(preset, defaults(), optionId)
        for (const [key, value] of Object.entries(presetValues(preset, optionId))) {
          // The switch of the ads and its alias leave together: either of the two on blocks the ads (the next tests).
          if (key === 'blockTrackers') continue
          const moved = { ...base, [key]: other(value), ...(key === 'blockAds' ? { blockTrackers: other(value) } : {}) } as Settings
          const now = presetOf(preset, moved)
          expect(now, `${id}/${optionId}: ${key}`).not.toBe(optionId)
          if (now !== null) for (const [k, v] of Object.entries(presetValues(preset, now))) expect(moved[k as keyof Settings], `${id}/${optionId}: ${key} reads as ${now}`).toEqual(v)
        }
      }
    }
  })

  it('names the settings of no option: a level of protection with one more rule, a sleep set by hand, one window that loads every tab, links split', () => {
    expect(presetOf(PRESETS.protection, withPatch(defaults(), { blockScriptlets: true }))).toBeNull()
    expect(presetOf(PRESETS.protection, withPatch(defaults(), { sendGpc: false }))).toBeNull()
    expect(presetOf(PRESETS.protection, withPatch(defaults(), { blockAds: false, blockTrackers: false }))).toBeNull()
    expect(presetOf(PRESETS.veille, withPatch(defaults(), { sleepAwakeMax: 20 }))).toBeNull()
    expect(presetOf(PRESETS.lancement, withPatch(defaults(), { restoreWindows: false, loadAllTabsAtLaunch: true }))).toBeNull()
    expect(presetOf(PRESETS.liens, withPatch(defaults(), { littleArcNewTabLinks: false }))).toBeNull()
  })

  it('reads the ads and the sleep as their rows read them: the alias alone blocks the ads, the delay 0 is « Jamais » whatever the cap', () => {
    expect(presetOf(PRESETS.protection, withPatch(defaults(), { blockAds: false, blockTrackers: true }))).toBe('renforcee')
    expect(presetOf(PRESETS.veille, withPatch(defaults(), { sleepAfterMinutes: 0, sleepAwakeMax: 20 }))).toBe('jamais')
    // The three values of the level, as the menu of the sleep wrote them before the preset.
    for (const [optionId, level] of [['modere', 'moderate'], ['equilibre', 'balanced'], ['maximal', 'maximum']] as const) {
      expect(chosen(PRESETS.veille, defaults(), optionId)).toMatchObject(SLEEP_LEVELS[level])
    }
  })
})

describe('the defaults and the guide', () => {
  it('make a new profile « Renforcée », « Équilibré », reopen the windows and open the links of other apps in a mini window', () => {
    expect(PRESET_IDS.map((id) => presetOf(PRESETS[id], defaults()))).toEqual(['renforcee', 'equilibre', 'affiches', 'mini'])
  })

  it('keep « Standard » what a profile had before « Renforcée » became the default, and the difference is the four settings of the new default', () => {
    expect(presetOf(PRESETS.protection, withPatch(defaults(), PROTECTION_OF_EARLIER_PROFILES))).toBe('standard')
    const added = Object.fromEntries(Object.entries(RENFORCEE).filter(([key, value]) => (STANDARD as Record<string, unknown>)[key] !== value))
    expect(added).toEqual(PROTECTION_OF_NEW_PROFILES)
  })

  it('agree on every option: the guide preselects the answers the option is made of, and its answers « conseillé » are the option of a new profile', () => {
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id]
      for (const option of preset.options) {
        const after = chosen(preset, defaults(), option.id)
        for (const questionId of preset.questions) {
          const question = questionById(questionId)!
          expect(Object.keys(option.answers), `${id}/${option.id}`).toEqual(preset.questions)
          expect(answerOf(question, after)?.id, `${id}/${option.id}: ${questionId}`).toBe(option.answers[questionId])
        }
      }
      const recommended = preset.options.find((option) => preset.questions.every((questionId) => questionById(questionId)!.answers.find((answer) => answer.recommended)?.id === option.answers[questionId]))
      expect(recommended?.id, id).toBe(presetOf(preset, defaults()))
    }
  })

  it('take the names and the lines of the guide when a preset is one question, and say everything in both catalogues', () => {
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id]
      if (preset.questions.length === 1) {
        const question = questionById(preset.questions[0]!)!
        expect(preset.options.map((option) => [option.id, option.label, option.effect]), id).toEqual(question.answers.map((answer) => [answer.id, answer.label, answer.effect]))
      }
      for (const key of [preset.label, preset.customEffect, ...preset.options.flatMap((option) => [option.label, option.effect])]) {
        expect((fr as Record<string, string>)[key], `${id}: ${key}`).toBeTruthy()
        expect((en as Record<string, string>)[key], `${id}: ${key}`).toBeTruthy()
      }
    }
  })
})

describe('« Annuler »', () => {
  it('puts back exactly the settings there were, for every option chosen from every other one', () => {
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id]
      for (const from of optionIds(preset)) {
        const before = chosen(preset, defaults(), from)
        for (const to of optionIds(preset)) {
          const change = presetChange(preset, before, to)
          if (from === to) {
            expect(change, `${id}: ${from} again`).toBeNull()
            continue
          }
          const after = withPatch(before, change!.patch)
          expect(withPatch(after, undoPatch(change!.record, after)), `${id}: ${from} → ${to} → back`).toEqual(before)
        }
      }
    }
  })

  it('goes back to before the first choice when others followed while the notice showed (the arrows choose as they move)', () => {
    const preset = PRESETS.protection
    const start = withPatch(defaults(), { blockAds: false, blockTrackers: false, blockCookieBanners: false })
    let settings = start
    let record: PresetRecord | null = null
    for (const optionId of ['standard', 'renforcee', 'stricte']) {
      const change: { patch: Partial<Settings>; record: PresetRecord } = presetChange(preset, settings, optionId, record)!
      settings = withPatch(settings, change.patch)
      record = change.record
    }
    expect(presetOf(preset, settings)).toBe('stricte')
    expect(withPatch(settings, undoPatch(record!, settings))).toEqual(start)
  })

  it('joins only a record of the same preset: the notice of another preset starts afresh', () => {
    const sleep = presetChange(PRESETS.veille, defaults(), 'maximal')!.record
    const links = presetChange(PRESETS.liens, defaults(), 'onglet', sleep)!.record
    expect(links.undo).toEqual({ externalLinksInLittleArc: true, littleArcNewTabLinks: true })
    expect(links.patch).toEqual({ externalLinksInLittleArc: false, littleArcNewTabLinks: false })
  })

  it('leaves alone a setting changed by hand since, as the guide does', () => {
    const change = presetChange(PRESETS.veille, defaults(), 'maximal')!
    const later = withPatch(withPatch(defaults(), change.patch), { sleepAwakeMax: 20 })
    expect(undoPatch(change.record, later)).toEqual({ sleepAfterMinutes: 30, sleepFreezeAfterMinutes: 0 })
  })
})

describe('the notice', () => {
  it('counts the rows that changed, the switch of the ads and its alias as one, and gives the settings to light', () => {
    const toStandard = presetChange(PRESETS.protection, defaults(), 'standard')!
    const notice = presetNotice(toStandard.record, withPatch(defaults(), toStandard.patch))
    expect(notice).toEqual({ count: 4, folded: 0, keys: ['blockCookieBanners', 'sendGpc', 'stripTrackingParams', 'stripCopiedLinks'] })
    const off = withPatch(defaults(), { blockAds: false, blockTrackers: false })
    const on = presetChange(PRESETS.protection, off, 'renforcee')!
    expect(presetNotice(on.record, withPatch(off, on.patch)).count).toBe(1)
    expect(presetNotice(on.record, withPatch(off, on.patch)).keys).toEqual(['blockAds', 'blockTrackers'])
  })

  it('counts the rows folded under « Plus de réglages » apart, as the page says they are', () => {
    const change = presetChange(PRESETS.protection, defaults(), 'stricte')!
    const after = withPatch(defaults(), change.patch)
    expect(presetNotice(change.record, after, (key) => key === 'blockScriptlets' || key === 'blockMode')).toMatchObject({ count: 3, folded: 2 })
  })

  it('counts nothing once the choices came back to where they started', () => {
    const first = presetChange(PRESETS.liens, defaults(), 'onglet')!
    const settings = withPatch(defaults(), first.patch)
    const back = presetChange(PRESETS.liens, settings, 'mini', first.record)!
    expect(presetNotice(back.record, withPatch(settings, back.patch)).count).toBe(0)
  })

  it('says it in whole sentences, in both languages', () => {
    expect(presetNoticeText({ count: 4, folded: 0 })).toBe('4 réglages ont changé.')
    expect(presetNoticeText({ count: 1, folded: 0 })).toBe('1 réglage a changé.')
    expect(presetNoticeText({ count: 4, folded: 2 })).toBe(frenchSpaces('4 réglages ont changé, dont 2 dans « Plus de réglages ».'))
    expect(presetNoticeText({ count: 1, folded: 1 })).toBe(frenchSpaces('1 réglage a changé, dans « Plus de réglages ».'))
    // Every one folded: « tous », not « dont 4 » of 4.
    expect(presetNoticeText({ count: 4, folded: 4 })).toBe(frenchSpaces('4 réglages ont changé, tous dans « Plus de réglages ».'))
    setLanguage('en')
    expect(presetNoticeText({ count: 3, folded: 1 })).toBe('3 settings changed, 1 of them under “More settings”.')
    expect(presetNoticeText({ count: 4, folded: 4 })).toBe('4 settings changed, all of them under “More settings”.')
    expect(presetNoticeText({ count: 1, folded: 0 })).toBe('1 setting changed.')
  })

  it('counts apart, with the table of the window, every setting a preset writes but the one its row stands for', () => {
    // Renforcée → Standard: the four settings of the new default; the cookie banners and the tracking parameters of the addresses are switches under
    // the level of protection, GPC and the copied links wait in « Plus de réglages ». Stricte adds three, the fingerprint the only one at the top.
    const toStandard = presetChange(PRESETS.protection, defaults(), 'standard')!
    expect(presetNotice(toStandard.record, withPatch(defaults(), toStandard.patch), inFold)).toMatchObject({ count: 4, folded: 2 })
    const toStricte = presetChange(PRESETS.protection, defaults(), 'stricte')!
    expect(presetNotice(toStricte.record, withPatch(defaults(), toStricte.patch), inFold)).toMatchObject({ count: 3, folded: 2 })
    // Every tab loaded at the launch: its switch waits; one window only: the row of the preset is the windows of the last session, at the top.
    const allTabs = presetChange(PRESETS.lancement, defaults(), 'tous')!
    expect(presetNotice(allTabs.record, withPatch(defaults(), allTabs.patch), inFold)).toMatchObject({ count: 1, folded: 1 })
    const oneWindow = presetChange(PRESETS.lancement, defaults(), 'une-fenetre')!
    expect(presetNotice(oneWindow.record, withPatch(defaults(), oneWindow.patch), inFold)).toMatchObject({ count: 1, folded: 0 })
    const maximal = presetChange(PRESETS.veille, defaults(), 'maximal')!
    expect(presetNotice(maximal.record, withPatch(defaults(), maximal.patch), inFold)).toMatchObject({ count: 3, folded: 2 })
  })
})

describe('the row of a preset in the window', () => {
  it('stands for the setting its options tell apart, at the top of its page, and every other setting it writes waits in « Plus de réglages »', () => {
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id]
      if (!('settingKey' in preset.row)) continue
      const own = preset.row.settingKey
      expect(presetKeys(preset), id).toContain(own)
      expect(placementOf(own), id).toBe('page')
      const values = new Set(preset.options.map((option) => JSON.stringify(chosen(preset, defaults(), option.id)[own])))
      expect(values.size, `${id}: its options set ${own} apart`).toBeGreaterThan(1)
      for (const key of presetKeys(preset).filter((key) => key !== own)) expect(placementOf(key), `${id}: ${key}`).toBe('more')
    }
  })

  it('draws for the level of protection a search id, four switches under it and the five others in « Plus de réglages »', () => {
    // Every level blocks the ads: no setting tells them apart, and the row carries a search id instead.
    expect(PRESETS.protection.row).toEqual({ searchKey: 'protectionLevel' })
    const atTop = presetKeys(PRESETS.protection).filter((key) => placementOf(key) === 'page')
    expect(atTop).toEqual(['blockAds', 'blockCookieBanners', 'stripTrackingParams', 'reduceFingerprint'])
    expect(presetKeys(PRESETS.protection).filter((key) => placementOf(key) === 'more').sort()).toEqual(['blockCosmetic', 'blockMode', 'blockScriptlets', 'sendGpc', 'stripCopiedLinks'])
  })

  it('watches every setting its options write, but the alias of the ads, which goes with its setting', () => {
    expect(presetKeys(PRESETS.protection).sort()).toEqual(['blockAds', 'blockCookieBanners', 'blockCosmetic', 'blockMode', 'blockScriptlets', 'reduceFingerprint', 'sendGpc', 'stripCopiedLinks', 'stripTrackingParams'])
    expect(presetKeys(PRESETS.veille)).toEqual(['sleepAfterMinutes', 'sleepAwakeMax', 'sleepFreezeAfterMinutes'])
    expect(presetKeys(PRESETS.lancement)).toEqual(['restoreWindows', 'loadAllTabsAtLaunch'])
    expect(presetKeys(PRESETS.liens)).toEqual(['externalLinksInLittleArc', 'littleArcNewTabLinks'])
  })

  it('is not changed at the option of a new profile, and is from every other option and from « Personnalisé »', () => {
    const changed = (preset: Preset, settings: Settings): boolean => presetKeys(preset).some((key) => isModified(settings, key))
    const custom = withPatch(defaults(), { sleepAwakeMax: 20, restoreWindows: false, loadAllTabsAtLaunch: true, littleArcNewTabLinks: false, blockScriptlets: true })
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id]
      expect(changed(preset, defaults()), id).toBe(false)
      for (const option of preset.options) expect(changed(preset, chosen(preset, defaults(), option.id)), `${id}/${option.id}`).toBe(option.id !== presetOf(preset, defaults()))
      expect(presetOf(preset, custom), id).toBeNull()
      expect(changed(preset, custom), id).toBe(true)
    }
  })

  it('goes back whole to the option of a new profile with « Rétablir », from every option and from « Personnalisé », the alias of the ads with it', () => {
    const custom = withPatch(defaults(), { sleepAwakeMax: 20, restoreWindows: false, loadAllTabsAtLaunch: true, littleArcNewTabLinks: false, blockScriptlets: true, blockAds: false, blockTrackers: false })
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id]
      for (const base of [custom, ...preset.options.map((option) => chosen(preset, defaults(), option.id))]) {
        const plan = resetPlanOf(presetKeys(preset), base)
        const after = plan ? withPatch(base, plan.patch) : base
        expect(presetOf(preset, after), id).toBe(presetOf(preset, defaults()))
        for (const key of presetKeys(preset)) expect(after[key as SettingKey], `${id}: ${key}`).toEqual(defaults()[key as SettingKey])
      }
    }
    expect(resetPlanOf(presetKeys(PRESETS.protection), custom)?.patch).toMatchObject({ blockAds: true, blockTrackers: true, blockScriptlets: false })
    // A profile made before « Renforcée » became the default keeps its « Standard » until it asks: « Rétablir » then gives it the level of a new profile.
    const earlier = withPatch(defaults(), PROTECTION_OF_EARLIER_PROFILES)
    expect(resetPlanOf(presetKeys(PRESETS.protection), earlier)?.patch).toEqual(PROTECTION_OF_NEW_PROFILES)
  })
})
