// « Notifications récentes »: the notices of this window, the latest first, for one that went by too fast. In memory only; nothing is fetched.
// Opened by Affichage › Notifications récentes or the command bar.

import type { NoticeEntry } from '@shared/notice-log'
import { api } from './api'
import { t } from '@shared/i18n'
import './notices.css'

const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** The panel as it is drawn from the list it is given. */
export function NoticesView({ items, onClose }: { items: readonly NoticeEntry[]; onClose: () => void }) {
  return (
    <div className="card notices" role="dialog" aria-modal="true" aria-labelledby="notices-title">
      <h2 id="notices-title">{t('notices.notifications-recentes')}</h2>
      <p className="muted notices-lead">{t('notices.les-dernieres-depuis-l-ouverture-de-cette-fenetre')}</p>
      {items.length === 0 ? (
        <p className="notices-empty">{t('notices.aucune-notification-pour-l-instant')}</p>
      ) : (
        <ul className="notices-list">
          {items.map((item, index) => (
            // The same words can come at the same second: the position keeps the lines apart.
            <li key={`${index}-${item.at}`}>
              <time dateTime={new Date(item.at).toISOString()}>{time(item.at)}</time>
              <span className="notices-words">
                <span>{item.message}</span>
                {item.detail && <span className="muted">{item.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="row end">
        <button type="button" className="button primary" onClick={onClose} autoFocus>
          {t('translate.close')}
        </button>
      </div>
    </div>
  )
}

export function NoticesPanel({ items }: { items: readonly NoticeEntry[] }) {
  return <NoticesView items={items} onClose={() => api().closeOverlay()} />
}
