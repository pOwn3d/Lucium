// A family of the reducer of the sidebar (sidebar.ts composes them in `reduceCore`): the archive, the favourites, read later, the bookmarks, the
// live folders, the sessions.

import { READ_LATER_FOLDERS_LIMIT, type ArchivedTab, type Favorite, type Folder, type Session, type SidebarState, type TabReminder, isListedTab, TAB_NAME_MAX } from './model'
import { containerById } from './containers'
import { SESSIONS_MAX, SESSION_SPACE_EMOJI, appendSessionTabs, autoSessionName, cleanSessionName, restorableTabs, sessionTabsOf } from './sessions'
import { dueReminders, tabReminderOf, tabReminderOutcome, withReminder } from './tab-reminder'
import { moveReadLater, readLaterItemOf, readLaterOutcome } from './read-later'
import { LIVE_FOLDERS_MAX, afterFailure, afterLook, cleanLiveSource, defaultLiveName, isLiveFolder, liveText } from './live-folders'
import { bookmarkAddressProblem, bookmarkOf, bookmarkOutcome, cleanBookmarks, cleanTags, mergeBookmarks, removeTag, renameTag } from './bookmarks'
import { themeHue } from './theme'
import { favoriteProfile, favoritesOf, withFavoriteAt, withProfileOrder } from './favorite-scope'
import { profileArchiveHours, profileOfSpace } from './profiles'
import { archiveAfterForgetting } from './closed-history'
import { parseSiteHost } from './site-data'
import { hostOf, isExtensionPageUrl, isNavigableUrl } from './url'
import { isInternalPageUrl } from './internal-page'
import { fillIcons } from './favicon'
import { ARCHIVE_LIMIT, cleanFaviconUrl, cleanReadLaterFolders, NAME_MAX, TAB_URL_MAX, TITLE_MAX, isLoadableUrl, isRecord, printable } from './state-clean'
import type { Ctx, Action } from './sidebar-actions'
import { typedName } from './sidebar-state'
import { sessionSourceTabs, tabOpenedSince } from './sidebar-selectors'
import { HOUR_MS, replaceTab, onlyPrivateTabsOn, select, archiveTabs, moveTabs, shownElsewhereOf, withSplitPanes } from './sidebar-helpers'
import type { Reducers } from './sidebar-helpers'
import { usageAfterForgetting } from './command-bar-usage'

/** The tab that brings a reminder back: in its space while that space exists, else in the one on screen; in its container while that container exists, else outside any. */
function reopenReminder(state: SidebarState, entry: TabReminder, background: boolean): Action {
  return { type: 'tab/open', url: entry.url, ...(state.spaces.some((s) => s.id === entry.spaceId) ? { spaceId: entry.spaceId } : {}), ...(entry.container !== undefined && containerById(state.settings, entry.container) ? { container: entry.container } : {}), ...(background ? { background: true } : {}) }
}

/** The actions on the library: archive, read later, bookmarks, live folders, favourites, their icons and the sessions (archive/, readlater/, readlater-folder/, bookmark/, bookmarks/, livefolder/, favorite/, favicon/, session/); undefined for the others. */
export function reduceLibrary(state: SidebarState, action: Action, ctx: Ctx, again: Reducers): SidebarState | undefined {
  switch (action.type) {
    case 'archive/sweep': {
      const hoursFor = (spaceId: string) => profileArchiveHours(state.settings, profileOfSpace(state, spaceId))
      // A tab on screen is not idle, whatever its date says: the selected tab of each space, in this window and in the others, and the other panes of its split view.
      const selected = withSplitPanes(state, [...Object.values(state.activeTabBySpace), ...shownElsewhereOf(action.shownElsewhere)])
      const stale = state.tabs.filter((t) => {
        const hours = hoursFor(t.spaceId)
        // A private tab left idle is swept too, and closes for good (the archive never hears of it): the description of the delay, in the settings, says so.
        return hours > 0 && !t.pinned && isListedTab(t) && !selected.has(t.id) && t.lastActiveAt < ctx.now - hours * HOUR_MS
      })
      return stale.length === 0 ? state : archiveTabs(state, stale.map((t) => t.id), 'auto', ctx)
    }
    case 'archive/add': {
      if (!isNavigableUrl(action.url) || action.url.length > TAB_URL_MAX) return state
      const spaceId = state.spaces.some((sp) => sp.id === action.spaceId) ? action.spaceId! : state.activeSpaceId
      // Where the entry comes from is one of the words the archive knows; anything else is left out.
      const source = action.source === 'auto' || action.source === 'manual' || action.source === 'little' ? action.source : undefined
      const entry: ArchivedTab = { id: ctx.newId(), spaceId, url: action.url, title: printable(action.title, TITLE_MAX) || hostOf(action.url) || action.url, archivedAt: ctx.now, ...(source ? { source } : {}) }
      return { ...state, archive: [entry, ...state.archive].slice(0, ARCHIVE_LIMIT) }
    }
    case 'archive/restore-last': {
      // The archive is newest first: this is "reopen the last closed tab".
      const count = Math.min(Math.max(1, Math.floor(Number(action.count)) || 1), state.archive.length)
      const entries = state.archive.slice(0, count)
      if (entries.length === 0) return state
      // The oldest of them goes back first, so a group of tabs comes back in the order it was archived in.
      return entries.reverse().reduce((s, entry) => again.core(s, { type: 'archive/restore', id: entry.id }, ctx), state)
    }
    case 'archive/clear': {
      // What a lock hides is not emptied with the rest: only the entries that show go.
      const keepSpaces = new Set(Array.isArray(action.keepSpaces) ? action.keepSpaces.filter((id): id is string => typeof id === 'string') : [])
      const kept = keepSpaces.size === 0 ? [] : state.archive.filter((entry) => keepSpaces.has(entry.spaceId))
      return kept.length === state.archive.length ? state : { ...state, archive: kept }
    }
    case 'archive/forget-pages': {
      if (typeof action.profileId !== 'string') return state
      // A site that is not a host forgets nothing (it must never turn into "forget everything").
      const site = action.site === undefined ? undefined : parseSiteHost(action.site.host)
      if (site === null) return state
      const scope = { profileId: action.profileId, ...(site ? { site: { host: site.host, subdomains: action.site!.subdomains === true } } : {}) }
      const archive = archiveAfterForgetting(state.archive, scope, (spaceId) => profileOfSpace(state, spaceId) === action.profileId)
      // The ranking of the command bar is history too: whole addresses, with how often each was chosen. It is kept per profile: erasing the history
      // of one profile empties its ranking, erasing the history of a site takes that site's addresses out of it, and the other profiles keep theirs.
      const usage = usageAfterForgetting(state.commandBarUsage, action.profileId, scope.site)
      // A space put aside took its archive with it into its session, which is saved with the state: its lists are history of its profile too.
      let asideChanged = false
      const sessions = state.sessions.map((session) => {
        const aside = session.space
        if (!aside || aside.space.profileId !== action.profileId) return session
        const kept = archiveAfterForgetting(aside.archive, scope, () => true)
        if (kept === aside.archive) return session
        asideChanged = true
        return { ...session, space: { ...aside, archive: [...kept] } }
      })
      if (archive === state.archive && usage === state.commandBarUsage && !asideChanged) return state
      return {
        ...state,
        ...(archive === state.archive ? {} : { archive: [...archive] }),
        ...(usage === state.commandBarUsage ? {} : { commandBarUsage: usage }),
        ...(asideChanged ? { sessions } : {})
      }
    }
    case 'readlater/add': {
      const tab = state.tabs.find((t) => t.id === action.tabId)
      // The list is saved: a private page is not put in it.
      if (!tab || tab.private === true) return state
      const outcome = readLaterOutcome(state.readLater, tab)
      if (outcome === 'unsupported' || outcome === 'full') return state
      let saved = state
      if (outcome === 'saved') {
        const item = readLaterItemOf(tab, ctx)
        if (!item) return state
        saved = { ...state, readLater: [item, ...state.readLater] }
      }
      return tab.pinned ? saved : again.core(saved, { type: 'tab/close', id: tab.id }, ctx)
    }
    // The reminders belong to the setting: with it off none is made, opened or fired (a pending one waits for it to come back).
    case 'reminder/add': {
      const tab = state.tabs.find((t) => t.id === action.tabId)
      // The list is saved: a private page is not put in it.
      if (!state.settings.tabReminders || !tab || tab.private === true) return state
      const outcome = tabReminderOutcome(state.tabReminders, tab, action.dueAt, ctx.now)
      if (outcome !== 'saved' && outcome !== 'updated') return state
      const entry = tabReminderOf(tab, action.dueAt, ctx)
      if (!entry) return state
      const saved = { ...state, tabReminders: withReminder(state.tabReminders, entry) }
      return tab.pinned ? saved : again.core(saved, { type: 'tab/close', id: tab.id }, ctx)
    }
    case 'reminder/cancel':
      return state.tabReminders.some((r) => r.id === action.id) ? { ...state, tabReminders: state.tabReminders.filter((r) => r.id !== action.id) } : state
    case 'reminder/open': {
      const entry = state.settings.tabReminders ? state.tabReminders.find((r) => r.id === action.id) : undefined
      return entry ? again.reduce({ ...state, tabReminders: state.tabReminders.filter((r) => r.id !== entry.id) }, reopenReminder(state, entry, false), ctx) : state
    }
    case 'reminder/fire': {
      if (!state.settings.tabReminders) return state
      const due = dueReminders(state.tabReminders, ctx.now)
      if (due.length === 0) return state
      const ids = new Set(due.map((r) => r.id))
      return due.reduce((s, entry) => again.reduce(s, reopenReminder(state, entry, true), ctx), { ...state, tabReminders: state.tabReminders.filter((r) => !ids.has(r.id)) })
    }
    case 'readlater/open': {
      const item = state.readLater.find((i) => i.id === action.id)
      return item ? again.reduce(state, { type: 'tab/open', url: item.url }, ctx) : state
    }
    case 'readlater/remove':
      return state.readLater.some((i) => i.id === action.id) ? { ...state, readLater: state.readLater.filter((i) => i.id !== action.id) } : state
    case 'readlater/clear':
      return state.readLater.length === 0 ? state : { ...state, readLater: [] }
    // The folders belong to the setting: with it off none is made or changed (the interface shows none, and nothing else may ask).
    case 'readlater-folder/create': {
      if (!state.settings.useReadLaterFolders || state.readLaterFolders.length >= READ_LATER_FOLDERS_LIMIT) return state
      const [folder] = cleanReadLaterFolders([{ id: ctx.newId(), name: action.name }])
      return folder ? { ...state, readLaterFolders: [...state.readLaterFolders, folder] } : state
    }
    case 'readlater-folder/rename': {
      if (!state.settings.useReadLaterFolders || !state.readLaterFolders.some((f) => f.id === action.id)) return state
      const [renamed] = cleanReadLaterFolders([{ id: action.id, name: action.name }])
      // A blank name keeps the old one, as for the folders of the sidebar.
      if (!renamed || typeof action.name !== 'string' || action.name.trim() === '') return state
      return { ...state, readLaterFolders: state.readLaterFolders.map((f) => (f.id === action.id ? { ...f, name: renamed.name } : f)) }
    }
    case 'readlater-folder/delete': {
      if (!state.settings.useReadLaterFolders || !state.readLaterFolders.some((f) => f.id === action.id)) return state
      return {
        ...state,
        readLaterFolders: state.readLaterFolders.filter((f) => f.id !== action.id),
        readLater: state.readLater.map((item) => {
          if (item.folderId !== action.id) return item
          const { folderId: _gone, ...loose } = item
          return loose
        })
      }
    }
    case 'readlater-folder/collapse': {
      if (!state.settings.useReadLaterFolders) return state
      const folder = state.readLaterFolders.find((f) => f.id === action.id)
      if (!folder || (folder.collapsed === true) === (action.collapsed === true)) return state
      return { ...state, readLaterFolders: state.readLaterFolders.map((f) => (f.id === action.id ? (action.collapsed === true ? { ...f, collapsed: true } : { id: f.id, name: f.name }) : f)) }
    }
    case 'readlater/move': {
      if (!state.settings.useReadLaterFolders) return state
      const moved = moveReadLater(state.readLater, state.readLaterFolders, action.id, action.folderId, action.beforeId)
      return moved === state.readLater ? state : { ...state, readLater: moved }
    }
    // The library belongs to its setting: with it off nothing is added, changed or removed (the interface shows none, and nothing else may ask).
    case 'bookmark/add': {
      const tab = state.tabs.find((t) => t.id === action.tabId)
      if (!state.settings.bookmarkManager || !tab || tab.private === true || bookmarkOutcome(state.bookmarks, tab) !== 'saved') return state
      const bookmark = bookmarkOf(tab, ctx)
      if (!bookmark) return state
      const tags = cleanTags(action.tags)
      return { ...state, bookmarks: [tags.length > 0 ? { ...bookmark, tags } : bookmark, ...state.bookmarks] }
    }
    case 'bookmark/open': {
      const bookmark = state.settings.bookmarkManager ? state.bookmarks.find((b) => b.id === action.id) : undefined
      return bookmark ? again.reduce(state, { type: 'tab/open', url: bookmark.url }, ctx) : state
    }
    case 'bookmark/edit': {
      const current = state.settings.bookmarkManager ? state.bookmarks.find((b) => b.id === action.id) : undefined
      const patch: Record<string, unknown> = typeof action.patch === 'object' && action.patch !== null ? action.patch : {}
      if (!current) return state
      let url = current.url
      if (patch['url'] !== undefined && patch['url'] !== current.url) {
        // Another page of the library cannot be given this address: the library keeps each page once.
        if (bookmarkAddressProblem(state.bookmarks, current.id, patch['url']) !== null) return state
        url = patch['url'] as string
      }
      const title = typeof patch['title'] === 'string' && patch['title'].trim() !== '' ? patch['title'] : current.title
      const [edited] = cleanBookmarks([{ ...current, url, title, tags: patch['tags'] !== undefined ? patch['tags'] : current.tags, note: patch['note'] !== undefined ? patch['note'] : current.note }])
      if (!edited || JSON.stringify(edited) === JSON.stringify(current)) return state
      return { ...state, bookmarks: state.bookmarks.map((b) => (b.id === current.id ? edited : b)) }
    }
    case 'bookmark/remove':
      return state.settings.bookmarkManager && state.bookmarks.some((b) => b.id === action.id) ? { ...state, bookmarks: state.bookmarks.filter((b) => b.id !== action.id) } : state
    case 'bookmark/tag-rename': {
      if (!state.settings.bookmarkManager) return state
      const renamed = renameTag(state.bookmarks, action.from, action.to)
      return renamed === state.bookmarks ? state : { ...state, bookmarks: renamed }
    }
    case 'bookmark/tag-delete': {
      if (!state.settings.bookmarkManager) return state
      const stripped = removeTag(state.bookmarks, action.tag)
      return stripped === state.bookmarks ? state : { ...state, bookmarks: stripped }
    }
    case 'bookmarks/import': {
      if (!state.settings.bookmarkManager) return state
      const merge = mergeBookmarks(state.bookmarks, action.entries, ctx)
      return merge.added === 0 && merge.merged === 0 ? state : { ...state, bookmarks: merge.list }
    }
    case 'archive/restore': {
      const entry = state.archive.find((a) => a.id === action.id)
      if (!entry) return state
      const left = { ...state, archive: state.archive.filter((a) => a.id !== entry.id) }
      // A page of an extension is not opened again from the archive (only an extension asks for one, see tab/open): its entry leaves, nothing else changes. The same for the
      // Extensions page (only the shell opens it); such an entry is not made (archiveTabs), so this is a file written by hand.
      if (isExtensionPageUrl(entry.url) || isInternalPageUrl(entry.url)) return left
      const spaceId = state.spaces.some((s) => s.id === entry.spaceId) ? entry.spaceId : state.activeSpaceId
      const opened = again.reduce(
        left,
        // The tab comes back in the container it was closed in, while there is one; else the rule of its site decides, as for any new tab.
        { type: 'tab/open', url: entry.url, spaceId, ...(entry.container !== undefined && containerById(state.settings, entry.container) ? { container: entry.container } : {}) },
        ctx
      )
      // The tab that came back is the one that is new: when none came (the address was refused), the entry stays in the archive and nothing else moves.
      // Looked for with a set of the tabs before (`tabOpenedSince`), not a search of them for each tab: « Rouvrir le dernier onglet fermé » is this.
      const restored = tabOpenedSince(state, opened)
      if (!restored) return state
      const titled = replaceTab(opened, restored.id, (t) => ({ ...t, title: entry.title }))
      // A tab that was pinned comes back pinned, at the end of the pinned ones: at its anchor address, in its folder while there is one (moveTabs puts it at the root of the pinned ones otherwise).
      return entry.pinned === true
        ? replaceTab(moveTabs(titled, [restored.id], Number.MAX_SAFE_INTEGER, true, entry.folderId), restored.id, (t) => ({ ...t, anchorUrl: entry.anchorUrl ?? t.anchorUrl }))
        : titled
    }
    case 'livefolder/create': {
      const source = cleanLiveSource(action.source)
      if (!state.settings.liveFolders || !source || state.folders.filter(isLiveFolder).length >= LIVE_FOLDERS_MAX) return state
      const name = liveText(action.name, NAME_MAX) || defaultLiveName(source)
      const spaceId = typeof action.spaceId === 'string' && state.spaces.some((sp) => sp.id === action.spaceId) ? action.spaceId : undefined
      const created = again.core(state, { type: 'folder/create', name, ...(spaceId ? { spaceId } : {}), ...(typeof action.parentId === 'string' ? { parentId: action.parentId } : {}) }, ctx)
      if (created === state) return state
      const folder = created.folders.at(-1)!
      return { ...created, folders: created.folders.map((f) => (f.id === folder.id ? { ...f, live: { source, items: [] } } : f)) }
    }
    case 'livefolder/edit': {
      const folder = state.folders.find((f) => f.id === action.id)
      if (!state.settings.liveFolders || !folder?.live) return state
      const source = action.source === undefined ? folder.live.source : cleanLiveSource(action.source)
      if (!source) return state
      const name = action.name === undefined ? folder.name : liveText(action.name, NAME_MAX) || folder.name
      const sameSource = JSON.stringify(source) === JSON.stringify(folder.live.source)
      if (sameSource && name === folder.name) return state
      return { ...state, folders: state.folders.map((f) => (f.id === folder.id ? { ...f, name, live: sameSource ? folder.live : { source, items: [] } } : f)) }
    }
    case 'livefolder/refresh': {
      if (!state.settings.liveFolders) return state
      const due = (f: Folder): boolean => f.live !== undefined && (f.id === action.id || action.id === undefined) && (f.live.checkedAt !== undefined || f.live.failure !== undefined)
      if (!state.folders.some(due)) return state
      return {
        ...state,
        folders: state.folders.map((f) => {
          if (!due(f) || !f.live) return f
          const { checkedAt: _at, failure: _why, ...live } = f.live
          return { ...f, live }
        })
      }
    }
    case 'livefolder/result': {
      const folder = state.folders.find((f) => f.id === action.id)
      if (!state.settings.liveFolders || !folder?.live || JSON.stringify(cleanLiveSource(action.source)) !== JSON.stringify(folder.live.source)) return state
      const live = action.failure !== undefined ? afterFailure(folder.live, String(action.failure), ctx.now) : afterLook(folder.live, Array.isArray(action.items) ? action.items : [], ctx.now)
      return { ...state, folders: state.folders.map((f) => (f.id === folder.id ? { ...f, live } : f)) }
    }
    case 'favorite/add': {
      if (onlyPrivateTabsOn(state, (url) => url === action.url)) return state
      // An address the engine would not load is no favourite (a file would not keep it either): the tile would stand for nothing.
      if (!isLoadableUrl(action.url)) return state
      const spaceId = action.spaceId ?? state.activeSpaceId
      const space = state.spaces.find((s) => s.id === spaceId)
      if (!space) return state
      // Each profile has its own favourites: the address may be a favourite of another profile already.
      if (favoritesOf(state, space.profileId).some((f) => f.url === action.url)) return state
      // The icon is read like the icon of a tab: an address of a picture within the bounds, or none.
      const icon = cleanFaviconUrl(action.faviconUrl)
      const favorite: Favorite = { id: ctx.newId(), url: action.url, title: printable(action.title, TITLE_MAX) ?? (hostOf(action.url) || action.url), ...(icon ? { faviconUrl: icon } : {}), profileId: space.profileId }
      return { ...state, favorites: withFavoriteAt(state.favorites, favorite, action.toIndex ?? Infinity) }
    }
    case 'favorite/place': {
      const favorite = state.favorites.find((f) => f.id === action.id)
      if (!favorite || !Number.isFinite(action.toIndex)) return state
      const mine = favoritesOf(state, favoriteProfile(favorite))
      const at = Math.max(0, Math.min(Math.trunc(action.toIndex), mine.length - 1))
      if (mine[at]?.id === favorite.id) return state
      return { ...state, favorites: withFavoriteAt(state.favorites, favorite, at) }
    }
    case 'favorite/move': {
      const favorite = state.favorites.find((f) => f.id === action.id)
      if (!favorite) return state
      const mine = favoritesOf(state, favoriteProfile(favorite))
      // One place before or after, nothing else: any other number would put a hole in the list.
      if (action.direction !== 1 && action.direction !== -1) return state
      const from = mine.indexOf(favorite)
      const to = from + action.direction
      if (to < 0 || to >= mine.length) return state
      const order = [...mine]
      ;[order[from], order[to]] = [order[to]!, order[from]!]
      return { ...state, favorites: withProfileOrder(state.favorites, favoriteProfile(favorite), order) }
    }
    case 'favorite/edit': {
      const favorite = state.favorites.find((f) => f.id === action.id)
      if (!favorite || !isRecord(action.patch)) return state
      const title = action.patch.title === undefined ? favorite.title : typedName(action.patch.title, TAB_NAME_MAX, '')
      const url = action.patch.url ?? favorite.url
      if (!title) return state
      // A new address is one a tab could hold: text, within the length of the address of a tab.
      if (url !== favorite.url && (typeof url !== 'string' || url.length > TAB_URL_MAX || !isNavigableUrl(url) || favoritesOf(state, favoriteProfile(favorite)).some((f) => f.id !== favorite.id && f.url === url))) return state
      return { ...state, favorites: state.favorites.map((f) => (f.id === favorite.id ? { ...f, title, url } : f)) }
    }
    case 'favorite/remove':
      return { ...state, favorites: state.favorites.filter((f) => f.id !== action.id) }
    case 'favorite/open': {
      const favorite = state.favorites.find((f) => f.id === action.id)
      const spaceId = action.spaceId ?? state.activeSpaceId
      const space = state.spaces.find((s) => s.id === spaceId)
      // A favourite of another profile is not opened here: its page would have the cookies of this space's profile.
      if (!favorite || !space || favoriteProfile(favorite) !== space.profileId) return state
      const page = state.tabs.find((t) => t.favoriteId === favorite.id && t.spaceId === spaceId)
      if (page) return select(state, page.id, ctx.now)
      const opened = again.core(state, { type: 'tab/open', url: favorite.url, spaceId }, ctx)
      // The address was refused (or no tab came of it): nothing to mark.
      if (opened.tabs.length !== state.tabs.length + 1) return opened
      const made = opened.tabs[opened.tabs.length - 1]!
      return replaceTab(opened, made.id, (t) => ({ ...t, favoriteId: favorite.id }))
    }
    case 'favicon/fill':
      return fillIcons(state, action.entries)
    case 'session/save': {
      // A session is the user's own work: past the limit nothing is pushed out, the save is refused.
      if (state.sessions.length >= SESSIONS_MAX) return state
      const tabs = sessionTabsOf(sessionSourceTabs(state, action.tabIds), state.folders)
      if (tabs.length === 0) return state
      const session: Session = { id: ctx.newId(), name: cleanSessionName(action.name) || autoSessionName(ctx.now), createdAt: ctx.now, tabs }
      return { ...state, sessions: [session, ...state.sessions] }
    }
    case 'session/restore': {
      const session = state.sessions.find((s) => s.id === action.id)
      const pages = session ? restorableTabs(session) : []
      if (!session || pages.length === 0) return state
      let base = state
      if (action.target === 'new-space') {
        // The new space looks like the one it is made from (same profile and colours), as for a folder turned into a space.
        const source = state.spaces.find((sp) => sp.id === state.activeSpaceId)
        base = again.reduce(state, { type: 'space/create', name: session.name, emoji: SESSION_SPACE_EMOJI, hue: source ? themeHue(source.theme) : 250, profileId: source?.profileId, theme: source?.theme }, ctx)
        if (base === state) return state
      }
      const { state: opened, firstId } = appendSessionTabs(base, base.activeSpaceId, pages, ctx)
      // A space with nothing on screen shows the first page restored; a space with a page on screen keeps it.
      const shown = opened.activeTabBySpace[opened.activeSpaceId]
      return firstId && !(shown && opened.tabs.some((t) => t.id === shown)) ? select(opened, firstId, ctx.now) : opened
    }
    case 'session/rename': {
      const name = cleanSessionName(action.name)
      const session = state.sessions.find((s) => s.id === action.id)
      // A blank name keeps the old one.
      if (!session || !name || name === session.name) return state
      // The list shows a space put aside under its name: renaming one renames the space, so that it comes back under the name it was shown by.
      const renamed: Session = session.space ? { ...session, name, space: { ...session.space, space: { ...session.space.space, name } } } : { ...session, name }
      return { ...state, sessions: state.sessions.map((s) => (s.id === session.id ? renamed : s)) }
    }
    case 'session/delete':
      return state.sessions.some((s) => s.id === action.id) ? { ...state, sessions: state.sessions.filter((s) => s.id !== action.id) } : state
    default:
      return undefined
  }
}
