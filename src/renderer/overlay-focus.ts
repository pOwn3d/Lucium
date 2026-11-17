// The focus of a panel of the overlay. A panel with no field leaves the focus on nothing, and then Escape and Tab reach no one: the panel itself
// (a dialog or a menu) takes the focus. The same happens later, when the row that had the focus is removed (« Supprimer » then « Confirmer » in the
// bookmarks, a site deleted in the cookies): the focus falls back on the document, so the panel takes it again and Escape still closes it.

/** What is read of the document: the element that has the focus, and the body, which has it when nothing does. */
export interface FocusHolder {
  activeElement: Element | null
  body: Element | null
}

/**
 * Gives the focus to the panel drawn under `root` when nothing has it. True when something has the focus afterwards; false while no panel is
 * drawn yet (some panels draw nothing until the first snapshot has arrived).
 */
export function takePanelFocus(root: Pick<HTMLElement, 'querySelector'>, holder: FocusHolder): boolean {
  if (holder.activeElement && holder.activeElement !== holder.body) return true
  const panel = root.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"]')
  if (!panel) return false
  if (!panel.hasAttribute('tabindex')) panel.tabIndex = -1
  panel.focus({ preventScroll: true })
  return true
}

/**
 * Whether the panel drawn under `root` says that a work is under way whose answer only it can show (`aria-busy` on the dialog: an import that
 * runs in the main process). Escape and a press outside leave such a panel open: closed, the work would go on with no one to show what it did.
 */
export function panelIsBusy(root: Pick<Element, 'querySelector'>): boolean {
  return root.querySelector('[role="dialog"][aria-busy="true"]') !== null
}

/**
 * Keeps a focus in the panel for as long as it is open: taken at once, and again after each change of what the panel draws that left the focus
 * on nothing. `watch` calls its argument at each such change and answers how to stop; the answer of this function stops the watch.
 */
export function keepPanelFocus(root: Pick<HTMLElement, 'querySelector'>, holder: FocusHolder, watch: (changed: () => void) => () => void): () => void {
  takePanelFocus(root, holder)
  return watch(() => void takePanelFocus(root, holder))
}
