// The mark a tab wears when its profile has a proxy and the tab does not go through it. A container and a private context (a private tab, a private window)
// are sessions of their own that several profiles share: the engine gives them the general proxy (`planProxies`: `global`), never a profile's. The text of
// the setting says so (Réglages › Vie privée et sécurité › DNS chiffré et proxy); the mark says it on the tab, where the person who set the proxy of a
// profile would look. Pure: the sidebar draws it from what it already has (the state), and nothing more is stored.

import type { Settings, SidebarState, TabItem } from './model'
import { containerOfTab } from './containers'
import { appliedProxy, type ProxySetting } from './proxy'

/** Why a tab goes out through the general proxy and not through its profile's: it lives in a container, or in a private context. */
export type ProxyMarkReason = 'container' | 'private'

/** Where the page of a tab is browsed: the session of its profile, a container's session, or a private context's. */
export type BrowsingContext = 'profile' | ProxyMarkReason

/**
 * The context of a tab. A window that is private (a private window, a guest's) browses every tab in a private context. In a normal window a private tab does,
 * and so does a tab of a container that still exists (the page of a container that was deleted is no longer in one: `containerOfTab`).
 */
export function browsingContextOf(settings: Pick<Settings, 'containers'>, tab: Pick<TabItem, 'container' | 'private'>, privateWindow: boolean): BrowsingContext {
  if (privateWindow || tab.private === true) return 'private'
  return containerOfTab(settings, tab) !== undefined ? 'container' : 'profile'
}

/** The inputs of the rule: the option, the general proxy, the proxy the profile of the tab has of its own (none: it follows the general one), the context. */
export interface ProxyMarkInput {
  /** `proxyEnabled`: off, nothing is configured, and no profile's proxy is used anywhere. */
  enabled: boolean
  general: ProxySetting
  /** The proxy of the profile of the tab: absent when the profile has none of its own. */
  profile: ProxySetting | undefined
  context: BrowsingContext
}

/**
 * Why this tab does not go through the proxy of its profile, or null. Null when the option is off, when the page is browsed in the session of its profile,
 * when the profile has no proxy of its own (it follows the general one, as the tab does), and when its proxy would send the traffic the same way the general
 * one does (nothing is lost then).
 */
export function proxyMarkOf(input: ProxyMarkInput): ProxyMarkReason | null {
  if (!input.enabled || input.context === 'profile' || input.profile === undefined) return null
  return JSON.stringify(appliedProxy(input.profile)) === JSON.stringify(appliedProxy(input.general)) ? null : input.context
}

/**
 * The tabs of a window that wear the mark, with their reason. Empty while no profile has a proxy of its own (the usual case: nothing is computed per tab).
 * `privateWindow`: the window is a private one (its only space belongs to no profile of the user, so it has no proxy of its own to lose).
 */
export function proxyMarkedTabs(state: Pick<SidebarState, 'tabs' | 'spaces' | 'settings'>, privateWindow: boolean): Map<string, ProxyMarkReason> {
  const marks = new Map<string, ProxyMarkReason>()
  const { settings } = state
  if (!settings.proxyEnabled || !Object.values(settings.profiles).some((own) => own.proxy !== undefined)) return marks
  const profileOf = new Map(state.spaces.map((space) => [space.id, space.profileId ?? 'default'] as const))
  for (const tab of state.tabs) {
    const reason = proxyMarkOf({
      enabled: true,
      general: settings.proxy,
      profile: settings.profiles[profileOf.get(tab.spaceId) ?? 'default']?.proxy,
      context: browsingContextOf(settings, tab, privateWindow)
    })
    if (reason !== null) marks.set(tab.id, reason)
  }
  return marks
}
