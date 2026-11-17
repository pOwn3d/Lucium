// IPC of the privacy features: the "Cookies par site" view, the test of a proxy, the private tab. Registered for each
// window with the window's own scoped IPC and guard (see registerIpc). Every argument is hostile until it is checked.

import type { WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { parseCookieSite } from '@shared/cookies'
import { probeProxy } from '../engine/network'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'
import { t } from '@shared/i18n'

export function registerPrivacyIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser, store: StateStore): void {
  /** The view is for a normal window with the feature on: it reads the cookies of a profile, and a private window has none of its own to manage. */
  const cookiesAllowed = (e: { sender: WebContents }, channel: string): boolean => guard(e.sender, channel) && !browser.isPrivate() && store.get().settings.cookieManager

  ipcMain.handle(Channel.cookieSites, (e) => (cookiesAllowed(e, Channel.cookieSites) ? browser.cookieSites() : Promise.reject(new Error(t('privacy-ipc.les-cookies-par-site-ne-sont-pas-disponibles-ici')))))

  ipcMain.handle(Channel.cookieNames, (e, host: unknown) => {
    const site = parseCookieSite(host)
    return cookiesAllowed(e, Channel.cookieNames) && site !== null ? browser.cookieNames(site) : []
  })

  ipcMain.handle(Channel.cookieRemoveSite, (e, host: unknown) => {
    const site = parseCookieSite(host)
    if (!cookiesAllowed(e, Channel.cookieRemoveSite) || site === null) return Promise.reject(new Error(t('privacy-ipc.site-non-valide-aucun-cookie-n-a-ete-retire')))
    return browser.removeCookieSite(site)
  })

  ipcMain.handle(Channel.cookieClean, (e) => (cookiesAllowed(e, Channel.cookieClean) ? browser.cleanCookies() : Promise.reject(new Error(t('privacy-ipc.les-cookies-par-site-ne-sont-pas-disponibles-ici')))))

  // The test reaches the proxy server only: an address that is not a proxy address is never connected to.
  ipcMain.handle(Channel.testProxy, (e, address: unknown) => (guard(e.sender, Channel.testProxy) && typeof address === 'string' ? probeProxy(address) : { ok: false, error: t('privacy-ipc.demande-refusee') }))

  ipcMain.on(Channel.newPrivateTab, (e) => {
    if (guard(e.sender, Channel.newPrivateTab)) browser.openPrivateTab()
  })
}
