// IPC of the Extensions page: one channel, one request (see shared/extension-page.ts). Registered for each window group with the group's own scoped IPC
// and guard (see registerIpc): a locked application answers it nothing. The page in a tab has a channel and a gate of its own (internal-page-ipc.ts) and shares the answer.

import type { WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { parseExtensionsRequest, type ExtensionsReply } from '@shared/extension-page'
import { t } from '@shared/i18n'
import type { ScopedIpc } from './ipc-scope'
import type { ExtensionsService } from './extensions-service'

/**
 * The answer to what the Extensions page asked, whichever channel it came over (the window of the interface or the page in a tab: the sender was judged before
 * this). The page is not trusted with what it asks: the shape, the ids and the profile are checked again, and a request that is none is not run.
 */
export async function answerExtensionsRequest(service: Pick<ExtensionsService, 'handle'>, raw: unknown): Promise<ExtensionsReply> {
  const request = parseExtensionsRequest(raw)
  if (!request) {
    console.warn('[extensions] a request that makes no sense was ignored')
    return { ok: false, message: t('feature.demande-invalide') }
  }
  try {
    return await service.handle(request)
  } catch (error) {
    // The service answers every case it knows; what gets here is a bug or a failure of the system. The person is told, and the log has the cause.
    console.error(`[extensions] the request ${request.op} failed:`, error)
    return { ok: false, message: t('extpage.l-action-a-echoue-message', { message: String((error as Error).message ?? error).slice(0, 200) }) }
  }
}

export function registerExtensionsIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, service: Pick<ExtensionsService, 'handle'>): void {
  ipcMain.handle(Channel.extensionsPage, async (e, raw: unknown): Promise<ExtensionsReply> => {
    if (!guard(e.sender, Channel.extensionsPage)) return { ok: false, message: t('feature.demande-refusee') }
    return answerExtensionsRequest(service, raw)
  })
}
