// The actions of the sidebar reducer (shared/sidebar.ts) and the context it runs in. Types only: every reader of an action imports them from
// `@shared/sidebar`, which re-exports them.

import type { ArchiveSource, ClosedHistory, Favorite, Boost, BoostInput, BlockMode, Folder, PermissionDecision, Settings, SplitArrangement, SplitGrid, SplitOrientation, SplitView, SidebarState, Space, TabItem, WorkView, WorkViewTarget } from './model'
import type { JoinZone } from './split-grid'
import type { SyncPatch } from './sidebar-sync'
import type { SharedBoost } from './boost-share'
import type { SessionTarget } from './sessions'
import type { SessionCopyData } from './session-backups'
import type { LiveItem, LiveSource } from './live-folders'
import type { FolderSide } from './folders'
import type { ImportedBookmark } from './bookmarks'
import type { SpaceTheme } from './theme'
import type { AutoplayMode } from './autoplay'
import type { ReadableMode } from './readable-mode'
import type { CustomFilterList } from './custom-filter-lists'
import type { IconFill } from './favicon'
import type { ScreenInfo } from './panel-scale'

export interface Ctx {
  now: number
  newId: () => string
  /**
   * The pages a tab went through, for the tab that is being archived (only the main process knows them, and only when the setting
   * `reopenHistory` is on). Absent in every other caller: an archive entry then keeps its address alone.
   */
  closedHistory?: (tabId: string) => ClosedHistory | undefined
}

/** A site of a work view as the sheet sends it: the address, and what to call it until its page has loaded. */
export interface WorkViewPaneInput {
  url: string
  title?: string
  faviconUrl?: string
}

/** A work view as the sheet makes it (`view/create`): read again like a file's (work-views.ts); its profile is the one of the space it is made from. */
export interface WorkViewInput {
  name?: string
  emoji?: string
  panes: WorkViewPaneInput[]
  orientation?: SplitOrientation
  ratios?: number[]
  grid?: SplitGrid
  target?: WorkViewTarget
}

/** What the sheet « Modifier la vue de travail » changes; a field left out stays as it is, `grid` and `target` null take them away. */
export interface WorkViewPatch {
  name?: string
  emoji?: string
  panes?: WorkViewPaneInput[]
  orientation?: SplitOrientation
  ratios?: number[]
  grid?: SplitGrid | null
  target?: WorkViewTarget | null
}

export type Action =
  /**
   * One complete creation (the space sheet). `theme` refines the colours that `hue` gives. `profileName` creates a profile
   * with that name for the space and wins over `profileId`; a name already taken or a malformed id creates nothing.
   * `letterIcon` makes the coloured letters the space's icon (the emoji stays as the second choice); letters that are not letters are ignored.
   */
  | { type: 'space/create'; name: string; emoji: string; hue: number; profileId?: string; theme?: Partial<SpaceTheme>; profileName?: string; letterIcon?: { letter: string; color?: string; round?: boolean } }
  | { type: 'space/select'; id: string }
  | { type: 'space/delete'; id: string }
  | { type: 'space/update'; id: string; patch: Partial<Pick<Space, 'name' | 'emoji' | 'profileId' | 'iconKind' | 'iconLetter' | 'iconColor' | 'iconRound' | 'background'>> & { theme?: Partial<SpaceTheme> } }
  /**
   * The framing of the video behind a space: the point of the video, in percent of its width (`x`) and height (`y`), that sits at the same point of the
   * sidebar (the frame of the Fond panel, dragged or moved with the arrows). Values are kept between 0 and 100; the centre (50, 50) removes the position.
   * A space without a video background, or a value that is not a number, changes nothing.
   */
  | { type: 'space/background-position'; id: string; x: number; y: number }
  /** Sets the theme of several spaces at once ("apply to all spaces", and its undo). A space not listed keeps its own; an unknown id is skipped. */
  | { type: 'space/apply-themes'; entries: Array<{ id: string; theme: Partial<SpaceTheme> }> }
  | { type: 'space/move'; id: string; toIndex: number }
  | { type: 'space/header'; id: string; visible: boolean }
  /**
   * The picture of a space (a file of the pictures folder, by its name), or none (`null`: the emoji again). Setting one is the main process' alone (it is
   * the one that makes the file) and makes the picture the space's icon; removing one is always allowed.
   */
  | { type: 'space/image'; id: string; image: string | null }
  /** A site added at the end of a space's web panels. Needs the setting "webPanels"; a site that is not a web page, is already there or past the limit changes nothing. */
  | { type: 'space/panel-add'; id: string; panelId: string; url: string; title?: string }
  | { type: 'space/panel-remove'; id: string; panelId: string }
  | {
      type: 'tab/open'
      url: string
      spaceId?: string
      background?: boolean
      /** Set when an extension opens one of its own pages (chrome.tabs.create, chrome.runtime.openOptionsPage). */
      allowExtensionPages?: boolean
      /**
       * Set by the shell alone, to open the Extensions page (`lucium-ui://extensions/`, internal-page.ts): without it that address is not one a tab can hold. Refused
       * for a private tab and for a container, whatever the action says; the interface can never send it (ipc-policy.ts).
       */
      allowInternalPages?: boolean
      /** A private tab of this window (setting `privateTabs`): refused when the setting is off, never kept anywhere (see `persistableState`). */
      private?: boolean
      /**
       * The container to open the tab in: refused when it does not exist. Absent: the rule of the site, if it has one (and the setting `tabContainers` is on). `null`: no container, whatever the rules say (an extension's tab, which belongs to its profile's session).
       */
      container?: string | null
      /** The tab a link was clicked in: Back on the new tab's first page returns there (see `tab/back-to-origin`). An id that is not a tab is ignored. */
      openerId?: string
      /** With the setting `tabTree`: the tab the new one hangs under in the sidebar (last child, after the rest of the branch). Ignored when it cannot be a parent. */
      parentId?: string
    }
  /** The tab goes to a container (its page is made again in the container's session), or leaves it (`null`: the profile's session again). */
  | { type: 'tab/set-container'; id: string; container: string | null }
  /** A container, with a name nobody else has and one of the colours of containers.ts. Needs the setting `tabContainers`. */
  | { type: 'container/create'; name: string; color?: string }
  | { type: 'container/update'; id: string; patch: { name?: string; color?: string } }
  /** The container goes with its rules, the tabs it holds (closed without a trace in the archive) and what remembers their pages. The main process erases its data. */
  | { type: 'container/delete'; id: string }
  /** The site (host and subdomains) always opens in this container, or no longer does (`container` null). Needs the setting `tabContainers`. */
  | { type: 'container/rule'; host: string; container: string | null }
  /** An answer to a permission prompt remembered for an origin in this container (`decision` null forgets it). */
  | { type: 'container/permission'; id: string; origin: string; permission: string; decision: PermissionDecision | null }
  /** The tab was navigated: it no longer returns to the tab it was opened from. */
  | { type: 'tab/forget-origin'; id: string }
  /**
   * Back on the first page of a tab opened from a link: the tab is closed (archived, as ⌘W does, so the toast can bring it back) and
   * the tab it was opened from is shown. Nothing happens to a tab with no origin.
   */
  | { type: 'tab/back-to-origin'; id: string }
  | { type: 'tab/select'; id: string }
  | { type: 'tab/close'; id: string }
  | { type: 'tab/pin'; id: string }
  | { type: 'tab/unpin'; id: string }
  /**
   * `parentId` is the tab the moved tab hangs under (null: none), with the setting `tabTree` and for a Today destination; `undefined` also means none.
   * The tab brings the tabs below it along. A parent that is itself in the moved branch, or cannot be one, refuses the move.
   */
  | { type: 'tab/move'; id: string; toIndex: number; pinned: boolean; folderId?: string; parentId?: string | null }
  /** Moves several tabs as one block (they keep the order of `ids`) to `toIndex` of the group, counted without them. */
  | { type: 'tabs/move'; ids: string[]; toIndex: number; pinned: boolean; folderId?: string; parentId?: string | null }
  /** Folds the branch of a tab away, or opens it again (`collapsed` undefined: the other one). Needs the setting `tabTree` and a tab that has children. */
  | { type: 'tab/tree-collapse'; id: string; collapsed?: boolean }
  /** The tab leaves its parent: it becomes a sibling of it, just below the parent's branch (what is below the tab goes with it). */
  | { type: 'tab/tree-detach'; id: string }
  /** Mode compact: both bars away, or both back when the window already is compact. Needs the setting `compactMode`; changes nothing without it. */
  | { type: 'compact/toggle' }
  /** `allowInternalPages`: the engine saw the Extensions page commit in this tab (main process only, see `cleanTabUpdate`). */
  | { type: 'tab/update'; id: string; patch: Partial<Pick<TabItem, 'url' | 'title' | 'faviconUrl'>>; allowInternalPages?: boolean }
  /** An empty name gives the page's own title back. */
  | { type: 'tab/rename'; id: string; title: string }
  /** An empty icon gives the favicon back. */
  | { type: 'tab/icon'; id: string; icon: string }
  /** The picture of a tab (a stored copy's name, made by the main process from a file the user picked), or null to take it away. */
  | { type: 'tab/image'; id: string; image: string | null }
  | { type: 'tab/move-to-space'; id: string; spaceId: string }
  | { type: 'tab/duplicate'; id: string }
  | { type: 'tab/close-others'; id: string }
  | { type: 'tab/archive'; id: string }
  /** Takes a pinned tab out of the pinned ones, to the archive (where it can be brought back as a tab of the day). */
  | { type: 'tab/remove-pinned'; id: string }
  | { type: 'tab/archive-group'; id: string; scope: 'above' | 'below' | 'others' }
  /**
   * Archives the Today tabs among `ids` (a pinned tab is only ever put to sleep). `pinned`: the pinned ones among `ids` go too, out of the pinned tabs
   * to the archive, which brings them back pinned (the sheet « Sites qui ne répondent plus »): one archive, so one « Annuler » brings them all back.
   */
  | { type: 'tabs/archive-many'; ids: string[]; pinned?: true }
  /** « Tout garder » of the tabs whose site no longer answers: each of `ids` is marked kept for the address it has now (shared/dead-tabs.ts). */
  | { type: 'tabs/keep-dead'; ids: string[] }
  | { type: 'tab/separate'; id: string }
  | { type: 'tab/back-to-anchor'; id: string }
  | { type: 'tab/replace-anchor'; id: string }
  /** "Never put this tab to sleep" (`keep`), or the delay's rules again. */
  | { type: 'tab/keep-awake'; id: string; keep: boolean }
  /** The tab reloads its page every `seconds` (5 s to 24 h), or no longer does (`null`). */
  | { type: 'tab/auto-reload'; id: string; seconds: number | null }
  /** A site (its host and subdomains) the delay never puts to sleep, or no longer leaves alone. */
  | { type: 'sleep/exclude-site'; site: string; excluded: boolean }
  /**
   * A site (its host and subdomains) where ads and trackers are no longer blocked (`exempt`), or blocked again. This choice and the next two (autoplay,
   * erasing at close) take the `tabId` it is made from (the panel of a page, the menu of a tab): a private tab changes nothing, since the lists are kept on disk.
   */
  | { type: 'blocking/exempt-site'; site: string; exempt: boolean; tabId?: string }
  /** The blocking mode of a site (its host and subdomains): `standard` or `strict`, or `null` to follow the general mode again. Taken from the site panel's tab. */
  | { type: 'blocking/site-mode'; site: string; mode: BlockMode | null; tabId?: string }
  /** Autoplay for a site (its host and subdomains): `allow`, `block`, or `null` to follow the general choice again. */
  | { type: 'autoplay/site'; site: string; mode: AutoplayMode | null; tabId?: string }
  /** The readable mode of a site (its host and subdomains): `original`, `dark` or `light`, or `null` to follow the default again. Taken from the tab it is made from, as the three above. */
  | { type: 'readable/site'; site: string; mode: ReadableMode | null; tabId?: string }
  /** A site whose data is erased when its last tab closes (`on`), or no longer is. Refused in a private window (its session is thrown away anyway). */
  | { type: 'siteclear/site'; site: string; on: boolean; tabId?: string }
  /** JavaScript off (`off`) or on again for a site (its exact host): its pages load without running a script. Taken from the tab it is made from, as the ones above. */
  | { type: 'javascript/site'; site: string; off: boolean; tabId?: string }
  /** A custom filter list the main process has just installed (its rules are on disk). Never dispatched by the interface. */
  | { type: 'filterlist/add'; list: CustomFilterList }
  /** A custom filter list whose rules the main process has just deleted. Never dispatched by the interface. */
  | { type: 'filterlist/remove'; id: string }
  /** Switches a custom filter list on or off. */
  | { type: 'filterlist/enable'; id: string; enabled: boolean }
  /** The first page of a profile has been created: its storage is expected on disk from now on. */
  | { type: 'profile/used'; id: string }
  /** Spaces whose profile lost its data go back to the default profile. */
  | { type: 'profile/revert-missing'; ids: string[] }
  /** Developer Mode for a site (its host and subdomains), on or off (⌃D). */
  | { type: 'developer/site'; site: string; enabled: boolean }
  /** An extension runs in one profile (`enabled`), or is switched off there: the other profiles keep their own choice. */
  | { type: 'extension/set-enabled'; profileId: string; extensionId: string; enabled: boolean }
  /** An extension may capture the sound of a tab in one profile (`allowed`), or may not: off by default, and each profile keeps its own choice. */
  | { type: 'extension/set-tab-capture'; profileId: string; extensionId: string; allowed: boolean }
  /** `shownElsewhere`: the tabs the other windows show (selected in a space of theirs), spared as the ones on screen here; the main process fills it (Browser.dispatch). */
  | { type: 'today/clear'; spaceId?: string; shownElsewhere?: readonly string[] }
  | { type: 'archive/sweep'; shownElsewhere?: readonly string[] }
  | { type: 'archive/restore'; id: string }
  /** `count` tabs come back, in the order they were archived in; one by default. */
  | { type: 'archive/restore-last'; count?: number }
  /** `keepSpaces`: the spaces whose entries stay (the locked ones, whose archive is hidden); the main process fills it (Browser.dispatch). */
  | { type: 'archive/clear'; keepSpaces?: readonly string[] }
  /**
   * Forgets the pages the archived tabs of a profile's spaces went through (their Back lists, see closed-history.ts), or only the pages of `site`
   * (its subdomains too when asked); the tabs themselves stay in the archive. Sent by the main process when the history or a site is cleared.
   */
  | { type: 'archive/forget-pages'; profileId: string; site?: { host: string; subdomains: boolean } }
  | { type: 'archive/add'; url: string; title: string; spaceId?: string; source: ArchiveSource }
  /**
   * "Lire plus tard": keeps the page of a tab (address, title, icon, date) at the top of the read-later list and closes the tab. A page
   * already in the list is not added again (its tab closes all the same); a list that is full, or a page that is not a web page, changes
   * nothing and leaves the tab open. A pinned tab is saved but stays: closing it would only put it to sleep.
   */
  | { type: 'readlater/add'; tabId: string }
  /** Opens a saved page in a new tab of the current space. The page stays in the list (the Toolkit's list does not remove it either). */
  | { type: 'readlater/open'; id: string }
  | { type: 'readlater/remove'; id: string }
  | { type: 'readlater/clear' }
  /** Creates a folder in the read-later list (with the setting `useReadLaterFolders` on, up to `READ_LATER_FOLDERS_LIMIT`). A blank name gives "Dossier". */
  | { type: 'readlater-folder/create'; name: string }
  | { type: 'readlater-folder/rename'; id: string; name: string }
  /** Removes the folder; its pages stay in the list, loose. */
  | { type: 'readlater-folder/delete'; id: string }
  | { type: 'readlater-folder/collapse'; id: string; collapsed: boolean }
  /**
   * Puts a page in a folder (`folderId` null: loose). `beforeId` places it before that page of the same folder; undefined: first of its
   * folder; null: last of it. Does nothing with the setting off.
   */
  | { type: 'readlater/move'; id: string; folderId: string | null; beforeId?: string | null }
  /**
   * The bookmark library (setting `bookmarkManager`; with it off every one of these changes nothing). "Ajouter aux signets" keeps the page of a
   * tab, which stays open; a page already there, a full library, a private tab or a page that is not a web page changes nothing.
   */
  | { type: 'bookmark/add'; tabId: string; tags?: string[] }
  /** Opens a bookmark in a new tab of the current space. */
  | { type: 'bookmark/open'; id: string }
  /** Edits a bookmark: an empty title or an address that is not a web page (or that another bookmark has) is not taken; the tags are repaired. */
  | { type: 'bookmark/edit'; id: string; patch: { title?: string; url?: string; tags?: string[]; note?: string } }
  | { type: 'bookmark/remove'; id: string }
  /** The tag `from` becomes `to` on every bookmark (merged into it where a bookmark has both). */
  | { type: 'bookmark/tag-rename'; from: string; to: string }
  /** The tag is taken off every bookmark (the bookmarks stay). */
  | { type: 'bookmark/tag-delete'; tag: string }
  /** What an import of a bookmarks file found, added to the library (main process only: it reads the file). Each entry is checked again here. */
  | { type: 'bookmarks/import'; entries: ImportedBookmark[] }
  /**
   * Live folders (setting `liveFolders`; with it off every one of these changes nothing). A new folder that fills itself from `source` (a feed or
   * a public repository, checked again here) at most `LIVE_FOLDERS_MAX` times; a blank name takes the name of the source. It then falls due at once.
   */
  | { type: 'livefolder/create'; source: LiveSource; name?: string; spaceId?: string; parentId?: string }
  /** Another source (its items are dropped and the folder falls due at once) and/or another name for a live folder. */
  | { type: 'livefolder/edit'; id: string; source?: LiveSource; name?: string }
  /** The folder (all of them without `id`) falls due now: the next look of the single timer reads it. */
  | { type: 'livefolder/refresh'; id?: string }
  /**
   * What a look found, from the scheduler of the main process only (never the interface). It counts only for the source that was looked at: a
   * folder whose source was changed meanwhile, or deleted, ignores the answer.
   */
  | { type: 'livefolder/result'; id: string; source: LiveSource; items?: LiveItem[]; failure?: string }
  /** A folder inside `parentId` when given (it must exist in the space and leave room for one more level). */
  | { type: 'folder/create'; name: string; spaceId?: string; parentId?: string }
  /** A new folder holding these tabs, which are pinned to be in it (New Folder with…). */
  | { type: 'folder/create-with'; tabIds: string[]; name?: string }
  /**
   * "Ranger les onglets…", once the person has validated the proposal (tab-grouping.ts): each group becomes a folder of that name holding the group's tabs, pinned to
   * be in it. A folder of the space that has the name already takes them instead of a second one being made, and two groups of one name go to one folder. The new
   * folders stand under the loose Today tabs with `atBottom`. Only the tabs `tidyCandidates` lists for `spaceId` (the space on screen by default) move: nothing
   * pinned, in a folder, private, in a split view or in the tab tree, whatever the groups say.
   */
  | { type: 'tabs/tidy'; groups: Array<{ name: string; tabIds: string[] }>; spaceId?: string; atBottom?: boolean }
  /**
   * The "Annuler" of the notice that follows (main process only, see `tidyOutcome`): the tabs listed leave the folder they were put in and take their place among the
   * Today tabs again (`index` is the one they had, `openerId` the tab they were opened from, which a pin forgets), and the folders that were made go, unless
   * something was put in them since. What is no longer as `tabs/tidy` left it (a tab closed, moved to another folder) is left alone.
   */
  | { type: 'tabs/untidy'; tabs: Array<{ id: string; folderId: string; index: number; openerId?: string }>; folderIds: string[] }
  /**
   * A folder at the root of the list goes under the loose Today tabs (`bottom`) or back above them (the pinned list, above the Today header), at the very end of
   * that side (the first folder of the top). A folder inside another has no side, and one that already is on the side asked changes nothing.
   */
  | { type: 'folder/bottom'; id: string; bottom: boolean }
  /** Marks (or unmarks) a folder whose tabs are never woken by themselves (`Folder.noWake`). */
  | { type: 'folder/no-wake'; id: string; on: boolean }
  /** Puts one emoji on a folder, in place of the folder drawing of its row (`Folder.icon`); `null` takes it away. Anything that is not one emoji changes nothing. */
  | { type: 'folder/icon'; id: string; icon: string | null }
  /** Archives the tabs of the folder and of the folders inside it, then removes them all. */
  | { type: 'folder/archive'; id: string }
  | { type: 'folder/toggle'; id: string }
  | { type: 'folder/collapse-all'; spaceId?: string }
  | { type: 'tabs/reset-pinned'; spaceId?: string }
  | { type: 'folder/delete'; id: string }
  | { type: 'folder/duplicate'; id: string }
  | { type: 'folder/rename'; id: string; name: string }
  /**
   * Turn "<folder>" into Space. The folder goes; its tabs and the folders inside it become the pinned list of a new space (same
   * profile and colours), which is then shown. The page on screen stays on screen when it was one of them.
   */
  | { type: 'folder/to-space'; id: string }
  /**
   * Moves a folder, with what it holds, under another folder (`parentId` null: the root) at `toIndex` among that folder's own folders, counted without it. At the
   * root, `side` says where in the list it lands (`FolderSide`: above the Today header, at the start of Today, under its tabs; absent: the side it had); inside
   * another folder it has none. The places of two folders on the same side are their places among the root folders: `toIndex` counts the ones of the other sides too.
   */
  | { type: 'folder/move'; id: string; parentId: string | null; toIndex: number; side?: FolderSide }
  /**
   * `tabId` and `withTabId` side by side (or stacked, `orientation`), in that order; `tabId` is the tab shown unless `focus` says the second. Joining
   * a split view that exists puts the new tab where `zone` says (split-grid.ts `joined`: an end of its row or column, a side, a corner that makes a grid),
   * by default at the end of its row or column, or in the free half of the long pane of a grid of three.
   */
  | { type: 'split/create'; tabId: string; withTabId: string; orientation?: SplitOrientation; focus?: 'first' | 'second'; zone?: JoinZone }
  | { type: 'split/remove'; tabId: string }
  /** The panes in a row or a column: a grid becomes that row or column again. */
  | { type: 'split/orientation'; id: string; orientation: SplitOrientation }
  /** « Disposition » in the menu of a split view: a row, a column, or a grid (three or four panes); the panes keep their order. */
  | { type: 'split/layout'; id: string; layout: SplitArrangement }
  /** The shares of the two dividers of a grid: its left column's width and its top row's height. */
  | { type: 'split/grid'; id: string; column: number; row: number }
  /** Moves a pane one place earlier (-1) or later (1) in its split view; the panes keep their sizes. */
  | { type: 'split/move'; tabId: string; direction: -1 | 1 }
  | { type: 'split/ratios'; id: string; ratios: number[] }
  /**
   * Puts a split view back as it was, after a pane left it (the "Annuler" of the notice "Volet fermé"): the same panes in the same order with the
   * same shares. Refused when a pane is gone, changed space, or is in another split view meanwhile; what is left of the split view is replaced.
   */
  | { type: 'split/restore'; split: SplitView }
  /**
   * The work views (setting `workViewsEnabled`; with it off every one of these changes nothing, see sidebar-work-views.ts). « Enregistrer comme vue de
   * travail… » in the menu of a split view: the split view `splitId` becomes a view of the profile of its space, named `name` (blank: « Vue de travail »),
   * and is marked as the view's. Refused past `WORK_VIEWS_MAX`, and when a pane holds a page a view cannot open again.
   */
  | {
      type: 'view/save'
      splitId: string
      name?: string
      emoji?: string
      /** What the whole sheet changed before « Enregistrer » (« Plus de réglages… »): the split view is marked as the view's only while its sites are still the view's. */
      patch?: WorkViewPatch
    }
  /** « Nouvelle vue de travail… » with no split view on screen: the view the sheet made, for the profile of `spaceId` (the space on screen when omitted). */
  | { type: 'view/create'; view: WorkViewInput; spaceId?: string }
  /** The sheet « Modifier la vue de travail »: a site that cannot be opened, fewer than two or more than four refuse the whole patch. */
  | { type: 'view/edit'; id: string; patch: WorkViewPatch }
  /**
   * A click on the tile: the view opens in the space it is always opened in, else in `spaceId` (the space shown in the window that asks; the space on screen
   * when omitted). When it already has a split view open there, that split view comes back as it was left and nothing opens twice.
   */
  | { type: 'view/open'; id: string; spaceId?: string; /** The window that asks opens it itself, whatever its place says: the window opened for a view « Dans une nouvelle fenêtre ». */ here?: true }
  /** « Enregistrer ce qui est affiché »: the view takes the sites and the layout of its split view open in `spaceId`, as they are on screen. */
  | { type: 'view/capture'; id: string; spaceId?: string }
  /** « Revenir aux adresses enregistrées »: each pane of its split view open in `spaceId` goes back to its address, and the layout to the one kept. */
  | { type: 'view/reset'; id: string; spaceId?: string }
  /** Moves a view one place earlier (-1) or later (1) among the views of its profile. */
  | { type: 'view/move'; id: string; direction: -1 | 1 }
  /** « Retirer la vue de travail »: the tile goes; the tabs it opened stay, their split view an ordinary one. The notice offers « Annuler ». */
  | { type: 'view/remove'; id: string }
  /** The « Annuler » of a removal (main process only): the view comes back at `index` of the list, and the split views `splitIds` it had open are its again. */
  | { type: 'view/restore'; view: WorkView; index: number; splitIds: string[] }
  /** What a synchronisation session writes into the state (sidebar-sync.ts): sent by the main process only. */
  | { type: 'sync/apply'; patch: SyncPatch }
  /**
   * `draft`: the editor is still open on a site whose Tweaks run a script. The Tweak is stored like any other save, so that what was typed outlives
   * the window; only the reload of the pages that run the script waits for the save without `draft` the editor sends as it closes.
   * A save that carries no `zap` keeps the Eraser list that is stored: the editor leaves it out while it has not changed it.
   */
  | { type: 'boost/save'; boost: BoostInput; draft?: boolean }
  /**
   * Installs a Tweak that came from a file or a link (main process only, see ipc-policy.ts). The Tweak is read again here with the same
   * rules as the file reader, gets the id given (or a new one when it is taken), is switched on, and keeps its script switched off.
   */
  | { type: 'boost/import'; id: string; boost: SharedBoost }
  | { type: 'boost/delete'; id: string }
  | { type: 'commandbar/used'; key: string }
  /** Pages forgotten in the history of a profile leave its ranking of the command bar too (the main process sends it with the forgetting). */
  | { type: 'commandbar/forget'; profileId: string; urls: string[] }
  /** A forgotten page put back in the history comes back in the ranking with the count it had (the main process kept it aside, in memory). */
  | { type: 'commandbar/put-back'; profileId: string; url: string; count: number }
  | { type: 'sidepanel/behavior'; extensionId: string; openOnActionClick: boolean }
  | { type: 'permission/set'; origin: string; permission: string; decision: PermissionDecision | null }
  /**
   * Adds a favourite to the profile of `spaceId` (the space the user is in when omitted), at `toIndex` of that profile's favourites (the end when omitted).
   * An address the profile has already changes nothing; another profile may have it too.
   */
  | { type: 'favorite/add'; url: string; title: string; faviconUrl?: string; toIndex?: number; spaceId?: string }
  /** Puts a favourite at `toIndex` of its profile's favourites counted without it (drag and drop). */
  | { type: 'favorite/place'; id: string; toIndex: number }
  | { type: 'favorite/remove'; id: string }
  /**
   * Opens a favourite: its page is the tab of the space that no list shows (the tile stands for it), selected; a second click on the tile shows that
   * page again instead of making another. One page per favourite and space (a space may be another profile, with other cookies). A favourite is only
   * opened in a space of its own profile: another profile's favourite changes nothing.
   */
  | { type: 'favorite/open'; id: string; spaceId?: string }
  /** Moves a favourite one place earlier (-1) or later (1) among the favourites of its profile. */
  | { type: 'favorite/move'; id: string; direction: -1 | 1 }
  /**
   * Edits a favourite: its name (Rename…) and its address (Edit Pinned Page › Replace Pinned URL with Current). An empty name, an
   * address that cannot be navigated to, or one another favourite of the same profile already has, changes nothing.
   */
  | { type: 'favorite/edit'; id: string; patch: { title?: string; url?: string } }
  | { type: 'settings/update'; patch: Partial<Settings> }
  /**
   * The size of the panels and of the windows of their own on one screen (Settings › Apparence), in percent, or null for « Automatique ». A screen has
   * one entry, found by its key; the one given is rebuilt from its size, name and density (`readScreen`) so that a key that does not match them is refused.
   */
  | { type: 'panel-size/set'; screen: ScreenInfo; percent: number | null }
  /** The notice « Les panneaux vous semblent trop petits ? » was shown for this screen: it is not shown for it again. */
  | { type: 'panel-size/noticed'; screen: ScreenInfo }
  /**
   * Adds what an importer found. Importing the same thing again changes nothing: an entry whose id the state already holds is left as
   * the user has it (an importer that names things from the source's own ids relies on it), a favourite is kept once per address.
   */
  | { type: 'import/merge'; spaces: Space[]; tabs: TabItem[]; folders: Folder[]; favorites: Favorite[]; splits?: SplitView[]; boosts?: Boost[] }
  /**
   * Takes an import back (the sheet's "Annuler l'import"): the entries with these ids leave the state, a space with everything in it.
   * Only what the import brought is named, so what the user added since stays. Main process only; nothing goes to the archive.
   */
  | { type: 'import/revert'; spaces: string[]; tabs: string[]; folders: string[]; favorites: string[]; splits: string[]; boosts: string[] }
  /** Help › Restore Data: the whole state is replaced by a saved one (an export, or a backup of the state file), except the settings that load code or reach the network at launch (extensions, Chrome's native hosts, update feed). Ignored when it is not a usable state. */
  | { type: 'state/restore'; state: SidebarState }
  /**
   * File › Enregistrer la session…: the tabs of the current space (the ones in `tabIds` when given: a multiple selection) are saved
   * under `name`, or under a name made of the date when it is blank. Nothing is saved when there is no page to keep or 100 sessions already.
   */
  | { type: 'session/save'; name?: string; tabIds?: string[] }
  /** Opens the pages of a session as tabs of the current space (`target` "new-space": of a new space named after it). */
  | { type: 'session/restore'; id: string; target?: SessionTarget }
  /** A blank name keeps the old one. For a space put aside the space takes the new name too. */
  | { type: 'session/rename'; id: string; name: string }
  | { type: 'session/delete'; id: string }
  /**
   * Espaces › Mettre l’espace de côté… : the space and everything in it become a session named after it, and the space leaves the sidebar
   * (its pages are closed). Refused for the only space, past 100 sessions, and for a space of more than 1000 tabs: nothing is ever dropped.
   */
  | { type: 'space/aside'; id: string }
  /** Rouvrir: the space of the session `id` (a space put aside) comes back as it was and is shown; the session is spent. */
  | { type: 'space/reopen'; id: string }
  /**
   * A copy of the session (see session-backups.ts) replaces the spaces, tabs, folders, split views, archive and what is on screen; the
   * favourites, Tweaks, sessions and settings stay as they are. Main process only: it makes a copy of what it replaces first.
   */
  | { type: 'backup/restore'; copy: SessionCopyData }
  /**
   * Gives an icon to the favourites and tabs that have none (see favicon.ts): the answer of the site-icon resolver. An item that
   * already shows an icon keeps it (the page it loaded is the source of truth), and so does one whose address is no longer on the
   * `origin` the icon was looked up for. Main process only: a private window does not look anything up.
   */
  | { type: 'favicon/fill'; entries: IconFill[] }
