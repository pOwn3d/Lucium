import { useId, useMemo, useRef, useState } from 'react'
import { DISCOVER_ENTRIES, DISCOVER_EXTRAS, discoverKeys, discoverName, discoverOff, discoverSummary, discoverWhere, type DiscoverEntry } from '@shared/discover'
import { discoverTipEntry, dayKey, putTipAwayPatch, showTipToday, tipSettingPatch } from '@shared/discover-tips'
import { t } from '@shared/i18n'
import type { Settings } from '@shared/model'
import type { PlatformId } from '@shared/platform'
import { api } from './api'

/** The tip draws from the cards written by hand (the chosen ones and the functions without a switch), never from the rows made from the registry alone: they say nothing of where to find the function. */
const TIP_POOL: readonly DiscoverEntry[] = [...DISCOVER_ENTRIES, ...DISCOVER_EXTRAS]

/**
 * The tip of the day of « Découvrir Lucium »: one function, the next one each day, with where to find it, its shortcut and « Essayer ». It is on by default,
 * « Compris » puts it away until tomorrow (it is never drawn twice the same day), « Ne plus afficher » turns it off in one click, and the box under it, always
 * there, turns it back on. What each button did is said in words (a live region) and the focus goes to the box when the card leaves, so that a keyboard or a
 * screen reader never loses its place. Nothing moves, nothing is counted, nothing is sent.
 * @param run the same « Essayer » as a card's: the panel is left and the action starts (Discover.tsx).
 */
export function DiscoverTip({ settings, platform, run, now }: { settings: Settings; platform: PlatformId; run: (entry: DiscoverEntry) => void; now?: Date }) {
  const act = api()
  const titleId = useId()
  const box = useRef<HTMLInputElement>(null)
  const [note, setNote] = useState('')
  // The day is read once when the panel opens: a panel left open across midnight keeps the tip it showed.
  const today = useMemo(() => dayKey(now ?? new Date()), [now])
  const entry = discoverTipEntry(TIP_POOL, today, (e) => discoverOff(e, settings))
  const shown = entry !== null && showTipToday(settings, today)
  const save = (patch: Partial<Settings>): void => void act.dispatch({ type: 'settings/update', patch })

  const putAway = (): void => {
    save(putTipAwayPatch(today))
    setNote(t('discover.astuce-rangee'))
    box.current?.focus()
  }
  const stop = (): void => {
    save(tipSettingPatch(false))
    setNote(t('discover.astuce-arretee'))
    box.current?.focus()
  }
  const keys = entry ? discoverKeys(entry, settings.keyBindings, platform) : null
  const kind = entry?.try.kind

  return (
    <div className="dv-tipzone">
      {shown && entry && (
        <section className="dv-guide dv-tip" aria-labelledby={titleId}>
          <h3 id={titleId}>{t('discover.astuce-titre')}</h3>
          <p className="dv-guide-name">{discoverName(entry)}</p>
          <p className="dv-guide-text">{discoverSummary(entry)}</p>
          <p className="dv-guide-text dv-guide-where">
            <b>{t('discover.ou-label')}</b> {discoverWhere(entry)}
          </p>
          {keys && (
            <span className="dv-keys" role="group" aria-label={t('discover.raccourci-label', { keys: keys.keys.join(' ') })}>
              {keys.keys.map((key, i) => (
                <kbd key={`${key}${i}`} className="tk-kbd" aria-hidden="true">
                  {key}
                </kbd>
              ))}
            </span>
          )}
          <div className="dv-guide-actions">
            {(kind === 'open' || kind === 'call' || kind === 'setting') && (
              <button
                type="button"
                className="tk-btn primary"
                aria-label={t(kind === 'setting' ? 'discover.regler-nom' : 'discover.essayer-nom', { name: discoverName(entry) })}
                onClick={() => {
                  save(putTipAwayPatch(today))
                  run(entry)
                }}
              >
                {t(kind === 'setting' ? 'discover.regler' : 'discover.essayer')}
              </button>
            )}
            <button type="button" className="tk-btn" aria-label={t('discover.astuce-compris-nom', { name: discoverName(entry) })} onClick={putAway}>
              {t('discover.astuce-compris')}
            </button>
            <button type="button" className="tk-btn quiet" aria-label={t('discover.astuce-arreter-nom')} onClick={stop}>
              {t('discover.astuce-arreter')}
            </button>
          </div>
        </section>
      )}
      <label className="dv-tipbox">
        <input
          ref={box}
          type="checkbox"
          checked={settings.discoverTip}
          onChange={(e) => {
            save(tipSettingPatch(e.target.checked))
            setNote(t(e.target.checked ? 'discover.astuce-remise' : 'discover.astuce-arretee'))
          }}
        />
        {t('discover.astuce-case')}
      </label>
      <p className="dv-guide-note" role="status" aria-live="polite">
        {note}
      </p>
    </div>
  )
}
