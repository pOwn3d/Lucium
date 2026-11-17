// Loaded into the command window of the page annotation only (docs/design/annotation-partage-fenetre.md, section « Annotation directe dans la
// page »). It gives that page the calls of PageAnnotateApi and nothing else.

import { contextBridge, ipcRenderer } from 'electron'
import { PAGE_ANNOTATE_CHANNEL, type BarDrag, type BarMenuAnchor, type LaserStyle, type PageAnnotateApi, type PageAnnotateState, type PageBrush, type PageEdit, type PageMode } from '../shared/page-annotate'
import type { NudgeDirection } from '../shared/annotate-bar'
import type { AutoClear } from '../shared/annotate-auto-clear'

const api: PageAnnotateApi = {
  getState: () => ipcRenderer.invoke(PAGE_ANNOTATE_CHANNEL.state) as Promise<PageAnnotateState>,
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: PageAnnotateState): void => listener(state)
    ipcRenderer.on(PAGE_ANNOTATE_CHANNEL.state, handler)
    return () => ipcRenderer.removeListener(PAGE_ANNOTATE_CHANNEL.state, handler)
  },
  setBrush: (brush: PageBrush) => ipcRenderer.invoke(PAGE_ANNOTATE_CHANNEL.brush, brush),
  setMode: (mode: PageMode) => ipcRenderer.invoke(PAGE_ANNOTATE_CHANNEL.mode, mode),
  edit: (command: PageEdit) => ipcRenderer.invoke(PAGE_ANNOTATE_CHANNEL.edit, command),
  setLaser: (style: LaserStyle) => ipcRenderer.invoke(PAGE_ANNOTATE_CHANNEL.laser, style),
  stop: () => ipcRenderer.invoke(PAGE_ANNOTATE_CHANNEL.stop),
  // The drag is a stream of pointer positions: sent, not asked (nothing comes back, and the next position does not wait for the last).
  dragBar: (drag: BarDrag) => ipcRenderer.send(PAGE_ANNOTATE_CHANNEL.drag, drag),
  openBarMenu: (anchor: BarMenuAnchor) => ipcRenderer.invoke(PAGE_ANNOTATE_CHANNEL.menu, anchor),
  nudgeBar: (direction: NudgeDirection, large: boolean) => ipcRenderer.invoke(PAGE_ANNOTATE_CHANNEL.nudge, direction, large),
  dismissHint: () => ipcRenderer.invoke(PAGE_ANNOTATE_CHANNEL.hint),
  setAutoClear: (value: AutoClear) => ipcRenderer.invoke(PAGE_ANNOTATE_CHANNEL.autoClear, value)
}

contextBridge.exposeInMainWorld('luciumPageAnnotate', api)
