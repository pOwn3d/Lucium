// The menu of the options button of a pane of a split view (context-menus.ts, kind `split`; `id` is the pane's tab).

import type { MenuItemConstructorOptions } from 'electron'
import type { MenuTarget } from '@shared/ipc'
import { splitFor } from '@shared/sidebar'
import { arrangementChoices, splitArrangement } from '@shared/split-grid'
import { workViewSaveRefusal } from '@shared/work-views'
import { t } from '@shared/i18n'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { block, entry, template, writeClipboard, type Item, type MenuContext } from './context-menu-kit'

export function splitMenuItems(target: Extract<MenuTarget, { kind: 'split' }>, browser: Browser, store: StateStore, context: MenuContext): MenuItemConstructorOptions[] {
  const state = store.get()
  const act = (action: Parameters<Browser['dispatch']>[0]) => () => browser.dispatch(action)
  const split = splitFor(state, target.id)
  const tab = state.tabs.find((t) => t.id === target.id)
  if (!split || !tab) return []
  const at = split.tabIds.indexOf(tab.id)
  // A grid reads its panes left to right, then top to bottom: a pane moves to the left or to the right in that order.
  const horizontal = splitArrangement(split) !== 'vertical'
  return template(
    [
      block(t('ctx.bloc-ouvrir'), [entry('copy', { label: t('ctx.copier-le-lien'), click: () => writeClipboard(browser, browser.copyable(tab.url), () => undefined) })]),
      block(t('ctx.bloc-organiser'), [
        entry(horizontal ? 'left' : 'up', { label: horizontal ? t('ctx.deplacer-le-volet-vers-la-gauche') : t('ctx.deplacer-le-volet-vers-le-haut'), enabled: at > 0, click: act({ type: 'split/move', tabId: tab.id, direction: -1 }) }),
        entry(horizontal ? 'right' : 'down', { label: horizontal ? t('ctx.deplacer-le-volet-vers-la-droite') : t('ctx.deplacer-le-volet-vers-le-bas'), enabled: at < split.tabIds.length - 1, click: act({ type: 'split/move', tabId: tab.id, direction: 1 }) }),
        entry('split', {
          label: t('toolbar.ajouter-une-vue-scindee'),
          enabled: split.tabIds.length < 4,
          click: () => {
            browser.dispatch({ type: 'tab/select', id: tab.id })
            browser.openOverlay({ panel: 'commandbar', mode: 'split', initial: '' })
          }
        }),
        // « Disposition »: a row, a column or a grid, the one the split view is in checked; a grid needs three or four panes.
        entry('stack', {
          label: t('ctx.disposition'),
          submenu: arrangementChoices(split).map((choice): Item => ({ label: choice.label, type: 'radio', checked: choice.checked, enabled: choice.enabled, click: act({ type: 'split/layout', id: split.id, layout: choice.arrangement }) }))
        }),
        // « Enregistrer comme vue de travail… »: the split view as it is on screen becomes a tile after the favourites. Only while the function is on, and
        // never in a private window, which keeps nothing; greyed out, with the reason, for a split view one of whose pages a view could not open again.
        ...(state.settings.workViewsEnabled && !browser.isPrivate() ? [saveAsWorkView(workViewSaveRefusal(state, split), () => browser.openOverlay({ panel: 'workview', splitId: split.id }))] : []),
        // Optional: the entry is there only while the setting that offers it is on.
        ...(state.settings.scrollSync
          ? [{ label: t('ctx.defilement-synchronise'), type: 'checkbox', checked: browser.isScrollSynced(split.id), click: () => browser.setScrollSynced(split.id, !browser.isScrollSynced(split.id)) } satisfies Item]
          : [])
      ]),
      block(t('ctx.bloc-retirer'), [entry('close', { label: t('ctx.separer-cet-onglet-de-la-vue-scindee'), click: act({ type: 'split/remove', tabId: tab.id }) })], true)
    ],
    context
  )
}

/** The entry « Enregistrer comme vue de travail… », greyed out with the reason the split view cannot be saved (`refusal`), when there is one. */
export function saveAsWorkView(refusal: string | null, click: () => void): Item {
  return entry('sparkle', { label: t('work-view.enregistrer-comme-vue-de-travail'), enabled: refusal === null, ...(refusal === null ? {} : { toolTip: refusal, sublabel: refusal }), click })
}
