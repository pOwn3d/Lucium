import { useEffect, useRef, type ReactNode } from 'react'
import { arcDialogKeyHandler, type DialogFocus } from '@shared/confirm-box'
import { t } from '@shared/i18n'
import { focusNextIn } from './templates/useFocusScope'
import './arc-dialog.css'

interface ArcDialogProps {
  title: string
  message?: string
  /** What the box is about, one line each (the profiles it will erase): a list under the message, which makes the box taller. */
  items?: readonly string[]
  /** A 34 px glyph in white; a bin by default. */
  icon?: ReactNode
  cancelLabel?: string
  confirmLabel: string
  /**
   * The confirm button is red (an action that cannot be undone) unless this is false. A red box has "Annuler" for its default button, focused when it
   * opens: Return does not confirm it (the rule is in shared/confirm-box.ts).
   */
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}

const BIN = (
  <svg viewBox="0 0 34 34" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9h22M13 9V6h8v3M9 9l1.200 19a2 2 0 0 0 2 1.800h9.600a2 2 0 0 0 2-1.800L25 9M14 14.500v9M20 14.500v9" />
  </svg>
)

/**
 * The standard confirmation box (450 wide, 273 tall or more when its text is long), for every question that needs a yes or a no: Escape cancels, Return presses the default button. That is
 * the confirmation for a question that costs nothing, and "Annuler" for one that erases or deletes (`danger`, the default here): a Return typed by
 * habit, or held down, must not throw anything away. A button reached with Tab is the one Return presses, and Tab stays inside the box.
 * It is drawn over a dimmed layer that covers its host.
 */
export function ArcDialog({ title, message, items, icon = BIN, cancelLabel = t('confirm-box.annuler'), confirmLabel, danger = true, onCancel, onConfirm }: ArcDialogProps) {
  const cancelButton = useRef<HTMLButtonElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Heard on the window, before anything below the dialog: the keys belong to the dialog while it is open.
    const onKey = arcDialogKeyHandler({
      danger,
      focus: (): DialogFocus => (document.activeElement === confirmButton.current ? 'confirm' : document.activeElement === cancelButton.current ? 'cancel' : 'other'),
      onCancel,
      onConfirm,
      // The host under the dimmed layer keeps its controls in the tab order: Tab goes round the buttons of the box, wherever the focus was.
      onTab: (backwards) => void (box.current && focusNextIn(box.current, document.activeElement, backwards))
    })
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [danger, onCancel, onConfirm])

  return (
    <div className="adlg-scrim" onMouseDown={(e) => e.stopPropagation()}>
      <div ref={box} className={`adlg ${items && items.length > 0 ? 'adlg-list' : ''}`} role="alertdialog" aria-modal="true" aria-label={title} aria-describedby={message ? 'adlg-message' : undefined}>
        <div className="adlg-icon">{icon}</div>
        <h2 className="adlg-title">{title}</h2>
        {message && (
          <p className="adlg-message" id="adlg-message">
            {message}
          </p>
        )}
        {items && items.length > 0 && (
          <ul className="adlg-items">
            {items.map((item, index) => (
              <li key={index} title={item}>
                {item}
              </li>
            ))}
          </ul>
        )}
        <div className="adlg-actions">
          <button ref={cancelButton} className="adlg-btn adlg-cancel" autoFocus={danger} onClick={onCancel}>
            {cancelLabel}
            <kbd>ESC</kbd>
          </button>
          <button ref={confirmButton} className={`adlg-btn ${danger ? 'adlg-danger' : 'adlg-confirm'}`} autoFocus={!danger} onClick={onConfirm}>
            {confirmLabel}
            {!danger && <kbd>↩</kbd>}
          </button>
        </div>
      </div>
    </div>
  )
}
