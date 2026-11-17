// The presets of the Settings: one choice among a few options that writes several settings at once, and « Personnalisé » when the settings are
// none of them. An option is one answer of « Régler en quelques questions » per question (settings-guide.ts): the values live in GUIDE_QUESTIONS
// only, so the guide and the presets cannot say two different things. Pure: the Settings window draws them (renderer/PresetSettings.tsx) and
// writes through `settings/update`, where the reducer cleans the patch as it cleans any other change.

import { t, tp, type MessageKey } from './i18n'
import type { SettingsPane } from './ipc'
import type { Settings } from './model'
import { categoryOfKey, type SettingKey } from './settings-catalog'
import { GUIDE_ROWS, guidePlan, holdsAnswer, questionById, type GuideKey, type GuideQuestion } from './settings-guide'
import type { SearchId } from './settings-synonyms'

export type PresetId = 'protection' | 'veille' | 'lancement' | 'liens'

export interface PresetOption {
  id: string
  label: MessageKey
  /** One line: what the option does, written under the control. */
  effect: MessageKey
  /** The answer this option is, for each question of its preset. */
  answers: Readonly<Record<string, string>>
}

export interface Preset {
  id: PresetId
  label: MessageKey
  /** The category it belongs to (the home page shows it too). */
  pane: SettingsPane
  /** The questions of the guide whose answers make its options. */
  questions: readonly string[]
  options: readonly PresetOption[]
  /** The line under the control when the settings are none of the options. */
  customEffect: MessageKey
  /** A row of buttons for short names; a menu for names that would not fit side by side. */
  control: 'buttons' | 'menu'
  /**
   * What the row of the preset stands for in the window: the setting its options tell apart, whose row it is (its place at the top of its page, what
   * a search or a link finds, its mirror on « Pour commencer »), its other settings waiting in « Plus de réglages »; or, for the protection, whose
   * three levels all block the ads, a search id of its own: the switch of the ads keeps its row, under the preset with three others.
   */
  row: { settingKey: SettingKey } | { searchKey: SearchId }
}

/** The options of a preset made of one question: its answers, with their names and their lines. */
function answersOf(questionId: string): PresetOption[] {
  const question = questionById(questionId)
  if (!question) throw new Error(`settings-presets: no question "${questionId}" in the guide`)
  return question.answers.map((answer) => ({ id: answer.id, label: answer.label, effect: answer.effect, answers: { [questionId]: answer.id } }))
}

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  // Standard is what a profile had before « Renforcée » became the default; each level adds to the one before it (the answers « conseillé » make Renforcée).
  protection: {
    id: 'protection',
    label: 'presets.protection',
    pane: 'protection',
    questions: ['bloqueur', 'site-casse', 'pistage'],
    options: [
      { id: 'standard', label: 'presets.protection-standard', effect: 'presets.protection-standard-effet', answers: { bloqueur: 'pubs', 'site-casse': 'site-par-site', pistage: 'rien' } },
      { id: 'renforcee', label: 'presets.protection-renforcee', effect: 'presets.protection-renforcee-effet', answers: { bloqueur: 'cookies', 'site-casse': 'site-par-site', pistage: 'adresses' } },
      { id: 'stricte', label: 'presets.protection-stricte', effect: 'presets.protection-stricte-effet', answers: { bloqueur: 'cookies', 'site-casse': 'plus-fort', pistage: 'empreinte' } }
    ],
    customEffect: 'presets.protection-personnalise',
    control: 'buttons',
    row: { searchKey: 'protectionLevel' }
  },
  veille: { id: 'veille', label: 'settings.mettre-en-veille-les-onglets-inactifs', pane: 'tabs', questions: ['veille'], options: answersOf('veille'), customEffect: 'presets.veille-personnalise', control: 'buttons', row: { settingKey: 'sleepAfterMinutes' } },
  lancement: { id: 'lancement', label: 'presets.lancement', pane: 'tabs', questions: ['lancement'], options: answersOf('lancement'), customEffect: 'presets.lancement-personnalise', control: 'menu', row: { settingKey: 'restoreWindows' } },
  liens: { id: 'liens', label: 'presets.liens', pane: 'navigation', questions: ['liens'], options: answersOf('liens'), customEffect: 'presets.liens-personnalise', control: 'buttons', row: { settingKey: 'externalLinksInLittleArc' } }
}

const questionsOf = (preset: Preset): GuideQuestion[] => preset.questions.map((id) => questionById(id)!)

const optionOf = (preset: Preset, optionId: string): PresetOption | undefined => preset.options.find((option) => option.id === optionId)

/**
 * The settings the options of a preset write, but an alias that has no row of its own (the trackers go with the ads, privacy-dashboard.ts): what the
 * dot of its row watches and what its « Rétablir » puts back, so that the preset of a new profile shows no change and « Rétablir » brings it back whole.
 */
export function presetKeys(preset: Preset): SettingKey[] {
  const keys = new Set<SettingKey>()
  for (const question of questionsOf(preset)) {
    for (const answer of question.answers) {
      if (!preset.options.some((option) => option.answers[question.id] === answer.id)) continue
      for (const key of Object.keys(answer.patch) as SettingKey[]) if (categoryOfKey(key) !== null) keys.add(key)
    }
  }
  return [...keys]
}

/** The option the settings are, or null for « Personnalisé »: each answer of the option holds, read as the guide reads it (an alias, the delay 0). */
export function presetOf(preset: Preset, settings: Settings): string | null {
  const questions = questionsOf(preset)
  const holds = (option: PresetOption): boolean =>
    questions.every((question) => {
      const answer = question.answers.find((candidate) => candidate.id === option.answers[question.id])
      return answer !== undefined && holdsAnswer(answer, settings)
    })
  return preset.options.find(holds)?.id ?? null
}

/**
 * What a choice wrote, kept while its notice shows: the settings written and the value each had before. A choice made while the notice of the same
 * preset still shows joins it, so that « Annuler » goes back to before the first one (the arrow keys move through the options and choose each).
 */
export interface PresetRecord {
  preset: PresetId
  patch: Partial<Settings>
  undo: Partial<Settings>
}

/**
 * The change a choice makes: `patch` is what to write now (only the settings that change, as the guide writes them), `record` what « Annuler » puts
 * back. Null when the settings already are that option, or for an option the preset does not have.
 */
export function presetChange(preset: Preset, settings: Settings, optionId: string, previous: PresetRecord | null = null): { patch: Partial<Settings>; record: PresetRecord } | null {
  const option = optionOf(preset, optionId)
  if (!option) return null
  const plan = guidePlan(questionsOf(preset), settings, option.answers)
  if (plan.count === 0) return null
  const joined = previous !== null && previous.preset === preset.id
  const record: PresetRecord = joined
    ? { preset: preset.id, patch: { ...previous.patch, ...plan.patch }, undo: { ...plan.undo, ...previous.undo } }
    : { preset: preset.id, patch: plan.patch, undo: plan.undo }
  return { patch: plan.patch, record }
}

/** What the notice says: how many rows differ from before the first choice, how many of them are folded on the page, and the settings to light. */
export interface PresetNotice {
  count: number
  folded: number
  keys: GuideKey[]
}

/**
 * The rows a record changed, counted as the guide counts them (the switch of the ads and its alias are one row), between the settings before the
 * first choice and `after`. `isFolded` says whether the row of a setting is out of sight under « Plus de réglages » on the page.
 */
export function presetNotice(record: PresetRecord, after: Settings, isFolded: (key: GuideKey) => boolean = () => false): PresetNotice {
  const before: Settings = { ...after, ...record.undo }
  const touched = new Set(Object.keys(record.undo))
  const rows = Object.values(GUIDE_ROWS).filter((row) => {
    if (!row.keys.some((key) => touched.has(key))) return false
    const read = row.read ?? ((settings: Settings) => settings[row.keys[0]!])
    return JSON.stringify(read(before)) !== JSON.stringify(read(after))
  })
  return { count: rows.length, folded: rows.filter((row) => isFolded(row.keys[0]!)).length, keys: rows.flatMap((row) => [...row.keys]) }
}

/** « 4 réglages ont changé, dont 2 dans « Plus de réglages ». » (« tous » when every one is folded), in the language of the interface. */
export function presetNoticeText(notice: Pick<PresetNotice, 'count' | 'folded'>): string {
  if (notice.folded > 1 && notice.folded === notice.count) return t('presets.ont-change-tous-replies', { count: notice.count })
  return notice.folded > 0 ? tp('presets.ont-change-replies', notice.count, { folded: notice.folded }) : tp('presets.ont-change', notice.count)
}
