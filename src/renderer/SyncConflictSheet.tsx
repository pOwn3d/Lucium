import { useState } from 'react'
import { getLanguage, quoted, t, tp, type MessageKey } from '@shared/i18n'
import { formatWhen, renderText, viewOf, type ConflictView, type SettledChange, type SettledConflict, type SettledValue, type TextRef } from '@shared/sync-conflicts'
import { AlertGlyph, Sheet } from './templates'
import './sync-conflict.css'

const translate = (key: string, vars: Record<string, string>): string => t(key as MessageKey, vars)
const say = (ref: TextRef): string => renderText(ref, translate)

/** A value as the person reads it: what they typed, « oui » or « non », or a word that says there is nothing to show. */
function valueText(value: SettledValue): string {
  switch (value.t) {
    case 'text':
      return value.text
    case 'bool':
      return t(value.value ? 'sync-conflict.value-yes' : 'sync-conflict.value-no')
    case 'absent':
      return t('sync-conflict.value-none')
    case 'complex':
      return t('sync-conflict.value-other')
  }
}

const Check = () => (
  <svg className="sc-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </svg>
)

/** « Comparer » opens the line it is on and closes it when it is open: one line at a time. */
export const nextComparing = (current: string | null, id: string): string | null => (current === id ? null : id)

export interface SyncConflictSheetProps {
  /** The lines to tell: those of the last session of the journal (`lastSession`). */
  entries: readonly SettledConflict[]
  /** The time of the screen, to say « 9 h 15 » for today and the date for another day. */
  now?: number
  /** « D'accord ». */
  onClose: () => void
  /**
   * « Rétablir cette version » and « Le supprimer partout »: put the version that lost back. It is an ordinary change of the state, which goes out at the next
   * session like any other, and the host takes the line out of the journal. The sheet itself changes nothing.
   */
  onRestore: (change: SettledChange, id: string) => void
  /** The line open on « Comparer » when the sheet opens (the tests open it so). */
  initialComparing?: string
}

/**
 * « Conflit réglé » (docs/synchronisation.md §13.4, the mockup « Conflit »): « Deux changements se croisaient », and for each conflict what each device did
 * and what is in force. Never a question that blocks: the merge has settled, « D'accord » only closes the sheet. « Comparer » shows the two versions, with
 * the possibility to put back the one that lost; a deletion that lost has no two versions to show and offers « Le supprimer partout » instead.
 * The page « Synchronisation » of the settings (card 444) mounts it with the lines of the journal and the host's way of changing the state.
 */
export function SyncConflictSheet({ entries, now, onClose, onRestore, initialComparing }: SyncConflictSheetProps) {
  const [comparing, setComparing] = useState<string | null>(initialComparing ?? null)
  const at = now ?? Date.now()
  const language = getLanguage()
  const cards = entries.map((entry) => ({ entry, view: viewOf(entry) }))

  const card = ({ entry, view }: { entry: SettledConflict; view: ConflictView }) => {
    const open = comparing === view.id
    const restore = view.restore
    return (
      <li key={view.id} className="sc-card">
        <h3 className="sc-title">
          <span className="sc-kind">{say(view.title)}</span>
          {view.label !== null && (
            <span className="sc-label" title={view.label}>
              {quoted(view.label)}
            </span>
          )}
        </h3>
        <ul className="sc-rows">
          {view.rows.map((row) => (
            <li key={row.platform} className={row.kept ? 'kept' : 'lost'}>
              <span className="sc-device">{t(row.platform === 'mac' ? 'sync-conflict.device-mac' : 'sync-conflict.device-ios')}</span>
              <span className="sc-text">{say(row.text)}</span>
              {row.at !== null && <span className="sc-time">{formatWhen(row.at, at, language)}</span>}
            </li>
          ))}
        </ul>
        <p className="sc-outcome">
          <Check />
          {say(view.outcome)}
        </p>
        {(view.compare || restore !== null) && (
          <div className="sc-actions">
            {view.compare ? (
              <button type="button" className="tk-btn" aria-expanded={open} onClick={() => setComparing(nextComparing(comparing, view.id))}>
                {open ? t('sync-conflict.hide-compare') : t('sync-conflict.compare')}
              </button>
            ) : (
              <button type="button" className="tk-btn" onClick={() => restore !== null && onRestore(restore, view.id)}>
                {t('sync-conflict.delete-everywhere')}
              </button>
            )}
          </div>
        )}
        {open && (
          <div className="sc-compare">
            <section className="sc-version kept" aria-label={t('sync-conflict.kept-version')}>
              <h4>{t('sync-conflict.kept-version')}</h4>
              <p className="sc-value">{valueText(entry.kept)}</p>
            </section>
            <section className="sc-version lost" aria-label={t('sync-conflict.other-version')}>
              <h4>{t('sync-conflict.other-version')}</h4>
              <p className="sc-value">{valueText(entry.lost)}</p>
              {restore !== null && (
                <button type="button" className="tk-btn" onClick={() => onRestore(restore, view.id)}>
                  {t('sync-conflict.restore')}
                </button>
              )}
            </section>
            <p className="sh-help sc-explain">{t('sync-conflict.explain-restore')}</p>
          </div>
        )}
      </li>
    )
  }

  return (
    <Sheet title={t('sync-conflict.title')} context={tp('sync-conflict.count', entries.length)} glyph={<AlertGlyph />} className="sync-conflict" onCancel={onClose} cancelLabel={null} primary={{ label: t('sync-conflict.ok') }} onSubmit={onClose}>
      <p className="sh-help">{t('sync-conflict.subtitle')}</p>
      <ul className="sc-list">{cards.map(card)}</ul>
    </Sheet>
  )
}
