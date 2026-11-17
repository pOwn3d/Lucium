// Where the tab a link opens goes: to the front, or behind the one the user is reading (Settings › Liens). Pure rules; the engine says
// what the page asked for (`planOpen`, popup.ts) and the shell applies the answer (shell/browser.ts).

import type { Settings } from './model'

export type TabMode = 'foreground' | 'background'

export type LinkOpenPrefs = Pick<Settings, 'modifiedClickBackground' | 'blankLinkBackground'>

/**
 * What the user wants for a tab a page asked for. Chromium reports a ⌘-click and a middle click as a background tab, and a link that opens
 * a tab by itself (`target="_blank"`, `window.open` without features) as a foreground one: each has its own setting. The defaults:
 * ⌘-click behind, `target="_blank"` in front. Glance and the mini window are not tabs; the caller leaves them alone.
 */
export function linkTabMode(asked: TabMode, prefs: LinkOpenPrefs): TabMode {
  const behind = asked === 'background' ? prefs.modifiedClickBackground : prefs.blankLinkBackground
  return behind ? 'background' : 'foreground'
}

/**
 * The mode a tab opens in, given how the request came: `byPage` is a click on a link or a script after a click (the settings of Liens
 * decide front or behind); a choice made in a menu ("Ouvrir en arrière-plan") is kept as it is, and so are Glance and the mini window.
 */
export function openTabMode(disposition: TabMode | 'peek' | 'little', byPage: boolean, prefs: LinkOpenPrefs): TabMode | 'peek' | 'little' {
  return byPage && (disposition === 'foreground' || disposition === 'background') ? linkTabMode(disposition, prefs) : disposition
}

export type PeekPrefs = Pick<Settings, 'peekWithShift' | 'peekOnExternalLinks'>

/**
 * Whether a request to open a link is answered by a Glance (the preview card) instead of a tab (Settings › Liens). Same vocabulary as `openTabMode`:
 * `byPage` says the page asked (a click), not the user in a menu.
 *  - A Shift+click reaches us as `peek` with `byPage` set: "Coup d'œil avec Maj" decides whether it is a Glance or an ordinary tab.
 *  - "Aperçu du lien (Coup d'œil)" in the menu of a link is `peek` too, but chosen by name (`byPage` false): it opens the preview whatever that option says,
 *    which only governs the Shift+click.
 *  - A link to another site that opens a tab by itself (`foreground`) is a Glance when "Coup d'œil pour les liens vers d'autres sites" is on.
 */
export function opensPeek(request: { disposition: TabMode | 'peek' | 'little'; byPage: boolean; external: boolean }, prefs: PeekPrefs): boolean {
  if (request.disposition === 'peek') return !request.byPage || prefs.peekWithShift
  // The page's own link only: « Ouvrir le lien dans un nouvel onglet », chosen in the menu of a link (`byPage` false), is a tab, as it says.
  return request.byPage && request.disposition === 'foreground' && request.external && prefs.peekOnExternalLinks
}
