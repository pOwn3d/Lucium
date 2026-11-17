// Loaded into the helper page of a capture of the sound of a tab, and into nothing else (main/engine/tab-capture-helper.ts: a window of its own, at its own address). It gives
// that page ONE function, `send`, which hands a chunk of sound to the main process on one channel; the main process takes it only from the main frame of a helper page that
// exists, and judges its shape, its order and its pace (shared/tab-capture-pcm.ts). Nothing else of Lucium reaches the page: no window.lucium, no other channel, no answer.

import { contextBridge, ipcRenderer } from 'electron'
import { Channel } from '../shared/ipc-channels'

contextBridge.exposeInMainWorld('luciumCapture', {
  send: (chunk: unknown): void => {
    // Bytes only: whatever else the page holds does not leave it.
    if (Object.prototype.toString.call(chunk) === '[object ArrayBuffer]') ipcRenderer.send(Channel.capturePcm, chunk)
  }
})
