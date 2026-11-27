// The context menu of a tab of the sidebar (context-menus.ts, kind `tab`), and the menu of a multiple selection of tabs it gives way to when the
// click landed in one.

import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { reminderPresetItems } from './reminder-menu'
import type { MenuTarget } from '@shared/ipc'
import { isPlusAnchor } from '@shared/plus-menu'
import { effectiveAccelerator } from '@shared/keybindings'
import { tabName, type SidebarState, type TabItem } from '@shared/model'
import { isReadLaterUrl } from '@shared/read-later'
import { isBookmarkUrl } from '@shared/bookmarks'
import { groupLabels, groupSummary, markdownLinks } from '@shared/selection'
import { activeTab, sidebarOrder, splitFor } from '@shared/sidebar'
import { splitArrangement } from '@shared/split-grid'
import { spaceGlyph } from '@shared/space-icon'
import { favoritesOfSpace } from '@shared/favorite-scope'
import { tabStep } from '@shared/tab-step'
import { menuCloseAction } from '@shared/tab-close'
import { NEW_WINDOW } from '@shared/window-move'
import { branchOf, childrenOf } from '@shared/tab-tree'
import { clearHostOfUrl, isClearedOnClose } from '@shared/site-clear'
import { isSiteExcluded } from '@shared/sleep'
import { isUnreadOff } from '@shared/unread-sites'
import { autoplayHostOf } from '@shared/autoplay'
import { hostnameOf } from '@shared/url'
import { t } from '@shared/i18n'
import { workViewSaveRefusal } from '@shared/work-views'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { autoReloadMenuItem } from './auto-reload-menu'
import { containerMenuItems } from './container-menu'
import { block, entry, moveTabsToSpace, shareItem, template, writeClipboard, type Item, type MenuContext } from './context-menu-kit'
import { saveAsWorkView } from './context-menu-split'
import { stopLabel } from '@shared/tab-capture'

/** « Arrêter la capture du son » for a tab an extension captures the sound of; nothing for any other. */
export function captureMenuItems(capturedBy: string | undefined, stop: () => void): Item[] {
  return capturedBy === undefined ? [] : [entry('mute', { label: stopLabel(), click: stop })]
}

/** The entries of "Déplacer vers la fenêtre": one per other normal window (what it shows under its name), then a new window. */
function windowMoveItems(browser: Browser, tabId: string): Item[] {
  const send = (id: string) => () => void browser.sendTabToWindow(tabId, id)
  const windows = browser.windowMoveChoices().map((choice): Item => ({ label: choice.label, ...(choice.title !== undefined ? { sublabel: choice.title } : {}), click: send(choice.id) }))
  return [...windows, ...(windows.length > 0 ? ([{ type: 'separator' }] satisfies Item[]) : []), { label: t('menu.nouvelle-fenetre'), click: send(NEW_WINDOW) }]
}

/** The tabs a menu on `target` applies to when it was opened inside a multiple selection (two or more tabs of one space), in sidebar order. */
function selectedTabs(state: SidebarState, tab: TabItem, selection: unknown): TabItem[] {
  if (!Array.isArray(selection)) return []
  const wanted = new Set(selection.filter((id): id is string => typeof id === 'string'))
  if (!wanted.has(tab.id)) return []
  const tabs = sidebarOrder(state, tab.spaceId).filter((t) => wanted.has(t.id))
  return tabs.length >= 2 ? tabs : []
}

/** The menu of a multiple selection: what can be done to the tabs together (archive, new folder with them, copy their links). */
function selectionMenuItems(tabs: TabItem[], browser: Browser, store: StateStore, win: BrowserWindow, context: MenuContext): MenuItemConstructorOptions[] {
  const state = store.get()
  const ids = tabs.map((t) => t.id)
  const summary = groupSummary(tabs)
  const labels = groupLabels(summary)
  const otherSpaces = state.spaces.filter((s) => s.id !== tabs[0]!.spaceId)
  return template(
    [
      block(t('ctx.bloc-organiser'), [
        entry('folder', { label: labels.newFolder, click: () => browser.dispatch({ type: 'folder/create-with', tabIds: ids }) }),
        entry('copy', { label: labels.copyLinks, click: () => writeClipboard(browser, markdownLinks(tabs, state.settings.stripCopiedLinks), () => browser.showToast(tabs.length === 1 ? t('ctx.lien-markdown-copie') : t('ctx.length-liens-markdown-copies', { length: tabs.length }))) }),
        // A session keeps the selection only (File › Sessions…); a private window keeps no session.
        ...(browser.isPrivate() ? [] : [entry('save', { label: t('ctx.enregistrer-comme-session'), click: () => browser.openOverlay({ panel: 'sessions', focus: 'save', tabIds: ids }) })]),
        entry('pin', {
          label: labels.pin,
          // Each tab goes through its own action. A pinned tab goes to the end of the pinned list and an unpinned one to the top
          // of Today, so the tabs are pinned from the first and unpinned from the last to keep the order of the sidebar.
          click: () => {
            for (const tab of summary.allPinned ? [...tabs].reverse() : tabs) if (tab.pinned === summary.allPinned) browser.dispatch({ type: summary.allPinned ? 'tab/unpin' : 'tab/pin', id: tab.id })
          }
        }),
        ...(otherSpaces.length > 0
          ? [
              entry('move', {
                label: t('ctx.deplacer-vers-l-espace'),
                submenu: otherSpaces.map((s) => ({ label: `${spaceGlyph(s)} ${s.name}`, click: () => moveTabsToSpace(browser, store, win, ids, s.id) }))
              })
            ]
          : [])
      ]),
      block(
        t('ctx.bloc-archiver-et-fermer'),
        [
          entry('archive', {
            label: labels.archive,
            enabled: summary.archivable > 0,
            click: () => {
              // The notice with "Annuler" is the browser's own (it follows every action that archives several tabs).
              browser.dispatch({ type: 'tabs/archive-many', ids })
            }
          }),
          // A Today tab is closed, a pinned one put to sleep: the same action does either.
          entry('close', { label: labels.close, click: () => tabs.forEach((tab) => browser.dispatch(menuCloseAction(tab))) }, true)
        ],
        true
      )
    ],
    context
  )
}

export function tabMenuItems(target: Extract<MenuTarget, { kind: 'tab' }>, browser: Browser, store: StateStore, win: BrowserWindow, context: MenuContext): MenuItemConstructorOptions[] {
  const state = store.get()
  const act = (action: Parameters<Browser['dispatch']>[0]) => () => browser.dispatch(action)
  const tab = state.tabs.find((t) => t.id === target.id)
  if (!tab) return []
  const grouped = selectedTabs(state, tab, target.selection)
  if (grouped.length > 0) return selectionMenuItems(grouped, browser, store, win, context)
  // Favourites are kept per profile: whether this page is one is a question about the profile of its space.
  const isFavorite = favoritesOfSpace(state, tab.spaceId).find((f) => f.url === tab.url)
  const info = browser.snapshot().runtime.tabs[tab.id]
  const muted = info?.muted ?? false
  const awake = browser.livePageIds().includes(tab.id)
  const otherSpaces = state.spaces.filter((s) => s.id !== tab.spaceId)
  const split = splitFor(state, tab.id)
  const splitCandidates = state.tabs.filter((t) => t.spaceId === tab.spaceId && t.id !== tab.id && !splitFor(state, t.id))
  const canJoinSplit = split ? split.tabIds.length < 4 : true
  const todayTabs = state.tabs.filter((t) => t.spaceId === tab.spaceId && !t.pinned)
  // One place up or down among the tabs of its group, as a drop would move it: the keyboard reaches the reordering through this menu.
  const upStep = tabStep(state, tab.id, -1)
  const downStep = tabStep(state, tab.id, 1)
  const position = todayTabs.findIndex((t) => t.id === tab.id)
  const hasTabsAbove = position > 0
  const hasTabsBelow = position !== -1 && position < todayTabs.length - 1
  // The row the person right-clicked: the sheets this menu opens hang from it. A malformed one is dropped, and the sheet is centred.
  const anchor = isPlusAnchor(target.anchor) ? { anchor: target.anchor } : {}
  const edit = (focus: 'name' | 'icon') => () => browser.openOverlay({ panel: 'tab', tabId: tab.id, focus, ...anchor })
  const archive = (scope: 'above' | 'below' | 'others') => act({ type: 'tab/archive-group', id: tab.id, scope })
  const sleepState = browser.sleepStateOf(tab.id)
  const shown = browser.isShown(tab.id)
  const siteExcluded = isSiteExcluded(tab.url, state.settings.sleepExcludedHosts)
  // Listed while the function is off is not erased: the entry then reads as unchecked, and a click switches the function on.
  const erasedAtClose = state.settings.siteDataClearOnCloseEnabled && isClearedOnClose(state.settings.siteDataClearOnClose, tab.url)
  // The shortcuts shown at the right of an entry are the user's own (Réglages › Raccourcis). A shortcut acts on the tab on screen, so it is shown only on
  // the entries of that tab: on another tab's menu it would promise something else than what the entry does.
  const unreadOff = isUnreadOff(state.settings.siteUnreadOff, tab.url)
  const onScreen = activeTab(state)?.id === tab.id
  const key = (id: string): Pick<Item, 'accelerator' | 'registerAccelerator'> => {
    const accelerator = onScreen ? effectiveAccelerator(id, state.settings.keyBindings) : undefined
    return accelerator ? { accelerator, registerAccelerator: false } : {}
  }
  // A page on screen cannot be put to sleep. A pinned tab already has its own "Mettre en veille" (it is also its close).
  const sleepItems: Item[] = [
    ...(tab.pinned
      ? [entry('sleep', { label: t('ctx.mettre-en-veille'), ...key('closeTab'), click: act({ type: 'tab/close', id: tab.id }) })]
      : [entry('sleep', { label: t('ctx.mettre-en-veille'), enabled: sleepState !== 'asleep' && !shown, click: () => void browser.sleepNow(tab.id) })]),
    // A frozen tab is thawed where it is (not shown, not reloaded), as the button on its row does.
    sleepState === 'frozen'
      ? entry('freeze', { label: t('ctx.degeler-l-onglet'), click: () => void browser.thawTab(tab.id) })
      : entry('freeze', { label: t('ctx.geler-garde-la-page-en-memoire'), enabled: sleepState === 'awake' && !shown, click: () => void browser.sleepNow(tab.id, 'freeze') }),
    // The marks and the list of sites are the shared state's: a private window follows the main window's settings and keeps none of its own.
    ...(browser.isPrivate()
      ? []
      : ([
          { label: t('ctx.ne-jamais-mettre-cet-onglet-en-veille'), type: 'checkbox', checked: tab.keepAwake === true, click: act({ type: 'tab/keep-awake', id: tab.id, keep: tab.keepAwake !== true }) },
          // The list keeps one tab of each site awake unless every tab is kept (Réglages, `sleepExcludedKeepAll`): the entry says which.
          { label: state.settings.sleepExcludedKeepAll ? t('ctx.garder-tous-les-onglets-de-ce-site-eveilles') : t('ctx.garder-un-onglet-de-ce-site-eveille'), type: 'checkbox', checked: siteExcluded, enabled: hostnameOf(tab.url) !== '', click: act({ type: 'sleep/exclude-site', site: tab.url, excluded: !siteExcluded }) }
        ] satisfies Item[]))
  ]
  // Optional: the entries of the tab tree, only with the function on and for a Today tab that has a branch to fold or a parent to leave.
  const children = state.settings.tabTree && !tab.pinned ? childrenOf(state.tabs, tab.id) : []
  const treeItems: Item[] = [
    ...(children.length > 0 ? [entry('branch', { label: tab.treeCollapsed ? t('ctx.deplier-les-onglets-enfants') : t('ctx.replier-les-onglets-enfants'), click: act({ type: 'tab/tree-collapse', id: tab.id }) })] : []),
    ...(state.settings.tabTree && tab.parentId !== undefined ? [entry('branch', { label: t('menu.sortir-l-onglet-de-son-parent'), click: act({ type: 'tab/tree-detach', id: tab.id }) })] : [])
  ]
  const archiveBranch: Item[] =
    children.length > 0
      ? [
          entry('archive', {
            label: t('ctx.archiver-l-onglet-et-ses-onglets-enfants'),
            click: () => {
              const ids = branchOf(store.get().tabs, tab.id).map((t) => t.id)
              // A private window only knows the single-tab action (it has no archive to keep).
              if (browser.isPrivate()) ids.forEach((id) => browser.dispatch({ type: 'tab/archive', id }))
              else browser.dispatch({ type: 'tabs/archive-many', ids })
            }
          })
        ]
      : []
  // "Archive Other Tabs" and "Archive Tabs Above" only exist when there is something to archive; "Below" is always there, greyed out when nothing is below.
  const hasOthers = state.tabs.some((t) => t.spaceId === tab.spaceId && !t.pinned && t.id !== tab.id)
  return template(
    [
      // The base entries first, then the optional ones, in blocks (setting them in blocks adds or takes away no entry).
      block(t('ctx.bloc-ouvrir'), [
        entry('split', {
          label: t('toolbar.ajouter-une-vue-scindee'),
          enabled: canJoinSplit,
          ...key('addSplit'),
          click: () => {
            browser.dispatch({ type: 'tab/select', id: tab.id })
            browser.openOverlay({ panel: 'commandbar', mode: 'split', initial: '' })
          }
        }),
        ...(canJoinSplit && splitCandidates.length > 0
          ? [
              entry('split', {
                label: split ? t('ctx.ajouter-un-onglet-a-la-vue-scindee') : t('ctx.vue-scindee-avec'),
                submenu: splitCandidates.slice(0, 20).map((t) => ({
                  label: tabName(t).slice(0, 60) || t.url,
                  click: act({ type: 'split/create', tabId: tab.id, withTabId: t.id })
                }))
              })
            ]
          : []),
        ...(split
          ? [
              entry('split', { label: t('ctx.retirer-de-la-vue-scindee'), click: act({ type: 'split/remove', tabId: tab.id }) }),
              // A row is offered the column; a column or a grid, the row (« Disposition », in the menu of the split view, offers all three).
              entry('stack', {
                label: splitArrangement(split) === 'horizontal' ? t('ctx.empiler-les-volets-vertical') : t('ctx.mettre-les-volets-cote-a-cote'),
                click: act({ type: 'split/orientation', id: split.id, orientation: splitArrangement(split) === 'horizontal' ? 'vertical' : 'horizontal' })
              }),
              // « Enregistrer comme vue de travail… », where a person looks for it: on a tab of the split view (it is also in the menu of the split view's options button).
              ...(state.settings.workViewsEnabled && !browser.isPrivate() ? [saveAsWorkView(workViewSaveRefusal(state, split), () => browser.openOverlay({ panel: 'workview', splitId: split.id }))] : [])
            ]
          : []),
        entry('dup', { label: t('ctx.dupliquer'), ...key('duplicateTab'), click: act({ type: 'tab/duplicate', id: tab.id }) }),
        entry('copy', {
          label: t('ctx.copier-le-lien'),
          accelerator: effectiveAccelerator('copyUrl', state.settings.keyBindings),
          registerAccelerator: false,
          click: () => writeClipboard(browser, browser.copyable(tab.url), () => undefined)
        }),
        entry('share', shareItem(tab.url))
      ]),
      block(t('ctx.bloc-personnaliser'), [
        entry('icon', { label: t('ctx.changer-l-icone'), click: edit('icon') }),
        entry('rename', { label: t('ctx.renommer'), click: edit('name') }),
        // "Mute" is greyed out for a page that makes no sound.
        entry('mute', { label: muted ? t('ctx.reactiver-le-son') : t('ctx.couper-le-son'), enabled: awake && (muted || info?.audible === true), ...key('muteTab'), click: () => browser.toggleMute(tab.id) }),
        ...captureMenuItems(info?.capturedBy, () => browser.stopTabCapture(tab.id)),
        entry('reload', autoReloadMenuItem(tab, browser, isPlusAnchor(target.anchor) ? target.anchor : undefined)),
        // The unread count of the site, as the site panel offers it (same action): a private tab or window keeps no site list, and a page without a web host has no site.
        ...(browser.isPrivate() || tab.private === true || autoplayHostOf(tab.url) === null
          ? []
          : ([{ label: t('ctx.masquer-le-compteur-de-messages-de-ce-site'), type: 'checkbox', checked: unreadOff, click: act({ type: 'unread/site', site: tab.url, off: !unreadOff, tabId: tab.id }) }] satisfies Item[]))
      ]),
      block(t('ctx.bloc-organiser'), [
        entry('pin', { label: tab.pinned ? t('ctx.desepingler') : t('ctx.epingler'), ...key('pin'), click: act({ type: tab.pinned ? 'tab/unpin' : 'tab/pin', id: tab.id }) }),
        ...(tab.pinned
          ? [
              entry('reload', { label: t('sidebar.revenir-a-l-adresse-epinglee'), click: act({ type: 'tab/back-to-anchor', id: tab.id }) }),
              entry('pin', { label: t('ctx.remplacer-l-adresse-epinglee-par-la-page'), click: act({ type: 'tab/replace-anchor', id: tab.id }) })
            ]
          : []),
        ...(tab.pinned && tab.anchorUrl && tab.anchorUrl !== tab.url ? [entry('pin', { label: t('ctx.separer-de-l-onglet-epingle'), click: act({ type: 'tab/separate', id: tab.id }) })] : []),
        entry('star', {
          label: isFavorite ? t('sidebar.retirer-des-favoris') : t('sidebar.ajouter-aux-favoris'),
          click: act(isFavorite ? { type: 'favorite/remove', id: isFavorite.id } : { type: 'favorite/add', url: tab.url, title: tab.title, faviconUrl: tab.faviconUrl, spaceId: tab.spaceId })
        }),
        entry('up', { label: t('ctx.deplacer-vers-le-haut'), enabled: upStep !== null, ...key('moveTabUp'), click: () => { if (upStep) browser.dispatch({ type: 'tab/move', id: tab.id, ...upStep }) } }),
        entry('down', { label: t('ctx.deplacer-vers-le-bas'), enabled: downStep !== null, ...key('moveTabDown'), click: () => { if (downStep) browser.dispatch({ type: 'tab/move', id: tab.id, ...downStep }) } }),
        ...(otherSpaces.length > 0
          ? [
              entry('move', {
                label: t('ctx.deplacer-vers-l-espace'),
                submenu: otherSpaces.map((s) => ({
                  label: `${spaceGlyph(s)} ${s.name}`,
                  click: () => moveTabsToSpace(browser, store, win, [tab.id], s.id)
                }))
              })
            ]
          : []),
        // Moving to another window (a drag of the row does it too): the other windows, by the names the Window menu gives them, and a new one. A tab of a
        // split view goes with the other panes, as a drag of its row takes them. Never in a private window: its tabs do not leave it.
        ...(browser.isPrivate() ? [] : [entry('move', { label: t('ctx.deplacer-vers-la-fenetre'), submenu: windowMoveItems(browser, tab.id) })]),
        ...treeItems,
        // Read later: keeps the page in the read-later list and closes the tab (a pinned tab stays). A private window keeps no list.
        ...(browser.isPrivate() ? [] : [entry('clock', { label: t('menu.lire-plus-tard'), enabled: isReadLaterUrl(tab.url), ...key('readLater'), click: act({ type: 'readlater/add', tabId: tab.id }) })]),
        // Remind me: the tab leaves the column and comes back at the chosen time (setting `tabReminders`); a private window keeps none.
        ...(!browser.isPrivate() && state.settings.tabReminders ? [entry('clock', { label: t('reminder.me-le-rappeler'), enabled: isReadLaterUrl(tab.url), submenu: reminderPresetItems(browser, store, tab.id) })] : []),
        // Optional: only while the function is on (a setting), and never in a private window, which keeps no bookmark and has no application windows.
        ...(!browser.isPrivate() && state.settings.bookmarkManager ? [entry('bookmark', { label: t('menu.ajouter-aux-signets'), enabled: isBookmarkUrl(tab.url), ...key('bookmarkAdd'), click: act({ type: 'bookmark/add', tabId: tab.id }) })] : []),
        ...(!browser.isPrivate() && state.settings.webAppWindows ? [entry('app', { label: t('menu.ouvrir-comme-application'), enabled: isBookmarkUrl(tab.url), ...key('openAsApp'), click: () => browser.openAsApp(tab.id) })] : []),
        // Optional: the container entries come only with the function on (nothing at all otherwise).
        ...containerMenuItems(browser, state, tab).map((item) => entry('container', item))
      ]),
      block(t('ctx.bloc-veille'), sleepItems),
      block(
        t('ctx.bloc-archiver-et-fermer'),
        [
          ...(tab.pinned
            ? []
            : [
                entry('archive', { label: t('menu.archiver-l-onglet'), ...key('closeTab'), click: act({ type: 'tab/archive', id: tab.id }) }),
                ...(hasOthers ? [entry('archive', { label: t('ctx.archiver-les-autres-onglets'), click: archive('others') })] : []),
                entry('archive', { label: t('ctx.archiver-les-onglets-en-dessous'), enabled: hasTabsBelow, click: archive('below') }),
                ...(hasTabsAbove ? [entry('archive', { label: t('ctx.archiver-les-onglets-au-dessus'), click: archive('above') })] : [])
              ]),
          ...archiveBranch,
          // The site's data goes when its last tab closes. A private window has nothing to erase (its session is thrown away whole), and a private tab leaves no site in the settings.
          ...(browser.isPrivate() || tab.private === true || clearHostOfUrl(tab.url) === null
            ? []
            : ([
                {
                  label: t('ctx.effacer-les-donnees-du-site-a-la-fermeture'),
                  type: 'checkbox',
                  checked: erasedAtClose,
                  click: act({ type: 'siteclear/site', site: tab.url, on: !erasedAtClose, tabId: tab.id })
                }
              ] satisfies Item[])),
          entry('close', { label: t('ctx.fermer-l-onglet'), click: act(menuCloseAction(tab)) }, true),
          entry('close', { label: t('ctx.fermer-les-autres-onglets-du-jour'), click: act({ type: 'tab/close-others', id: tab.id }) }, true)
        ],
        true
      )
    ],
    context
  )
}
