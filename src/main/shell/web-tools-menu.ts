// The entries of the application menu that belong to the optional web tools. Each tool is a setting that is off by default, and
// its entries are not in the menu while it is off, so the menu keeps its base entries until the user asks for more.

import type { MenuItemConstructorOptions } from 'electron'
import { activeTab, splitFor } from '@shared/sidebar'
import type { MenuFacts } from '@shared/menu-state'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { t } from '@shared/i18n'
import { languageName } from '@shared/translate-quick'

interface MenuContext {
  browser: Browser
  store: StateStore
  /** The accelerator the user gave a command (menu.ts' `acc`). */
  acc: (id: string) => string | undefined
  /** The address of the page on screen when it is a web page. */
  page: string | null
  facts: MenuFacts
  /** A private window keeps no list of watched pages. */
  private: boolean
  report: (what: string, message?: string) => (error: unknown) => void
}

/** File ›: the QR code of the page, and watching the page for changes. */
export function webToolsFileItems({ browser, store, acc, page, report, facts, private: isPrivate }: MenuContext): MenuItemConstructorOptions[] {
  const { settings } = store.get()
  const items: MenuItemConstructorOptions[] = []
  if (settings.qrCode) items.push({ label: t('menu.code-qr-de-cette-page'), accelerator: acc('qrCode'), enabled: page !== null, click: () => page !== null && browser.openOverlay({ panel: 'qr', text: page }) })
  // Local page translation: on a web page only. A private window may translate (it writes nothing); the panel says what it cannot do there. A page in another
  // language than the target gets « Traduire en <langue> », done at once without the panel, and a translated one « Afficher l'original » (`facts.translate`);
  // every other page « Traduire cette page… », the panel.
  if (settings.translateLocal) {
    const offer = facts.translate
    const tabId = activeTab(store.get())?.id
    if (offer && tabId !== undefined) {
      const label = offer.state === 'offered' ? t('translate.menu-to', { language: languageName(offer.to) }) : t('translate.show-original')
      items.push({ label, accelerator: acc('translatePage'), click: () => browser.translateTabNow(tabId) })
    } else items.push({ label: t('menu.traduire-cette-page'), accelerator: acc('translatePage'), enabled: page !== null, click: () => page !== null && browser.openOverlay({ panel: 'translate' }) })
  }
  // Picture in Picture of the page's main video (the largest that can float), the way to float Google Meet's, whose own button fails in Electron. Not in a private window.
  if (!isPrivate) items.push({ label: t('menu.image-dans-l-image'), enabled: page !== null, click: () => { console.info(`[pip] menu click (page ${page === null ? 'none' : 'web page'})`); void browser.floatMainVideo() } })
  if (settings.pageWatch && !isPrivate) {
    // Nor for a private tab of a normal window: its address would be written down, and looked at with the cookies of the profile.
    const watchable = page !== null && activeTab(store.get())?.private !== true
    items.push(
      { label: t('menu.surveiller-cette-page'), accelerator: acc('watchPage'), enabled: watchable, click: () => void browser.watchPage(false).catch(report('page watch', t('web-tools-menu.la-page-n-a-pas-pu-etre-mise-sous-surveillance'))) },
      { label: t('menu.surveiller-une-zone-de-la-page'), enabled: watchable, click: () => void browser.watchPage(true).catch(report('page watch of a zone', t('web-tools-menu.la-zone-n-a-pas-pu-etre-mise-sous-surveillance'))) }
    )
  }
  return items
}

/** View ›: synchronized scrolling of the split view, and the battery saver. */
export function webToolsViewItems({ browser, store, acc, facts }: MenuContext): MenuItemConstructorOptions[] {
  const { settings } = store.get()
  const items: MenuItemConstructorOptions[] = []
  const tab = activeTab(store.get())
  const split = tab ? splitFor(store.get(), tab.id) : undefined
  if (settings.scrollSync) {
    items.push({
      label: t('menu.defilement-synchronise-des-volets'),
      accelerator: acc('scrollSync'),
      type: 'checkbox',
      checked: facts.scrollSynced === true,
      enabled: split !== undefined,
      click: () => split && browser.setScrollSynced(split.id, !browser.isScrollSynced(split.id))
    })
  }
  if (settings.batterySaver) {
    items.push({ label: t('menu.mode-economie-de-batterie'), accelerator: acc('batterySaver'), type: 'checkbox', checked: facts.saverAsked === true, click: () => browser.toggleBatterySaverAsked() })
  }
  return items
}
