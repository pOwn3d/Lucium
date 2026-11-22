// A family of the reducer of the sidebar (sidebar.ts composes them in `reduceCore`): the actions on the spaces, the folders and the profiles.

import type { Folder, Session, SidebarState, Space, TabItem } from './model'
import { CONTAINERS_MAX, CONTAINER_COLORS, containerById, isContainerColor, newContainerId, validateContainerName, withContainerPermission, withContainerRule, withoutContainerPages, type Container } from './containers'
import { asideOf, asideRefusal, cleanSessionName, reopenAside, sessionTabsOf } from './sessions'
import { cleanTheme, themeFromHue, themeHue, type SpaceTheme } from './theme'
import { isSpaceImageName } from './space-image'
import { isSpaceEmoji, isSpaceMark, spaceEmojiOr } from './space-emoji'
import { LETTER_COLORS, cleanIconColor, cleanIconLetter, isSpaceIconKind } from './space-icon'
import { withWebPanel, withoutWebPanel } from './web-panels'
import { importedFavorites } from './favorite-scope'
import { LIVE_FOLDERS_MAX, isLiveFolder } from './live-folders'
import { withoutWindowKeys } from './window-tabs'
import { cleanRetiredProfiles } from './profile-retire'
import { PROFILE_NAME_LIMIT, isProfileId, newProfileId, profileLabels, takenProfileIds, validateProfileName } from './profiles'
import { LOCK_SETTING_KEYS, cleanLockedSpaces } from './lock'
import { markUsed, revertMissing } from './profile-recovery'
import { FOLDER_MAX_DEPTH, canMoveFolder, folderDepth, folderPlacement, folderSubtreeIds, isFolderSide, sideOfFolder, withSide, type FolderSide } from './folders'
import { cleanSpaceBackground, withBackgroundPosition } from './space-media'
import { NAME_MAX, isRecord, printable, withoutDevtoolsEntries, withoutForeignGrants } from './state-clean'
import { t } from './i18n'
import { scanBoostCss } from './boost-css'
import type { Ctx, Action } from './sidebar-actions'
import { restoredState, normalize, typedName } from './sidebar-state'
import { sidebarOrder, pickNeighbor } from './sidebar-selectors'
import { copySuffix, MAX_THEME_ENTRIES, archiveTabs, moveTabs, onlyPrivateTabsOn } from './sidebar-helpers'
import type { Reducers } from './sidebar-helpers'

/** The actions on the spaces, their folders, profiles and containers, and the whole state (restore, import, backup) (space/, folder/, profile/, container/, state/, import/, backup/); undefined for the others. */
export function reduceSpaces(state: SidebarState, action: Action, ctx: Ctx, again: Reducers): SidebarState | undefined {
  switch (action.type) {
    case 'space/create': {
      // The profile decides which cookies the space sees: when it cannot be had as asked, nothing is created.
      let settings = state.settings
      let profileId = action.profileId ?? 'default'
      if (action.profileName !== undefined) {
        if (validateProfileName(action.profileName, profileLabels(state)) !== null) return state
        profileId = newProfileId(action.profileName, takenProfileIds(state))
        settings = { ...settings, profileNames: { ...settings.profileNames, [profileId]: action.profileName.trim().slice(0, PROFILE_NAME_LIMIT) } }
      } else if (!isProfileId(profileId)) return state
      const base = themeFromHue(action.hue)
      const space: Space = {
        id: ctx.newId(),
        name: typedName(action.name, NAME_MAX, t('state-clean.espace')),
        emoji: spaceEmojiOr(action.emoji, '✨'),
        theme: action.theme ? cleanTheme({ ...base, ...action.theme }, base) : base,
        profileId
      }
      const letters = isRecord(action.letterIcon) ? cleanIconLetter(action.letterIcon['letter']) : null
      if (letters !== null && isRecord(action.letterIcon)) {
        space.iconKind = 'letter'
        space.iconLetter = letters
        space.iconColor = cleanIconColor(action.letterIcon['color']) ?? LETTER_COLORS[0]!
        if (action.letterIcon['round'] === true) space.iconRound = true
      }
      return {
        ...state,
        settings,
        spaces: [...state.spaces, space],
        activeSpaceId: space.id,
        activeTabBySpace: { ...state.activeTabBySpace, [space.id]: null }
      }
    }
    case 'space/select': {
      if (!state.spaces.some((s) => s.id === action.id)) return state
      return { ...state, activeSpaceId: action.id }
    }
    case 'space/delete': {
      if (state.spaces.length <= 1 || !state.spaces.some((s) => s.id === action.id)) return state
      const { [action.id]: _removed, ...activeTabBySpace } = state.activeTabBySpace
      const spaces = state.spaces.filter((s) => s.id !== action.id)
      return normalize({
        ...state,
        spaces,
        tabs: state.tabs.filter((t) => t.spaceId !== action.id),
        folders: state.folders.filter((f) => f.spaceId !== action.id),
        archive: state.archive.filter((a) => a.spaceId !== action.id),
        activeSpaceId: state.activeSpaceId === action.id ? (spaces[0]?.id ?? '') : state.activeSpaceId,
        activeTabBySpace
      })
    }
    case 'container/create': {
      const { settings } = state
      if (!settings.tabContainers || settings.containers.length >= CONTAINERS_MAX || validateContainerName(action.name, settings.containers.map((c) => c.name)) !== null) return state
      const name = action.name.trim()
      const color = isContainerColor(action.color) ? action.color : CONTAINER_COLORS[settings.containers.length % CONTAINER_COLORS.length]!.id
      const container: Container = { id: newContainerId(name, ctx.newId(), settings.containers.map((c) => c.id)), name, color }
      return { ...state, settings: { ...settings, containers: [...settings.containers, container] } }
    }
    case 'container/update': {
      const container = containerById(state.settings, action.id)
      const patch: Record<string, unknown> = isRecord(action.patch) ? action.patch : {}
      if (!container) return state
      let next = container
      if (patch['name'] !== undefined) {
        // The other containers' names: renaming a container to its own name in another case is allowed.
        if (validateContainerName(patch['name'], state.settings.containers.filter((c) => c.id !== container.id).map((c) => c.name)) !== null) return state
        next = { ...next, name: (patch['name'] as string).trim() }
      }
      if (patch['color'] !== undefined) {
        if (!isContainerColor(patch['color'])) return state
        next = { ...next, color: patch['color'] }
      }
      return next === container || (next.name === container.name && next.color === container.color) ? state : { ...state, settings: { ...state.settings, containers: state.settings.containers.map((c) => (c.id === container.id ? next : c)) } }
    }
    case 'container/delete': {
      const container = containerById(state.settings, action.id)
      if (!container) return state
      // Its tabs close without going to the archive (that would keep what was browsed in it); what else remembers their pages goes too.
      const going = state.tabs.filter((t) => t.container === container.id).map((t) => t.id)
      const closed = going.length > 0 ? { ...archiveTabs(state, going, 'manual', ctx), archive: state.archive } : state
      const cleared = withoutContainerPages(closed, container.id)
      return { ...cleared, settings: { ...cleared.settings, containers: cleared.settings.containers.filter((c) => c.id !== container.id), containerRules: cleared.settings.containerRules.filter((r) => r.containerId !== container.id) } }
    }
    case 'container/rule': {
      // Taking a site out of its container is always allowed; sending one in needs the function on.
      if (action.container !== null && !state.settings.tabContainers) return state
      const rules = withContainerRule(state.settings.containerRules, state.settings.containers, action.host, action.container)
      return JSON.stringify(rules) === JSON.stringify(state.settings.containerRules) ? state : { ...state, settings: { ...state.settings, containerRules: rules } }
    }
    case 'container/permission': {
      const container = containerById(state.settings, action.id)
      if (!container) return state
      const next = withContainerPermission(container, action.origin, action.permission, action.decision)
      return next === container ? state : { ...state, settings: { ...state.settings, containers: state.settings.containers.map((c) => (c.id === container.id ? next : c)) } }
    }
    case 'profile/used': {
      const used = markUsed(state.settings.usedProfiles, action.id)
      return used === state.settings.usedProfiles ? state : { ...state, settings: { ...state.settings, usedProfiles: [...used] } }
    }
    case 'profile/revert-missing':
      return Array.isArray(action.ids) ? revertMissing(state, action.ids.filter((id): id is string => typeof id === 'string')) : state
    case 'folder/collapse-all': {
      const spaceId = action.spaceId ?? state.activeSpaceId
      return { ...state, folders: state.folders.map((f) => (f.spaceId === spaceId ? { ...f, collapsed: true } : f)) }
    }
    case 'folder/create': {
      const parent = action.parentId ? state.folders.find((f) => f.id === action.parentId) : undefined
      // A sub-folder goes in its parent's space, and only while there is a level left.
      if (action.parentId && (!parent || folderDepth(state.folders, parent.id) >= FOLDER_MAX_DEPTH)) return state
      // A space that does not exist is the one on screen (as for `archive/add`): a folder of a missing space would be listed by nothing.
      const spaceId = parent?.spaceId ?? (state.spaces.some((sp) => sp.id === action.spaceId) ? action.spaceId! : state.activeSpaceId)
      const folder: Folder = { id: ctx.newId(), spaceId, name: typedName(action.name, NAME_MAX, t('import.dossier-sans-nom')), collapsed: false, ...(parent ? { parentId: parent.id } : {}) }
      // A sub-folder created inside a collapsed folder would be invisible: open the parent.
      const folders = state.folders.map((f) => (f.id === parent?.id ? { ...f, collapsed: false } : f))
      return { ...state, folders: [...folders, folder] }
    }
    case 'folder/create-with': {
      if (!Array.isArray(action.tabIds)) return state
      const wanted = new Set(action.tabIds)
      const first = state.tabs.find((t) => wanted.has(t.id))
      if (!first) return state
      // Tabs of one space only; they go into the folder in the order the sidebar shows them.
      const ids = sidebarOrder(state, first.spaceId).filter((t) => wanted.has(t.id)).map((t) => t.id)
      const folder: Folder = { id: ctx.newId(), spaceId: first.spaceId, name: typedName(action.name, NAME_MAX, t('menu.nouveau-dossier-2')), collapsed: false }
      return moveTabs({ ...state, folders: [...state.folders, folder] }, ids, Number.MAX_SAFE_INTEGER, true, folder.id)
    }
    case 'folder/bottom': {
      const folder = state.folders.find((f) => f.id === action.id)
      // Anything but `true` is "back on top": above the Today header, where a folder at the start of Today goes too.
      const side: FolderSide = action.bottom === true ? 'bottom' : 'top'
      // A folder inside another is placed with it: only a root folder has a side of the list.
      if (!folder || folder.parentId !== undefined || sideOfFolder(folder) === side) return state
      // It goes to the very end of the side it moves to: after the other folders under the tabs, or first among the ones above them.
      return again.core(state, { type: 'folder/move', id: folder.id, parentId: null, toIndex: side === 'bottom' ? Number.MAX_SAFE_INTEGER : 0, side }, ctx)
    }
    case 'folder/no-wake': {
      const folder = state.folders.find((f) => f.id === action.id)
      const on = action.on === true
      if (!folder || (folder.noWake === true) === on) return state
      const { noWake: _was, ...rest } = folder
      return { ...state, folders: state.folders.map((f) => (f.id === folder.id ? (on ? { ...rest, noWake: true as const } : rest) : f)) }
    }
    case 'folder/icon': {
      const folder = state.folders.find((f) => f.id === action.id)
      // Exactly one emoji, or null to take it away: a letter, text or several emoji would end up drawn in the row (and saved), so they change nothing.
      // (The same emoji again, or none on a folder that has none, is no change: `reduce` gives the state back.)
      if (!folder || (action.icon !== null && !isSpaceEmoji(action.icon))) return state
      const { icon: _was, ...rest } = folder
      return { ...state, folders: state.folders.map((f) => (f.id === folder.id ? (action.icon === null ? rest : { ...rest, icon: action.icon }) : f)) }
    }
    case 'folder/duplicate': {
      const folder = state.folders.find((f) => f.id === action.id)
      if (!folder) return state
      // The copy takes the whole subtree along: the folders inside it and every tab of them, all with new ids.
      const subtree = folderSubtreeIds(state.folders, folder.id)
      const newIds = new Map(subtree.map((id) => [id, ctx.newId()]))
      // A live folder is copied with its source while there is room for one more: past the limit a copy would look live and never be read again, so it
      // is an ordinary folder.
      let liveRoom = LIVE_FOLDERS_MAX - state.folders.filter(isLiveFolder).length
      const copies = subtree.map((id): Folder => {
        const original = state.folders.find((f) => f.id === id)!
        const { live, ...plain } = original
        const copy: Folder = { ...plain, id: newIds.get(id)!, ...(live !== undefined && liveRoom-- > 0 ? { live } : {}) }
        // The suffix stays when the name is long: the copy is told from the original by it.
        if (id === folder.id) return { ...copy, name: `${folder.name.slice(0, NAME_MAX - copySuffix().length)}${copySuffix()}` }
        return { ...copy, parentId: newIds.get(original.parentId!)! }
      })
      const tabCopies = state.tabs
        .filter((t) => t.folderId && newIds.has(t.folderId))
        .map((t): TabItem => ({ ...t, id: ctx.newId(), folderId: newIds.get(t.folderId!)!, createdAt: ctx.now }))
      const at = state.folders.findIndex((f) => f.id === folder.id)
      const folders = [...state.folders.slice(0, at + 1), ...copies, ...state.folders.slice(at + 1)]
      return { ...state, folders, tabs: [...state.tabs, ...tabCopies] }
    }
    case 'folder/to-space': {
      const folder = state.folders.find((f) => f.id === action.id)
      if (!folder) return state
      const source = state.spaces.find((sp) => sp.id === folder.spaceId)
      const created = again.reduce(state, { type: 'space/create', name: folder.name, emoji: '📁', hue: source ? themeHue(source.theme) : 250, profileId: source?.profileId, theme: source?.theme }, ctx)
      if (created === state) return state
      const spaceId = created.activeSpaceId
      const inside = new Set(folderSubtreeIds(state.folders, folder.id))
      const folders = state.folders
        .filter((f) => f.id !== folder.id)
        .map((f): Folder => {
          if (!inside.has(f.id)) return f
          const { parentId: _gone, ...rest } = f
          // A folder that sat in the removed one is now at the root of the new space.
          return f.parentId === folder.id ? { ...rest, spaceId } : { ...f, spaceId }
        })
      const tabs = state.tabs.map((t): TabItem => (t.folderId && inside.has(t.folderId) ? { ...t, spaceId, pinned: true, folderId: t.folderId === folder.id ? undefined : t.folderId } : t))
      const shown = state.activeTabBySpace[folder.spaceId]
      const wasShown = shown ? tabs.find((t) => t.id === shown)?.spaceId === spaceId : false
      return {
        ...created,
        folders,
        tabs,
        activeTabBySpace: {
          ...created.activeTabBySpace,
          [spaceId]: wasShown ? shown! : null,
          [folder.spaceId]: wasShown ? pickNeighbor({ ...state, tabs }, state.tabs.find((t) => t.id === shown)!) : (created.activeTabBySpace[folder.spaceId] ?? null)
        }
      }
    }
    case 'folder/archive': {
      const folder = state.folders.find((f) => f.id === action.id)
      if (!folder) return state
      const gone = new Set(folderSubtreeIds(state.folders, folder.id))
      const inside = state.tabs.filter((t) => t.folderId && gone.has(t.folderId)).map((t) => t.id)
      const archived = archiveTabs(state, inside, 'manual', ctx)
      return { ...archived, folders: archived.folders.filter((f) => !gone.has(f.id)) }
    }
    case 'folder/move': {
      if (!canMoveFolder(state.folders, action.id, action.parentId) || !Number.isFinite(action.toIndex)) return state
      const folder = state.folders.find((f) => f.id === action.id)!
      const without = state.folders.filter((f) => f.id !== folder.id)
      const siblings = without.filter((f) => f.spaceId === folder.spaceId && (f.parentId ?? null) === action.parentId)
      const at = Math.max(0, Math.min(Math.trunc(action.toIndex), siblings.length))
      const here = folderPlacement(state.folders, folder.id)
      // At the root the folder keeps its side unless the move says another (one that is none is not read); inside another folder it has none (it is placed with its parent).
      const side = isFolderSide(action.side) ? action.side : sideOfFolder(folder)
      if (here && here.parentId === action.parentId && here.index === at && side === sideOfFolder(folder)) return state
      const { parentId: _old, ...bare } = folder
      const moved: Folder = action.parentId ? withSide({ ...bare, parentId: action.parentId }, 'top') : withSide(bare, side)
      // In the flat list it stands in front of the sibling whose place it takes, else after the last sibling, else after its new parent.
      const next = siblings[at]
      const last = siblings[siblings.length - 1]
      const index = next ? without.indexOf(next) : last ? without.indexOf(last) + 1 : action.parentId ? without.findIndex((f) => f.id === action.parentId) + 1 : without.length
      // A folder moved into a closed folder would vanish from the sidebar: the new parent opens.
      const folders = [...without.slice(0, index), moved, ...without.slice(index)].map((f) => (f.id === action.parentId && f.collapsed ? { ...f, collapsed: false } : f))
      return { ...state, folders }
    }
    case 'folder/toggle':
      return { ...state, folders: state.folders.map((f) => (f.id === action.id ? { ...f, collapsed: !f.collapsed } : f)) }
    case 'folder/delete': {
      const folder = state.folders.find((f) => f.id === action.id)
      if (!folder) return state
      // What was inside (tabs and folders) moves up to the parent folder, or to the root of the pinned list.
      return {
        ...state,
        folders: state.folders
          .filter((f) => f.id !== folder.id)
          .map((f) => {
            if (f.parentId !== folder.id) return f
            const { parentId: _old, ...rest } = f
            // Folders that come up to the root stay on the side of the list their parent was on.
            return folder.parentId ? { ...rest, parentId: folder.parentId } : withSide(rest, sideOfFolder(folder))
          }),
        tabs: state.tabs.map((t) => (t.folderId === folder.id ? { ...t, folderId: folder.parentId } : t))
      }
    }
    case 'space/update': {
      // The fields below are each checked like the one `space/create` takes: the patch comes from the interface and is never copied whole. A profile id names
      // a storage partition: one that is not a plain id changes nothing at all, whatever else the patch says.
      const raw = isRecord(action.patch) ? action.patch : {}
      if (raw['profileId'] !== undefined && !isProfileId(raw['profileId'])) return state
      const patch: Partial<Pick<Space, 'name' | 'emoji' | 'profileId' | 'iconLetter' | 'iconColor' | 'iconRound' | 'background'>> = {}
      const name = printable(raw['name'], NAME_MAX)
      if (name !== null && name.trim()) patch.name = name
      // One emoji, one letter, one digit, or nothing: anything else leaves the space the mark it has.
      if (isSpaceMark(raw['emoji'])) patch.emoji = spaceEmojiOr(raw['emoji'], '✨')
      if (raw['profileId'] !== undefined) patch.profileId = raw['profileId'] as string
      const letters = cleanIconLetter(raw['iconLetter'])
      if (letters !== null) patch.iconLetter = letters
      const color = cleanIconColor(raw['iconColor'])
      if (color !== null) patch.iconColor = color
      if (typeof raw['iconRound'] === 'boolean') patch.iconRound = raw['iconRound']
      if ('background' in raw) {
        if (raw['background'] === undefined || raw['background'] === null) patch.background = undefined
        else {
          const background = cleanSpaceBackground(raw['background'])
          if (background) patch.background = background
        }
      }
      const theme = isRecord(raw['theme']) ? (raw['theme'] as Partial<SpaceTheme>) : undefined
      return {
        ...state,
        spaces: state.spaces.map((sp) => {
          if (sp.id !== action.id) return sp
          const merged: Space = { ...sp, ...patch, theme: theme ? cleanTheme({ ...sp.theme, ...theme }, sp.theme) : sp.theme }
          // The kind asked for is taken only if the space has what it shows: letters for the letter, one of our files for the picture.
          const kind = raw['iconKind']
          const usable = isSpaceIconKind(kind) && (kind === 'emoji' || (kind === 'letter' && merged.iconLetter !== undefined) || (kind === 'image' && merged.image !== undefined))
          return usable ? { ...merged, iconKind: kind } : merged
        })
      }
    }
    case 'space/background-position': {
      // The numbers come from the interface (a drag): `withBackgroundPosition` keeps them between 0 and 100 and refuses anything that is not a number.
      const space = state.spaces.find((sp) => sp.id === action.id)
      if (!space?.background || space.background.type !== 'video') return state
      const background = withBackgroundPosition(space.background, action.x, action.y)
      return background === space.background ? state : { ...state, spaces: state.spaces.map((sp) => (sp.id === action.id ? { ...sp, background } : sp)) }
    }
    case 'space/apply-themes': {
      // The entries come from the interface: anything but a list of { id, theme } is ignored, and each theme is repaired like any saved one.
      const entries = Array.isArray(action.entries) ? action.entries.slice(0, MAX_THEME_ENTRIES) : []
      const themes = new Map<string, Partial<SpaceTheme>>()
      for (const entry of entries) if (isRecord(entry) && typeof entry['id'] === 'string' && isRecord(entry['theme']) && !themes.has(entry['id'])) themes.set(entry['id'], entry['theme'] as Partial<SpaceTheme>)
      if (!state.spaces.some((sp) => themes.has(sp.id))) return state
      return { ...state, spaces: state.spaces.map((sp) => (themes.has(sp.id) ? { ...sp, theme: cleanTheme({ ...sp.theme, ...themes.get(sp.id) }, sp.theme) } : sp)) }
    }
    case 'space/header':
      return {
        ...state,
        spaces: state.spaces.map((sp) => {
          if (sp.id !== action.id) return sp
          const { hideHeader: _old, ...rest } = sp
          return action.visible ? rest : { ...rest, hideHeader: true }
        })
      }
    case 'space/image': {
      const space = state.spaces.find((sp) => sp.id === action.id)
      if (!space) return state
      if (action.image === null) {
        if (space.image === undefined) return state
        const { image: _gone, ...rest } = space
        // Without its picture a space that wore it shows its emoji again.
        const kept: Space = rest.iconKind === 'image' ? { ...rest, iconKind: 'emoji' } : rest
        return { ...state, spaces: state.spaces.map((sp) => (sp.id === space.id ? kept : sp)) }
      }
      if (!isSpaceImageName(action.image) || (space.image === action.image && space.iconKind === 'image')) return state
      return { ...state, spaces: state.spaces.map((sp) => (sp.id === space.id ? { ...sp, image: action.image as string, iconKind: 'image' } : sp)) }
    }
    case 'space/panel-add': {
      const space = state.spaces.find((sp) => sp.id === action.id)
      // A panel id names one panel (opening and removing go by it): one the space already has is refused.
      // The list of panels is saved with the space: the page of a private tab is not put in it.
      if (onlyPrivateTabsOn(state, (url) => url === action.url)) return state
      if (!space || !state.settings.webPanels || typeof action.panelId !== 'string' || action.panelId === '' || action.panelId.length > 256 || space.webPanels?.some((p) => p.id === action.panelId)) return state
      const next = withWebPanel(space, { id: action.panelId, url: action.url, title: action.title })
      return next === space ? state : { ...state, spaces: state.spaces.map((sp) => (sp.id === space.id ? next : sp)) }
    }
    case 'space/panel-remove': {
      const space = state.spaces.find((sp) => sp.id === action.id)
      if (!space) return state
      const next = withoutWebPanel(space, action.panelId)
      return next === space ? state : { ...state, spaces: state.spaces.map((sp) => (sp.id === space.id ? next : sp)) }
    }
    case 'space/move': {
      const from = state.spaces.findIndex((sp) => sp.id === action.id)
      // An index that is not a number would put the space first (splice of NaN): refused.
      if (from === -1 || !Number.isFinite(action.toIndex)) return state
      const spaces = [...state.spaces]
      const [moved] = spaces.splice(from, 1)
      spaces.splice(Math.max(0, Math.min(action.toIndex, spaces.length)), 0, moved!)
      return { ...state, spaces }
    }
    case 'folder/rename': {
      // A blank name keeps the old one.
      const name = typedName(action.name, NAME_MAX, '')
      const folder = state.folders.find((f) => f.id === action.id)
      if (!folder || !name || folder.name === name) return state
      return { ...state, folders: state.folders.map((f) => (f.id === folder.id ? { ...f, name } : f)) }
    }
    case 'space/aside': {
      // A window needs a space to show, and a session is the user's own work: past the limit nothing is pushed out, and a space too big to keep whole stays.
      if (asideRefusal(state, action.id) !== null) return state
      const space = state.spaces.find((s) => s.id === action.id)!
      // The session is saved with the state: the private tabs of the space are closed with it, not kept in it.
      // Nor does the session name a window: the keys of the windows last as long as the windows do.
      const publicTabs = withoutWindowKeys({ ...state, tabs: state.tabs.filter((t) => t.private !== true) })
      const aside = asideOf(publicTabs, space.id)
      if (!aside) return state
      const session: Session = { id: ctx.newId(), name: cleanSessionName(space.name) || t('state-clean.espace'), createdAt: ctx.now, tabs: sessionTabsOf(sidebarOrder(publicTabs, space.id), state.folders), space: aside }
      const { [space.id]: _gone, ...activeTabBySpace } = state.activeTabBySpace
      const spaces = state.spaces.filter((s) => s.id !== space.id)
      const at = state.spaces.indexOf(space)
      // The space on screen is replaced by its neighbour: the next one, else the previous.
      const shown = state.activeSpaceId === space.id ? (state.spaces[at + 1] ?? state.spaces[at - 1])!.id : state.activeSpaceId
      return normalize({
        ...state,
        spaces,
        tabs: state.tabs.filter((t) => t.spaceId !== space.id),
        folders: state.folders.filter((f) => f.spaceId !== space.id),
        archive: state.archive.filter((a) => a.spaceId !== space.id),
        splits: state.splits.filter((sp) => sp.spaceId !== space.id),
        activeSpaceId: shown,
        activeTabBySpace,
        sessions: [session, ...state.sessions]
      })
    }
    case 'space/reopen': {
      const session = state.sessions.find((s) => s.id === action.id)
      if (!session?.space) return state
      return normalize({ ...reopenAside(state, session.space, ctx), sessions: state.sessions.filter((s) => s.id !== session.id) })
    }
    case 'space/import':
      return normalize(reopenAside(state, { ...action.aside, index: state.spaces.length }, ctx))
    case 'backup/restore': {
      // Only the parts a copy holds: everything else of the state is what it is now. A copy with no usable space is refused, not replaced by an empty browser.
      const { spaces, tabs, folders, activeSpaceId, activeTabBySpace, splits, archive } = action.copy
      const restored = restoredState({ ...state, spaces, tabs, folders, activeSpaceId, activeTabBySpace, splits, archive })
      if (!restored) return state
      return restored
    }
    case 'state/restore': {
      const read = restoredState(action.state)
      if (!read) return state
      // Nor does it open the developer tools' own pages: an entry that points at one is not restored.
      const restored = normalize(withoutDevtoolsEntries(read))
      // A file that comes from elsewhere decides neither which extensions are loaded at launch, nor which programs Lucium starts,
      // nor where it fetches updates from (nor from which channel), nor whether the Chrome Web Store may install or update anything: those stay what they are
      // on this installation.
      // The applications a downloaded file is opened with are this installation's too: a file from elsewhere cannot name a program.
      const { extensionPaths, chromeNativeHosts, updateFeedUrl, updateChannel, webStoreInstall, webStoreUpdates, openWithApps } = state.settings
      // Nor does it say where files are written without a question (the download folder of each profile, the folder of the translation models), nor
      // which server the traffic or the names of the sites go through (the proxy, of the browser and of each profile; the DNS): the interface itself
      // may only name a folder the person picked in the system's dialog, and a file gets no more than the interface.
      const { translateModelsDir, proxyEnabled, proxy, dohCustom, dohMode, dohProvider, dohCustomUrl } = state.settings
      const profiles = Object.fromEntries(
        [...new Set([...Object.keys(restored.settings.profiles), ...Object.keys(state.settings.profiles)])].flatMap((id) => {
          const { downloadDir: _folder, proxy: _proxy, ...fromFile } = restored.settings.profiles[id] ?? {}
          const here = state.settings.profiles[id]
          const own = { ...fromFile, ...(here?.downloadDir !== undefined ? { downloadDir: here.downloadDir } : {}), ...(here?.proxy !== undefined ? { proxy: here.proxy } : {}) }
          return Object.keys(own).length > 0 ? [[id, own]] : []
        })
      )
      // Nor does it grant a site the camera, the microphone or anything else a prompt asks for: its refusals are kept, its « allow » only where this
      // installation had answered the same. The containers have answers of their own, read the same way.
      const sitePermissions = withoutForeignGrants(restored.sitePermissions, state.sitePermissions)
      const containers = restored.settings.containers.map((container) => {
        const { permissions, ...rest } = container
        const kept = withoutForeignGrants(permissions ?? {}, state.settings.containers.find((c) => c.id === container.id)?.permissions ?? {})
        return Object.keys(kept).length > 0 ? { ...rest, permissions: kept } : rest
      })
      // Nor does it free the ids of the profiles deleted here whose folders are still on disk (profile-retire.ts): it may only add some.
      const retiredProfileIds = cleanRetiredProfiles([...state.settings.retiredProfileIds, ...restored.settings.retiredProfileIds])
      // Nor does it switch this installation's lock on or off, or change which of its spaces are locked.
      const lock = Object.fromEntries(LOCK_SETTING_KEYS.map((key) => [key, state.settings[key]]))
      const network = { translateModelsDir, proxyEnabled, proxy, dohCustom, dohMode, dohProvider, dohCustomUrl, profiles, containers }
      // Nor does it decide what Lucium does on its own: reading pages again on a timer, taking addresses from other applications, looking for updates.
      // The pages to watch are the file's only while watching is off here: they then wait for the person to turn it on.
      const { pageWatch, urlAutomation, autoUpdate } = state.settings
      const pageWatches = pageWatch ? state.settings.pageWatches : restored.settings.pageWatches
      const unattended = { pageWatch, pageWatches, urlAutomation, autoUpdate }
      const kept = { ...restored.settings, ...unattended, extensionPaths, chromeNativeHosts, updateFeedUrl, updateChannel, webStoreInstall, webStoreUpdates, openWithApps, retiredProfileIds, ...network, ...lock }
      // Nor does it run its scripts: as with boost/import, a Tweak that carries JavaScript comes back with the script waiting for the person to turn it on.
      // Nor does it fetch anything through its styles: a Tweak whose CSS would be refused to a shared Tweak (an address to load, a selector that
      // reads what is typed) comes back switched off, its text kept, for the person to read and turn on.
      const boosts = restored.boosts.map((b) => ({ ...b, ...(b.js.trim() !== '' ? { jsEnabled: false } : {}), ...(scanBoostCss(b.css).ok ? {} : { enabled: false }) }))
      return { ...restored, boosts, sitePermissions, settings: { ...kept, lockedSpaces: cleanLockedSpaces(kept.lockedSpaces, new Set(restored.spaces.map((s) => s.id))) } }
    }
    case 'import/merge': {
      /** The incoming entries whose id is neither known nor already taken by an earlier incoming one. */
      const fresh = <T extends { id: string }>(known: readonly T[], incoming: readonly T[] | undefined): T[] => {
        const ids = new Set(known.map((entry) => entry.id))
        const out: T[] = []
        for (const entry of incoming ?? []) {
          if (ids.has(entry.id)) continue
          ids.add(entry.id)
          out.push(entry)
        }
        return out
      }
      const spaces = fresh(state.spaces, action.spaces)
      const merged: SidebarState = {
        ...state,
        spaces: [...state.spaces, ...spaces],
        tabs: [...state.tabs, ...fresh(state.tabs, action.tabs)],
        folders: [...state.folders, ...fresh(state.folders, action.folders)],
        // Each lands in a profile, once per address in it (importedFavorites: the same rule the importers use to know what to take back).
        favorites: [...state.favorites, ...importedFavorites(state, action.favorites, spaces)],
        splits: [...state.splits, ...fresh(state.splits, action.splits)],
        boosts: [...state.boosts, ...fresh(state.boosts, action.boosts)],
        activeTabBySpace: {
          ...state.activeTabBySpace,
          // Only the spaces this merge adds: a space that was already there keeps the tab it shows.
          ...Object.fromEntries(spaces.map((s) => [s.id, null]))
        }
      }
      return normalize(merged)
    }
    case 'import/revert': {
      const spaces = new Set(action.spaces)
      const tabs = new Set(action.tabs)
      const folders = new Set(action.folders)
      const favorites = new Set(action.favorites)
      const splits = new Set(action.splits)
      const boosts = new Set(action.boosts)
      const next: SidebarState = {
        ...state,
        spaces: state.spaces.filter((s) => !spaces.has(s.id)),
        tabs: state.tabs.filter((t) => !tabs.has(t.id) && !spaces.has(t.spaceId)),
        folders: state.folders.filter((f) => !folders.has(f.id) && !spaces.has(f.spaceId)),
        favorites: state.favorites.filter((f) => !favorites.has(f.id)),
        splits: state.splits.filter((v) => !splits.has(v.id) && !spaces.has(v.spaceId)),
        boosts: state.boosts.filter((b) => !boosts.has(b.id))
      }
      const unchanged = next.spaces.length === state.spaces.length && next.tabs.length === state.tabs.length && next.folders.length === state.folders.length && next.favorites.length === state.favorites.length && next.splits.length === state.splits.length && next.boosts.length === state.boosts.length
      // `normalize` cuts what pointed at the entries that left: the shown space and tab, the archive of a space, a lock, a split view that lost a pane.
      return unchanged ? state : normalize(next)
    }
    default:
      return undefined
  }
}
