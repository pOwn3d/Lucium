// The part of a shot of the features page that runs inside the page of Réglages: bringing a row up under the head of the window. It lives here, apart from
// scripts/site-captures.mjs, so that a test can run it on a document (show-row.test.ts). Playwright sends it to the page as its source text: it must
// stand alone (no import, no helper of this file).

/**
 * Unfolds the groups around the first row `selectors` find and scrolls it just under the head of the Settings window (its title and sidebar),
 * with the title of its group when it is the group's first row: the image keeps the top of the window (features.ts, `anchor: 'top'`). A row that only
 * a search shows (`data-search-only`) or that « Pour commencer » draws again (`data-mirror`) is passed over: the image keeps the row of the page. False
 * when no row is left.
 *
 * `foot`: the row's bottom at this height of the page instead (the foot of the image).
 */
export function showRowInPage([list, foot]: [string[], number | null]): boolean {
  const shown = (element: Element): boolean => !element.closest('[data-search-only], [data-mirror]')
  const row = list.map((selector) => [...document.querySelectorAll(selector)].find(shown) ?? null).find((element) => element !== null)
  if (!row) return false
  for (let fold = row.closest('details'); fold; fold = fold.parentElement?.closest('details') ?? null) fold.open = true
  // A row that waits in « Plus de réglages »: the fold is opened by its button (React draws it open before the click returns).
  const more = row.closest<HTMLElement>('.more-settings-body')
  if (more?.hidden) row.closest('.more-settings')?.querySelector<HTMLElement>('.more-settings-toggle')?.click()
  // The title of its group comes along when the row is the first of the group (nothing of another row above it).
  const section = row.closest('.pref-section')
  const firstRow = section?.querySelector('.pref-row')
  const first = section && (firstRow === row || firstRow?.contains(row) || row.contains(firstRow ?? null)) ? section : row
  let box: HTMLElement | null = row.parentElement
  while (box && !(box.scrollHeight > box.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement
  const scroller = box ?? document.scrollingElement
  if (!scroller) return true
  // A row near the end of its page could not reach the top: blank room under the last group lets it (nothing drawn, only space). Only a scroller of
  // its own gets it: on the root element, `height: 100%` and `border-box` (styles.css) take the padding out of the height the window is laid out
  // in, and the whole page (title bar, sidebar, rows) falls to nothing under its title. A page that fits in its window has no scroller: its row is
  // already in view.
  if (box && box.style.paddingBottom === '') box.style.paddingBottom = `${box.clientHeight}px`
  if (foot !== null) scroller.scrollTop += row.getBoundingClientRect().bottom - foot
  else scroller.scrollTop += first.getBoundingClientRect().top - (box ? box.getBoundingClientRect().top : 0) - 12
  return true
}
