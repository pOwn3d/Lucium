// IPC of the keyboard and extension features of this group: the command bar's extension keywords. Registered for each window with the
// window's own scoped IPC and guard (see registerIpc).

import type { WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { parseOmniboxRequest } from '@shared/omnibox'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'

export function registerKeyExtIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser, store: StateStore): void {
  // What the bar sends is exactly an extension id, a short text and one of three places; the browser then checks the extension and the setting.
  ipcMain.on(Channel.omniboxEnter, (e, raw: unknown) => {
    if (!guard(e.sender, Channel.omniboxEnter)) return
    if (!store.get().settings.omniboxKeywords) return console.warn('[omnibox] the text was refused: extension keywords are off (Réglages › Recherche et barre de commandes)')
    const request = parseOmniboxRequest(raw)
    if (!request) return console.warn('[omnibox] a request that makes no sense was ignored')
    browser.omniboxEnter(request)
  })
}
