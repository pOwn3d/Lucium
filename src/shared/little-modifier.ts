// ⌥⌘-clic on a link opens it in a mini window (Settings › Navigation › Plus de réglages). Pure rules; the engine only passes on the disposition Chromium gave
// the window the page asked for (`details.disposition` of Electron's window-open handler), and the shell asks `littleLinkOpens` what to do.
//
// Why only this combination, and why the disposition rather than the keys: Electron gives the shell no keys for a mouse event (neither
// `input-event` nor `before-mouse-event` carries `modifiers`, measured in Electron 45), and the keys of the keyboard are not seen by a page that
// did not have the focus. What Chromium reports is the result of the keys: ⌘ → "background-tab", ⇧⌘ → "foreground-tab" (the same as a link that
// opens a tab by itself), ⇧ → "new-window" (a Glance here), a lone ⌥ → a download of the link (no window at all). ⌥⌘ is the one combination that
// has a disposition of its own: "other". That is what this module recognises; ⌥⇧ and ⇧⌘ cannot be told from a Glance and from a plain
// target="_blank" link, so they are not offered.
// A plain click on a link that opens a new tab on another site opens a mini window as well (`newTabLinkOpensLittle`, below), and
// `linkWindowDestination` is the one choice the shell makes between a mini window, a Glance and a tab.

import { opensPeek } from './link-open'
import type { Settings } from './model'
import { parseFeatures } from './popup'

/** What Electron calls the disposition of a window opened by ⌥⌘-clic (measured in Electron 45 / Chromium 156, docs/fonctions.md). */
export const LITTLE_LINK_DISPOSITION = 'other'

export interface LittleLinkRequest {
  /** `littleArcModifier`: the feature is on. */
  enabled: boolean
  /** The tab the link was clicked in is a private tab: what it opens never leaves its private context, so never a mini window (which archives). */
  privateTab: boolean
  url: string
  /** The click of a person on a link, or a script after one (not a choice in a menu). */
  byPage: boolean
  /** The disposition Chromium gave the window (`details.disposition`), when the window came from a page. */
  chromium: string | undefined
}

/**
 * Whether the window the page asked for is to be a mini window: the feature is on, the window came from a click (not a menu), it is not a
 * private tab's, Chromium says it is the one ⌥⌘ makes, and the address is a web one (a blank page or anything else keeps its usual way).
 */
export function littleLinkOpens(request: LittleLinkRequest): boolean {
  if (!request.enabled || request.privateTab || !request.byPage) return false
  if (!isWebAddress(request.url)) return false
  return request.chromium === LITTLE_LINK_DISPOSITION
}

const isWebAddress = (url: string | undefined): boolean => typeof url === 'string' && /^https?:\/\//i.test(url)

// ---------- a link that would open a new tab ----------
//
// A plain click on a link that opens a new tab on another site (`target="_blank"`, or `window.open` without features after a click) opens it in a
// mini window instead, as one click. What Chromium reports for it is "foreground-tab". The rest keeps its way:
//  - ⌘ + clic and the middle click are "background-tab": still a tab behind (⇧⌘-clic is "foreground-tab" too and cannot be told from a plain click);
//  - a link that stays in the page never reaches the window-open handler;
//  - a sign-in window (`window.open` with a size, a position or `popup`) is a popup, never a mini window: its page needs `window.opener`;
//  - a link to the same site (registrable domain: mail.google.com → accounts.google.com) stays a tab;
//  - a page of Lucium (or anything that is not a web page) opens what it opens as before;
//  - private and guest windows have no mini window (no opener), and a private tab never gets one;
//  - a choice made in a menu ("Ouvrir dans un nouvel onglet") is kept.
// The setting `littleArcNewTabLinks` off brings back the way before: a tab, and ⌥⌘-clic for a mini window (`littleArcModifier`).

/** What Chromium calls the disposition of a window a plain click on a `target="_blank"` link asks for. */
export const NEW_TAB_DISPOSITION = 'foreground-tab'

/** The features of `window.open` that make the window a popup (a size, a place on the screen, `popup`): such a window stays a popup. */
const POPUP_FEATURES = new Set(['popup', 'width', 'height', 'innerwidth', 'innerheight', 'outerwidth', 'outerheight', 'left', 'top', 'screenx', 'screeny'])

/** Whether the feature list of `window.open` asks for a popup window (read as the HTML specification reads it, `parseFeatures`). */
export function asksForPopup(features: string | undefined): boolean {
  return [...parseFeatures(features).entries.keys()].some((name) => POPUP_FEATURES.has(name))
}

export interface NewTabLinkRequest {
  /** `littleArcNewTabLinks`: a mini window for such a link (on by default). */
  enabled: boolean
  privateTab: boolean
  /** The address the link opens. */
  url: string
  /** The address of the page the link was clicked in. */
  pageUrl: string | undefined
  /** The click of a person on a link, or a script after one (not a choice in a menu). */
  byPage: boolean
  /** `details.disposition` of the window-open handler. */
  chromium: string | undefined
  /** `details.features` of the window-open handler. */
  features: string | undefined
  /** Whether two web addresses are of the same site (party.ts `isOwnSite`: the registrable domain). */
  sameSite: (url: string, pageUrl: string) => boolean
}

/** Whether a link that asks for a new tab opens in a mini window instead (the rules above). */
export function newTabLinkOpensLittle(request: NewTabLinkRequest): boolean {
  if (!request.enabled || request.privateTab || !request.byPage) return false
  if (request.chromium !== NEW_TAB_DISPOSITION || asksForPopup(request.features)) return false
  if (!isWebAddress(request.url) || !isWebAddress(request.pageUrl)) return false
  return !request.sameSite(request.url, request.pageUrl!)
}

export type LinkDestination = 'little' | 'peek' | 'tab'

export interface LinkWindowRequest {
  /** What the engine planned (`planOpen`) or the menu asked for. */
  disposition: 'foreground' | 'background' | 'peek' | 'little'
  byPage: boolean
  chromium: string | undefined
  features: string | undefined
  url: string
  /** The address of the tab the link was clicked in (undefined when the tab is gone). */
  pageUrl: string | undefined
  privateTab: boolean
  /** The window can open a mini window: false in a private or a guest window. */
  littleAvailable: boolean
}

export type LinkWindowPrefs = Pick<Settings, 'littleArcModifier' | 'littleArcNewTabLinks' | 'peekWithShift' | 'peekOnExternalLinks'>

/**
 * Where a window a page (or the menu of a link) asked for goes: a mini window, a Glance or a tab. In this order: the menu's "Ouvrir dans une
 * mini-fenêtre"; ⌥⌘-clic; a Glance (Shift + clic, the menu's Glance, and "Coup d'œil pour les liens vers d'autres sites", which the user turned on and
 * so wins over the default below); a link that would open a new tab on another site; a tab.
 */
export function linkWindowDestination(request: LinkWindowRequest, prefs: LinkWindowPrefs, sameSite: (url: string, pageUrl: string) => boolean): LinkDestination {
  if (request.disposition === 'little') return 'little'
  const { privateTab, url, byPage, chromium } = request
  if (request.littleAvailable && littleLinkOpens({ enabled: prefs.littleArcModifier, privateTab, url, byPage, chromium })) return 'little'
  // "Another site" has one meaning for the Glance of "Coup d'œil pour les liens vers d'autres sites" and for the mini window below: `sameSite`.
  const external = request.pageUrl !== undefined && !sameSite(url, request.pageUrl)
  if (opensPeek({ disposition: request.disposition, byPage, external }, prefs)) return 'peek'
  if (request.littleAvailable && newTabLinkOpensLittle({ enabled: prefs.littleArcNewTabLinks, privateTab, url, pageUrl: request.pageUrl, byPage, chromium, features: request.features, sameSite })) return 'little'
  return 'tab'
}
