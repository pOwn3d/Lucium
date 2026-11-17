// The menu of the tile of a work view (context-menus.ts, kind `workview`): a right click on the tile, or the Menu key and ⇧F10 when it has the focus.

import type { MenuItemConstructorOptions } from 'electron'
import type { MenuTarget } from '@shared/ipc'
import { isPlusAnchor } from '@shared/plus-menu'
import { openWorkView, workViewOfSplit, workViewsOf } from '@shared/work-views'
import { t } from '@shared/i18n'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { block, entry, template, type MenuContext } from './context-menu-kit'

export function workViewMenuItems(target: Extract<MenuTarget, { kind: 'workview' }>, browser: Browser, store: StateStore, context: MenuContext): MenuItemConstructorOptions[] {
  const state = store.get()
  const view = state.workViews.find((each) => each.id === target.id)
  // A private window shows no tile, and the function off shows none either: a menu asked for all the same is empty.
  if (!view || browser.isPrivate() || !state.settings.workViewsEnabled) return []
  const act = (action: Parameters<Browser['dispatch']>[0]) => () => browser.dispatch(action)
  const shown = state.activeSpaceId
  // What « Enregistrer ce qui est affiché » and « Revenir aux adresses enregistrées » work on: the split view the view has open in the space shown.
  const open = openWorkView(state, view.id, shown)
  const mine = workViewsOf(state, view.profileId)
  const at = mine.indexOf(view)
  const anchor = isPlusAnchor(target.anchor) ? { anchor: target.anchor } : {}
  return template(
    [
      block(t('ctx.bloc-ouvrir'), [
        entry('split', { label: t('work-view.ouvrir'), click: act({ type: 'view/open', id: view.id, spaceId: shown }) }),
        entry('app', { label: t('work-view.ouvrir-dans-une-nouvelle-fenetre'), click: () => browser.openWorkViewInNewWindow(view.id) })
      ]),
      block(t('ctx.bloc-personnaliser'), [
        entry('rename', { label: t('work-view.modifier'), click: () => browser.openOverlay({ panel: 'workview', viewId: view.id, full: true, ...anchor }) }),
        entry('save', { label: t('work-view.enregistrer-ce-qui-est-affiche'), enabled: open !== undefined && workViewOfSplit(state, open) !== null, click: act({ type: 'view/capture', id: view.id, spaceId: shown }) }),
        entry('reload', { label: t('work-view.revenir-aux-adresses-enregistrees'), enabled: open !== undefined, click: act({ type: 'view/reset', id: view.id, spaceId: shown }) })
      ]),
      block(t('ctx.bloc-organiser'), [
        entry('up', { label: t('ctx.deplacer-vers-le-haut'), enabled: at > 0, click: act({ type: 'view/move', id: view.id, direction: -1 }) }),
        entry('down', { label: t('ctx.deplacer-vers-le-bas'), enabled: at >= 0 && at < mine.length - 1, click: act({ type: 'view/move', id: view.id, direction: 1 }) })
      ]),
      block(t('ctx.bloc-retirer'), [entry('trash', { label: t('work-view.retirer-la-vue-de-travail'), click: act({ type: 'view/remove', id: view.id }) }, true)], true)
    ],
    context
  )
}
