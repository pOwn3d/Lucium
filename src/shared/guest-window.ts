// The guest window (Settings › Fonctions en option): the browser lent to somebody else. It keeps nothing, like a private window (its state
// lives in memory and is scrubbed, its pages go to a throw-away session erased with the window, no extension runs), and it also shows nothing
// of its owner: it starts from the default settings, not from the owner's, so the lists the owner built (watched pages, sites erased, link
// rules, site searches, exceptions, folders of extensions…) are not there to read. Only what makes the window usable and protective follows
// the main window (`GUEST_INHERITED`). It is not a private window painted differently: it has its own theme and its own name, "Invité", and
// none of the private window's marks (the dark bar, the glasses). The private rules themselves are reused as they are (private-window.ts).
//
// Pure rules; the main process applies them (shell/windows.ts, shell/browser.ts, index.ts).

import { defaultSettings, type Settings, type SidebarState, type Space } from './model'
import { PRIVATE_PROFILE_ID } from './private-window'
import { createInitialState, type Ctx } from './sidebar'
import { themeFromHue, type SpaceTheme } from './theme'
import { t } from './i18n'

/**
 * What the window and its only space are called: the one word the guest sees to tell this window from the others. Read in the language of
 * the interface when the window is made; the space keeps the name it was given.
 */
export const guestLabel = (): string => t('guest-window.invite')
export const GUEST_SPACE_EMOJI = '👤'

/** A calm, desaturated blue-grey that follows the system appearance: nothing like the private window's fixed dark colour. */
export function guestTheme(): SpaceTheme {
  return { ...themeFromHue(205, 0.22), overlay: 'none', noise: 0, intensity: 0.7, vibrant: false }
}

/**
 * The settings a guest window takes from the main window and follows when they change: the look of the application (its language included), the shortcuts of the
 * menus, the search engine typed searches go to, and the protections. Nothing the owner built by hand (lists of sites, rules, folders) is
 * here, and a test (guest-window.test.ts) fails if a list or a record joins this list.
 */
export const GUEST_INHERITED = [
  'searchUrlTemplate',
  'keyBindings',
  // The language of the interface is part of the look too, and more than that: the menu bar is built in the language of the window in front
  // (app-menu-wiring.ts). A guest window left on the default, the language of the system, changed the menu bar of an owner who chose French on a
  // Mac in English (or the reverse) as soon as it took the focus, and its notices and its menu entry were worded in another language than its name.
  'interfaceTranslated',
  'language',
  'interfaceAppearance',
  'websiteAppearance',
  'uiScale',
  'windowVibrancy',
  'sidebarOpacity',
  'windowBorder',
  'cardOutline',
  // The size and shape of the command bar's card are part of the look too (a large one is often a need of the eyes, not a taste): two words, nothing the owner built.
  'commandBarSize',
  'commandBarShape',
  'blockAds',
  'blockCookieBanners',
  'blockCosmetic',
  'blockMode',
  // The extended rules and the fingerprint protection are protections too: a guest window reads them from its own settings (the page guard of
  // a window follows the window's state), so without them a guest browsed less protected than its owner. The sites the owner excepted stay out.
  'blockScriptlets',
  'reduceFingerprint',
  'fingerprintStrict',
  'httpsUpgrade',
  'sendGpc',
  'stripTrackingParams',
  'stripCopiedLinks',
  'blockThirdPartyCookies',
  'unwrapRedirects',
  'safeBrowsing',
  'blockPings',
  'trimReferer',
  'httpsOnly'
] as const satisfies readonly (keyof Settings)[]

/** The settings of the main window a guest window follows. */
export function guestInherited(main: Settings): Partial<Settings> {
  return Object.fromEntries(GUEST_INHERITED.map((key) => [key, main[key]])) as Partial<Settings>
}

/** What a new guest window starts with: one empty space named "Invité", the default settings plus what it inherits, and nothing of the owner. */
export function createGuestState(main: SidebarState, ctx: Ctx): SidebarState {
  const initial = createInitialState(ctx)
  const space: Space = { ...initial.spaces[0]!, name: guestLabel(), emoji: GUEST_SPACE_EMOJI, theme: guestTheme(), profileId: PRIVATE_PROFILE_ID }
  return {
    ...initial,
    spaces: [space],
    activeSpaceId: space.id,
    activeTabBySpace: { [space.id]: null },
    // No extension in a guest window, and the store cannot install into it.
    settings: { ...defaultSettings(), ...guestInherited(main.settings), sidebarVisible: true, extensionPaths: [], webStoreInstall: false, webStoreUpdates: 'manual' }
  }
}

/** A text with its first letter in capitals: the same words at the start of a sentence. */
const capitalised = (text: string): string => text.charAt(0).toLocaleUpperCase() + text.slice(1)

/**
 * The notices of the private rules ("Les extensions ne fonctionnent pas dans une fenêtre privée") are worded for the private window. A guest
 * window runs the same rules but must not call itself that: the words are changed where they are shown (Browser.showToast), not at the
 * fifty places that write them. The words are those of the language of the interface (the notice was written in it), the plural first: in
 * English the singular is a part of it. At the start of a sentence they take a capital, there as here.
 */
export function guestWording(message: string): string {
  const pairs = [
    [t('guest-window.fenetres-privees'), t('guest-window.fenetres-invite')],
    [t('guest-window.fenetre-privee'), t('guest-window.fenetre-invite')]
  ] as const
  return pairs.reduce((text, [privateWords, guestWords]) => text.replaceAll(privateWords, guestWords).replaceAll(capitalised(privateWords), capitalised(guestWords)), message)
}
