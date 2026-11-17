// The two buttons that end a confirmation shown inside a panel (not a box of its own): "Annuler", then the red one that erases. "Annuler" has the focus
// when they appear, so that a Return typed at once keeps things as they are; the red button is reached with Tab or the pointer (shared/confirm-box.ts).

interface ConfirmActionsProps {
  cancelLabel: string
  confirmLabel: string
  /** Extra class of the red button (the engine tests and the stylesheet reach it by this). */
  confirmClass?: string
  /** Extra class of the cancel button. */
  cancelClass?: string
  confirmDisabled?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmActions({ cancelLabel, confirmLabel, confirmClass = '', cancelClass = '', confirmDisabled = false, onCancel, onConfirm }: ConfirmActionsProps) {
  return (
    <>
      <button className={`button ${cancelClass}`.trim()} autoFocus onClick={onCancel}>
        {cancelLabel}
      </button>
      <button className={`button primary ${confirmClass}`.trim()} disabled={confirmDisabled} onClick={onConfirm}>
        {confirmLabel}
      </button>
    </>
  )
}
