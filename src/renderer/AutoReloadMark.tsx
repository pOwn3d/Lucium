import { useEffect, useState } from 'react'
import { autoReloadLabel, autoReloadTooltip, countdownText } from '@shared/auto-reload'
import type { AutoReload } from '@shared/model'
import { t } from '@shared/i18n'
import { api } from './api'
import './auto-reload.css'

/**
 * Re-renders the caller once a second, on the second the countdown rolls over, while `endsAt` is in the future; returns the ms left
 * (null without a countdown). The timer lives only as long as the mark does and stops when the countdown ends: no publication per second.
 */
function useMsLeft(endsAt: number | undefined): number | null {
  const [, tick] = useState(0)
  useEffect(() => {
    if (endsAt === undefined) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = (): void => {
      const left = endsAt - Date.now()
      if (left <= 0) return
      timer = setTimeout(() => {
        tick((n) => n + 1)
        next()
      }, left % 1000 || 1000)
    }
    tick((n) => n + 1)
    next()
    return () => clearTimeout(timer)
  }, [endsAt])
  return endsAt === undefined ? null : endsAt - Date.now()
}

/**
 * The mark on the row of a tab that reloads itself: a small circular arrow after the title and the time left ("12 s", "1:05"), dimmed.
 * Under the pointer it becomes the button that stops the reloading. Only tabs that have the setting wear it; the other rows are unchanged.
 */
export function AutoReloadMark({ tabId, autoReload, reloadAt }: { tabId: string; autoReload: AutoReload; reloadAt?: number | undefined }) {
  const left = useMsLeft(reloadAt)
  const counting = left !== null && left > 0
  const stop = t('auto-reload-mark.arreter-le-rechargement-automatique')
  const info = counting ? t('auto-reload-mark.rechargement-dans-left-toutes-les-every', { left: autoReloadLabel(Math.ceil(left / 1000)), every: autoReloadLabel(autoReload.seconds) }) : autoReloadTooltip(autoReload.seconds)
  return (
    <button
      type="button"
      className="auto-reload-mark"
      title={`${info}\n${stop}`}
      aria-label={stop}
      onClick={(e) => {
        e.stopPropagation()
        void api().dispatch({ type: 'tab/auto-reload', id: tabId, seconds: null })
      }}
    >
      <span className="auto-reload-face">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75" />
          <path d="M12.9 1.9v2.6h-2.6" />
        </svg>
        {counting && <span className="auto-reload-left">{countdownText(left)}</span>}
      </span>
      <svg className="auto-reload-stop" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </svg>
    </button>
  )
}
