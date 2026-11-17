import { useId, useMemo, useState } from 'react'
import { tabName } from '@shared/model'
import { NAME_MAX } from '@shared/state-clean'
import { hostOf } from '@shared/url'
import { proposeTidy, tidyActions, tidyPlan, type TidyChoices } from '@shared/tab-grouping'
import { t, tp } from '@shared/i18n'
import { api, useSnapshot } from './api'
import { FolderGlyph, Sheet } from './templates'
import './tidy-panel.css'

/** The same set without `value` when it was in, with it when it was not. */
const toggled = <T,>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => {
  const next = new Set(set)
  if (!next.delete(value)) next.add(value)
  return next
}

/**
 * "Ranger les onglets…": the folders proposed for the Today tabs of a space, to validate. The proposal is made once, from the tabs the panel opens on (a tab opened or
 * closed meanwhile does not shuffle the list under the pointer); what is ticked, renamed or moved is the person's, and nothing moves in the sidebar until "Ranger".
 * The work is `proposeTidy` and `tidyPlan` (tab-grouping.ts); this draws it and sends `tabs/tidy` with the groups the plan keeps.
 */
export function TidyPanel({ spaceId, initial }: { spaceId: string; /** What is already changed when the panel opens (the tests open it so; the person opens it with nothing changed). */ initial?: Partial<TidyChoices> }) {
  const snapshot = useSnapshot()
  const act = api()
  const place = useId()
  const state = snapshot?.state
  const ready = state !== undefined
  // Made when the first snapshot arrives and not again.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const proposal = useMemo(() => (state ? proposeTidy(state, spaceId) : null), [ready, spaceId])
  const [names, setNames] = useState<ReadonlyMap<string, string>>(initial?.names ?? new Map())
  const [offGroups, setOffGroups] = useState<ReadonlySet<string>>(initial?.offGroups ?? new Set())
  const [offTabs, setOffTabs] = useState<ReadonlySet<string>>(initial?.offTabs ?? new Set())
  const [chosen, setChosen] = useState<'top' | 'bottom' | null>(null)
  if (!state || !proposal) return null

  const space = state.spaces.find((sp) => sp.id === spaceId)
  const choices: TidyChoices = { names, offGroups, offTabs }
  const plan = tidyPlan(state, spaceId, proposal, choices)
  const position = chosen ?? state.settings.tidyFoldersPosition
  const tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]))
  const close = () => act.closeOverlay()
  const apply = () => {
    const actions = tidyActions(plan, spaceId, position, state.settings.tidyFoldersPosition)
    if (actions.length === 0) return
    for (const action of actions) void act.dispatch(action)
    close()
  }

  return (
    <Sheet
      title={t('tidy-panel.ranger-les-onglets')}
      context={space?.name}
      glyph={<FolderGlyph />}
      className="tidy-panel"
      onCancel={close}
      cancelLabel={proposal.groups.length === 0 ? t('templates.fermer') : undefined}
      primary={proposal.groups.length === 0 ? undefined : { label: t('tidy-panel.ranger'), disabled: plan.apply.length === 0 }}
      onSubmit={apply}
    >
      {proposal.groups.length === 0 ? (
        <p className="tp-empty">{t('tidy-panel.rien-a-ranger')}</p>
      ) : (
        <>
          <p className="sh-help">{t('tidy-panel.rien-ne-bouge-avant-ranger')}</p>
          <ul className="tp-groups">
            {plan.rows.map((row) => (
              <li key={row.key} className={`tp-group ${row.on ? '' : 'off'}`}>
                <div className="tp-head">
                  <input type="checkbox" checked={row.on} aria-label={t('tidy-panel.ranger-le-groupe', { name: row.name })} onChange={() => setOffGroups(toggled(offGroups, row.key))} />
                  <input
                    className="tk-field tp-name"
                    value={row.name}
                    maxLength={NAME_MAX}
                    aria-label={t('tidy-panel.nom-du-dossier')}
                    onChange={(e) => setNames(new Map(names).set(row.key, e.target.value))}
                  />
                  <span className="tp-count">{tp('tidy-panel.onglets', row.kept.length)}</span>
                </div>
                {row.into && <p className="tp-note">{t('tidy-panel.dossier-existant')}</p>}
                {row.few && <p className="tp-note warn">{t('tidy-panel.au-moins-deux-onglets')}</p>}
                <ul className="tp-tabs">
                  {row.tabIds.map((id) => {
                    const tab = tabsById.get(id)
                    if (!tab) return null
                    return (
                      <li key={id}>
                        <label className="tp-tab">
                          <input type="checkbox" checked={!offTabs.has(id)} disabled={!row.on} onChange={() => setOffTabs(toggled(offTabs, id))} />
                          <span className="tp-tab-title">{tabName(tab)}</span>
                          <span className="tp-tab-host">{hostOf(tab.url)}</span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
          {plan.created > 0 && (
            <div className="tp-place" role="radiogroup" aria-labelledby={`${place}-label`}>
              <span id={`${place}-label`}>{t('tidy-panel.placer-les-nouveaux-dossiers')}</span>
              {(['top', 'bottom'] as const).map((side) => (
                <label key={side}>
                  <input type="radio" name={place} checked={position === side} onChange={() => setChosen(side)} />
                  {side === 'top' ? t('tidy-panel.en-haut') : t('tidy-panel.en-bas')}
                </label>
              ))}
            </div>
          )}
          <p className="sh-help tp-summary" aria-live="polite">
            {plan.apply.length === 0 ? t('tidy-panel.rien-n-est-coche') : `${tp('tidy-panel.dossiers', plan.created + plan.extended)} · ${tp('tidy-panel.onglets', plan.moved)}`}
          </p>
        </>
      )}
    </Sheet>
  )
}
