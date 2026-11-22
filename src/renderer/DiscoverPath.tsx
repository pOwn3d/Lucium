import { useId, useState } from 'react'
import { ALL_DISCOVER_ENTRIES, discoverName, discoverOff, discoverSummary, type DiscoverEntry } from '@shared/discover'
import { DISCOVER_PATH_STEPS, cleanDiscoverPath, pathProgress, resetPathPatch, tickStepPatch } from '@shared/discover-tips'
import { t } from '@shared/i18n'
import type { Settings } from '@shared/model'
import { api } from './api'

const STEPS: readonly DiscoverEntry[] = DISCOVER_PATH_STEPS.map((id) => ALL_DISCOVER_ENTRIES.find((entry) => entry.id === id)!)

/**
 * The path « Parcours de découverte », at the head of « Découvrir Lucium »: a few steps, each a function of the catalogue with a box to tick and the same
 * « Essayer » as its card. « Essayer » ticks the step (the panel is left at once, so the person is not asked to come back and tick), the box ticks or unticks
 * by hand, « Recommencer » unticks all. The ticks are kept on this machine (`discoverPath`), nothing is counted or sent. Every step is a real checkbox with its
 * line as its description; the progress and the reset are said in a live region.
 * @param run the same « Essayer » as a card's: the panel is left and the action starts (Discover.tsx).
 */
export function DiscoverPath({ settings, run }: { settings: Settings; run: (entry: DiscoverEntry) => void }) {
  const act = api()
  const titleId = useId()
  const [note, setNote] = useState('')
  const path = cleanDiscoverPath(settings.discoverPath)
  const { done, total, complete } = pathProgress(path)
  const save = (patch: Partial<Settings>): void => void act.dispatch({ type: 'settings/update', patch })

  return (
    <section className="dv-guide dv-path" aria-labelledby={titleId}>
      <h3 id={titleId}>{t('discover.parcours-titre')}</h3>
      <p className="dv-guide-text">{t('discover.parcours-intro')}</p>
      <ol className="dv-steps" aria-label={t('discover.parcours-liste')}>
        {STEPS.map((entry) => {
          const name = discoverName(entry)
          const id = `${titleId}-${entry.id}`
          const ticked = path.includes(entry.id as (typeof path)[number])
          const off = discoverOff(entry, settings)
          const kind = entry.try.kind
          const adjustOnly = off || kind === 'setting'
          return (
            <li key={entry.id} className="dv-step">
              <input id={id} type="checkbox" checked={ticked} aria-describedby={`${id}-line`} onChange={(e) => save(tickStepPatch(path, entry.id, e.target.checked))} />
              <div className="dv-step-body">
                <label htmlFor={id}>{name}</label>
                <p id={`${id}-line`} className="dv-guide-text">
                  {discoverSummary(entry)}
                </p>
              </div>
              {(adjustOnly || kind === 'open' || kind === 'call') && (
                <button
                  type="button"
                  className={`tk-btn${ticked ? '' : ' primary'}`}
                  aria-label={t(adjustOnly ? 'discover.regler-nom' : 'discover.essayer-nom', { name })}
                  onClick={() => {
                    save(tickStepPatch(path, entry.id, true))
                    run(entry)
                  }}
                >
                  {t(adjustOnly ? 'discover.regler' : 'discover.essayer')}
                </button>
              )}
            </li>
          )
        })}
      </ol>
      <div className="dv-guide-actions">
        <p className="dv-guide-progress" aria-live="polite">
          {t('discover.parcours-avancement', { done, total })} {complete ? t('discover.parcours-fini') : ''}
        </p>
        <button
          type="button"
          className="tk-btn"
          aria-label={t('discover.parcours-recommencer-nom')}
          onClick={() => {
            save(resetPathPatch())
            setNote(t('discover.parcours-remis'))
          }}
        >
          {t('discover.parcours-recommencer')}
        </button>
      </div>
      <p className="dv-guide-note" role="status" aria-live="polite">
        {note}
      </p>
    </section>
  )
}
