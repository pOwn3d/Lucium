// IPC of the page « Synchronisation » of the Settings (docs/synchronisation.md §13.1): one channel, one request at a time. Registered for each window with the
// window's own scoped IPC and guard (see registerIpc). Every request is read by `parseSyncRequest` (src/shared/sync-ipc.ts) before anything is done: a request that
// is not exactly one of the kinds, or has a field more, is refused with a sentence and nothing happens. The page names no path, no port, no address and no key; it
// holds none. Refused as a whole in a private window (nothing of the synchronisation is for it) and, by the guard, while the application is locked.

import type { WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { parseSyncRequest, type SyncProblem, type SyncReply, type SyncRequest } from '@shared/sync-ipc'
import { isWebAddress, parseSyncResumeRequest, resumeTargetSpace, resumeView, type SyncResumeReply, type SyncResumeRequest } from '@shared/sync-resume'
import type { SidebarState } from '@shared/model'
import type { Action } from '@shared/sidebar-actions'
import { t, type MessageKey } from '@shared/i18n'
import { getSyncService } from '../sync/registry'
import { SyncServiceError, type SyncService } from '../sync/sync-service'
import type { ScopedIpc } from './ipc-scope'
import type { Browser } from './browser'
import type { StateStore } from '../store'
import { getLockService } from '../lock-service'

/** The sentence of each problem, a key of the catalogues (`sync.error.<problem>`). */
const PROBLEM_TEXT: Record<SyncProblem, MessageKey> = {
  unavailable: 'sync.error.unavailable',
  port: 'sync.error.port',
  identity: 'sync.error.identity',
  'identity-unopenable': 'sync.error.identity-unopenable',
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
      case 'pair-start':
        await service.startPairing()
        break
      case 'pair-close':
        service.closePairing()
        break
      case 'answer':
        service.answer(request.allow, request.shareToday === true)
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

/** What the list « Sur l'iPhone » needs of the application: the spaces, which of them are locked, and the way a page is opened. */
export interface ResumePorts {
  state: () => SidebarState
  isSpaceLocked: (spaceId: string) => boolean
  dispatch: (action: Action) => void
}

/**
 * The list of the iPhones' open tabs, or the opening of one of them (docs/synchronisation.md §10.4). The bar is given titles and hosts and names a line by its identifier: the
 * address and the space are read again here from what the service holds, so that nothing the bar sends can make this open another page. An address that is not `http` or `https`,
 * a line that is not (or no more) in the list, a space the lock keeps: nothing opens. Nothing is written in the state but the new tab itself.
 */
export function handleSyncResume(service: Pick<SyncService, 'resumeSource'>, ports: ResumePorts, request: SyncResumeRequest): SyncResumeReply {
  const source = service.resumeSource()
  const view = resumeView(source)
  if (request.kind === 'list') return { ok: true, view }
  // Only a list that is shown can be opened from.
  if (view.availability !== 'list') return { ok: false }
  const row = source.rows.find((one) => one.id === request.id)
  if (row === undefined || !isWebAddress(row.url)) return { ok: false }
  const state = ports.state()
  const spaceId = resumeTargetSpace(row, new Set(state.spaces.map((space) => space.id)), state.activeSpaceId, ports.isSpaceLocked)
  if (spaceId === null) return { ok: false }
  ports.dispatch({ type: 'tab/open', url: row.url, spaceId })
  return { ok: true, view }
}

export function registerSyncIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser, store: Pick<StateStore, 'get'>): void {
  ipcMain.handle(Channel.syncRequest, async (e, raw: unknown): Promise<SyncReply> => {
    const service = getSyncService()
    if (!guard(e.sender, Channel.syncRequest) || browser.isPrivate()) return { ok: false, message: t('feature.demande-refusee'), status: null }
    const request = parseSyncRequest(raw)
    if (!service || !request) return { ok: false, message: t('feature.demande-invalide'), status: service?.status() ?? null }
    return handleSyncRequest(service, request)
  })
  ipcMain.handle(Channel.syncResume, (e, raw: unknown): SyncResumeReply => {
    const service = getSyncService()
    // A private window has no part in the synchronisation, and a locked application shows nothing (the guard).
    if (!guard(e.sender, Channel.syncResume) || browser.isPrivate() || !service) return { ok: false }
    const request = parseSyncResumeRequest(raw)
    if (!request) return { ok: false }
    const lock = getLockService()
    return handleSyncResume(service, { state: () => store.get(), isSpaceLocked: (spaceId) => lock?.isSpaceLocked(spaceId) ?? false, dispatch: (action) => browser.dispatch(action) }, request)
  })
}
