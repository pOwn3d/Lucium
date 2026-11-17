// The rule of every box that asks before something is lost (erased, deleted, replaced, interrupted): the way out is the default button, so that a
// Return typed by habit, or held down, or meant for another window, leaves things as they are. Pure; the native boxes (main process) and the
// boxes drawn by the interface (renderer/ArcDialog.tsx) both take their decision from here.

/** The buttons of a two-choice native box (`dialog.showMessageBox*`), the confirmation first and the way out last, as macOS lays them out. */
export interface ConfirmButtons {
  buttons: [string, string]
  /** The button Return presses. */
  defaultId: number
  /** The button Escape (and a closed sheet) answers. */
  cancelId: number
}

/**
 * The two buttons of a question. When confirming `destroys` something, Cancel is the default button; otherwise the confirmation is (a question
 * whose answer costs nothing, like "Export?", is answered by Return as usual).
 */
export function confirmButtons(confirm: string, cancel: string, destroys: boolean): ConfirmButtons {
  return { buttons: [confirm, cancel], defaultId: destroys ? 1 : 0, cancelId: 1 }
}

/** What has the focus in a box drawn by the interface. */
export type DialogFocus = 'cancel' | 'confirm' | 'other'

/** What a key does in such a box. */
export type DialogKeyAction = 'cancel' | 'confirm' | 'ignore'

/**
 * The reaction of a drawn box to a key, or null for a key that is none of its business (it goes on to the page below). Escape cancels.
 * Return presses the default button: Cancel when the box is `danger` (it erases or deletes), the confirmation otherwise. A button that was
 * reached on purpose (Tab) is the one Return presses, in both. A Return that repeats (a key held down) does nothing: a box must never be
 * confirmed by a key that was pressed for something else and not released.
 */
export function arcDialogKey(input: { key: string; repeat: boolean; focus: DialogFocus; danger: boolean }): DialogKeyAction | null {
  if (input.key === 'Escape') return 'cancel'
  if (input.key !== 'Enter') return null
  if (input.repeat) return 'ignore'
  if (input.focus === 'confirm') return 'confirm'
  if (input.focus === 'cancel') return 'cancel'
  return input.danger ? 'cancel' : 'confirm'
}

/** What the handler needs of a keyboard event (a DOM `KeyboardEvent` has all of it). */
export interface KeyEventLike {
  key: string
  repeat: boolean
  shiftKey?: boolean
  preventDefault(): void
  stopImmediatePropagation(): void
}

/**
 * The key handler of a drawn box. A key the box answers is taken from the page below (the default action of the button that has the focus is
 * stopped too, so that a Return answered here is not answered a second time by a click); any other key goes on.
 * Tab belongs to the box too: `onTab` moves the focus round its own buttons (backwards with Shift), so that it never reaches a control of the
 * host, which stays in the tab order under the dimmed layer.
 */
export function arcDialogKeyHandler(box: { danger: boolean; focus(): DialogFocus; onCancel(): void; onConfirm(): void; onTab(backwards: boolean): void }): (event: KeyEventLike) => void {
  return (event) => {
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopImmediatePropagation()
      return box.onTab(event.shiftKey === true)
    }
    const action = arcDialogKey({ key: event.key, repeat: event.repeat, focus: box.focus(), danger: box.danger })
    if (action === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (action === 'cancel') box.onCancel()
    else if (action === 'confirm') box.onConfirm()
  }
}
