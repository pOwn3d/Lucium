// The template of the small editors: edit a tab, a favourite, the reload of a page, the name of a window,
// a live folder, the QR code, the translation. One width, one header (glyph, title, and in grey what is being edited), one foot: the destructive action
// on the left, "Annuler" then the main action on the right.
//
//   <Sheet title="Modifier l’onglet" context={tab.title} glyph={<PlusGlyph />} onCancel={close}
//          primary={{ label: 'Enregistrer', disabled: !valid }} onSubmit={save} footStart={<button className="tk-btn quiet danger">Fermer l’onglet</button>}>
//     <SheetField label="Nom" error={problem}>{(field) => <input className="tk-field" {...field} value={name} onChange={…} data-autofocus />}</SheetField>
//   </Sheet>
//
// With an `anchor` (the element that opened it, in window coordinates) the sheet is a bubble hung from that element (AnchoredBubble.tsx);
// without one it is the centred sheet.
//
// What it does for every editor: Escape and "Annuler" leave it, Return in a field submits it, Tab stays inside it, the focus goes to the first field
// (or to `data-autofocus`) when it opens and back to what had it when it leaves. It is a form: the main button is its submit button.

import { useId, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { isLeaveKey } from '@shared/panel-keys'
import type { BubbleAlign, BubbleSide } from '@shared/anchored-bubble'
import type { PlusAnchor } from '@shared/plus-menu'
import { AnchoredBubble } from './AnchoredBubble'
import { hueProps } from './hue'
import { useFocusScope } from './useFocusScope'
import './primitives.css'
import './sheet.css'

/** The width every small editor has. */
export const SHEET_WIDTH = 420

export interface SheetProps {
  title: string
  /** What is being edited, in grey: the name of the tab, the domain. */
  context?: string
  glyph?: ReactNode
  hue?: number
  /** A class of the panel itself, for the stylesheet that draws what is its own (`qr-panel`). */
  className?: string
  /** The element that opened the sheet: it is then a bubble hung from it, on `side` (below by default). */
  anchor?: PlusAnchor
  side?: BubbleSide
  align?: BubbleAlign
  /** Escape and "Annuler". */
  onCancel: () => void
  /** Escape, when it is to do less than the cancel button (leave without choosing, where « Tout garder » remembers a choice). Default: `onCancel`. */
  onEscape?: () => void
  /** `null`: no "Annuler" (a sheet that only shows something, and has a main action "Fermer"). */
  cancelLabel?: string | null
  /** The main action: the submit button of the form. */
  primary?: { label: string; disabled?: boolean; busy?: boolean; danger?: boolean }
  /** What the form does when it is submitted (the main button, or Return in a field). */
  onSubmit?: () => void
  /** The destructive action, on the left of the foot. */
  footStart?: ReactNode
  children?: ReactNode
}

export function Sheet({ title, context, glyph, hue, className, anchor, side, align, onCancel, onEscape, cancelLabel, primary, onSubmit, footStart, children }: SheetProps) {
  const root = useRef<HTMLFormElement>(null)
  const titleId = useId()
  const { className: hueClass, style } = hueProps(hue)
  useFocusScope(root, { trap: true })

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!primary?.disabled && !primary?.busy) onSubmit?.()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isLeaveKey(event.nativeEvent)) return
    // The sheet owns Escape while it is open: the host must not close it a second time.
    event.stopPropagation()
    ;(onEscape ?? onCancel)()
  }

  const sheet = (
    <form ref={root} className={['sh tk-panel', hueClass, className].filter(Boolean).join(' ')} style={style} role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={submit} onKeyDown={onKeyDown} noValidate>
      <header className="sh-head">
        {glyph && (
          <span className="tk-glyph" aria-hidden="true">
            {glyph}
          </span>
        )}
        <h2 id={titleId}>{title}</h2>
        {context && (
          <span className="sh-ctx" title={context}>
            {context}
          </span>
        )}
      </header>
      <div className="sh-body">{children}</div>
      <footer className="sh-foot">
        {footStart && <span className="sh-start">{footStart}</span>}
        {cancelLabel !== null && (
          <button type="button" className="tk-btn" onClick={onCancel}>
            {cancelLabel ?? t('templates.annuler')}
          </button>
        )}
        {primary && (
          <button type="submit" className={`tk-btn primary${primary.danger ? ' danger' : ''}`} disabled={primary.disabled} aria-busy={primary.busy ? true : undefined}>
            {primary.label}
          </button>
        )}
      </footer>
    </form>
  )
  return anchor ? (
    <AnchoredBubble anchor={anchor} side={side} align={align}>
      {sheet}
    </AnchoredBubble>
  ) : (
    sheet
  )
}

export interface SheetFieldProps {
  label: string
  /** A line of help under the control. */
  help?: string
  /** What is wrong, said before the person submits: it marks the control invalid and is read with it. */
  error?: string
  /** The control: it must take these props (`id`, `aria-describedby`, `aria-invalid`). */
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactNode
}

export function SheetField({ label, help, error, children }: SheetFieldProps) {
  const id = useId()
  const noteId = `${id}-note`
  return (
    <div className="sh-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(help || error ? { 'aria-describedby': noteId } : {}), ...(error ? { 'aria-invalid': true as const } : {}) })}
      {error ? (
        <p id={noteId} className="sh-error" role="alert">
          {error}
        </p>
      ) : (
        help && (
          <p id={noteId} className="sh-help">
            {help}
          </p>
        )
      )}
    </div>
  )
}
