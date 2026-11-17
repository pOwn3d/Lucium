// Loaded into the view window of the annotated window share only (docs/design/annotation-partage-fenetre.md, « Fenêtre annotée »). It gives that page
// the drawing actions the main process sends, and two calls that go out: a click, sent to main in the passage mode only, and whether the picture
// is black (sent when it changes).

import { contextBridge, ipcRenderer } from 'electron'
import { WINDOW_SHARE_CHANNEL, type WindowShareViewApi } from '../shared/window-share'
import type { DrawAction } from '../shared/window-share-draw'
import type { PassClick } from '../shared/window-share-pass'

const api: WindowShareViewApi = {
  onDraw: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, action: DrawAction): void => listener(action)
    ipcRenderer.on(WINDOW_SHARE_CHANNEL.draw, handler)
    return () => ipcRenderer.removeListener(WINDOW_SHARE_CHANNEL.draw, handler)
  },
  sendClick: (click: PassClick) => ipcRenderer.send(WINDOW_SHARE_CHANNEL.click, click),
  sendPicture: (blank: boolean) => ipcRenderer.send(WINDOW_SHARE_CHANNEL.picture, blank)
}

contextBridge.exposeInMainWorld('luciumShareView', api)
