// The line icons of the rows of the command bar, one for each kind of answer. In a module of their own: the search of the tabs draws
// three of them, and does not have to load the whole command bar for that.

import type { ReactNode } from 'react'
import type { Candidate } from '@shared/command-bar'

/** Line icons of the command bar: 18 px, one stroke, the text colour. */
export const glyph = (path: string) => (
  <svg className="result-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={path} />
  </svg>
)
export const ICONS: Record<Candidate['kind'], ReactNode> = {
  // A globe: any page.
  open: glyph('M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM2.5 10h15M10 2.5c2 2.1 3 4.6 3 7.5s-1 5.4-3 7.5c-2-2.1-3-4.6-3-7.5s1-5.400 3-7.5Z'),
  history: glyph('M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM2.5 10h15M10 2.5c2 2.1 3 4.6 3 7.5s-1 5.4-3 7.5c-2-2.1-3-4.6-3-7.5s1-5.400 3-7.5Z'),
  // A window: an open tab.
  tab: glyph('M3.5 4.5h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM2.5 8h15'),
  // A window: a window of the browser, by name (like a tab, which is a window in the window).
  window: glyph('M3.500 4.500h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM2.500 8h15M5 6.250h.01M7 6.250h.01'),
  // A box: the archive.
  archived: glyph('M3 5.5h14v3H3zM4.5 8.5v7h11v-7M8 11.5h4'),
  // Two panes side by side: a work view (its row leads with the view's emoji; this is the icon of the kind).
  workview: glyph('M3.500 4.500h6v11h-6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM12.500 4.500h4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4Z'),
  // Stacked sheets: a saved session of tabs.
  session: glyph('M6 3.500h9.500a1 1 0 0 1 1 1V13M4.500 6h9.500a1 1 0 0 1 1 1v8.500a1 1 0 0 1-1 1H4.500a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z'),
  // A bookmark: a page kept to be read later (its favicon leads the row when it has one).
  readlater: glyph('M5.500 3h9a1 1 0 0 1 1 1v13l-5.500-3.500L4.500 17V4a1 1 0 0 1 1-1Z'),
  // A star: a bookmark of the library.
  bookmark: glyph('M10 2.800l2.100 4.300 4.700.7-3.400 3.300.8 4.700L10 13.600 5.800 15.800l.8-4.700L3.200 7.800l4.700-.7L10 2.800Z'),
  // A magnifier: a search.
  'site-search': glyph('M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM14 14l3.500 3.500'),
  suggestion: glyph('M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM14 14l3.500 3.500'),
  // A bolt: a command.
  action: glyph('M11 2.500 4.500 11H10l-1 6.500L15.500 9H10l1-6.500Z'),
  // A puzzle piece: an extension.
  extension: glyph('M3.500 7.500H7.200a1.800 1.800 0 1 1 3.600 0H15v2.700a1.800 1.800 0 1 1 0 3.600V17.500H3.500Z'),
  // The same puzzle piece: the text typed after an extension's keyword goes to that extension.
  omnibox: glyph('M3.500 7.500H7.200a1.800 1.800 0 1 1 3.600 0H15v2.700a1.800 1.800 0 1 1 0 3.600V17.500H3.500Z'),
  // The same puzzle piece: the Extensions page.
  extpage: glyph('M3.500 7.500H7.200a1.800 1.800 0 1 1 3.600 0H15v2.700a1.800 1.800 0 1 1 0 3.600V17.500H3.500Z'),
  // Sliders: a Settings pane.
  pane: glyph('M3 6.500h14M3 13.500h14M12 4.500v4M8 11.500v4'),
  // The same sliders: the page of Lucium that stands for a chrome:// address.
  internal: glyph('M3 6.500h14M3 13.500h14M12 4.500v4M8 11.500v4'),
  // A window with a panel on its right: a web panel.
  webpanel: glyph('M3.500 4.500h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM12 4.500v11'),
  // A box with a handle: a tab container.
  container: glyph('M3.500 6.500h13a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1ZM7.500 6.500v-1.500a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.500M2.500 11h15'),
  // A pocket calculator: the answer of a calculation.
  calc: glyph('M5.500 2.500h9a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1ZM7 5.500h6M7.500 9h.01M10 9h.01M12.500 9h.01M7.500 12h.01M10 12h.01M12.500 12h.01'),
  // The emoji of the space is drawn in a tile (see `lead`), these two have no line icon.
  space: null,
  move: null
}
