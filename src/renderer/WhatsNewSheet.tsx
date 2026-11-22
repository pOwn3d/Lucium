// "Quoi de neuf": what this version changed, in the first points of the changelog shipped with the application, and "Voir tout" for the rest. Opened by
// an update (once per version), then with "Ne plus montrer" (the function goes off, and a notice offers to undo it), or by Aide › Nouveautés. Nothing is fetched.

import { useState } from 'react'
import type { WhatsNewSheet as Sheet } from '@shared/whats-new'
import { api } from './api'
import { DISCOVER_REQUEST } from '@shared/discover'
import { t } from '@shared/i18n'
import './whats-new.css'

/** The sheet as it is drawn from what it is given. */
export function WhatsNewView({ sheet, onClose, onNever, onDiscover }: { sheet: Sheet; onClose: () => void; onNever: () => void; onDiscover?: () => void }) {
  const [all, setAll] = useState(false)
  const shown = all ? sheet.points : sheet.points.slice(0, sheet.featured)
  const more = sheet.points.length - sheet.featured
  return (
    <div className="card news" role="dialog" aria-modal="true" aria-labelledby="news-title" aria-describedby="news-lead">
      <h2 id="news-title">{t('whats-new.nouveautes-d-lucium-version', { version: sheet.version })}</h2>
      <p className="muted news-lead" id="news-lead">
        {sheet.fromUpdate ? t('whats-new.mise-a-jour-installee-lu-dans-un-fichier-livre') : t('whats-new.lu-dans-un-fichier-livre-avec-l-application')}
      </p>
      {sheet.points.length === 0 ? (
        <p className="news-empty">{t('whats-new.aucune-note-pour-cette-version')}</p>
      ) : (
        <ul className="news-points">
          {shown.map((point, index) => (
            // Two lines of a changelog can start the same way: the position keeps them apart.
            <li key={`${index}-${point.title}`}>
              <b>{point.title}</b>
              {point.text && <span>{point.text}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="row end">
        {sheet.fromUpdate && (
          <button type="button" className="button news-never" onClick={onNever}>
            {t('whats-new.ne-plus-montrer')}
          </button>
        )}
        {onDiscover && sheet.points.length > 0 && (
          <button type="button" className="button" onClick={onDiscover}>
            {t('discover.lien-nouveautes')}
          </button>
        )}
        {more > 0 && !all && (
          <button type="button" className="button" onClick={() => setAll(true)}>
            {t('whats-new.voir-tout-more-autres', { more })}
          </button>
        )}
        <button type="button" className="button primary" onClick={onClose} autoFocus>
          {t('translate.close')}
        </button>
      </div>
    </div>
  )
}

export function WhatsNewSheet({ sheet }: { sheet: Sheet }) {
  const act = api()
  return <WhatsNewView sheet={sheet} onClose={() => act.closeOverlay()} onNever={() => act.whatsNewDismiss()} onDiscover={() => act.openOverlay(DISCOVER_REQUEST)} />
}
