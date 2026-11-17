// "Quitter ce site ?": a page on screen holds the navigation the user started (its `beforeunload` handler), and Lucium asks, under the toolbar,
// in the colours of the theme. "Rester" is the default (a stray Return keeps what was typed) and is on the right, as the primary button is everywhere else;
// Escape and a click outside stay too; ⌘↩ leaves. The page waits behind the sheet, and nothing else is frozen. The answer goes to the main process, which
// starts the navigation again on "Quitter" (main/engine/unload-guard.ts).

import { useEffect, useRef } from 'react'
import type { LeaveRequest } from '@shared/leave-sheet'
import { api } from './api'
import { usePlatform } from './use-platform'
import { commandHeld } from '@shared/keybindings'
import { commandPress } from '@shared/platform'
import { t } from '@shared/i18n'
import './leave-sheet.css'

export function LeaveSheet({ request }: { request: LeaveRequest }) {
  const act = api()
  const platform = usePlatform()
  const stay = useRef<HTMLButtonElement>(null)
  const answer = (leave: boolean) => act.answerLeave(request.id, leave)

  useEffect(() => {
    stay.current?.focus()
  }, [])

  // Escape stays and ⌘↩ (Ctrl+Enter away from macOS) leaves, wherever the focus is while the sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const leave = e.key === 'Enter' && commandHeld(e, platform)
      if (e.key !== 'Escape' && !leave) return
      e.preventDefault()
      e.stopImmediatePropagation()
      act.answerLeave(request.id, leave)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [act, request.id, platform])

  return (
    <div className="leave-scrim" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
      <div className="leave" role="alertdialog" aria-modal="true" aria-labelledby="leave-title" aria-describedby="leave-text">
        <div className="leave-site">
          <span className="leave-fav" aria-hidden="true">
            {request.site.charAt(0).toUpperCase()}
          </span>
          <span className="leave-host">{request.site}</span>
        </div>
        <h2 id="leave-title">{t('engine.quitter-ce-site')}</h2>
        <p id="leave-text">{t('leave.ce-site-demande-une-confirmation-les-modifications')}</p>
        <div className="leave-actions">
          <button ref={stay} type="button" className="button primary" onClick={() => answer(false)}>
            {t('engine.rester')}
            <kbd>↩</kbd>
          </button>
          <button type="button" className="button" onClick={() => answer(true)}>
            {t('app.quitter')}
            <kbd>{commandPress('↩', platform)}</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}
