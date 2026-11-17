// IPC of the list of devices pages were let use (Settings › Vie privée et sécurité › Plus de réglages › API matérielles du web). Registered for each window with the window's own
// scoped IPC and guard (see registerIpc). The request is checked field by field; the interface names a grant by its opaque id and nothing else.

import type { WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { openConnectionNotice, parseHardwareRequest, type HardwareReply } from '@shared/web-hardware'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'
import { t } from '@shared/i18n'

export function registerHardwareIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser): void {
  ipcMain.handle(Channel.webHardware, (e, raw: unknown): HardwareReply => {
    const refused = (message: string): HardwareReply => ({ ok: false, message, grants: [] })
    if (!guard(e.sender, Channel.webHardware)) return refused(t('feature.demande-refusee'))
    // A private window has no grant and must not show the normal windows': the list stays empty there.
    if (browser.isPrivate()) return refused(t('hardware-ipc.les-appareils-ne-sont-pas-disponibles-dans-une'))
    const request = parseHardwareRequest(raw)
    if (!request) return refused(t('feature.demande-invalide'))
    if (request.kind === 'list') return { ok: true, message: '', grants: browser.webHardwareGrants() }
    if (request.kind === 'revoke') {
      if (!browser.webHardwareGrants().some((grant) => grant.id === request.id)) return { ok: false, message: t('hardware-ipc.cette-autorisation-n-existe-plus'), grants: browser.webHardwareGrants() }
      const holders = browser.revokeWebHardware(request.id)
      return { ok: true, message: holders > 0 ? t('hardware-ipc.acces-retire-open-connection-notice', { OPEN_CONNECTION_NOTICE: openConnectionNotice() }) : t('hardware-ipc.acces-retire'), grants: browser.webHardwareGrants() }
    }
    const holders = browser.revokeWebHardware()
    return { ok: true, message: holders > 0 ? t('hardware-ipc.tous-les-acces-sont-retires-open-connection', { OPEN_CONNECTION_NOTICE: openConnectionNotice() }) : t('hardware-ipc.tous-les-acces-sont-retires'), grants: browser.webHardwareGrants() }
  })
}
