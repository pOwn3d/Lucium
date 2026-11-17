import { useEffect, useRef } from 'react'
import type { ExtensionReviewRequest, PermissionLevel } from '@shared/extension-review'
import type { KeyEventLike } from '@shared/confirm-box'
import { api } from './api'
import { focusNextIn } from './templates/useFocusScope'
import './arc-dialog.css'
import './extension-review.css'
import { t, tp } from '@shared/i18n'

const LEVEL_LABEL: Record<PermissionLevel, string> = { get broad() { return t('extension-review.acces-etendu') }, get sensitive() { return t('extension-review.sensible') }, normal: '' }

/** What hears the keys of the sheet: the window, before anything below the sheet. */
interface KeyTarget {
  addEventListener(type: 'keydown', listener: (event: KeyEventLike) => void, capture: true): void
  removeEventListener(type: 'keydown', listener: (event: KeyEventLike) => void, capture: true): void
}

/**
 * The keys that belong to the sheet while it is open, wherever the focus is. Escape refuses. Tab goes round the parts of the sheet (backwards with
 * Shift) and comes back into it from outside: the sheet says it is modal (`aria-modal`), and the host under its dimmed layer keeps its controls in
 * the tab order, so without this a Tab would reach them, and a Space typed there would act on what the person cannot see. Every other key is left
 * alone: Return presses the button that has the focus. Answers what takes the listener away.
 */
export function listenReviewKeys(target: KeyTarget, sheet: { box(): HTMLElement | null; active(): Element | null; refuse(): void }): () => void {
  const onKey = (event: KeyEventLike): void => {
    if (event.key !== 'Escape' && event.key !== 'Tab') return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.key === 'Escape') return sheet.refuse()
    const box = sheet.box()
    if (box) focusNextIn(box, sheet.active(), event.shiftKey === true)
  }
  target.addEventListener('keydown', onKey, true)
  return () => target.removeEventListener('keydown', onKey, true)
}

/**
 * The sheet that comes before an extension of the Chrome Web Store is installed or updated: what its package asks for, in plain words,
 * the wide permissions first. It is drawn from the manifest of the package that was downloaded, never from what the store page claims.
 * The same sheet asks before an installed extension is granted a permission its manifest lists as facultative (`optional`): only what it asks for is listed.
 * Escape refuses. Return presses the button that has the focus, which is "Annuler" when the extension asks for wide access: a stray
 * key press cannot accept it. Tab stays inside the sheet.
 */
export function ExtensionReview({ request }: { request: ExtensionReviewRequest }) {
  const { review, mode } = request
  const act = api()
  const answer = (allow: boolean) => act.answerExtensionReview(request.id, allow)
  const cancel = useRef<HTMLButtonElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)

  // Escape and Tab belong to the sheet while it is open, wherever the focus is.
  useEffect(() => listenReviewKeys(window, { box: () => box.current, active: () => document.activeElement, refuse: () => act.answerExtensionReview(request.id, false) }), [act, request.id])

  useEffect(() => {
    ;(review.broad ? cancel : confirm).current?.focus()
  }, [review.broad])

  const title = mode === 'update' ? t('extension-review.mettre-a-jour-name', { name: review.name }) : mode === 'optional' ? t('extension-review.accorder-ce-que-name-demande', { name: review.name }) : t('extension-review.ajouter-name-a-lucium', { name: review.name })
  const intro =
    mode === 'update'
      ? t('extension-review.la-version-version-demande-des-acces-que-la', { version: review.version })
      : mode === 'optional'
        ? t('extension-review.cette-extension-demande-en-plus-de-ce-qu-elle-a-deja')
        : t('extension-review.cette-extension-pourra')
  const nothing = review.permissions.length === 0 && review.sites.scope === 'none'

  return (
    <div className="adlg-scrim" onMouseDown={(e) => e.stopPropagation()}>
      <div ref={box} className="adlg adlg-ext" role="alertdialog" aria-modal="true" aria-label={title} aria-describedby="adlg-ext-intro">
        <div className="ext-head">
          {request.icon ? <img className="ext-icon" src={request.icon} alt="" width={40} height={40} /> : <div className="ext-icon ext-letter" aria-hidden="true">{review.name.slice(0, 1).toUpperCase()}</div>}
          <div className="ext-titles">
            <h2 className="adlg-title">{title}</h2>
            {/* An extension that asks for more may come from a folder: only the sheets of the store name it. */}
            <p className="ext-sub">{mode === 'optional' ? t('extension-review.version-version', { version: review.version }) : t('extension-review.version-chrome-web-store', { version: review.version })}</p>
          </div>
        </div>
        {review.description && <p className="ext-description">{review.description}</p>}
        {review.warning && (
          <p className="ext-warning" role="note">
            {review.warning}
          </p>
        )}
        <p className="ext-intro" id="adlg-ext-intro">
          {intro}
        </p>
        <ul className="ext-list" aria-label={t('extension-review.autorisations-demandees')}>
          {review.sites.scope !== 'none' && (
            <li className={review.sites.scope === 'all' ? 'ext-broad' : 'ext-sensitive'}>
              <span className="ext-what">{review.sites.line}</span>
              {review.sites.scope === 'all' ? <b className="ext-level">{LEVEL_LABEL.broad}</b> : <b className="ext-level">{LEVEL_LABEL.sensitive}</b>}
              {review.sites.scope === 'specific' && review.sites.patterns.length > 0 && (
                <small className="ext-patterns">
                  {review.sites.patterns.join('  ')}
                  {review.sites.count > review.sites.patterns.length ? `  ${t('extension-review.et-count-autres', { count: review.sites.count - review.sites.patterns.length })}` : ''}
                </small>
              )}
            </li>
          )}
          {review.permissions.map((permission) => (
            <li key={permission.id} className={`ext-${permission.level}`}>
              <span className="ext-what">{permission.label}</span>
              {LEVEL_LABEL[permission.level] && <b className="ext-level">{LEVEL_LABEL[permission.level]}</b>}
              <small className="ext-patterns">{permission.id}</small>
            </li>
          ))}
          {nothing && <li className="ext-normal">{t('extension-review.aucune-autorisation-particuliere')}</li>}
        </ul>
        <p className="ext-foot">
          {[
            mode === 'install' ? t('extension-review.elle-sera-installee-dans-le-profil-profile', { profile: request.profile }) : '',
            mode === 'optional' ? t('extension-review.l-autorisation-vaudra-pour-le-profil-profile', { profile: request.profile }) : '',
            review.optionalCount > 0 ? tp('extension-review.autorisations-facultatives-demandees-plus-tard', review.optionalCount) : ''
          ].filter((sentence) => sentence !== '').join(' ')}
        </p>
        <div className="adlg-actions">
          <button ref={cancel} type="button" className="adlg-btn adlg-cancel" onClick={() => answer(false)}>
            {t('confirm-box.annuler')}
            <kbd>ESC</kbd>
          </button>
          <button ref={confirm} type="button" className="adlg-btn adlg-confirm" onClick={() => answer(true)}>
            {mode === 'update' ? t('passwords-panel.mettre-a-jour') : mode === 'optional' ? t('permissions.autoriser') : t('settings.ajouter')}
          </button>
        </div>
      </div>
    </div>
  )
}
