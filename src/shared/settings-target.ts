// Where a Settings window opens: a category, and a place inside it. `chrome://extensions` leads to the Extensions page, a tab of the window (internal-page.ts).

import { isExtensionId } from './extension-review'
import type { ExtensionsTarget } from './extension-page'
import { isProfileId } from './profiles'
import { SETTINGS_SUBPAGES, type SettingsPage, type SettingsPane, type SettingsSubpage } from './ipc'
import { resolveSettingsTarget } from './settings-catalog'
import { subpageAt } from './settings-subpages'

/**
 * The URL hash the Settings UI reads ("protection/permissions"). An old pane ("advanced/extensions") leads to the category that took its place
 * (settings-catalog.ts); an anchor it does not know, or that belongs to another category, is left out: the category opens at its top.
 */
export function settingsHash(pane: SettingsPane | string, anchor?: string): string {
  const target = resolveSettingsTarget(pane, anchor) ?? { pane: 'home' as const }
  return 'anchor' in target && target.anchor !== undefined ? `${target.pane}/${target.anchor}` : target.pane
}

/** Where the Settings window opens again when it is asked for no place: a page, and the subpage it showed. */
export interface SettingsResumePlace {
  pane: SettingsPage
  anchor?: SettingsSubpage
}

/**
 * The place a Settings window was showing when it closed, read from its address (`…/settings.html#protection/filterlists`): its page, and its subpage
 * when it showed one. A group it was taken to (`#protection/permissions` of an old link, `#appearance/panelsize`) and the guide are not kept: the window
 * opens again on the page, at its top. An address that names no page gives none, and the window opens on « Pour commencer ». Pure: the main process
 * keeps the answer in memory for the session (settings-window.ts), nothing is written.
 */
export function settingsResumePlace(url: string): SettingsResumePlace | null {
  const at = url.indexOf('#')
  if (at < 0) return null
  const [pane = '', anchor = ''] = url.slice(at + 1).split('/')
  const target = resolveSettingsTarget(pane, anchor)
  if (!target) return null
  const sub = (SETTINGS_SUBPAGES as readonly string[]).includes(target.anchor ?? '') ? subpageAt(target.pane, target.anchor) : null
  return sub === null ? { pane: target.pane } : { pane: target.pane, anchor: sub }
}

/**
 * The script that takes an open Settings window to `hash`. Setting a hash the window already has fires no `hashchange`, so the window would stay where
 * it is (scrolled elsewhere, or the group not lit): the event is sent by hand then, and the window handles it as it handles a link.
 */
export function showHashScript(hash: string): string {
  return `(() => { const next = ${JSON.stringify(hash)}; if (location.hash === '#' + next) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = next })()`
}

/**
 * The Extensions page that the address `chrome://extensions` (or `arc://extensions`) stands for: the list, or the page of one extension for
 * `?id=<id>` (an id that is not one gives the list; `&profile=<id>` names the copy, as the address of the page itself does, see `displayAddress`), or the
 * shortcuts for `/shortcuts`. Any other path, query or fragment may follow; null for any other text, `chrome://extensionsfoo` included. Extensions cannot be
 * managed in a page of Chromium under Electron, so Lucium has a page of its own, in a tab, and shows it at this address.
 */
export function extensionsPageOf(text: string): ExtensionsTarget | null {
  const match = /^(?:chrome|arc):\/\/extensions(?:\/([^?#\s]*))?(?:\?([^#\s]*))?(?:#\S*)?$/i.exec(text.trim())
  if (!match) return null
  const [, path = '', query = ''] = match
  if (/^shortcuts\/?$/i.test(path)) return { view: 'shortcuts' }
  const params = new URLSearchParams(query)
  const id = params.get('id')
  if (!isExtensionId(id)) return { view: 'list' }
  const profile = params.get('profile')
  return { view: 'detail', extensionId: id, ...(isProfileId(profile) ? { profileId: profile } : {}) }
}
