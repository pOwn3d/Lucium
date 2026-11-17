// « Fonctions en option »: the catalogue of the features that add something to Lucium (a tree of tabs, the containers, the notes, the QR code…), which no
// category draws (shared/settings-catalog.ts, FEATURE_THEMES). One line a feature, theme by theme: its switch, the first sentence of what it does, its cost
// said in a sentence, the whole text behind « En savoir plus ». What goes with a feature follows its line: its option, shown while it is on; the row of
// the subpage of its list (the containers, the scripts, the pages watched: shared/settings-subpages.ts), while it is on; and the two sets of settings
// that are no feature of the registry, the clearing of the page annotation and the summary by a local model. Above the catalogue, a filter « Toutes /
// Allumées / Coupées » keeps the lines of the features in one state, in the order of the themes, and says how many lines it shows; a line whose switch
// is turned under it stays until the filter changes.

import { useContext, useState, type ReactNode } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { featureById, isFeatureShownOn, type Feature, type FeatureId } from '@shared/features'
import { CATALOGUE_FEATURES, FEATURE_THEMES, isModified, type FeatureTheme } from '@shared/settings-catalog'
import { AUTO_CLEAR_SECONDS } from '@shared/annotate-auto-clear'
import { shortcutSuffix } from '@shared/keybindings'
import { platformOf } from '@shared/platform'
import { t, tp, type MessageKey } from '@shared/i18n'
import { ContainersSettings } from './ContainersSettings'
import { CatalogueFeature } from './FeaturesSettings'
import { UserScriptsEntry, UserScriptsSettings } from './UserScriptsSettings'
import { PageWatchesSettings, SummarySettings } from './WebToolsSettings'
import { Check, Choice, Group, Row, SubpageEntry } from './settings-parts'
import { FeatureFilterContext, SearchingContext, SettingsStateContext, type FeatureFilter } from './settings-context'
import { radioGroupKeys } from './radio-keys'
import './settings-presets.css'

interface PageProps {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

/** The features the page lists, in its order. */
export const catalogueFeatures = (): Feature[] => CATALOGUE_FEATURES.map(featureById)

/** How many of the features the page lists are on. */
export const featuresOn = (settings: Settings): number => CATALOGUE_FEATURES.filter((id) => isFeatureShownOn(settings, id)).length

/**
 * The options of a feature, under its line while it is on. They stay drawn while it is off when one of them is not at its default (so that it can be
 * seen and put back) and in a search or « Réglages modifiés » (which find every row): greyed then, as they do nothing.
 */
function FeatureOptions({ on, keys, children }: { on: boolean; keys: readonly (keyof Settings)[]; children: ReactNode }) {
  const settings = useContext(SettingsStateContext)
  const { searching } = useContext(SearchingContext)
  const changed = settings !== null && keys.some((key) => isModified(settings, key))
  if (!on && !searching && !changed) return null
  return <div className="feature-options">{children}</div>
}

/** What follows the line of a feature in its theme: an option of its own, or the rows that are set with it. */
function After({ id, snapshot, update }: PageProps & { id: FeatureId }) {
  const { settings } = snapshot.state
  switch (id) {
    case 'reload-all-button':
      // The command of the View menu, its shortcut and the command bar follow it whether the buttons are shown or not: never hidden with them.
      return (
        <Check
          settingKey="reloadAllWakes"
          label={t('settings.actualiser-tous-les-onglets-reveille-aussi')}
          hint={t('settings.actualiser-tous-les-onglets-recharge-aussi')} more={t('settings.quand-vous-actualisez-tous-les-onglets-ceux-en')}
          checked={settings.reloadAllWakes}
          onChange={(reloadAllWakes) => update({ reloadAllWakes })}
        />
      )
    case 'notes':
      return (
        <FeatureOptions on={settings.notes} keys={['notesListButton']}>
          {/* Greyed while the notes are off: the button is not drawn then, whatever it says. */}
          <Check
            settingKey="notesListButton"
            label={t('notes.bouton-toutes-les-notes-dans-la-barre-d-outils')}
            hint={t('notes.bouton-toutes-les-notes-ligne')}
            more={t('notes.bouton-toutes-les-notes-hint', { shortcut: shortcutSuffix('notes', settings.keyBindings, platformOf(snapshot.platform)) })}
            checked={settings.notesListButton}
            disabled={!settings.notes}
            onChange={(notesListButton) => update({ notesListButton })}
          />
        </FeatureOptions>
      )
    case 'annotate-capture':
      // The automatic clearing of the page annotation (⌥⌘M), which has no switch of its own: the same setting as the timer button of the annotation bar; then the keys of one letter.
      return (
        <>
          <Check
            settingKey="annotateAutoClear"
            label={t('settings.effacer-les-annotations-automatiquement')}
            hint={t('settings.les-traits-s-effacent-seuls-apres-quelques')} more={t('settings.effacer-les-annotations-automatiquement-aide')}
            checked={settings.annotateAutoClear}
            onChange={(annotateAutoClear) => update({ annotateAutoClear })}
          />
          <Row settingKey="annotateAutoClearSeconds" label={t('settings.delai-sans-activite')}>
            <Choice
              className="pop"
              label={t('settings.delai-avant-l-effacement-des-annotations')}
              disabled={!settings.annotateAutoClear}
              value={settings.annotateAutoClearSeconds}
              choices={AUTO_CLEAR_SECONDS.map((seconds): [number, string] => [seconds, tp('settings.annotations-secondes', seconds)])}
              onChange={(annotateAutoClearSeconds) => update({ annotateAutoClearSeconds })}
            />
          </Row>
          {/* On by default: nothing changes for a person who never touches it. Off, the letters (the tools, E, X) are left to the page; the buttons and the keys with ⌘ or ⌥ stay. */}
          <Check
            settingKey="annotateLetterKeys"
            label={t('settings.touches-d-une-lettre-pour-annoter')}
            hint={t('settings.les-lettres-choisissent-un-outil-e-et-x')} more={t('settings.touches-d-une-lettre-pour-annoter-aide')}
            checked={settings.annotateLetterKeys}
            onChange={(annotateLetterKeys) => update({ annotateLetterKeys })}
          />
        </>
      )
    // The lists of three features are on their subpage, whose row follows their line while they are on (the containers while one is left, too: they
    // can still be renamed and deleted).
    case 'containers':
      return settings.tabContainers || settings.containers.length > 0 ? <SubpageEntry id="containers" snapshot={snapshot} /> : null
    case 'user-scripts':
      return <UserScriptsEntry snapshot={snapshot} />
    case 'page-watch':
      return settings.pageWatch ? <SubpageEntry id="pagewatches" snapshot={snapshot} /> : null
    default:
      return null
  }
}

/** What follows a theme: the settings of the summary by a local model, which is no feature of the registry, under « Pages web » (kept by the filter as its switch says). */
function ThemeLists({ theme, shows, snapshot, update }: PageProps & { theme: FeatureTheme['id']; shows: (id: string, on: boolean) => boolean }) {
  return theme === 'pages' && shows(SUMMARY, snapshot.state.settings.aiSummary) ? <SummarySettings snapshot={snapshot} update={update} /> : null
}

/**
 * The subpages of the catalogue (the containers, the imported scripts, the pages watched): beside the page, never inside the part it draws whole, so that
 * the window can draw one of them alone (SettingsCategories.tsx).
 */
export function FeatureSubpages({ snapshot, update }: PageProps) {
  return (
    <>
      <ContainersSettings snapshot={snapshot} />
      <UserScriptsSettings snapshot={snapshot} />
      <PageWatchesSettings snapshot={snapshot} update={update} />
    </>
  )
}

/** The choices of the filter, in their order. */
const FILTERS: ReadonlyArray<readonly [FeatureFilter, MessageKey]> = [
  ['all', 'settings.fonctions-filtre-toutes'],
  ['on', 'settings.fonctions-filtre-allumees'],
  ['off', 'settings.fonctions-filtre-coupees']
]

/** Whether a line in this state stays under the filter. */
export const keptBy = (filter: FeatureFilter, on: boolean): boolean => filter === 'all' || on === (filter === 'on')

/** The summary by a local model: a set of rows under « Pages web » that the filter keeps as its switch says, though it is no feature of the registry. */
const SUMMARY = 'summary'

/**
 * The lines a filter keeps with these settings: the features, and the summary. Taken when the filter is chosen, they stay drawn until it changes: a
 * switch turned under « Allumées » or « Coupées » keeps its line, and the focus on it, instead of going with it.
 */
export function linesKept(filter: FeatureFilter, settings: Settings): ReadonlySet<string> {
  const ids: string[] = CATALOGUE_FEATURES.filter((id) => keptBy(filter, isFeatureShownOn(settings, id)))
  return new Set(keptBy(filter, settings.aiSummary) ? [...ids, SUMMARY] : ids)
}

/** « Toutes / Allumées / Coupées »: a group of radio buttons, one stop of Tab, the arrows (and Home, End) move and choose. */
function FilterChoice({ filter, onChoose }: { filter: FeatureFilter; onChoose: (filter: FeatureFilter) => void }) {
  return (
    <div className="preset-buttons features-filter" role="radiogroup" aria-label={t('settings.fonctions-filtre')} onKeyDown={radioGroupKeys}>
      {FILTERS.map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={filter === id} tabIndex={filter === id ? 0 : -1} data-filter={id} onClick={() => onChoose(id)}>
          {t(label)}
        </button>
      ))}
    </div>
  )
}

export function FeaturesPage({ snapshot, update }: PageProps) {
  const { searching } = useContext(SearchingContext)
  const held = useContext(FeatureFilterContext)
  const [own, setOwn] = useState<FeatureFilter>('all')
  // A search and « Réglages modifiés » find every row: the filter is not drawn there and keeps nothing out.
  const filter: FeatureFilter = searching ? 'all' : (held?.filter ?? own)
  const choose = held?.choose ?? setOwn
  const { settings } = snapshot.state
  const all = CATALOGUE_FEATURES.length
  // The lines of the filter as it was chosen, taken again when it changes (React's way of a state that follows a value: set during the draw).
  const [stay, setStay] = useState(() => ({ filter, lines: linesKept(filter, settings) }))
  if (stay.filter !== filter) setStay({ filter, lines: linesKept(filter, settings) })
  const lines = stay.filter === filter ? stay.lines : linesKept(filter, settings)
  const shows = (id: string, on: boolean): boolean => keptBy(filter, on) || lines.has(id)
  const shown = CATALOGUE_FEATURES.filter((id) => shows(id, isFeatureShownOn(settings, id))).length
  return (
    <>
      <p className="pref-intro">{tp('settings.fonctions-allumees', featuresOn(settings), { all })}</p>
      {!searching && (
        <>
          <FilterChoice filter={filter} onChoose={choose} />
          <p className="sr-only" aria-live="polite">
            {tp('settings.fonctions-affichees', shown, { all })}
          </p>
        </>
      )}
      {FEATURE_THEMES.map((theme) => (
        <ThemeSection key={theme.id} theme={theme} shows={shows} snapshot={snapshot} update={update} />
      ))}
    </>
  )
}

/** A theme: the lines the filter keeps, in their order, under its title; nothing when it keeps none. */
function ThemeSection({ theme, shows, snapshot, update }: PageProps & { theme: FeatureTheme; shows: (id: string, on: boolean) => boolean }) {
  const ids = theme.features.filter((id) => shows(id, isFeatureShownOn(snapshot.state.settings, id)))
  return (
    <>
      {ids.length > 0 && (
        <Group title={t(theme.title)}>
          {ids.map((id) => (
            <CatalogueEntry key={id} id={id} snapshot={snapshot} update={update} />
          ))}
        </Group>
      )}
      <ThemeLists theme={theme.id} shows={shows} snapshot={snapshot} update={update} />
    </>
  )
}

/** A line of the catalogue, and what follows it. */
function CatalogueEntry({ id, snapshot, update }: PageProps & { id: FeatureId }) {
  return (
    <>
      <CatalogueFeature id={id} snapshot={snapshot} update={update} />
      <After id={id} snapshot={snapshot} update={update} />
    </>
  )
}
