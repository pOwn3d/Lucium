// A family of the reducer of the sidebar (sidebar.ts composes them in `reduceCore`): the settings, the Tweaks, the sites and the containers.

import { BOOST_JS_MAX, type ArchivedTab, type SidebarState } from './model'
import { checkSharedBoost } from './boost-share'
import { unreadableCode } from './boost-css'
import { knownProfiles, profileOfSpace, profileRecordsHistory, withExtensionEnabled, withExtensionTabCapture } from './profiles'
import { normalizeSleepHost, setSiteExcluded } from './sleep'
import { setJavascriptOff } from './site-javascript'
import { normalizeBlockHost, setBlockingExempt, withSiteBlockMode } from './blocker'
import { withSiteAutoplay } from './autoplay'
import { withSiteReadable } from './readable-mode'
import { setClearedOnClose } from './site-clear'
import { CUSTOM_LISTS_MAX, cleanCustomFilterLists, withCustomListEnabled } from './custom-filter-lists'
import { setDeveloperHost } from './developer-mode'
import { boundSitePermissions, isRecordKey } from './state-clean'
import { cleanUnusedPermissionDays, forgetVisits, sweepUnused, withVisit } from './unused-permissions'
import { readScreen, withNoticed, withPanelSize } from './panel-scale'
import type { Ctx, Action } from './sidebar-actions'
import { BOOST_ID, uniqueBoostName, cleanBoost, clampSettings } from './sidebar-state'
import { USAGE_KEY_PREFIX, fromPrivateTab, onlyPrivateTabsOn } from './sidebar-helpers'
import { USAGE_KEY_MAX, usageAfterPick, usageWithPageBack, usageWithoutPages } from './command-bar-usage'
import { activeTab } from './sidebar-selectors'

/** The actions on the settings and what is decided per site (blocking, sleep, autoplay, readable mode, permissions, filter lists, Tweaks, the side panel) (settings/, blocking/, sleep/, autoplay/, readable/, siteclear/, extension/, developer/, permission/, filterlist/, boost/, commandbar/, sidepanel/); undefined for the others. */
export function reduceSettings(state: SidebarState, action: Action, ctx: Ctx): SidebarState | undefined {
  switch (action.type) {
    case 'sleep/exclude-site': {
      const site = normalizeSleepHost(action.site)
      if (action.excluded === true && site !== null && onlyPrivateTabsOn(state, (url) => normalizeSleepHost(url) === site)) return state
      const before = state.settings.sleepExcludedHosts
      const hosts = setSiteExcluded(before, action.site, action.excluded === true)
      return hosts.length === before.length && hosts.every((host, i) => host === before[i]) ? state : { ...state, settings: { ...state.settings, sleepExcludedHosts: hosts } }
    }
    case 'blocking/exempt-site': {
      if (fromPrivateTab(state, action.tabId)) return state
      const before = state.settings.blockExceptions
      const hosts = setBlockingExempt(before, action.site, action.exempt === true)
      return hosts.length === before.length && hosts.every((host, i) => host === before[i]) ? state : { ...state, settings: { ...state.settings, blockExceptions: hosts } }
    }
    case 'blocking/site-mode': {
      if (fromPrivateTab(state, action.tabId)) return state
      const before = state.settings.blockModeSites
      const next = withSiteBlockMode(before, action.site, action.mode)
      return JSON.stringify(next) === JSON.stringify(before) ? state : { ...state, settings: { ...state.settings, blockModeSites: next } }
    }
    case 'autoplay/site': {
      if (fromPrivateTab(state, action.tabId)) return state
      const before = state.settings.siteAutoplay
      const next = withSiteAutoplay(before, action.site, action.mode ?? null)
      // 1.0.1 applies the choices of the sites only while « Un réglage pour chaque site » (`autoplayPerSite`) is on; here the choices always apply and nothing reads
      // the key. A file that holds a choice keeps the key on, so that the version that reads it again applies the choice it was told to make.
      const perSite = Object.keys(next).length > 0 ? true : state.settings.autoplayPerSite
      return JSON.stringify(next) === JSON.stringify(before) && perSite === state.settings.autoplayPerSite ? state : { ...state, settings: { ...state.settings, siteAutoplay: next, autoplayPerSite: perSite } }
    }
    case 'javascript/site': {
      if (fromPrivateTab(state, action.tabId)) return state
      const before = state.settings.siteJavascriptOff
      // Only a real true turns JavaScript off (the interface is not trusted); anything else puts the site back.
      const next = setJavascriptOff(before, action.site, action.off === true)
      return next.length === before.length && next.every((host, i) => host === before[i]) ? state : { ...state, settings: { ...state.settings, siteJavascriptOff: next } }
    }
    case 'readable/site': {
      if (fromPrivateTab(state, action.tabId)) return state
      // A choice that changes nothing is no new state: `reduce` hands the old one back.
      return { ...state, settings: { ...state.settings, siteReadableMode: withSiteReadable(state.settings.siteReadableMode, action.site, action.mode ?? null) } }
    }
    case 'siteclear/site': {
      if (fromPrivateTab(state, action.tabId)) return state
      const before = state.settings.siteDataClearOnClose
      const on = action.on === true
      const next = setClearedOnClose(before, action.site, on)
      const unchanged = next.length === before.length && next.every((host, i) => host === before[i])
      // Asking for a site to be erased at close is asking for the function: the first site (or a site already listed while the function was off) switches it on.
      const enable = on && !state.settings.siteDataClearOnCloseEnabled && setClearedOnClose([], action.site, true).length > 0
      if (unchanged && !enable) return state
      return { ...state, settings: { ...state.settings, siteDataClearOnClose: next, ...(enable ? { siteDataClearOnCloseEnabled: true } : {}) } }
    }
    case 'filterlist/add': {
      const lists = state.settings.customFilterLists
      const [added] = cleanCustomFilterLists([action.list])
      // A full list or a list already there is refused: the main process has checked, this is the reducer's own bound.
      if (!added || lists.some((l) => l.id === added.id) || lists.length >= CUSTOM_LISTS_MAX) return state
      return { ...state, settings: { ...state.settings, customFilterLists: [...lists, added] } }
    }
    case 'filterlist/remove': {
      const lists = state.settings.customFilterLists
      return lists.some((l) => l.id === action.id) ? { ...state, settings: { ...state.settings, customFilterLists: lists.filter((l) => l.id !== action.id) } } : state
    }
    case 'filterlist/enable': {
      const lists = state.settings.customFilterLists
      const next = withCustomListEnabled(lists, action.id, action.enabled)
      return next === lists ? state : { ...state, settings: { ...state.settings, customFilterLists: [...next] } }
    }
    case 'extension/set-enabled': {
      // The ids come from the interface: a profile or an extension that is not well formed changes nothing.
      const profiles = withExtensionEnabled(state.settings.profiles, action.profileId, action.extensionId, action.enabled === true)
      return profiles === state.settings.profiles ? state : { ...state, settings: { ...state.settings, profiles } }
    }
    case 'extension/set-tab-capture': {
      const profiles = withExtensionTabCapture(state.settings.profiles, action.profileId, action.extensionId, action.allowed === true)
      return profiles === state.settings.profiles ? state : { ...state, settings: { ...state.settings, profiles } }
    }
    case 'developer/site': {
      const site = normalizeBlockHost(action.site)
      if (action.enabled === true && site !== null && onlyPrivateTabsOn(state, (url) => normalizeBlockHost(url) === site)) return state
      const before = state.settings.developerHosts
      const hosts = setDeveloperHost(before, action.site, action.enabled === true)
      return hosts.length === before.length && hosts.every((host, i) => host === before[i]) ? state : { ...state, settings: { ...state.settings, developerHosts: hosts } }
    }
    case 'settings/update': {
      const settings = clampSettings({ ...state.settings, ...action.patch })
      // Keeping the pages of a closed tab switched off lets go of what it kept: once it is off, it holds nothing.
      const archive = !settings.reopenHistory && state.archive.some((entry) => entry.history) ? state.archive.map(({ history: _gone, ...rest }): ArchivedTab => rest) : state.archive
      return { ...state, settings, archive }
    }
    case 'panel-size/set': {
      // The screen comes from the interface: it is rebuilt from its fields, and what does not describe a screen changes nothing.
      const screen = readScreen(action.screen)
      if (screen === null || (action.percent !== null && (typeof action.percent !== 'number' || !Number.isFinite(action.percent)))) return state
      const panelSizes = withPanelSize(state.settings.panelSizes, screen, action.percent, ctx.now)
      return panelSizes === state.settings.panelSizes ? state : { ...state, settings: { ...state.settings, panelSizes } }
    }
    case 'panel-size/noticed': {
      const screen = readScreen(action.screen)
      if (screen === null) return state
      const panelSizes = withNoticed(state.settings.panelSizes, screen, ctx.now)
      return panelSizes === state.settings.panelSizes ? state : { ...state, settings: { ...state.settings, panelSizes } }
    }
    case 'boost/save': {
      // A script past the bound is refused as a whole: cutting it would save code that was never written.
      if (typeof action.boost.js === 'string' && action.boost.js.length > BOOST_JS_MAX) return state
      if (typeof action.boost.jsDraft === 'string' && action.boost.jsDraft.length > BOOST_JS_MAX) return state
      const previous = typeof action.boost.id === 'string' ? state.boosts.find((b) => b.id === action.boost.id) : undefined
      // A script that a person could not read as it runs (boost-css.ts, `unreadableCode`) does not become the script of a Tweak: the save is refused
      // as a whole, and the editor, which looks first, says why. A script already stored that way is left as it is, and no page runs it.
      if (typeof action.boost.js === 'string' && action.boost.js !== previous?.js && unreadableCode(action.boost.js)) return state
      // A save that does not say `jsEnabled: true` (a stale editor, a toggle built from an older copy, a value that is not a flag) never switches a waiting script on.
      const guarded = action.boost.jsEnabled !== true && previous?.jsEnabled === false ? { ...action.boost, jsEnabled: false } : action.boost
      // The Eraser adds its picks from the main process while an editor is open: a save that says nothing of the list does not empty it.
      const listed = guarded.zap === undefined && previous ? { ...guarded, zap: previous.zap } : guarded
      // The same for the script being typed: only the editor, which always says what its field holds, changes or ends a draft.
      const saved = listed.jsDraft === undefined && previous?.jsDraft !== undefined ? { ...listed, jsDraft: previous.jsDraft } : listed
      const boost = cleanBoost(saved, ctx.newId)
      if (!boost.host) return state
      const exists = state.boosts.some((b) => b.id === boost.id)
      return { ...state, boosts: exists ? state.boosts.map((b) => (b.id === boost.id ? boost : b)) : [...state.boosts, boost] }
    }
    case 'boost/import': {
      // The switch of the feature: with sharing off, nothing comes in by this door.
      if (!state.settings.boostSharing) return state
      const checked = checkSharedBoost(action.boost)
      if (!checked.ok) return state
      const shared = checked.boost
      // The setting is read here, at the last step: whatever asked for the import, a script that the person does not want in never gets in.
      const js = state.settings.boostScriptImport === 'never' ? '' : shared.js
      const taken = new Set(state.boosts.map((b) => b.id))
      const id = typeof action.id === 'string' && BOOST_ID.test(action.id) && !taken.has(action.id) ? action.id : ctx.newId()
      const boost = cleanBoost({ ...shared, js, id, enabled: true, ...(js.trim() !== '' ? { jsEnabled: false } : {}) }, ctx.newId)
      if (taken.has(boost.id)) return state
      const names = new Set(state.boosts.filter((b) => b.host === boost.host).map((b) => b.name.trim().toLowerCase()))
      return { ...state, boosts: [...state.boosts, { ...boost, name: uniqueBoostName(boost.name, names) }] }
    }
    case 'commandbar/used': {
      if (typeof action.key !== 'string' || !action.key || action.key.length > USAGE_KEY_MAX) return state
      // The ranking is saved: choosing a private tab in the bar does not teach it that address.
      if (state.tabs.some((t) => t.private === true && `${USAGE_KEY_PREFIX}${t.url}` === action.key)) return state
      // Nor does anything chosen in the bar while a private tab is on screen: the bar of a new private tab is over a blank page, and the key is the
      // address typed for it (or the search, with its words), which no tab holds yet.
      if (activeTab(state)?.private === true) return state
      // Nor while the history is not recorded for the profile of the space on screen: the ranking is a list of the addresses chosen, kept in the state file.
      if (!profileRecordsHistory(state.settings, profileOfSpace(state, state.activeSpaceId))) return state
      // The ranking is the profile's: what is picked in a space is counted for the profile of that space, and for no other.
      const usage = usageAfterPick(state.commandBarUsage, profileOfSpace(state, state.activeSpaceId), action.key)
      return usage === state.commandBarUsage ? state : { ...state, commandBarUsage: usage }
    }
    case 'commandbar/forget': {
      if (typeof action.profileId !== 'string' || !Array.isArray(action.urls)) return state
      const usage = usageWithoutPages(state.commandBarUsage, action.profileId, action.urls.filter((url): url is string => typeof url === 'string'))
      return usage === state.commandBarUsage ? state : { ...state, commandBarUsage: usage }
    }
    case 'commandbar/put-back': {
      if (typeof action.profileId !== 'string' || typeof action.url !== 'string' || typeof action.count !== 'number') return state
      // Only for a profile that exists (a ranking under another id would be read by nothing, then by a new profile that takes the id), and only
      // while its history is recorded: the ranking is a list of addresses kept in the state file.
      if (!knownProfiles(state).includes(action.profileId) || !profileRecordsHistory(state.settings, action.profileId)) return state
      const usage = usageWithPageBack(state.commandBarUsage, action.profileId, action.url, action.count)
      return usage === state.commandBarUsage ? state : { ...state, commandBarUsage: usage }
    }
    case 'sidepanel/behavior': {
      // The id is a key of a record of the state, and the value a boolean: anything else is not kept.
      if (!isRecordKey(action.extensionId) || typeof action.openOnActionClick !== 'boolean') return state
      if (state.sidePanelBehavior[action.extensionId] === action.openOnActionClick) return state
      return { ...state, sidePanelBehavior: { ...state.sidePanelBehavior, [action.extensionId]: action.openOnActionClick } }
    }
    case 'boost/delete':
      return { ...state, boosts: state.boosts.filter((b) => b.id !== action.id) }
    case 'permission/set': {
      // What the interface sends is written as it comes: an origin and a permission that can be keys of a record, an answer that is one.
      if (!isRecordKey(action.origin) || !isRecordKey(action.permission)) return state
      if (action.decision !== null && action.decision !== 'allow' && action.decision !== 'deny') return state
      // The origin and the answer go to the end of their records: the ones that go when a ceiling is reached are the longest unused.
      const { [action.origin]: known, ...others } = state.sitePermissions
      const forOrigin = { ...(known ?? {}) }
      delete forOrigin[action.permission]
      if (action.decision !== null) forOrigin[action.permission] = action.decision
      // An origin that is left with no answer is no entry (a file would not hold it either): `null` forgets, it does not leave an empty record behind.
      // A site left with no answer has no day of visit to keep either.
      const { [action.origin]: _visit, ...visits } = state.siteVisits
      return { ...state, siteVisits: Object.keys(forOrigin).length > 0 ? state.siteVisits : visits, sitePermissions: boundSitePermissions(Object.keys(forOrigin).length > 0 ? { ...others, [action.origin]: forOrigin } : others) }
    }
    case 'permission/visit': {
      const visits = withVisit(state.siteVisits, state.sitePermissions, action.origin, action.day)
      return visits === state.siteVisits ? state : { ...state, siteVisits: visits }
    }
    case 'permission/forget-visits': {
      const visits = forgetVisits(state.siteVisits, action.host, action.subdomains === true)
      return visits === state.siteVisits ? state : { ...state, siteVisits: visits }
    }
    case 'permission/sweep': {
      const swept = sweepUnused(state.sitePermissions, state.siteVisits, action.day, cleanUnusedPermissionDays(state.settings.forgetUnusedPermissionsDays))
      return swept.sitePermissions === state.sitePermissions && swept.siteVisits === state.siteVisits ? state : { ...state, sitePermissions: swept.sitePermissions, siteVisits: swept.siteVisits }
    }
    default:
      return undefined
  }
}
