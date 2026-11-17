// The head of the results of a search in the Settings: the answer for what is not a setting (a command of a menu, something done from the page,
// something Lucium does not have, shared/settings-answers.ts), and the best result, which Enter in the search field opens where it lives
// (settings-filter.ts marks it). The rows themselves stay under them, grouped by category, each with its control.

import { t } from '@shared/i18n'
import type { KeyBindings } from '@shared/keybindings'
import type { PlatformId } from '@shared/platform'
import { answerText, type SettingsAnswer } from '@shared/settings-answers'
import { categoryOfKey, settingsPaneLabel } from '@shared/settings-catalog'
import { BEST_ATTRIBUTE, type Unit } from './settings-filter'
import type { JumpTarget } from './settings-context'

/** The best result as the head names it: what the row is called, and where it lives (« Onglets et fenêtres › Mise en veille »). */
export interface BestResult {
  label: string
  path: string
}

/**
 * What the head says of the row a search put first: its label, else the title of its group (a list), else the start of what it says; and its place, the
 * subpage it is on included (the title of its group when it is not the subpage's).
 */
export function bestResultOf(unit: Unit | null): BestResult | null {
  if (!unit) return null
  const { category, subpage, group } = unit.place
  const label = unit.fields.label.trim() || group.trim() || unit.text.trim().slice(0, 80)
  return { label, path: [category, subpage, group === subpage ? '' : group].filter((part) => part.trim() !== '').join(' › ') }
}

/** Whether two best results read the same (the window sets its state only when it changes). */
export const sameBestResult = (a: BestResult | null, b: BestResult | null): boolean => a?.label === b?.label && a?.path === b?.path

/**
 * Opens the row the search put first, where it lives: through its « Ouvrir dans … », or, for a row that has none (a link, the questions of the guide),
 * by giving its control the focus.
 */
export function openBestResult(root: HTMLElement | null): void {
  const row = root?.querySelector<HTMLElement>(`[${BEST_ATTRIBUTE}]`)
  if (!row) return
  const open = row.querySelector<HTMLElement>('.pref-open')
  if (open) return open.click()
  row.scrollIntoView?.({ block: 'center' })
  ;(row.matches('button, a, input, select') ? row : row.querySelector<HTMLElement>('input, select, button, [tabindex]'))?.focus()
}

/** The answer of the search for what is not a setting, with « Ouvrir dans … » the setting that comes closest. */
export function SearchAnswer({ answer, bindings, platform, onOpen }: { answer: SettingsAnswer; bindings: KeyBindings | undefined; platform: PlatformId; onOpen: (target: JumpTarget) => void }) {
  const key = answer.open
  const pane = key ? categoryOfKey(key) : null
  return (
    <div className="search-answer" role="note">
      <p>{answerText(answer, bindings, platform)}</p>
      {key && pane && (
        <button type="button" className="pref-open" onClick={() => onOpen({ pane, key })}>
          {t('settings.open-in', { path: settingsPaneLabel(pane) })}
        </button>
      )}
    </div>
  )
}

/** The best result, above the results grouped by category: its name and its place, a click (or Enter in the search field) opens it. */
export function BestResultLine({ best, onOpen }: { best: BestResult; onOpen: () => void }) {
  return (
    <section className="search-best" aria-labelledby="search-best-title">
      <h3 className="results-cat-title" id="search-best-title">
        {t('settings-search.best-result')}
      </h3>
      <button type="button" className="search-best-row" onClick={onOpen}>
        <span className="search-best-label">{best.label}</span>
        {best.path && <span className="search-best-path">{best.path}</span>}
      </button>
    </section>
  )
}
