// IPC of the clipboard for the "Copier" and "Coller" buttons of the command bar. Registered for each window with the window's own scoped IPC and
// guard (see registerIpc). The main process reads and writes the text: the interface never receives HTML or an image from the clipboard, never a
// text longer than an address (it is not cut, it is refused), and what it asks to write is checked again here.

import type { WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { CLIPBOARD_TEXT_MAX, isClipboardWrite, type ClipboardTextReply } from '@shared/clipboard-text'
import type { ScopedIpc } from './ipc-scope'

/** The part of Electron's `clipboard` this uses (its calls are asynchronous in Electron 45); a fake stands in for it in the tests. */
export interface TextClipboard {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

export function registerClipboardIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, clipboard: TextClipboard): void {
  ipcMain.handle(Channel.clipboardRead, async (e): Promise<ClipboardTextReply> => {
    if (!guard(e.sender, Channel.clipboardRead)) return { ok: false, reason: 'unreadable' }
    try {
      const text = await clipboard.readText()
      if (typeof text !== 'string') return { ok: false, reason: 'unreadable' }
      return text.length > CLIPBOARD_TEXT_MAX ? { ok: false, reason: 'too-long' } : { ok: true, text }
    } catch (error) {
      console.error('[clipboard] cannot read the text:', error instanceof Error ? error.name : typeof error)
      return { ok: false, reason: 'unreadable' }
    }
  })

  ipcMain.handle(Channel.clipboardWrite, async (e, text: unknown): Promise<boolean> => {
    if (!guard(e.sender, Channel.clipboardWrite)) return false
    if (!isClipboardWrite(text)) {
      console.warn('[clipboard] a text that is not 1 to', CLIPBOARD_TEXT_MAX, 'characters was refused:', typeof text === 'string' ? text.length : typeof text)
      return false
    }
    try {
      await clipboard.writeText(text)
      return true
    } catch (error) {
      console.error('[clipboard] cannot write the text:', error instanceof Error ? error.name : typeof error)
      return false
    }
  })
}
