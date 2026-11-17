// The lock screen: what replaces the whole window while Lucium is locked (`kind: 'app'`), or the page card while the space on screen is locked
// (`kind: 'space'`). The interface is given a skeleton state meanwhile (shared/lock.ts, redactForLock): there is nothing behind this to uncover.
// A phrase typed here goes to the main process, which checks it against the hash it keeps; Touch ID, where the Mac has it, is asked for first.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Space } from '@shared/model'
import type { LockTarget } from '@shared/lock'
import { PASSPHRASE_MAX_LENGTH, type UiSnapshot } from '@shared/ipc'
import { spaceGlyph } from '@shared/space-icon'
import { resolveAppearance, themeVars } from '@shared/theme'
import { api } from './api'
import { useCountdown } from './use-countdown'
import './lock.css'
import { t } from '@shared/i18n'

const LOCK_ICON = (
  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="10.500" width="14" height="9.500" rx="2" />
    <path d="M8 10.500V8a4 4 0 0 1 8 0v2.500" />
  </svg>
)

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The "try again in N s." the main process ends a refusal with (lock-service.ts), in the language of the interface: the live countdown below
 * takes its place.
 */
function waitPattern(): RegExp {
  const [before = '', after = ''] = t('lock-service.reessayez-dans-seconds-s', { seconds: '\u0000' }).split('\u0000')
  return new RegExp(` ?${escapeRegExp(before)}\\d+${escapeRegExp(after)}`)
}

export function LockScreen({ snapshot, kind, space, systemDark }: { snapshot: UiSnapshot; kind: 'app' | 'space'; space?: Space; systemDark: boolean }) {
  const lock = snapshot.lock
  const target: LockTarget = kind === 'app' || !space ? { scope: 'app' } : { scope: 'space', spaceId: space.id }
  const [phrase, setPhrase] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [until, setUntil] = useState(() => Date.now() + (lock?.retryInMs ?? 0))
  const seconds = useCountdown(until)
  const asked = useRef(false)

  const unlock = async (withPhrase: string | undefined) => {
    setBusy(true)
    try {
      const reply = await api().lockUnlock({ target, ...(withPhrase !== undefined ? { phrase: withPhrase } : {}) })
      if (!reply.ok) {
        setMessage(reply.message)
        if (reply.retryInMs) setUntil(Date.now() + reply.retryInMs)
      }
    } catch (error) {
      // The exception is kept for the log; the page says what happened, in the language of the interface.
      console.warn('[lock] the request failed:', error)
      setMessage(t('errors.erreur-inattendue'))
    } finally {
      // Whatever came of it, the phrase does not stay in the page.
      setPhrase('')
      setBusy(false)
    }
  }

  // Touch ID is offered at once, once; the phrase is there if it does not work.
  useEffect(() => {
    if (asked.current || !lock?.touchId) return
    asked.current = true
    void unlock(undefined)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const card = (
    <form
      className="lock-card"
      aria-label={kind === 'app' ? t('lock-screen.lucium-est-verrouille') : t('lock-screen.name-est-verrouille', { name: space?.name ?? t('lock-screen.cet-espace') })}
      onSubmit={(e) => {
        e.preventDefault()
        if (phrase !== '' && seconds === 0) void unlock(phrase)
      }}
      onKeyDown={(e) => {
        // Return in the field unlocks on the key itself, not only through the form's implicit submission (which waits for a character event).
        if (e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'BUTTON') return
        e.preventDefault()
        if (phrase !== '' && seconds === 0 && !busy) void unlock(phrase)
      }}
    >
      <div className="lock-icon">{LOCK_ICON}</div>
      <h1>{kind === 'app' ? t('lock-screen.lucium-est-verrouille') : `${space ? spaceGlyph(space) : ''} ${t('lock-screen.name-est-verrouille', { name: space?.name ?? t('lock-screen.cet-espace') })}`}</h1>
      <p className="lock-sub">{kind === 'app' ? t('lock-screen.saisissez-la-phrase-du-verrou-pour-afficher-vos') : t('lock-screen.ses-onglets-sont-masques-et-ses-pages-en-veille')}</p>
      <input
        className="lock-field"
        type="password"
        aria-label={t('lock-settings.phrase-du-verrou')}
        placeholder={t('lock-settings.phrase-du-verrou')}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        maxLength={PASSPHRASE_MAX_LENGTH}
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
      />
      {(message || seconds > 0) && (
        // The alert is said once, when it comes. The seconds that tick are a timer, which a screen reader reads on demand and never by itself:
        // as plain text of the alert they were said again at every second of the wait.
        <p className="lock-message" role="alert">
          {seconds > 0 ? message.replace(waitPattern(), '') : message}
          {seconds > 0 && (
            <span role="timer" aria-live="off">
              {` ${t('lock-service.reessayez-dans-seconds-s', { seconds })}`}
            </span>
          )}
        </p>
      )}
      <div className="lock-actions">
        {lock?.touchId && (
          <button type="button" className="lock-button" disabled={busy} onClick={() => void unlock(undefined)}>
            Touch ID
          </button>
        )}
        <button type="submit" className="lock-button primary" disabled={busy || phrase === '' || seconds > 0}>
          {t('lock-screen.deverrouiller')}
        </button>
      </div>
    </form>
  )

  if (kind === 'space') return <div className="lock-stage">{card}</div>
  const themed = space ?? snapshot.state.spaces.find((s) => s.id === snapshot.state.activeSpaceId) ?? snapshot.state.spaces[0]
  const appearance = themed ? resolveAppearance(themed.theme, systemDark) : 'dark'
  const style = themed ? ({ ...themeVars(themed.theme, appearance) } as CSSProperties) : undefined
  return (
    <div className={`shell ${appearance} lock-app`} style={style}>
      {card}
    </div>
  )
}
