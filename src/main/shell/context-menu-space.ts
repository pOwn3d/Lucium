// The context menu of a space (context-menus.ts, kind `space`): « Barre de cette fenêtre » first when the click was on the sidebar itself, then
// customizing the space, its theme, organizing it, its lock, and deleting it.

import { dialog, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { MenuTarget, SpaceEditorFocus } from '@shared/ipc'
import { effectiveAccelerator } from '@shared/keybindings'
import type { SidebarState } from '@shared/model'
import { asideRefusal } from '@shared/sessions'
import { parseThemeCode, type ThemeFileRequest } from '@shared/theme-code'
import { sidebarPlacement } from '@shared/window-sidebar'
import type { LockConfig } from '@shared/lock'
import { t, tp } from '@shared/i18n'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { asideSpace, withEveryWindowsTabs } from './space-aside'
import { applyThemeToAll, copySpaceTheme, pasteTheme } from './theme-actions'
import { themeEnvironment } from './theme-environment'
import { runThemeFileRequest } from './boost-share'
import { shareEnvironment } from './share-environment'
import { getLockService } from '../lock-service'
import { webPanelMenuItems } from './web-panel-menu'
import { block, entry, template, type Block, type Item, type MenuContext } from './context-menu-kit'

/**
 * The space's own lock (the settings of « Verrouillage »): lock it, or take its lock away (only while it is unlocked). Without a phrase yet the
 * first entry leads to Settings, where the phrase is chosen; a private window has no lock to set.
 */
function spaceLockItems(spaceId: string, state: SidebarState, browser: Browser): MenuItemConstructorOptions[] {
  if (browser.isPrivate()) return []
  const lock = getLockService()
  const ask = (config: LockConfig) => void lock?.configure(config).then((reply) => reply.ok || browser.showToast(reply.message))
  if (state.settings.lockedSpaces.includes(spaceId)) {
    return [{ label: t('ctx.retirer-le-verrou-de-l-espace'), enabled: lock?.isSpaceLocked(spaceId) === false, click: () => ask({ op: 'space', spaceId, locked: false }) }]
  }
  if (lock?.isActive()) return [{ label: t('ctx.verrouiller-l-espace'), click: () => ask({ op: 'space', spaceId, locked: true }) }]
  return [{ label: t('ctx.verrouiller-l-espace-2'), click: () => browser.openOverlay({ panel: 'settings', pane: 'protection', anchor: 'lock' }) }]
}

/**
 * « Barre de cette fenêtre », first in the menu of a right click on the sidebar itself (or its docked column): dock it to a column of icons or give the full
 * one back (⌃⌘S), its side, ticked as it is on screen, and « Comme les nouvelles fenêtres », ticked while the window follows the setting. Only this window
 * changes; Réglages › Apparence keeps the side of the new windows.
 */
export function windowSidebarBlock(browser: Browser, state: SidebarState): Block {
  const placement = sidebarPlacement(state.settings, browser.windowSidebar())
  const accelerator = effectiveAccelerator('dockSidebar', state.settings.keyBindings)
  return block(t('ctx.bloc-barre-de-cette-fenetre'), [
    entry('panel', {
      label: placement.docked ? t('ctx.deplier-la-barre') : t('ctx.replier-la-barre-icones-seules'),
      // The key acts on the window the menu is in: it is shown as the menu bar's, never registered twice.
      ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
      click: () => browser.changeWindowSidebar({ op: 'dock', docked: !placement.docked })
    }),
    { label: t('ctx.barre-a-gauche'), type: 'checkbox', checked: !placement.right, click: () => browser.changeWindowSidebar({ op: 'side', side: 'left' }) },
    { label: t('ctx.barre-a-droite'), type: 'checkbox', checked: placement.right, click: () => browser.changeWindowSidebar({ op: 'side', side: 'right' }) },
    { label: t('ctx.comme-les-nouvelles-fenetres'), type: 'checkbox', checked: placement.own === null, click: () => browser.changeWindowSidebar({ op: 'side', side: null }) }
  ])
}

/** A theme file request from a menu: the shell's own sheets say how it went; a failure no sheet has told is said in a toast. */
async function shareThemeFile(browser: Browser, store: StateStore, win: BrowserWindow, request: ThemeFileRequest): Promise<void> {
  try {
    const reply = await runThemeFileRequest(shareEnvironment(browser, store, win), request)
    if (!reply.ok && !reply.cancelled && !reply.shown && reply.message) browser.showToast(reply.message)
  } catch (error) {
    console.error('[menu] sharing a theme failed:', error)
    browser.showToast(t('boostshare.le-partage-a-echoue-reason', { reason: String((error as Error).message ?? error) }))
  }
}

export function spaceMenuItems(target: Extract<MenuTarget, { kind: 'space' }>, browser: Browser, store: StateStore, win: BrowserWindow, context: MenuContext): MenuItemConstructorOptions[] {
  const state = store.get()
  const act = (action: Parameters<Browser['dispatch']>[0]) => () => browser.dispatch(action)
  const space = state.spaces.find((s) => s.id === target.id)
  if (!space) return []
  const profiles = [...new Set(['default', ...state.spaces.map((sp) => sp.profileId)])]
  const edit = (focus: SpaceEditorFocus) => () => browser.openOverlay({ panel: 'space', spaceId: space.id, focus })
  const themes = themeEnvironment(browser, store)
  const reportTheme = (error: unknown) => console.error('[menu] theme action failed:', error)
  // A shortcut acts on the space on screen: it is shown only on the entries of that space (see the tab menu).
  const onScreen = space.id === state.activeSpaceId
  // The name, the icon, the theme and the header of a locked space wait for the phrase (lock.ts refuses them), and so does a new folder, which
  // would land in it: their entries are greyed out, and say why under the pointer.
  const free = getLockService()?.isSpaceLocked(space.id) !== true
  const whyLocked: Pick<Item, 'toolTip'> = free ? {} : { toolTip: t('lock.deverrouillez-l-espace-d-abord') }
  const key = (id: string, always = false): Pick<Item, 'accelerator' | 'registerAccelerator'> => {
    const accelerator = onScreen || always ? effectiveAccelerator(id, state.settings.keyBindings) : undefined
    return accelerator ? { accelerator, registerAccelerator: false } : {}
  }
  return template(
    [
      // A right click on the sidebar itself, not on the icon of a space: the sidebar of this window comes first.
      ...(target.sidebar === true ? [windowSidebarBlock(browser, state)] : []),
      block(t('ctx.bloc-personnaliser'), [
        // One panel for the icon, the name, the colour and the profile: it replaces "Changer l’icône de l’espace…" and "Modifier la
        // couleur du thème…". The editor is tied to the visible space, so its live preview is the sidebar the user is looking at.
        entry('palette', {
          label: t('ctx.personnaliser-l-espace'),
          enabled: free,
          ...whyLocked,
          click: () => {
            browser.dispatch({ type: 'space/select', id: space.id })
            browser.openOverlay({ panel: 'space', spaceId: space.id })
          }
        }),
        entry('rename', { label: t('ctx.renommer-l-espace'), enabled: free, ...whyLocked, ...key('renameSpace'), click: edit('name') }),
        entry('profile', {
          label: t('ctx.definir-le-profil'),
          enabled: free,
          ...whyLocked,
          submenu: [
            ...profiles.map((id): Item => ({
              label: state.settings.profileNames[id] ?? (id === 'default' ? t('menu.profil-par-defaut') : id),
              type: 'radio',
              checked: id === space.profileId,
              click: () => browser.dispatch({ type: 'space/update', id: space.id, patch: { profileId: id } })
            })),
            { type: 'separator' },
            { label: t('ctx.nouveau-profil'), click: edit('profile') }
          ]
        })
      ]),
      block(t('ctx.bloc-theme'), [
        // The theme travels as a short text (a code, or just a colour) that can be copied from a space and pasted into another.
        entry('copy', { label: t('ctx.copier-le-theme'), click: () => void copySpaceTheme(themes, space.id).catch(reportTheme) }),
        entry('import', {
          label: t('ctx.coller-le-theme'),
          enabled: free && parseThemeCode(context.clipboardText).ok,
          ...whyLocked,
          click: () =>
            void pasteTheme(themes, space.id)
              .then((reply) => reply.ok || browser.showToast(reply.message))
              .catch(reportTheme)
        }),
        entry('sparkle', { label: t('ctx.appliquer-ce-theme-a-tous-les-espaces'), enabled: state.spaces.length > 1, click: () => void applyThemeToAll(themes, space.id).catch(reportTheme) }),
        // The theme as a file to send, and a file to take: the dialogs and the sheet that shows the theme before it is applied are the share module's.
        ...(state.settings.boostSharing
          ? [
              entry('export', { label: t('ctx.exporter-le-theme-dans-un-fichier'), click: () => void shareThemeFile(browser, store, win, { kind: 'export-file', spaceId: space.id }) }),
              entry('import', { label: t('cmd.importer-un-theme-depuis-un-fichier'), enabled: free, ...whyLocked, click: () => void shareThemeFile(browser, store, win, { kind: 'import-file', spaceId: space.id }) })
            ]
          : [])
      ]),
      block(t('ctx.bloc-organiser'), [
        entry('folder', { label: t('menu.nouveau-dossier-2'), enabled: free, ...whyLocked, click: act({ type: 'folder/create', name: t('menu.nouveau-dossier-2'), spaceId: space.id }) }),
        entry('header', { label: space.hideHeader ? t('ctx.afficher-l-en-tete-de-l-espace') : t('ctx.masquer-l-en-tete-de-l-espace'), enabled: free, ...whyLocked, click: act({ type: 'space/header', id: space.id, visible: space.hideHeader === true }) }),
        { label: t('ctx.apercu-dans-la-carte-de-survol'), type: 'checkbox', checked: state.settings.hoverCards, click: act({ type: 'settings/update', patch: { hoverCards: !state.settings.hoverCards } }) },
        // Sites kept beside the page (only while the function is on).
        ...webPanelMenuItems(browser, state, space).map((item) => entry('panel', item)),
        // Closes the pages and keeps the space (theme, settings, tabs) as a session, to open again later: the reversible way to get a space out of the way.
        entry('aside', { label: t('menu.mettre-l-espace-de-cote'), enabled: asideRefusal(withEveryWindowsTabs(store), space.id) === null, ...key('asideSpace'), click: () => asideSpace(browser, store, win, space.id) }),
        ...spaceLockItems(space.id, state, browser).map((item) => entry('lock', item)),
        entry('grid', { label: t('menu.gerer-les-espaces'), ...key('manageSpaces', true), click: () => browser.openOverlay({ panel: 'spaces' }) })
      ]),
      block(
        t('ctx.bloc-supprimer'),
        [
          entry('broom', { label: t('cmd.vider-les-onglets-du-jour'), ...key('clearToday'), click: act({ type: 'today/clear', spaceId: space.id }) }, true),
          entry(
            'trash',
            {
              label: t('ctx.supprimer-l-espace'),
              enabled: state.spaces.length > 1,
              click: () => {
                // The tabs the other windows have in the space are closed too (windows with tabs of their own): the question counts them all.
                const tabCount = withEveryWindowsTabs(store).tabs.filter((t) => t.spaceId === space.id).length
                const answer = dialog.showMessageBoxSync(win, {
                  type: 'warning',
                  buttons: [t('translate.remove'), t('confirm-box.annuler')],
                  defaultId: 1,
                  cancelId: 1,
                  message: t('ctx.supprimer-l-espace-name', { name: space.name }),
                  detail: tp('ctx.onglets-seront-fermes', tabCount)
                })
                if (answer === 0) browser.dispatch({ type: 'space/delete', id: space.id })
              }
            },
            true
          )
        ],
        true
      )
    ],
    context
  )
}
