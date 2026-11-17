import { useState } from 'react'
import { deadTabGroups, deadTabRows, withLaterEntries, type DeadTabEntry, type DeadTabGroupKind, type DeadTabRow } from '@shared/dead-tabs'
import { t, tp } from '@shared/i18n'
import { api, useSnapshot } from './api'
import { TabMark } from './TabPicture'
import { AlertGlyph, Sheet } from './templates'
import './dead-tabs.css'

const GROUP_TITLES: Record<DeadTabGroupKind, () => string> = {
  pinned: () => t('dead-tabs.groupe-epingles'),
  today: () => t('dead-tabs.groupe-aujourd-hui')
}

/**
 * « Sites qui ne répondent plus »: the tabs whose site no longer answers, after « Actualiser tous les onglets » or the load of every tab at launch
 * (shared/dead-tabs.ts decides which). The pinned tabs come first, in a group of their own, then those of the day. Each row has the icon, the name,
 * the address and the reason, the space when there are several, and a tick box, ticked at first: the button of the sheet asks before anything goes.
 * « Afficher » shows the tab behind the sheet, to see what it was before deciding. « Fermer les onglets cochés » sends them to the archive in one go,
 * a pinned one with them (out of the pinned tabs; the archive brings it back pinned), so that one « Annuler » brings them all back, and keeps the
 * others; « Tout garder » keeps them all. A tab kept is not offered again for its address for a while (`DEAD_KEPT_MS`). Escape leaves without
 * choosing: nothing is remembered, and the next run offers them again. While a run goes on, the tabs it finds are added at the end of their group
 * (`deadTabs` of the snapshot), the ones already there keeping their place and their tick.
 */
export function DeadTabsSheet({ entries, initialOff }: { entries: readonly DeadTabEntry[]; /** The rows unticked when it opens (the tests open it so). */ initialOff?: ReadonlySet<string> }) {
  const snapshot = useSnapshot()
  const act = api()
  const [off, setOff] = useState<ReadonlySet<string>>(initialOff ?? new Set())
  const [shown, setShown] = useState<string | null>(null)
  if (!snapshot) return null

  const groups = deadTabGroups(deadTabRows(withLaterEntries(entries, snapshot.deadTabs), snapshot.state, Date.now()))
  // The rows in the order they are shown: the pinned ones first.
  const rows = groups.flatMap((group) => group.rows)
  // A heading only when it says something: the pinned tabs are named as such, and the tabs of the day only beside them.
  const headed = groups.some((group) => group.kind === 'pinned')
  const ticked = rows.filter((row) => !off.has(row.tab.id))
  const keep = (ids: string[]) => {
    if (ids.length > 0) void act.dispatch({ type: 'tabs/keep-dead', ids })
  }
  const close = () => {
    if (ticked.length > 0) void act.dispatch({ type: 'tabs/archive-many', ids: ticked.map((row) => row.tab.id), ...(ticked.some((row) => row.tab.pinned) ? { pinned: true as const } : {}) })
    keep(rows.filter((row) => off.has(row.tab.id)).map((row) => row.tab.id))
    act.closeOverlay()
  }
  const keepAll = () => {
    keep(rows.map((row) => row.tab.id))
    act.closeOverlay()
  }
  // One row at once, without ticking: the tab goes to the archive as the ticked ones do (« Annuler » brings it back), a pinned one out of the pinned tabs.
  // The sheet stays for the others, and goes with the last one.
  const closeOne = (row: DeadTabRow) => {
    void act.dispatch({ type: 'tabs/archive-many', ids: [row.tab.id], ...(row.tab.pinned ? { pinned: true as const } : {}) })
    if (rows.length === 1) act.closeOverlay()
  }
  const toggle = (id: string) => {
    const next = new Set(off)
    if (!next.delete(id)) next.add(id)
    setOff(next)
  }
  const rowOf = (row: DeadTabRow) => (
    <li key={row.tab.id} className={`dt-row ${off.has(row.tab.id) ? 'off' : ''}`} aria-current={shown === row.tab.id ? 'true' : undefined}>
      <input type="checkbox" checked={!off.has(row.tab.id)} aria-label={row.tab.pinned ? t('dead-tabs.retirer-name', { name: row.name }) : t('dead-tabs.fermer-name', { name: row.name })} onChange={() => toggle(row.tab.id)} />
      <span className="dt-icon" aria-hidden="true">
        <TabMark tab={row.tab} />
      </span>
      <span className="dt-text">
        <span className="dt-name" title={row.name}>
          {row.name}
        </span>
        <span className="dt-address" title={row.tab.url}>
          {row.address}
        </span>
        <span className="dt-why">
          <span className="dt-reason">{row.reason}</span>
          {row.space && <span className="dt-space">{row.space}</span>}
          {shown === row.tab.id && <span className="dt-shown">{t('dead-tabs.affiche-derriere')}</span>}
        </span>
      </span>
      <span className="dt-actions">
        <button
          type="button"
          className="tk-btn dt-show"
          aria-label={t('dead-tabs.afficher-l-onglet-name', { name: row.name })}
          onClick={() => {
            void act.dispatch({ type: 'tab/select', id: row.tab.id })
            setShown(row.tab.id)
          }}
        >
          {t('dead-tabs.afficher')}
        </button>
        <button type="button" className="tk-btn dt-close" aria-label={row.tab.pinned ? t('dead-tabs.retirer-cet-onglet-name', { name: row.name }) : t('dead-tabs.fermer-cet-onglet-name', { name: row.name })} onClick={() => closeOne(row)}>
          {row.tab.pinned ? t('dead-tabs.retirer') : t('dead-tabs.fermer')}
        </button>
      </span>
    </li>
  )

  return (
    <Sheet
      title={t('dead-tabs.sites-qui-ne-repondent-plus')}
      context={tp('dead-tabs.onglets', rows.length)}
      glyph={<AlertGlyph />}
      className="dead-tabs"
      onCancel={keepAll}
      onEscape={() => act.closeOverlay()}
      cancelLabel={t('dead-tabs.tout-garder')}
      primary={{ label: t('dead-tabs.fermer-les-onglets-coches'), disabled: ticked.length === 0 }}
      onSubmit={close}
    >
      <p className="sh-help">{t('dead-tabs.aide')}</p>
      {snapshot.reloadRun && <p className="sh-help dt-running">{t('dead-tabs.en-cours')}</p>}
      {groups.map((group) =>
        headed ? (
          <section key={group.kind} className="dt-group" aria-label={GROUP_TITLES[group.kind]()}>
            <h3 className="dt-group-title">{GROUP_TITLES[group.kind]()}</h3>
            <ul className="dt-rows">{group.rows.map(rowOf)}</ul>
          </section>
        ) : (
          <ul key={group.kind} className="dt-rows">
            {group.rows.map(rowOf)}
          </ul>
        )
      )}
      <p className="sh-help dt-summary" aria-live="polite">
        {tp('dead-tabs.onglets-coches', ticked.length)}
      </p>
    </Sheet>
  )
}
