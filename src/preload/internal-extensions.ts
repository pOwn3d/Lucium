// The preload of the Extensions page when it is a tab. The engine registers it in the sessions of the tabs for the address of the page only
// (engine/internal-pages.ts, `matches`), and this file asks the question again itself: it gives `window.lucium` to a document whose origin is exactly the
// page's, in the top frame, and gives nothing to any other. If the registration were refused, nothing would be registered at all (a script that runs in every
// page of a session is a cost and a risk the limit was made to avoid), and a page that did get here by any other road would find nothing to call.
//
// What it gives is eight of the calls of the interface (`InternalPageApi`), so that the page is the same component as it was in a window of its own, and each
// one goes over a channel of its own (`InternalChannel`): never one of the `lucium:` channels of the interface. The main process checks the sender of every message
// again (shared/internal-gate.ts) and everything the page sends.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { INTERNAL_ORIGIN } from '../shared/internal-page'
import { InternalChannel } from '../shared/ipc-channels'
import type { InternalPageApi } from '../shared/ipc-api'
import type { UiSnapshot } from '../shared/ipc'

if (location.origin === INTERNAL_ORIGIN && window === window.top) {
  const api: InternalPageApi = {
    getSnapshot: () => ipcRenderer.invoke(InternalChannel.getSnapshot),
    onSnapshot: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: UiSnapshot): void => listener(snapshot)
      ipcRenderer.on(InternalChannel.snapshot, handler)
      return () => ipcRenderer.removeListener(InternalChannel.snapshot, handler)
    },
    extensionsPage: (request) => ipcRenderer.invoke(InternalChannel.extensionsPage, request),
    extensionUpdates: (target) => ipcRenderer.send(InternalChannel.extensionUpdates, target),
    openWebStore: () => ipcRenderer.send(InternalChannel.openWebStore),
    // Settings, and nothing else: the page has no other panel to open, and the main process reads the target again.
    openOverlay: (request) => {
      if (request.panel === 'settings') ipcRenderer.send(InternalChannel.openSettings, { pane: request.pane, anchor: request.anchor })
    },
    pathOfDroppedFile: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch (error) {
        // Not a file of the disk (a dragged picture of a page, say): there is nothing to open, and the cause is written.
        console.warn('[drop] no path for the dropped item:', error instanceof Error ? error.message : String(error))
        return ''
      }
    },
    openLocalFiles: (paths) => ipcRenderer.send(InternalChannel.openLocalFiles, paths)
  }
  contextBridge.exposeInMainWorld('lucium', api)
}
