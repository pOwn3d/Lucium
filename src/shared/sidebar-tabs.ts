// A family of the reducer of the sidebar (sidebar.ts composes them in `reduceCore`): the actions on the tabs, their moves and their split views.

import { type Folder, type SplitView, type SidebarState, type TabItem, isListedTab, TAB_NAME_MAX } from './model'
import { containerById, containerForUrl } from './containers'
import { TIDY_GROUPS_MAX, TIDY_TABS_MAX, tidyCandidates, tidyTargets } from './tab-grouping'
import { SPLIT_MIN_RATIO, equalRatios } from './split'
import { arranged, isJoinZone, isSplitArrangement, joined, withoutPane } from './split-grid'
import { splitJoin } from './split-place'
import { hostOf, isExtensionPageUrl, isNavigableUrl, isViewSourceUrl } from './url'
import { isInternalPageUrl } from './internal-page'
import { t } from './i18n'
import { autoReloadSeconds } from './auto-reload'
import { isSpaceImageName } from './space-image'
import { compactPatch } from './compact'
import { treeOutdentSlot } from './tab-tree'
import { cleanSplits, TAB_URL_MAX, isRecord } from './state-clean'
import type { Ctx, Action } from './sidebar-actions'
import { typedName } from './sidebar-state'
import { sidebarOrder, splitFor, originOf, pickNeighbor } from './sidebar-selectors'
import { anchorOf, sameTabFields, replaceTab, cleanTabUpdate, select, archiveTabs, moveTabs, withSplitPanes, tidyIfEnabled, moveToGroup, shownElsewhereOf } from './sidebar-helpers'
import type { Reducers } from './sidebar-helpers'

/** The actions on the tabs, their moves and their split views (tab/, tabs/, split/, today/, compact/); undefined for the others. */
export function reduceTabs(state: SidebarState, action: Action, ctx: Ctx, again: Reducers): SidebarState | undefined {
  switch (action.type) {
    case 'tab/open': {
      const spaceId = action.spaceId ?? state.activeSpaceId
      // The page of Lucium that stands for chrome://extensions: only the shell opens it (the flag), never in a private tab nor in a container (its session is its profile's).
      const internal = action.allowInternalPages === true && isInternalPageUrl(action.url)
      const openable = typeof action.url === 'string' && action.url.length <= TAB_URL_MAX && (isNavigableUrl(action.url) || isViewSourceUrl(action.url) || (action.allowExtensionPages === true && isExtensionPageUrl(action.url)) || internal)
      if (!openable || !state.spaces.some((s) => s.id === spaceId)) return state
      if (internal && (action.private === true || typeof action.container === 'string')) return state
      // A private tab asked for while the setting is off is refused: it must never come out as an ordinary tab that is saved.
      if (action.private === true && !state.settings.privateTabs) return state
      // A container that does not exist is refused: the page would otherwise open with the cookies of the profile, which is not what was asked.
      // The switch is not asked here: turning the function off keeps the identity of the tabs in a container, their copies and their reopenings included.
      if (typeof action.container === 'string' && !containerById(state.settings, action.container)) return state
      // A private tab keeps its throw-away session; any other tab goes where its container, else the rule of its site, says.
      // An extension's own page needs the session of its profile: it never goes to a container.
      const container = action.private === true || action.container === null || isExtensionPageUrl(action.url) ? undefined : (action.container ?? containerForUrl(state.settings, action.url))
      const tab: TabItem = {
        id: ctx.newId(),
        spaceId,
        url: action.url,
        // Until the page says it itself (its document title), the Extensions page is called what it is: it has no host to stand for it.
        title: internal ? t('extpage.extensions') : hostOf(action.url) || action.url,
        pinned: false,
        ...(action.private === true ? { private: true } : {}),
        ...(container !== undefined ? { container } : {}),
        // An id that is not a tab is dropped at once by `pruneOrigins`.
        ...(action.openerId !== undefined ? { openerId: action.openerId } : {}),
        // The tab it hangs under in the tree. `settleTree` (run after every action) drops it at once when the setting is off or the opener cannot be a
        // parent (not a tab, pinned, another space), and otherwise puts the tab after the rest of that branch.
        ...(typeof action.parentId === 'string' ? { parentId: action.parentId } : {}),
        createdAt: ctx.now,
        lastActiveAt: ctx.now
      }
      const next = { ...state, tabs: [...state.tabs, tab] }
      return action.background ? next : select(next, tab.id, ctx.now)
    }
    case 'tab/select':
      return select(state, action.id, ctx.now)
    case 'tab/set-container': {
      const tab = state.tabs.find((t) => t.id === action.id)
      // A private tab has its throw-away session, and an extension's page needs the session of its profile's extensions: neither goes to a container.
      if (!tab || tab.private === true || isInternalPageUrl(tab.url)) return state
      if (action.container === null) return tab.container === undefined ? state : replaceTab(state, tab.id, ({ container: _gone, ...rest }) => rest)
      if (typeof action.container !== 'string' || !state.settings.tabContainers || !containerById(state.settings, action.container) || tab.container === action.container || isExtensionPageUrl(tab.url)) return state
      const container = action.container
      return replaceTab(state, tab.id, (t) => ({ ...t, container }))
    }
    case 'tab/forget-origin': {
      const tab = state.tabs.find((t) => t.id === action.id)
      if (!tab || tab.openerId === undefined) return state
      return replaceTab(state, tab.id, ({ openerId: _gone, ...rest }) => rest)
    }
    case 'tab/back-to-origin': {
      const origin = originOf(state, action.id)
      if (!origin) return state
      const closed = archiveTabs(state, [action.id], 'manual', ctx)
      return select(closed, origin.id, ctx.now)
    }
    case 'tab/close': {
      const tab = state.tabs.find((t) => t.id === action.id)
      if (!tab) return state
      const wasActive = state.activeTabBySpace[tab.spaceId] === tab.id
      // Closing a pinned tab only puts it back to sleep on its anchor URL.
      const closed: SidebarState = tab.pinned
        ? replaceTab(state, tab.id, (t) => ({ ...t, url: anchorOf(t) ?? t.url }))
        : { ...state, tabs: state.tabs.filter((t) => t.id !== tab.id) }
      const nextActive = wasActive ? pickNeighbor(state, tab) : state.activeTabBySpace[tab.spaceId]
      const withActive = {
        ...closed,
        activeTabBySpace: { ...closed.activeTabBySpace, [tab.spaceId]: nextActive === tab.id ? null : (nextActive ?? null) }
      }
      return withActive
    }
    case 'tab/pin': {
      // A pinned tab keeps its anchor address: pinning it again must not write the address it has now over it.
      const current = state.tabs.find((t) => t.id === action.id)
      if (current?.private === true || current?.pinned === true) return state
      return moveToGroup(replaceTab(state, action.id, (t) => ({ ...t, anchorUrl: t.url, title: tidyIfEnabled(state, t.title, t.url) })), action.id, true)
    }
    case 'tab/unpin':
      return moveToGroup(
        replaceTab(state, action.id, (t) => ({ ...t, anchorUrl: undefined, folderId: undefined })),
        action.id,
        false
      )
    case 'tab/move':
      return moveTabs(state, [action.id], action.toIndex, action.pinned, action.folderId, action.parentId)
    case 'tabs/move':
      return moveTabs(state, action.ids, action.toIndex, action.pinned, action.folderId, action.parentId)
    case 'tab/tree-collapse': {
      const tab = state.settings.tabTree ? state.tabs.find((t) => t.id === action.id) : undefined
      if (!tab || !state.tabs.some((t) => t.parentId === tab.id)) return state
      const fold = action.collapsed === undefined ? tab.treeCollapsed !== true : action.collapsed === true
      if ((tab.treeCollapsed === true) === fold) return state
      return replaceTab(state, tab.id, ({ treeCollapsed: _old, ...rest }) => (fold ? { ...rest, treeCollapsed: true } : rest))
    }
    case 'tab/tree-detach': {
      const tab = state.settings.tabTree ? state.tabs.find((t) => t.id === action.id) : undefined
      const slot = tab ? treeOutdentSlot(state.tabs, tab) : null
      return tab && slot ? moveTabs(state, [tab.id], slot.toIndex, false, undefined, slot.parentId) : state
    }
    case 'compact/toggle': {
      const patch = compactPatch(state.settings)
      return patch ? { ...state, settings: { ...state.settings, ...patch } } : state
    }
    case 'tab/update': {
      // A field left out (or `undefined`) means "unchanged": spreading it would erase the field.
      const tab = state.tabs.find((t) => t.id === action.id)
      const patch = tab ? cleanTabUpdate(action.patch, tab, action.allowInternalPages === true) : {}
      if (!tab || Object.keys(patch).length === 0) return state
      let changed = false
      const updated = replaceTab(state, action.id, (t) => {
        const { faviconUrl: icon, ...rest } = { ...t, ...patch }
        // An empty icon is no icon: the field goes, as for a tab that never had one.
        const next: TabItem = icon ? { ...rest, faviconUrl: icon } : rest
        // A page rewrites its title all the time: a pinned tab keeps showing the tidy one.
        const result = next.pinned && typeof patch.title === 'string' ? { ...next, title: tidyIfEnabled(state, next.title, next.url) } : next
        changed = !sameTabFields(t, result)
        return result
      })
      // A page repeats its title and address: the same values (or a tab that is gone) are no new state, so nothing is saved or drawn again.
      return changed ? updated : state
    }
    case 'tab/rename': {
      const name = typedName(action.title, TAB_NAME_MAX, '')
      return replaceTab(state, action.id, (t) => {
        const { customTitle: _old, ...rest } = t
        return name ? { ...rest, customTitle: name } : rest
      })
    }
    case 'tab/icon': {
      if (typeof action.icon !== 'string') return state
      // One emoji (or a short sequence): a stray paragraph of text is not an icon.
      const icon = [...action.icon.trim()].slice(0, 8).join('')
      // An emoji chosen, or the site's icon taken back: the tab's picture goes too (it would be shown over either).
      return replaceTab(state, action.id, (t) => {
        const { icon: _old, image: _picture, ...rest } = t
        return icon && !/[\p{L}\p{N}]/u.test(icon.replace(/[\u200d\ufe0f]/g, '')) ? { ...rest, icon } : rest
      })
    }
    case 'tab/image': {
      // Only the name of a stored copy (never a path); a private tab writes nothing, so it keeps no picture either.
      if (action.image !== null && !isSpaceImageName(action.image)) return state
      const picture = action.image
      return replaceTab(state, action.id, (t) => {
        const { image: _old, ...rest } = t
        if (picture === null) return rest
        if (t.private) return t
        const { icon: _emoji, ...withoutEmoji } = rest
        return { ...withoutEmoji, image: picture }
      })
    }
    case 'tab/back-to-anchor':
      return replaceTab(state, action.id, (t) => {
        const anchor = anchorOf(t)
        return anchor ? { ...t, url: anchor } : t
      })
    case 'tab/replace-anchor':
      return replaceTab(state, action.id, (t) => (t.pinned ? { ...t, anchorUrl: t.url } : t))
    case 'tab/keep-awake': {
      const tab = state.tabs.find((t) => t.id === action.id)
      // The renderer is not trusted: only a real `true` marks a tab.
      const keep = action.keep === true
      if (!tab || (tab.keepAwake === true) === keep) return state
      return replaceTab(state, tab.id, ({ keepAwake: _old, ...rest }) => (keep ? { ...rest, keepAwake: true } : rest))
    }
    case 'tab/auto-reload': {
      const tab = state.tabs.find((t) => t.id === action.id)
      if (!tab) return state
      if (action.seconds === null) return tab.autoReload === undefined ? state : replaceTab(state, tab.id, ({ autoReload: _old, ...rest }) => rest)
      // The renderer is not trusted: an interval that is no number, or outside the bounds, changes nothing.
      const seconds = autoReloadSeconds(action.seconds)
      if (seconds === null || tab.autoReload?.seconds === seconds) return state
      return replaceTab(state, tab.id, (t) => ({ ...t, autoReload: { seconds } }))
    }
    case 'today/clear': {
      const spaceId = action.spaceId ?? state.activeSpaceId
      // What is on screen stays, here and in the other windows, the other panes of a split view with it (clearing would otherwise dissolve the split view being looked at).
      const keep = withSplitPanes(state, [state.activeTabBySpace[spaceId], ...shownElsewhereOf(action.shownElsewhere)])
      // The Today tabs go to the archive ("Clear"): the sidebar's own notice offers to bring them back.
      const going = state.tabs.filter((t) => t.spaceId === spaceId && !t.pinned && isListedTab(t) && !keep.has(t.id))
      return going.length === 0 ? state : archiveTabs(state, going.map((t) => t.id), 'manual', ctx)
    }
    case 'tab/archive': {
      const tab = state.tabs.find((t) => t.id === action.id)
      return tab && !tab.pinned ? archiveTabs(state, [tab.id], 'manual', ctx) : state
    }
    case 'tab/remove-pinned': {
      const tab = state.tabs.find((t) => t.id === action.id)
      return tab && tab.pinned ? archiveTabs(state, [tab.id], 'manual', ctx) : state
    }
    case 'tab/archive-group': {
      const tab = state.tabs.find((t) => t.id === action.id)
      if (!tab) return state
      const today = state.tabs.filter((t) => t.spaceId === tab.spaceId && !t.pinned && isListedTab(t))
      const at = today.findIndex((t) => t.id === tab.id)
      const picked = action.scope === 'above' ? today.slice(0, Math.max(0, at)) : action.scope === 'below' ? today.slice(at + 1) : today.filter((t) => t.id !== tab.id)
      return picked.length === 0 ? state : archiveTabs(state, picked.map((t) => t.id), 'manual', ctx)
    }
    case 'tabs/archive-many': {
      if (!Array.isArray(action.ids)) return state
      const wanted = new Set(action.ids)
      // The renderer is not trusted: only a real `true` lets a pinned tab go, and never the page of a favourite (its tile stays, nothing to archive).
      const withPinned = action.pinned === true
      const picked = state.tabs.filter((t) => wanted.has(t.id) && (!t.pinned || (withPinned && t.favoriteId === undefined)))
      return picked.length === 0 ? state : archiveTabs(state, picked.map((t) => t.id), 'manual', ctx)
    }
    case 'tabs/keep-dead': {
      // The renderer is not trusted: only the ids of tabs that exist mark anything, and the time is the reducer's.
      if (!Array.isArray(action.ids)) return state
      const wanted = new Set(action.ids.filter((id) => typeof id === 'string'))
      return { ...state, tabs: state.tabs.map((t) => (wanted.has(t.id) ? { ...t, deadKept: { url: t.url, at: ctx.now } } : t)) }
    }
    case 'tab/separate': {
      const tab = state.tabs.find((t) => t.id === action.id)
      // A pinned tab that navigated away from its anchor: the visited page becomes a Today tab, the pin goes back.
      const anchor = tab ? anchorOf(tab) : undefined
      if (!tab?.pinned || !anchor || tab.url === anchor) return state
      // The page stays in the container of the pinned tab, while there is one: outside it, the site would be loaded again with the cookies of the profile.
      const container = containerById(state.settings, tab.container) ? tab.container : undefined
      const copy: TabItem = { id: ctx.newId(), spaceId: tab.spaceId, url: tab.url, title: tab.title, faviconUrl: tab.faviconUrl, pinned: false, ...(container !== undefined ? { container } : {}), createdAt: ctx.now, lastActiveAt: ctx.now }
      const reset = replaceTab(state, tab.id, (t) => ({ ...t, url: anchor, title: hostOf(anchor) || t.title }))
      return select({ ...reset, tabs: [...reset.tabs, copy] }, copy.id, ctx.now)
    }
    case 'tabs/reset-pinned': {
      const spaceId = action.spaceId ?? state.activeSpaceId
      return {
        ...state,
        tabs: state.tabs.map((t) => {
          const anchor = anchorOf(t)
          return t.spaceId === spaceId && t.pinned && anchor && t.url !== anchor ? { ...t, url: anchor } : t
        })
      }
    }
    case 'tabs/tidy': {
      // A space that is none has no tab to move: nothing happens.
      const spaceId = action.spaceId ?? state.activeSpaceId
      const movable = new Set(tidyCandidates(state, spaceId).map((tab) => tab.id))
      // What comes from the interface is read as far as it is usable: groups and tabs within bounds, names as text, and only the tabs the proposal could have named.
      let budget = TIDY_TABS_MAX
      const groups = (Array.isArray(action.groups) ? action.groups.slice(0, TIDY_GROUPS_MAX) : []).flatMap((group: unknown) => {
        if (!isRecord(group) || !Array.isArray(group.tabIds)) return []
        const ids = group.tabIds.slice(0, budget).filter((id): id is string => typeof id === 'string' && movable.has(id))
        budget -= ids.length
        return ids.length > 0 ? [{ name: group.name, tabIds: ids }] : []
      })
      // The tabs go in the folder in the order the sidebar shows them.
      const shown = new Map(sidebarOrder(state, spaceId).map((tab, i) => [tab.id, i]))
      let tidied = state
      for (const target of tidyTargets(state.folders, spaceId, groups)) {
        const ids = [...target.tabIds].sort((a, b) => shown.get(a)! - shown.get(b)!)
        const folder: Folder = target.folderId ? tidied.folders.find((f) => f.id === target.folderId)! : { id: ctx.newId(), spaceId, name: target.name, collapsed: false, ...(action.atBottom === true ? { atBottom: true as const } : {}) }
        const holder = target.folderId ? tidied : { ...tidied, folders: [...tidied.folders, folder] }
        tidied = moveTabs(holder, ids, Number.MAX_SAFE_INTEGER, true, folder.id)
      }
      return tidied
    }
    case 'tabs/untidy': {
      const entries = (Array.isArray(action.tabs) ? action.tabs.slice(0, TIDY_TABS_MAX) : []).filter(
        (entry): entry is { id: string; folderId: string; index: number; openerId?: string } => isRecord(entry) && typeof entry.id === 'string' && typeof entry.folderId === 'string' && typeof entry.index === 'number' && Number.isFinite(entry.index)
      )
      let undone = state
      // From the first place to the last: each tab goes back where it stood, and the ones before it already are where they stood.
      for (const entry of [...entries].sort((a, b) => a.index - b.index)) {
        const tab = undone.tabs.find((candidate) => candidate.id === entry.id)
        if (tab === undefined || tab.folderId !== entry.folderId) continue
        undone = moveTabs(undone, [tab.id], Math.max(0, Math.trunc(entry.index)), false)
        // Back on the first page of a tab opened from a link closes it and returns there: the pin forgot that, the tab it came from is named again (`pruneOrigins` drops a name that is none).
        if (typeof entry.openerId === 'string') undone = replaceTab(undone, tab.id, (t) => ({ ...t, openerId: entry.openerId }))
      }
      const made = (Array.isArray(action.folderIds) ? action.folderIds : []).filter((id): id is string => typeof id === 'string')
      // A folder somebody put something in since (a tab, a folder) stays: undoing what was tidied must not lose what came after.
      const gone = new Set(made.filter((id) => !undone.tabs.some((tab) => tab.folderId === id) && !undone.folders.some((f) => f.parentId === id)))
      return gone.size === 0 ? undone : { ...undone, folders: undone.folders.filter((f) => !gone.has(f.id)) }
    }
    case 'tab/move-to-space': {
      const tab = state.tabs.find((t) => t.id === action.id)
      if (!tab || tab.spaceId === action.spaceId || !state.spaces.some((sp) => sp.id === action.spaceId)) return state
      const moved: TabItem = { ...tab, spaceId: action.spaceId, pinned: false, anchorUrl: undefined, folderId: undefined }
      const wasActive = state.activeTabBySpace[tab.spaceId] === tab.id
      const next = { ...state, tabs: [...state.tabs.filter((t) => t.id !== tab.id), moved] }
      return {
        ...next,
        activeTabBySpace: {
          ...next.activeTabBySpace,
          [tab.spaceId]: wasActive ? pickNeighbor(state, tab) : next.activeTabBySpace[tab.spaceId] ?? null
        }
      }
    }
    case 'tab/duplicate': {
      const tab = state.tabs.find((t) => t.id === action.id)
      // A copy of a tab in a container is in that container (and a copy of one outside any is outside, whatever the rules say).
      return tab ? again.reduce(state, { type: 'tab/open', url: tab.url, spaceId: tab.spaceId, ...(tab.private === true ? { private: true } : { container: containerById(state.settings, tab.container) ? tab.container : null }) }, ctx) : state
    }
    case 'tab/close-others': {
      const keep = state.tabs.find((t) => t.id === action.id)
      if (!keep) return state
      // The other panes of the split view of the tab that stays are on screen with it, and the page of a favourite is no row of Today: both stay, as
      // « Vider Aujourd’hui » leaves them.
      const spared = withSplitPanes(state, [keep.id])
      // The other tabs of the space go to the archive, as every other group of closed tabs does: the notice offers to bring them back.
      const going = state.tabs.filter((t) => t.spaceId === keep.spaceId && !t.pinned && isListedTab(t) && !spared.has(t.id)).map((t) => t.id)
      const archived = going.length === 0 ? state : archiveTabs(state, going, 'manual', ctx)
      return { ...archived, activeTabBySpace: { ...archived.activeTabBySpace, [keep.spaceId]: keep.id } }
    }
    case 'split/create': {
      const a = state.tabs.find((t) => t.id === action.tabId)
      const b = state.tabs.find((t) => t.id === action.withTabId)
      if (!a || !b || a.id === b.id || a.spaceId !== b.spaceId) return state
      const splitA = splitFor(state, a.id)
      const splitB = splitFor(state, b.id)
      let splits: SplitView[]
      if (splitA && splitB) return state // two existing splits are never merged
      const host = splitA ?? splitB
      if (host) {
        // Where the zone says (a side or a corner of the split view), at its end without one; nothing when it is full or does not take a tab there.
        const grown = joined(host, splitA ? b.id : a.id, isJoinZone(action.zone) ? action.zone : undefined)
        if (!grown) return state
        splits = state.splits.map((sp) => (sp.id === host.id ? grown : sp))
      } else {
        const created: SplitView = {
          id: ctx.newId(),
          spaceId: a.spaceId,
          tabIds: [a.id, b.id],
          orientation: action.orientation === 'vertical' ? 'vertical' : 'horizontal',
          ratios: equalRatios(2)
        }
        splits = [...state.splits, created]
      }
      // Two tabs of different lists: one joins the other's list, right after it, so that the row of the split view stands at that tab's place (split-place.ts).
      const join = splitJoin(state, a.id, b.id)
      const placed = join ? moveTabs(state, [join.id], join.toIndex, join.pinned, join.folderId) : state
      return select({ ...placed, splits }, action.focus === 'second' && !host ? b.id : a.id, ctx.now)
    }
    case 'split/remove': {
      const sp = splitFor(state, action.tabId)
      if (!sp) return state
      // A grid of four keeps a grid of three, one of three gives the two panes left as they were placed (split-grid.ts `withoutPane`).
      const left = withoutPane(sp, action.tabId)
      return { ...state, splits: state.splits.map((x) => (x.id === sp.id ? left : x)) }
    }
    case 'split/move': {
      const sp = state.splits.find((x) => x.tabIds.includes(action.tabId))
      if (!sp) return state
      // One place to the left or to the right, nothing else: any other number would put a pane that is no tab in the split view.
      if (action.direction !== 1 && action.direction !== -1) return state
      const from = sp.tabIds.indexOf(action.tabId)
      const to = from + action.direction
      if (to < 0 || to >= sp.tabIds.length) return state
      const swap = <T,>(list: T[]): T[] => {
        const next = [...list]
        ;[next[from], next[to]] = [next[to]!, next[from]!]
        return next
      }
      return { ...state, splits: state.splits.map((x) => (x === sp ? { ...x, tabIds: swap(x.tabIds), ratios: swap(x.ratios) } : x)) }
    }
    case 'split/orientation':
    case 'split/layout': {
      const sp = state.splits.find((x) => x.id === action.id)
      const arrangement = action.type === 'split/layout' ? action.layout : action.orientation
      // « Disposition » names any arrangement; the entry of the menu of a tab, a row or a column only.
      if (!sp || !isSplitArrangement(arrangement) || (action.type === 'split/orientation' && arrangement === 'grid')) return state
      const next = arranged(sp, arrangement)
      return next === sp ? state : { ...state, splits: state.splits.map((x) => (x === sp ? next : x)) }
    }
    case 'split/grid': {
      const sp = state.splits.find((x) => x.id === action.id)
      // A share that would leave a column or a row under the minimum is refused, as `split/ratios` refuses one.
      const fits = (share: unknown): share is number => typeof share === 'number' && Number.isFinite(share) && share >= SPLIT_MIN_RATIO - 1e-9 && share <= 1 - SPLIT_MIN_RATIO + 1e-9
      if (!sp?.grid || !fits(action.column) || !fits(action.row)) return state
      if (sp.grid.column === action.column && sp.grid.row === action.row) return state
      const grid = { ...sp.grid, column: action.column, row: action.row }
      return { ...state, splits: state.splits.map((x) => (x === sp ? { ...x, grid } : x)) }
    }
    case 'split/ratios': {
      const sp = state.splits.find((x) => x.id === action.id)
      if (!sp || !Array.isArray(action.ratios) || action.ratios.length !== sp.tabIds.length || !action.ratios.every((r) => Number.isFinite(r) && r > 0)) return state
      const sum = action.ratios.reduce((acc, r) => acc + r, 0)
      const scaled = action.ratios.map((r) => r / sum)
      // The minimum is the share a pane ends up with, not the number the caller sent (ratios that add up to 2 are scaled down by half).
      if (!scaled.every((r) => r >= SPLIT_MIN_RATIO - 1e-9)) return state
      return { ...state, splits: state.splits.map((x) => (x.id === sp.id ? { ...x, ratios: scaled } : x)) }
    }
    case 'split/restore': {
      // Its shape is cleaned like a saved one (the action comes from the interface); whether its tabs are still there is checked against the state.
      // All or nothing: a split view with one pane less than it had is not "put back". (A single pane, or panes in another space, are also dropped by `normalize`.)
      const [saved] = cleanSplits([action.split])
      if (!saved) return state
      const spaceOf = new Map(state.tabs.map((t) => [t.id, t.spaceId]))
      if (!saved.tabIds.every((id) => spaceOf.get(id) === saved.spaceId)) return state
      // What is left of the same split view (the other panes) is the only thing the restored one may stand on.
      const left = state.splits.find((sp) => sp.id === saved.id)
      if (left && !left.tabIds.every((id) => saved.tabIds.includes(id))) return state
      if (state.splits.some((sp) => sp.id !== saved.id && sp.tabIds.some((id) => saved.tabIds.includes(id)))) return state
      return { ...state, splits: left ? state.splits.map((sp) => (sp.id === saved.id ? saved : sp)) : [...state.splits, saved] }
    }
    default:
      return undefined
  }
}
