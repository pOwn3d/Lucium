// IPC of the page « Synchronisation » of the Settings (docs/synchronisation.md §13.1): one channel, one request at a time. Registered for each window with the
// window's own scoped IPC and guard (see registerIpc). Every request is read by `parseSyncRequest` (src/shared/sync-ipc.ts) before anything is done: a request that
// is not exactly one of the kinds, or has a field more, is refused with a sentence and nothing happens. The page names no path, no port, no address and no key; it
// holds none. Refused as a whole in a private window (nothing of the synchronisation is for it) and, by the guard, while the application is locked.

import type { WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { parseSyncRequest, type SyncProblem, type SyncReply, type SyncRequest } from '@shared/sync-ipc'
import { t, type MessageKey } from '@shared/i18n'
import { getSyncService } from '../sync/registry'
import { SyncServiceError, type SyncService } from '../sync/sync-service'
import type { ScopedIpc } from './ipc-scope'
import type { Browser } from './browser'

/** The sentence of each problem, a key of the catalogues (`sync.error.<problem>`). */
const PROBLEM_TEXT: Record<SyncProblem, MessageKey> = {
  unavailable: 'sync.error.unavailable',
  port: 'sync.error.port',
  identity: 'sync.error.identity',
  locked: 'sync.error.locked',
  network: 'sync.error.network',
  internal: 'sync.error.internal'
}

/** What one request does to the service, and the state to draw afterwards. A failure the service names is told in the person's words; any other is logged and told as `internal`. */
export async function handleSyncRequest(service: SyncService, request: SyncRequest): Promise<SyncReply> {
  try {
    switch (request.kind) {
      case 'status':
        break
      case 'enable':
        await service.setEnabled(request.on)
        break
      case 'category':
        service.setCategory(request.category, request.on)
        break
      case 'open-window':
        await service.openWindow()
        break
      case 'prolong':
        service.prolong()
        break
      case 'close-window':
        await service.closeWindow('manual')
        break
      case 'pair-start':
        await service.startPairing()
        break
      case 'pair-close':
        service.closePairing()
        break
      case 'answer':
        service.answer(request.allow)
        break
      case 'forget':
        service.forget(request.id)
        break
      case 'leave':
        await service.leave()
        break
    }
    return { ok: true, status: service.status() }
  } catch (error) {
    if (error instanceof SyncServiceError) return { ok: false, message: t(PROBLEM_TEXT[error.problem]), status: service.status() }
    console.error('[sync] a request of the page failed:', error)
    return { ok: false, message: t(PROBLEM_TEXT.internal), status: service.status() }
  }
}

export function registerSyncIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser): void {
  ipcMain.handle(Channel.syncRequest, async (e, raw: unknown): Promise<SyncReply> => {
    const service = getSyncService()
    if (!guard(e.sender, Channel.syncRequest) || browser.isPrivate()) return { ok: false, message: t('feature.demande-refusee'), status: null }
    const request = parseSyncRequest(raw)
    if (!service || !request) return { ok: false, message: t('feature.demande-invalide'), status: service?.status() ?? null }
    return handleSyncRequest(service, request)
  })
}
