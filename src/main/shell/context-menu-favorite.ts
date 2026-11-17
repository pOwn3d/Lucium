// The context menu of a favourite of the sidebar (context-menus.ts, kind `favorite`).

import type { MenuItemConstructorOptions } from 'electron'
import type { MenuTarget } from '@shared/ipc'
import { isPlusAnchor } from '@shared/plus-menu'
import { activeTab, splitFor, tabOpenedSince } from '@shared/sidebar'
import { spaceGlyph } from '@shared/space-icon'
import { favoriteProfile, favoritesOf } from '@shared/favorite-scope'
import { isNavigableUrl } from '@shared/url'
import { t } from '@shared/i18n'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { block, entry, shareItem, template, writeClipboard, type MenuContext } from './context-menu-kit'

export function favoriteMenuItems(target: Extract<MenuTarget, { kind: 'favorite' }>, browser: Browser, store: StateStore, context: MenuContext): MenuItemConstructorOptions[] {
  const state = store.get()
  const act = (action: Parameters<Browser['dispatch']>[0]) => () => browser.dispatch(action)
  const favorite = state.favorites.find((f) => f.id === target.id)
  if (!favorite) return []
  const active = activeTab(state)
  const otherSpaces = state.spaces
  // Where the page on screen could replace this favourite's address: a page that can be opened and that no other favourite of the profile has.
  const replaceable = !!active && isNavigableUrl(active.url) && active.url !== favorite.url && !favoritesOf(state, favoriteProfile(favorite)).some((f) => f.url === active.url)
  // The favourites of its profile, in the order the sidebar shows them: the reordering is one place up or down among them (favorite/move).
  const sameProfile = favoritesOf(state, favoriteProfile(favorite))
  const favoriteAt = sameProfile.indexOf(favorite)
  const copyLink = () => writeClipboard(browser, browser.copyable(favorite.url), () => undefined)
  // The menu of a favourite. A favourite here is a tile that opens its address: it has no page of its own
  // (nothing to mute, nothing to duplicate: two favourites of a profile never share an address) and no icon to change.
  return template(
    [
      block(t('ctx.bloc-ouvrir'), [
        entry('split', {
          label: t('ctx.ouvrir-en-vue-scindee'),
          enabled: !!active && splitFor(state, active.id) === undefined,
          click: () => {
            const before = store.get()
            const beside = activeTab(before)
            browser.dispatch({ type: 'tab/open', url: favorite.url })
            // Only the tab just made is paired: when the opening was refused, the last tab of the state is one that was already there.
            const opened = tabOpenedSince(before, store.get())
            if (beside && opened) browser.dispatch({ type: 'split/create', tabId: beside.id, withTabId: opened.id })
          }
        }),
        entry('mini', { label: t('ctx.ouvrir-dans-une-mini-fenetre'), click: () => browser.openLittle(favorite.url) }),
        entry('copy', { label: t('ctx.copier-le-lien'), click: copyLink }),
        entry('share', shareItem(favorite.url))
      ]),
      block(t('ctx.bloc-personnaliser'), [
        entry('rename', { label: t('ctx.renommer'), enabled: !browser.isPrivate(), click: () => browser.openOverlay({ panel: 'favorite', favoriteId: favorite.id, ...(isPlusAnchor(target.anchor) ? { anchor: target.anchor } : {}) }) }),
        entry('link', {
          label: t('ctx.modifier-la-page-epinglee'),
          submenu: [
            { label: t('sidebar.revenir-a-l-adresse-epinglee'), enabled: !!active && active.url !== favorite.url, click: () => browser.submitUrl(favorite.url, 'current') },
            { label: t('ctx.remplacer-l-adresse-epinglee-par-la-page'), enabled: replaceable, click: act({ type: 'favorite/edit', id: favorite.id, patch: { url: active?.url } }) }
          ]
        }),
        entry('mute', { label: t('ctx.couper-le-son'), enabled: false })
      ]),
      block(t('ctx.bloc-organiser'), [
        entry('up', { label: t('ctx.deplacer-vers-le-haut'), enabled: favoriteAt > 0, click: act({ type: 'favorite/move', id: favorite.id, direction: -1 }) }),
        entry('down', { label: t('ctx.deplacer-vers-le-bas'), enabled: favoriteAt >= 0 && favoriteAt < sameProfile.length - 1, click: act({ type: 'favorite/move', id: favorite.id, direction: 1 }) }),
        entry('move', {
          label: t('ctx.deplacer-vers'),
          enabled: otherSpaces.length > 0,
          submenu: otherSpaces.map((sp) => ({
            label: `${spaceGlyph(sp)} ${sp.name}`,
            // The tile becomes a pinned tab of that space.
            click: () => {
              const before = store.get()
              browser.dispatch({ type: 'tab/open', url: favorite.url, spaceId: sp.id, background: true })
              // The opening may be refused: the tile then stays, and no tab that was already there (one at the same address, say) is pinned for it.
              const created = tabOpenedSince(before, store.get())
              if (!created) return
              browser.dispatch({ type: 'tab/pin', id: created.id })
              browser.dispatch({ type: 'favorite/remove', id: favorite.id })
            }
          }))
        })
      ]),
      block(t('ctx.bloc-retirer'), [entry('star', { label: t('sidebar.retirer-des-favoris'), click: act({ type: 'favorite/remove', id: favorite.id }) }, true)], true)
    ],
    context
  )
}
