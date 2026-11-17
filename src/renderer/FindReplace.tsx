import { useEffect, useRef, useState } from 'react'
import { FIND_REPLACE_PANEL } from '@shared/ipc'
import { api, useSnapshot } from './api'
import './find-replace.css'

const GLYPH = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

/**
 * Edit › Find › Find and Replace. The field and the counter are those of the find panel (same search in the page); a second field and
 * two buttons rewrite the matches that sit in text fields and editable regions, the only places a page lets the user change.
 */
export function FindReplace() {
  const snapshot = useSnapshot()
  const act = api()
  // A search already under way (Use Selection to Find, or Find before Find and Replace) is the one shown.
  const [text, setText] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  // The last replacement asked could not be made (the request failed): said until another one is asked.
  const [failed, setFailed] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const typed = useRef(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const known = snapshot?.find?.text
  useEffect(() => {
    if (!typed.current && known) setText(known)
  }, [known])

  const find = snapshot?.find
  const matches = find?.matches ?? 0
  const searching = text !== ''
  const step = (forward: boolean) => act.find(text, { next: true, forward, matchCase })
  const replace = async (all: boolean) => {
    if (!searching) return
    // How many were replaced is said by a notice at the foot of the sidebar (the panel has no room for a line of its own).
    setFailed(false)
    try {
      await act.findReplace({ query: text, replacement, all, matchCase })
    } catch (error) {
      // No notice comes when the request itself fails: the panel says it, beside the buttons.
      console.error('[find] the replacement could not be made:', error)
      setFailed(true)
      return
    }
    // The search is run again: the occurrences that were replaced are no longer there.
    act.find(text, { matchCase })
  }

  return (
    <div className="fr-host">
      <div
        className="fr"
        role="search"
        aria-label={t('menu.trouver-et-remplacer')}
        style={{ '--fr-shadow': `${FIND_REPLACE_PANEL.shadow}px`, width: FIND_REPLACE_PANEL.width, height: FIND_REPLACE_PANEL.height } as React.CSSProperties}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            act.closeOverlay()
          }
        }}
      >
        <div className="fr-line">
          <span className="fr-icon">
            <svg viewBox="0 0 16 16" width="13" height="13" {...GLYPH}>
              <circle cx="7" cy="7" r="5" />
              <path d="m11 11 3.500 3.500" />
            </svg>
          </span>
          <input
            ref={input}
            className="fr-input"
            value={text}
            placeholder={t('menu.rechercher-2')}
            aria-label={t('menu.rechercher')}
            spellCheck={false}
            onChange={(e) => {
              typed.current = true
              setText(e.target.value)
              act.find(e.target.value, { matchCase })
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (searching) step(!e.shiftKey)
            }}
          />
          {searching && <span className="fr-count" aria-live="polite">{`${find?.ordinal ?? 0}/${matches}`}</span>}
          <button
            className={`fr-btn fr-case ${matchCase ? 'on' : ''}`}
            title={t('find-replace.respecter-la-casse')}
            aria-label={t('find-replace.respecter-la-casse')}
            aria-pressed={matchCase}
            onClick={() => {
              setMatchCase(!matchCase)
              if (searching) act.find(text, { matchCase: !matchCase })
            }}
          >
            Aa
          </button>
          <button className="fr-btn" title={t('panels.occurrence-precedente')} aria-label={t('menu.occurrence-precedente')} disabled={matches === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => step(false)}>
            <svg viewBox="0 0 12 12" width="11" height="11" {...GLYPH}>
              <path d="m2.500 7.500 3.500-3.500 3.500 3.500" />
            </svg>
          </button>
          <button className="fr-btn" title={t('panels.occurrence-suivante')} aria-label={t('menu.occurrence-suivante')} disabled={matches === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => step(true)}>
            <svg viewBox="0 0 12 12" width="11" height="11" {...GLYPH}>
              <path d="m2.500 4.500 3.500 3.500 3.500-3.500" />
            </svg>
          </button>
          <button className="fr-btn" title={t('cmd.fermer-echap')} aria-label={t('translate.close')} onClick={() => act.closeOverlay()}>
            <svg viewBox="0 0 12 12" width="10" height="10" {...GLYPH}>
              <path d="m2.500 2.500 7 7m0-7-7 7" />
            </svg>
          </button>
        </div>
        <div className="fr-line">
          <input
            className="fr-input fr-replacement"
            value={replacement}
            placeholder={t('find-replace.remplacer-par')}
            aria-label={t('find-replace.remplacer-par-2')}
            spellCheck={false}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              void replace(e.altKey)
            }}
          />
          {failed && (
            <span className="fr-failure" role="alert">
              {t('find-replace.remplacement-impossible')}
            </span>
          )}
          <button className="fr-text" disabled={!searching} onClick={() => void replace(false)} title={t('find-replace.remplacer-la-prochaine-occurrence')}>
            {t('find-replace.remplacer')}
          </button>
          <button className="fr-text" disabled={!searching} onClick={() => void replace(true)} title={t('find-replace.remplacer-toutes-les-occurrences')} aria-label={t('find-replace.tout-remplacer')}>
            {t('history-days.tout')}
          </button>
        </div>
      </div>
    </div>
  )
}

import { t } from '@shared/i18n'