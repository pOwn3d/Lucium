// « Réglages modifiés »: every category drawn one under the other, as a search draws them, and only the rows of the settings that are not at their
// default left shown, each with its control, its « Rétablir » and the way to where it lives. Plain DOM, applied after every draw (a row put back
// leaves the view at once), as the search filter is.

import { UNIT_SELECTOR } from './settings-filter'

/**
 * Hides every row that stands for no changed setting, and the groups and categories left empty. A row drawn again elsewhere (a mirror, in Profils) and
 * a row that shows the own value of another profile are not shown: each changed setting appears once, where it lives. Returns how many rows show.
 */
export function showModifiedOnly(root: HTMLElement, changed: ReadonlySet<string>): number {
  let shown = 0
  for (const unit of Array.from(root.querySelectorAll<HTMLElement>(UNIT_SELECTOR))) {
    // A row with no key of its own stands for the settings its group names as a whole (the language, the local summary).
    const own = unit.dataset['setting'] ?? (unit.closest<HTMLElement>('.pref-section')?.dataset['setting'] ?? '')
    const keys = own.split(' ').filter((key) => key !== '')
    const hit = !unit.hasAttribute('data-mirror') && unit.dataset['scope'] !== 'profile' && keys.some((key) => changed.has(key))
    unit.hidden = !hit
    if (hit) shown++
  }
  for (const holder of Array.from(root.querySelectorAll<HTMLElement>('.pref-section, [data-category-label]'))) {
    holder.hidden = holder.querySelector(`:is(${UNIT_SELECTOR}):not([hidden])`) === null
  }
  return shown
}
