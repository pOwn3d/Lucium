// Loaded into the command window of the annotated window share only (docs/design/annotation-partage-fenetre.md, « Fenêtre annotée »). It gives that page
// the calls of WindowShareApi and nothing else: the view window has its own preload, which only receives drawing actions.

import { contextBridge, ipcRenderer } from 'electron'
import { WINDOW_SHARE_CHANNEL, type ShareList, type ShareStart, type ShareState, type WindowShareApi } from '../shared/window-share'
import type { Brush } from '../shared/window-share-draw'

const api: WindowShareApi = {
  list: () => ipcRenderer.invoke(WINDOW_SHARE_CHANNEL.list) as Promise<ShareList>,
  start: (id) => ipcRenderer.invoke(WINDOW_SHARE_CHANNEL.start, id) as Promise<ShareStart>,
  stop: () => ipcRenderer.invoke(WINDOW_SHARE_CHANNEL.stop),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ShareState): void => listener(state)
    ipcRenderer.on(WINDOW_SHARE_CHANNEL.state, handler)
    return () => ipcRenderer.removeListener(WINDOW_SHARE_CHANNEL.state, handler)
  },
  setBrush: (brush: Brush) => ipcRenderer.invoke(WINDOW_SHARE_CHANNEL.brush, brush),
  edit: (command) => ipcRenderer.invoke(WINDOW_SHARE_CHANNEL.edit, command),
  setPass: (on: boolean) => ipcRenderer.invoke(WINDOW_SHARE_CHANNEL.pass, on),
  setShortcut: (on: boolean) => ipcRenderer.invoke(WINDOW_SHARE_CHANNEL.shortcut, on)
}

contextBridge.exposeInMainWorld('luciumShare', api)
