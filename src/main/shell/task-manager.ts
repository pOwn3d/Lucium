import type { BrowserWindow } from 'electron'

export interface TaskManagerDeps {
  /** Webcontents allowed to call the privileged IPC. */
  trusted: Set<number>
  createWindow: () => BrowserWindow
}

/** The task manager window (Help › Troubleshooting): one window, reused, trusted only while it exists. */
export class TaskManager {
  private win: BrowserWindow | null = null

  constructor(private readonly deps: TaskManagerDeps) {}

  open(): void {
    const existing = this.win
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    const win = this.deps.createWindow()
    this.win = win
    const id = win.webContents.id
    this.deps.trusted.add(id)
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key.toLowerCase() === 'w' && (input.meta || input.control)) {
        event.preventDefault()
        win.close()
      }
    })
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      this.deps.trusted.delete(id)
      if (this.win === win) this.win = null
    })
  }

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  close(): void {
    if (this.isOpen()) this.win!.close()
  }
}
