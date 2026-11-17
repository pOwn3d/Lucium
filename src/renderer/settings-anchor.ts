// Where a link to a group of Réglages (`#protection/sitedata`) leaves the window once its category is drawn: the group scrolled to and lit for a moment,
// as the row a search result leads to; when it waits in « Plus de réglages », the window opens that fold first (`inClosedFold`). Apart from the window so
// that it is tested without one.

/** How long a group or a row that a link or a result led to is lit. */
export const FLASH_MS = 1700

/** What the landing reads and changes of the group: the part of an element it uses. */
export interface LandingGroup {
  readonly offsetTop: number
  /** Reading it makes the browser apply the class change, so that the animation starts again. */
  readonly offsetWidth: number
  readonly classList: { add(name: string): void; remove(name: string): void }
}

/** The clock of the landing (the tests give their own). */
export interface LandingTimers {
  set(run: () => void, ms: number): unknown
  clear(timer: unknown): void
}

const realTimers: LandingTimers = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) }

/** The body of « Plus de réglages » (SettingsMore.tsx): hidden while the fold is closed. */
export const FOLD_BODY = '.more-settings-body'

/** Whether an element waits in a « Plus de réglages » that is closed: the window opens the fold before it lands on it. */
export const inClosedFold = (el: { closest(selector: string): { hidden: boolean } | null }): boolean => el.closest(FOLD_BODY)?.hidden === true

/**
 * Takes the scrolling content to `group`: puts it 20 px under the top and lights it for `FLASH_MS` (a second arrival lights it again). Without a group
 * (an anchor that names none, or no anchor) the category starts from its top. Answers what ends the lighting, for the effect to give back.
 */
export function landOnGroup(content: { scrollTop: number }, group: LandingGroup | null, timers: LandingTimers = realTimers): () => void {
  if (!group) {
    content.scrollTop = 0
    return () => undefined
  }
  content.scrollTop = group.offsetTop - 20
  group.classList.remove('pref-flash')
  void group.offsetWidth
  group.classList.add('pref-flash')
  const timer = timers.set(() => group.classList.remove('pref-flash'), FLASH_MS)
  return () => {
    timers.clear(timer)
    group.classList.remove('pref-flash')
  }
}

/**
 * Where the focus goes once a link has landed on a group (Aide › État de Lucium…, a menu, the command bar): its title, reached by the script and not by
 * Tab, so that a screen reader says where the link led and Tab goes on into the group. A group without a title gives it to its first control.
 */
export function focusLanding(group: { querySelector(selector: string): HTMLElement | null }): HTMLElement | null {
  const title = group.querySelector(':scope > h3')
  const target = title ?? group.querySelector('input, select, button, [tabindex]')
  if (!target) return null
  if (target === title) target.tabIndex = -1
  target.focus({ preventScroll: true })
  return target
}

/** What a search shows and the page does not (the row that names the editor of the shortcuts among the results): never where a result lands. */
export const SEARCH_ONLY = '[data-search-only]'

/**
 * The row a result of a search lands on, by the key it stands for: the first element of the page that carries it (a row, a group, a list, an
 * editor), by its key or its search id; never a part that only a search shows.
 */
export function landingRow(root: ParentNode, key: string): HTMLElement | null {
  const selector = `.pref-row[data-setting~="${key}"], .pref-row[data-search="${key}"], [data-setting~="${key}"], [data-search="${key}"]`
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) => el.closest(SEARCH_ONLY) === null) ?? null
}

/**
 * Whether a key goes to a field being typed in (a text field, a menu, an area, an editable element): Escape is the field's there, and does not leave
 * the subpage. A switch, a box, a button are not fields.
 */
export const typingIn = (target: EventTarget | null): boolean =>
  typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && target.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]), select, textarea, [contenteditable]:not([contenteditable="false"])')
