import { t } from '@shared/i18n'
import type { BarClipNotice } from './bar-clipboard'

/**
 * "Copier" and "Coller", at the right of the genres on the row under the field. The word on "Copier" becomes "Copié" for a moment, and the live region says
 * what happened to a screen reader; when nothing could be done, the sentence that says why is on screen, beside the buttons. The buttons take no focus from
 * the field when clicked (the pointer would take the caret away), and are buttons for the keyboard.
 */
/** The sentence of a notice of the bar, as the live region says it; '' with none. */
export function barNoticeText(notice: BarClipNotice | null): string {
  if (notice === null) return ''
  return notice.kind === 'problem' || notice.kind === 'told' ? notice.message : notice.kind === 'copied' ? t('cmd.copie') : t('cmd.colle')
}

export function BarClipboardButtons({ notice, onCopy, onPaste }: { notice: BarClipNotice | null; onCopy: () => void; onPaste: () => void }) {
  const copied = notice?.kind === 'copied'
  const said = barNoticeText(notice)
  const copyName = copied ? t('cmd.copie') : t('cmd.copier-le-texte-du-champ')
  return (
    <div className="cb-clip" role="group" aria-label={t('cmd.presse-papiers')}>
      {/* Always in the markup, so that a screen reader hears the change of its text; the sentence of a problem is shown, a confirmation is only said. */}
      <span className={`cb-clip-note ${notice?.kind === 'problem' ? 'problem' : ''}`} title={notice?.kind === 'problem' ? said : undefined} role="status" aria-live="polite" aria-atomic="true">
        {said}
      </span>
      <button type="button" className={`cb-clip-copy ${copied ? 'done' : ''}`} title={copyName} aria-label={copyName} onMouseDown={(e) => e.preventDefault()} onClick={onCopy}>
        {copied ? t('cmd.copie') : t('cmd.copier')}
      </button>
      <button type="button" className="cb-clip-paste" title={t('cmd.coller-a-la-place-du-texte-du-champ')} aria-label={t('cmd.coller-a-la-place-du-texte-du-champ')} onMouseDown={(e) => e.preventDefault()} onClick={onPaste}>
        {t('cmd.coller')}
      </button>
    </div>
  )
}
