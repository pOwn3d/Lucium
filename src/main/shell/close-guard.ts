// "Avertir avant de fermer une fenêtre de plusieurs onglets": the question asked when a window is closed by hand (the red button,
// ⇧⌘W). The rules are shared/window-close.ts. The listener on a window's `close` event exists only while the setting is on: switched
// off, nothing of this runs.

import { dialog, type BrowserWindow, type Event as ElectronEvent } from 'electron'
import { closeWarning, windowTabCount, type WindowCloseWarning } from '@shared/window-close'
import type { WindowRecord } from './windows'
import { t } from '@shared/i18n'

export interface CloseAnswer {
  /** Close the window after all. */
  close: boolean
  /** "Fermer et ne plus demander": the setting goes off. */
  stopAsking: boolean
}

export type CloseAsker = (win: BrowserWindow, warning: WindowCloseWarning) => Promise<CloseAnswer>

/** The question as a sheet on the window; Cancel is the default button, so that a stray Return keeps the window. */
export const askWithSheet: CloseAsker = async (win, warning) => {
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [t('translate.close'), t('confirm-box.annuler')],
    defaultId: 1,
    cancelId: 1,
    message: warning.message,
    detail: warning.detail,
    checkboxLabel: t('close-guard.fermer-et-ne-plus-demander'),
    checkboxChecked: false
  })
  return { close: response === 0, stopAsking: response === 0 && checkboxChecked }
}

/** What the guard needs of the window manager. */
export interface CloseGuardHost {
  windowCount(): number
  quitting(): boolean
  /** Switches the setting off (the sheet's checkbox). */
  stopAsking(): void
}

export class CloseGuard {
  private enabled = false
  private readonly watched = new Set<WindowRecord>()
  private readonly handlers = new Map<WindowRecord, (event: ElectronEvent) => void>()
  /** Windows the user said yes for: their next `close` goes through. */
  private readonly confirmed = new Set<WindowRecord>()
  private readonly asking = new Set<WindowRecord>()

  constructor(
    private readonly host: CloseGuardHost,
    /** Replaced by the engine test: a recorder instead of a real sheet nobody could answer. */
    public ask: CloseAsker = askWithSheet
  ) {}

  /** Number of windows carrying the listener (the engine test reads it: off means none). */
  listening(): number {
    return this.handlers.size
  }

  watch(record: WindowRecord): void {
    this.watched.add(record)
    if (this.enabled) this.attach(record)
  }

  unwatch(record: WindowRecord): void {
    this.watched.delete(record)
    this.detach(record)
    this.confirmed.delete(record)
    this.asking.delete(record)
  }

  /** Follows the setting: the listener is put on every window while it is on, and taken off again when it goes off. */
  sync(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    for (const record of this.watched) {
      if (enabled) this.attach(record)
      else this.detach(record)
    }
  }

  private attach(record: WindowRecord): void {
    if (this.handlers.has(record) || record.win.isDestroyed()) return
    const handler = (event: ElectronEvent): void => this.onClose(record, event)
    this.handlers.set(record, handler)
    // First of the window's listeners, whenever the setting comes on: what comes after (the main window put away on macOS, windows.ts) sees a close
    // the question holds as prevented, and waits for the answer.
    record.win.prependListener('close', handler)
  }

  private detach(record: WindowRecord): void {
    const handler = this.handlers.get(record)
    if (!handler) return
    this.handlers.delete(record)
    if (!record.win.isDestroyed()) record.win.off('close', handler)
  }

  private onClose(record: WindowRecord, event: ElectronEvent): void {
    if (this.confirmed.delete(record)) return
    const state = record.store.get()
    const warning = closeWarning({
      kind: record.kind,
      ...(record.guest === true ? { guest: true as const } : {}),
      windows: this.host.windowCount(),
      quitting: this.host.quitting(),
      tabs: windowTabCount(state, record.kind),
      ...(record.kind === 'private' ? {} : { space: state.spaces.find((space) => space.id === state.activeSpaceId)?.name })
    })
    if (!warning) return
    event.preventDefault()
    // The question is already on screen: a second attempt to close does not stack another one.
    if (this.asking.has(record)) return
    this.asking.add(record)
    this.ask(record.win, warning)
      .then((answer) => {
        if (answer.stopAsking) this.host.stopAsking()
        if (!answer.close || record.win.isDestroyed()) return
        this.confirmed.add(record)
        record.win.close()
      })
      .catch((error: unknown) => {
        // Closing a window by mistake is what the setting guards against: when the question cannot be asked, the window stays open.
        console.error(`[close-guard] cannot ask about closing window ${record.id}; it stays open:`, error)
      })
      .finally(() => this.asking.delete(record))
  }
}
