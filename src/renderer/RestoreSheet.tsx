import { useState } from 'react'
import { restoreRows, type RestoreRow } from '@shared/session-restore'
import { t, tp } from '@shared/i18n'
import { api, useSnapshot } from './api'
import { TabMark } from './TabPicture'
import { AlertGlyph, Sheet } from './templates'
import './restore-sheet.css'

/**
 * « Reprendre où vous en étiez ? »: opened by the main process at the launch that follows an abnormal exit (main/shell/clean-exit.ts), once, over the tabs the state
 * file kept. A row for each tab of the day (shared/session-restore.ts: the pinned and the private ones are not offered), ticked at first. « Garder les onglets
 * cochés » sends the unticked ones to the archive in one go, so that one « Annuler » brings them all back, and keeps the others; « Tout garder » keeps them all. Escape
 * leaves without choosing: nothing changes, and the sheet is not offered again for this run. Nothing is loaded or fetched here: the rows are what the interface already has.
 */
export function RestoreSheet({ initialOff }: { /** The rows unticked when it opens (the tests open it so). */ initialOff?: ReadonlySet<string> }) {
  const snapshot = useSnapshot()
  const act = api()
  const [off, setOff] = useState<ReadonlySet<string>>(initialOff ?? new Set())
  if (!snapshot) return null

  const { rows, hidden } = restoreRows(snapshot.state)
  const ticked = rows.filter((row) => !off.has(row.tab.id))
  const toggle = (id: string) => {
    const next = new Set(off)
    if (!next.delete(id)) next.add(id)
    setOff(next)
  }
  const keepTicked = () => {
    const away = rows.filter((row) => off.has(row.tab.id)).map((row) => row.tab.id)
    if (away.length > 0) void act.dispatch({ type: 'tabs/archive-many', ids: away })
    act.closeOverlay()
  }
  const rowOf = (row: RestoreRow) => (
    <li key={row.tab.id} className={`rs-row ${off.has(row.tab.id) ? 'off' : ''}`}>
      <input type="checkbox" checked={!off.has(row.tab.id)} aria-label={t('restore.garder-name', { name: row.name })} onChange={() => toggle(row.tab.id)} />
      <span className="rs-icon" aria-hidden="true">
        <TabMark tab={row.tab} />
      </span>
      <span className="rs-text">
        <span className="rs-name" title={row.name}>
          {row.name}
        </span>
        <span className="rs-address" title={row.tab.url}>
          {row.address}
        </span>
        {row.space && <span className="rs-space">{row.space}</span>}
      </span>
    </li>
  )

  return (
    <Sheet
      title={t('restore.reprendre-ou-vous-en-etiez')}
      context={tp('restore.onglets', rows.length + hidden)}
      glyph={<AlertGlyph />}
      className="restore"
      onCancel={() => act.closeOverlay()}
      cancelLabel={t('restore.tout-garder')}
      primary={{ label: t('restore.garder-les-onglets-coches') }}
      onSubmit={keepTicked}
    >
      <p className="sh-help">{t('restore.aide')}</p>
      <ul className="rs-rows">{rows.map(rowOf)}</ul>
      {hidden > 0 && <p className="sh-help">{tp('restore.autres-onglets', hidden)}</p>}
      <p className="sh-help rs-summary" aria-live="polite">
        {tp('restore.onglets-coches', ticked.length)}
      </p>
    </Sheet>
  )
}
