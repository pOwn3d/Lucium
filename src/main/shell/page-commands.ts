// What the application menu does to the page or the window and that Browser does not already offer: share, view source, jump to the
// selection, Developer Mode, case and style of the selected text, Cast, spell checking. Each acts on the browser it is given (the
// window that has the focus).

import { app, BrowserWindow, ShareMenu, webContents as allWebContents, type Session } from 'electron'
import { currentPlatform } from '../platform'
import { developerModeLabel, isDeveloperUrl } from '@shared/developer-mode'
import { readableToggle, takesReadableMode, type ReadableMode } from '@shared/readable-mode'
import { JUMP_TO_SELECTION_SCRIPT, SELECTION_TEXT_SCRIPT, formatScript, transformScript, type CaseTransform, type FormatCommand } from '@shared/text-format'
import { activeTab } from '@shared/sidebar'
import { spellCheckChoiceOf, spellCheckEnabled, type SpellCheckChoice } from '@shared/spell-check'
import { hostnameOf } from '@shared/url'
import type { TabItem } from '@shared/model'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { t } from '@shared/i18n'

const isWebPage = (url: string | undefined): url is string => url !== undefined && /^https?:\/\//i.test(url)

/** The address of the page that is on screen when it is a web page (what sharing and viewing the source make sense for). */
export function sharablePage(store: StateStore): string | null {
  const url = activeTab(store.get())?.url
  return isWebPage(url) ? url : null
}

/** File › Share…: the system's sharing menu for the page (Mail, Messages, AirDrop, Notes…), under the top right of the window. */
export function sharePage(store: StateStore, win: BrowserWindow): void {
  const url = sharablePage(store)
  if (!url) return
  const { width } = win.getContentBounds()
  new ShareMenu({ urls: [url] }).popup({ window: win, x: Math.max(0, width - 220), y: 44 })
}

/** Lucium → Share Lucium: no website to point at, so the sharing menu gets a sentence. */
export function shareApp(win: BrowserWindow): void {
  const { width } = win.getContentBounds()
  new ShareMenu({ texts: [t('page-commands.lucium-un-navigateur-libre-a-barre-laterale')] }).popup({ window: win, x: Math.max(0, width - 220), y: 44 })
}

/** View › Developer › View Source: the page's source in a new tab (Chromium's own view). */
export function viewSource(browser: Browser, store: StateStore): void {
  const url = sharablePage(store)
  if (url) browser.dispatch({ type: 'tab/open', url: `view-source:${url}` })
}

/** View › Developer › Turn on / off Developer Mode for this site (⌃D). */
export function toggleDeveloperMode(browser: Browser, store: StateStore): void {
  const url = activeTab(store.get())?.url
  const host = hostnameOf(url ?? '')
  if (!host || !isWebPage(url)) return
  const on = !isDeveloperUrl(url, store.get().settings.developerHosts)
  browser.dispatch({ type: 'developer/site', site: host, enabled: on })
}

export { developerModeLabel }

/** The notice that says what View › Appearance › Page Contrast for This Site did (the menu has no other mark of it than the checked entry). */
const READABLE_NOTICES = {
  original: (host: string) => t('page-commands.contraste-de-la-page-original-pour-host', { host }),
  dark: (host: string) => t('page-commands.contraste-de-la-page-sombre-pour-host', { host }),
  light: (host: string) => t('page-commands.contraste-de-la-page-clair-pour-host', { host })
} as const

/**
 * View › Appearance › Page Contrast for This Site, and the menu of the toolbar's button « Contraste de la page »: the mode of the site on screen (`null`: it follows
 * the default again). `tab`: the tab the choice is made for, the one on screen unless the menu was opened on another. Never for a private tab: its site is
 * not written to the settings.
 */
export function setReadableSite(browser: Browser, store: StateStore, mode: ReadableMode | null, tab: TabItem | undefined = activeTab(store.get())): void {
  const host = hostnameOf(tab?.url ?? '')
  if (!tab || tab.private === true || !host || !isWebPage(tab.url)) return
  browser.dispatch({ type: 'readable/site', site: host, mode, tabId: tab.id })
  browser.showToast(mode === null ? t('page-commands.contraste-de-la-page-comme-les-autres-sites-pour-host', { host }) : READABLE_NOTICES[mode](host))
}

/**
 * A click on the toolbar's button « Contraste de la page » (the tab it is on): the page moves to the next mode, Original, then Dark, then Light, then Original
 * again (`readableToggle` decides what is written; `setReadableSite` writes it and says so). Nothing for a page that takes no mode, a PDF, a private tab or
 * a private window, as the menu of the button.
 */
export function toggleReadableSite(browser: Browser, store: StateStore, tabId: string): void {
  const tab = store.get().tabs.find((t) => t.id === tabId)
  if (!tab || tab.private === true || browser.isPrivate() || !takesReadableMode(tab.url) || browser.showsPdf(tabId)) return
  const next = readableToggle(store.get().settings, tab.url, browser.isSystemDark())
  if (next) setReadableSite(browser, store, next.mode, tab)
}

/** Edit › Find › Use Selection to Find: the selected text becomes the search. */
export async function useSelectionToFind(browser: Browser): Promise<void> {
  const text = String((await browser.evaluateInPage(SELECTION_TEXT_SCRIPT)) ?? '').trim()
  if (!text) return
  browser.findInPage(text, {})
  browser.openOverlay({ panel: 'find' })
}

/** Edit › Find › Jump to Selection. */
export async function jumpToSelection(browser: Browser): Promise<boolean> {
  return (await browser.evaluateInPage(JUMP_TO_SELECTION_SCRIPT)) === true
}

/** Edit › Transformations. Resolves to whether a selection in an editable place was changed. */
export async function transformSelection(browser: Browser, kind: CaseTransform): Promise<boolean> {
  return (await browser.evaluateInPage(transformScript(kind))) === true
}

/** Edit › Format › Font. */
export async function formatSelection(browser: Browser, command: FormatCommand): Promise<boolean> {
  return (await browser.evaluateInPage(formatScript(command))) === true
}

// ---- Edit › Spelling and Grammar › Check Spelling While Typing ----

// On macOS the checker is the system's. Elsewhere it is Chromium's own, and Chromium fetches the dictionary of every language a session checks from its CDN
// (redirector.gvt1.com) as soon as it makes the session, while that file is missing, whatever the checker is switched to: with the checker "off" (below) a
// first launch still downloaded fr-FR-3-0.bdic one second after the start, before any text field. So, away from macOS, a session comes into the world with
// no language at all (nothing to fetch) and gets its own back when the checker is switched on: nothing is downloaded before the user asks.
// The user's choice is kept in the settings (`spellCheck`, see shared/spell-check.ts): `followSpellChecking` applies it at launch, `setSpellChecking` records it.
let spellChecking: boolean | null = null
let rememberChoice: (choice: SpellCheckChoice) => void = () => {}
/** The languages Electron gave a session (those of the system), while the session has none because the checker is off. */
const keptLanguages = new WeakMap<Session, string[]>()

/**
 * What one session is told: the checker on or off and, away from macOS (the system's checker fetches nothing and these calls are no-ops there), the
 * languages it may fetch dictionaries for: none while the checker is off, the session's own again once it is on. The languages come first: Electron
 * switches the checker on with a language list that is not empty and off with an empty one, and the choice has the last word.
 */
function applyToSession(ses: Session, enabled: boolean): void {
  if (!currentPlatform().facts.systemSpellChecker) {
    if (enabled) {
      const languages = keptLanguages.get(ses)
      if (languages) {
        ses.setSpellCheckerLanguages(languages)
        keptLanguages.delete(ses)
      }
    } else {
      if (!keptLanguages.has(ses)) keptLanguages.set(ses, ses.getSpellCheckerLanguages())
      ses.setSpellCheckerLanguages([])
    }
  }
  ses.setSpellCheckerEnabled(enabled)
}

/** Applies the choice to every session the application has (those of its web contents), and to those created later. */
function applySpellChecking(enabled: boolean): void {
  for (const contents of allWebContents.getAllWebContents()) applyToSession(contents.session, enabled)
}

export const isSpellChecking = (): boolean => (spellChecking ??= currentPlatform().facts.systemSpellChecker)

/** A click on the menu entry: applied to every session now, and kept in the settings, so that the next launch starts the same way. */
export function setSpellChecking(enabled: boolean): void {
  spellChecking = enabled
  applySpellChecking(enabled)
  rememberChoice(spellCheckChoiceOf(enabled))
}

/**
 * Call before the application is ready: every session made from then on (the default one, a partition of a profile or of a container, a private window's) is
 * told the checker's state the moment it exists, before a page can make Chromium fetch a dictionary for it. Until the choice of the settings is known
 * (`followSpellChecking`) that state is the system's default: off. Nothing happens on macOS.
 */
export function holdSpellDictionaries(): void {
  // macOS keeps what it did: its checker is the system's and it fetches nothing.
  if (currentPlatform().facts.systemSpellChecker) return
  app.on('session-created', (ses) => applyToSession(ses, isSpellChecking()))
}

/**
 * Starts from the choice the settings hold (the system's own default while there is none) and keeps a window opened later in line with it.
 * `remember` writes a new choice to the settings. Call once at startup, before the menu is built.
 */
export function followSpellChecking(choice: SpellCheckChoice, remember: (choice: SpellCheckChoice) => void): void {
  spellChecking = spellCheckEnabled(choice, currentPlatform().facts.systemSpellChecker)
  rememberChoice = remember
  // The sessions made before the choice was known were told the system's default: the saved choice reaches them now, and those of the windows opened later.
  applySpellChecking(isSpellChecking())
  app.on('web-contents-created', (_event, contents) => applyToSession(contents.session, isSpellChecking()))
}
