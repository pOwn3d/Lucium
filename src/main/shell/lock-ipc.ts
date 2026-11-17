// IPC of the lock (Réglages › Vie privée et sécurité › Verrouillage, the lock screen): unlocking with the phrase or Touch ID, and changing the lock.
// Registered for each window with the window's own scoped IPC and guard (see registerIpc). A phrase passes through here to the service
// and is never logged.

import type { WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { parseLockConfig, parseUnlockRequest, type LockReply } from '@shared/lock'
import { getLockService } from '../lock-service'
import type { ScopedIpc } from './ipc-scope'
import type { Browser } from './browser'
import { t } from '@shared/i18n'

const REFUSED: LockReply = { ok: false, get message() { return t('feature.demande-refusee') } }

export function registerLockIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser): void {
  // Any window can unlock: the application lock covers all of them, and one unlocking opens all of them.
  ipcMain.handle(Channel.lockUnlock, async (e, raw: unknown): Promise<LockReply> => {
    if (!guard(e.sender, Channel.lockUnlock)) return REFUSED
    const lock = getLockService()
    const request = parseUnlockRequest(raw)
    if (!lock || !request) return { ok: false, message: t('feature.demande-invalide') }
    return lock.unlock(request)
  })

  // Changing the lock is for the normal windows: a private window has no settings of its own to put a lock on.
  ipcMain.handle(Channel.lockConfigure, async (e, raw: unknown): Promise<LockReply> => {
    if (!guard(e.sender, Channel.lockConfigure) || browser.isPrivate()) return REFUSED
    const lock = getLockService()
    const config = parseLockConfig(raw)
    if (!lock || !config) return { ok: false, message: t('feature.demande-invalide') }
    return lock.configure(config)
  })
}
