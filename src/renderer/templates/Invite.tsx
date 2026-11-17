// The template of the invites: what the browser asks the person before it goes on: a site's permission, a sign-in,
// a box of the page, the lock screen. A coloured pastille, a title that names the site, one sentence, the fields, a risk written with its icon, then
// the answers: the safe one has the focus when the invite opens, so that a reflex key does no harm.
//
//   <Invite tone="info" glyph={<KeyGlyph />} title={<>Connexion à <strong>exemple.org</strong></>} lead="Le site demande un identifiant."
//           dismiss={{ label: 'Annuler', kbd: 'ESC', onClick: refuse }} accept={{ label: 'Se connecter', kbd: '↩', onClick: answer }}>
//     <input className="tk-field" … />
//   </Invite>
//
// What it does for every invite: Escape refuses (wherever the focus is), Return in a field answers, the "remember this choice" box is never ticked
// for the person, and the host's own handling of the backdrop never reaches it.

import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { isAnswerKey, isLeaveKey } from '@shared/panel-keys'
import { AlertGlyph } from './glyphs'
import { hueProps } from './hue'
import { useFocusScope } from './useFocusScope'
import './primitives.css'
import './invite.css'

export type InviteTone = 'accent' | 'info' | 'ok' | 'warn' | 'danger'

export interface InviteAnswer {
  label: string
  /** The key shown on the button ("ESC", "↩"). */
  kbd?: string
  onClick?: () => void
}

export interface InviteProps {
  /** The colour of the pastille: the kind of request. */
  tone?: InviteTone
  glyph: ReactNode
  hue?: number
  /** A class of the invite itself, for what is its own. */
  className?: string
  /** Who asks, above the title ("Message de exemple.org"): the host the browser knows, never a text of the page. */
  kicker?: string
  /** The title: the site in `<strong>`, the rest in regular weight. */
  title: ReactNode
  lead?: ReactNode
  /** The fields, between the sentence and the answers. Give the first one `data-autofocus` to start in it. */
  children?: ReactNode
  /** A risk the person must read, with its icon. */
  banner?: { tone?: 'warn' | 'danger'; text: ReactNode; /** Announced at once (a refusal just happened) instead of read with the invite. */ alert?: boolean }
  /** "Se souvenir pour ce site": offered unticked, and only if it makes sense. */
  remember?: { label: string; checked: boolean; onChange: (checked: boolean) => void }
  /** The safe answer ("Refuser", "Annuler"): Escape and the focus on opening, unless `initialFocus` says otherwise. */
  dismiss: InviteAnswer
  accept: InviteAnswer & { disabled?: boolean; danger?: boolean }
  /** Where the focus starts: on the safe answer (by default), or in the first field (a sign-in: the person came to type). */
  initialFocus?: 'dismiss' | 'field'
  /** The form is submitted by Return in a field and by the accept button. */
  onSubmit?: () => void
  /** A dimmed layer behind, over the whole window: the invite is modal. */
  scrim?: boolean
}

export function Invite({ tone = 'accent', glyph, hue, className, kicker, title, lead, children, banner, remember, dismiss, accept, initialFocus = 'dismiss', onSubmit, scrim = true }: InviteProps) {
  const root = useRef<HTMLFormElement>(null)
  const titleId = useId()
  const leadId = useId()
  const { className: hueClass, style } = hueProps(hue)
  const dismissRef = useRef(dismiss.onClick)
  dismissRef.current = dismiss.onClick
  useFocusScope(root, { trap: true, initial: initialFocus === 'field' ? '[data-autofocus]' : '[data-dismiss]' })

  // Escape belongs to the invite while it is open, wherever the focus is: the page behind must not get it.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (!isLeaveKey({ key: event.key })) return
      event.preventDefault()
      event.stopImmediatePropagation()
      dismissRef.current?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!accept.disabled) (onSubmit ?? accept.onClick)?.()
  }
  // Return on a button presses that button; in a field it answers.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isAnswerKey(event.nativeEvent, (event.target as HTMLElement).tagName)) return
    event.preventDefault()
    if (!accept.disabled) (onSubmit ?? accept.onClick)?.()
  }

  const card = (
    <form
      ref={root}
      className={['iv tk-panel', hueClass, className].filter(Boolean).join(' ')}
      style={style}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={lead ? leadId : undefined}
      onSubmit={submit}
      onKeyDown={onKeyDown}
      noValidate
    >
      <div className="iv-body">
        <span className={`tk-glyph ${tone === 'accent' ? '' : tone}`.trim()} aria-hidden="true">
          {glyph}
        </span>
        <div className="iv-text">
          {kicker && <span className="iv-kicker">{kicker}</span>}
          <h2 id={titleId} className="iv-title">
            {title}
          </h2>
          {lead && (
            <p id={leadId} className="iv-lead">
              {lead}
            </p>
          )}
        </div>
      </div>
      {children && <div className="iv-fields">{children}</div>}
      {banner && (
        <p className={`tk-banner iv-banner ${banner.tone ?? 'warn'}`} role={banner.alert ? 'alert' : 'note'}>
          <AlertGlyph />
          <span>{banner.text}</span>
        </p>
      )}
      {remember && (
        <label className="iv-remember">
          <input type="checkbox" checked={remember.checked} onChange={(event) => remember.onChange(event.target.checked)} />
          {remember.label}
        </label>
      )}
      <div className="iv-foot">
        <button type="button" className="tk-btn" data-dismiss="" onClick={dismiss.onClick}>
          {dismiss.label}
          {dismiss.kbd && <kbd className="tk-kbd">{dismiss.kbd}</kbd>}
        </button>
        <button type="submit" className={`tk-btn primary${accept.danger ? ' danger' : ''}`} disabled={accept.disabled}>
          {accept.label}
          {accept.kbd && <kbd className="tk-kbd">{accept.kbd}</kbd>}
        </button>
      </div>
    </form>
  )
  return scrim ? (
    <div className="iv-scrim" onMouseDown={(event) => event.stopPropagation()}>
      {card}
    </div>
  ) : (
    card
  )
}
