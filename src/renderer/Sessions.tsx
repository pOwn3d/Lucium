import { useEffect, useState } from 'react'
import type { BackupListing } from '@shared/session-backups'
import { copyWhen, reasonLabel } from '@shared/session-backups'
import { SESSIONS_MAX, SESSION_NAME_MAX, SESSION_TABS_MAX, autoSessionName, cleanSessionName, savableCount, sessionAge, tabsLabel } from '@shared/sessions'
import { sessionSourceTabs } from '@shared/sidebar'
import { SPACE_UNDO_MS } from '@shared/space-manage'
import { api, useSnapshot } from './api'
import { ListGroup, ListPanel, TabGlyph, activeSpaceHue, useUndoQueue } from './templates'
import './sessions.css'
import { settingsPath } from '@shared/settings-path'

/**
 * "Sessions…": the tabs of a space saved under a name, and restored in one click (Chrome Toolkit's "Sessions d'onglets").
 * Saving asks only for a name (blank: the date); restoring opens the pages as tabs of the current space, or of a new one.
 * A space put aside (Espaces › Mettre l’espace de côté…) is a session of its own kind: "Rouvrir" brings the space back as it was.
 * Below the list, the automatic copies of the session (Réglages › Téléchargements et fichiers › Copies automatiques): the date and the tabs of each, and one click, confirmed, puts one back.
 * The frame is the template of the panels of a list (templates/ListPanel.tsx): a session deleted leaves the list at once and can be taken back
 * ("Annuler", ⌘Z), and the arrows go from one session to the next.
 */
export function Sessions({ focus, tabIds }: { focus?: 'save'; tabIds?: string[] }) {
  const snapshot = useSnapshot()
  // What the user typed in the name field; null until they type. Opened by "Enregistrer la session…", the field shows the automatic name until then, selected,
  // so that Return alone saves. That name is worked out from the snapshot being drawn, not at the first render: the language of the interface comes with the
  // first snapshot, and the first render has none (a name made then would be French in the English interface).
  const [typed, setTyped] = useState<string | null>(null)
  const [newSpace, setNewSpace] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [backups, setBackups] = useState<BackupListing | null>(null)
  // The copy whose restoration awaits its confirmation, and what the last attempt said when it did not work.
  const [restoring, setRestoring] = useState<string | null>(null)
  const [backupNote, setBackupNote] = useState('')
  // A request about the copies that got no answer at all. Kept as what failed, not as a sentence: the list is asked for before the first snapshot,
  // which is what brings the language of the interface.
  const [backupFailure, setBackupFailure] = useState<'list' | 'restore' | 'copy' | null>(null)
  // The ages are worked out once per opening of the panel: they do not need to tick while it is on screen.
  const [now] = useState(() => Date.now())
  const act = api()
  // A row can be a space set aside: a deletion waits as long here as in "Gérer les espaces", where the same space can be deleted.
  const undo = useUndoQueue(SPACE_UNDO_MS)
  useEffect(() => {
    let live = true
    void act
      .sessionBackups()
      .then((listing) => live && setBackups(listing))
      .catch((error: unknown) => {
        // Without this the list stayed empty with nothing to tell it from a profile that has no copy.
        console.error('[sessions] the list of the automatic copies could not be read:', error)
        if (live) setBackupFailure('list')
      })
    return () => {
      live = false
    }
  }, [act])
  if (!snapshot) return null

  const name = typed ?? (focus === 'save' ? autoSessionName(now) : '')
  const { state } = snapshot
  // A session whose deletion can still be taken back is out of the list, and out of its count.
  const sessions = state.sessions.filter((session) => !undo.hidden.has(session.id))
  const source = sessionSourceTabs(state, tabIds)
  const savable = savableCount(source)
  const kept = Math.min(savable, SESSION_TABS_MAX)
  const full = sessions.length >= SESSIONS_MAX
  const canSave = savable > 0 && !full
  const space = state.spaces.find((s) => s.id === state.activeSpaceId)
  const selection = tabIds !== undefined

  const save = () => {
    if (!canSave) return
    // A deletion still waiting is made first: the room it leaves is the room this session takes.
    undo.flush()
    void act.dispatch({ type: 'session/save', name: cleanSessionName(name), ...(selection ? { tabIds } : {}) })
    setTyped('')
    setSaved(kept)
  }

  const restore = (id: string) => {
    void act.dispatch({ type: 'session/restore', id, target: newSpace ? 'new-space' : 'current' })
    act.closeOverlay()
  }

  const reopen = (id: string) => {
    void act.dispatch({ type: 'space/reopen', id })
    act.closeOverlay()
  }

  const restoreBackup = (id: string) => {
    setBackupFailure(null)
    if (restoring !== id) {
      setBackupNote('')
      return setRestoring(id)
    }
    setRestoring(null)
    void act
      .restoreBackup(id)
      .then((result) => {
        if (result.ok) return act.closeOverlay()
        setBackupNote(result.message)
      })
      .catch((error: unknown) => {
        // The restoration was confirmed: a failure that says nothing reads as a restoration that worked.
        console.error('[sessions] the restoration of an automatic copy failed:', error)
        setBackupFailure('restore')
      })
  }

  const backUpNow = () => {
    setRestoring(null)
    setBackupFailure(null)
    void act
      .backUpNow()
      .then(async (outcome) => {
        setBackupNote(outcome.message)
        setBackups(await act.sessionBackups())
      })
      .catch((error: unknown) => {
        console.error('[sessions] the copy asked for could not be made, or the list could not be read after it:', error)
        setBackupFailure('copy')
      })
  }

  // The session leaves the list at once; it is deleted when the time to take it back has passed, or when the panel is left.
  const remove = (id: string, sessionName: string, aside: boolean) =>
    undo.remove(id, aside ? t('space-manage.espace-mis-de-cote-supprime', { name: sessionName }) : t('sessions.session-supprimee', { name: sessionName }), () => void act.dispatch({ type: 'session/delete', id }))

  const commitRename = (id: string, current: string) => {
    const value = renaming?.id === id ? renaming.value : current
    setRenaming(null)
    // A blank name is the reducer's to refuse: the session keeps the one it has.
    if (cleanSessionName(value) && cleanSessionName(value) !== current) void act.dispatch({ type: 'session/rename', id, name: value })
  }

  // The counts through the plural rules of the language: "1 onglet sélectionné", "3 tabs of the Space “Perso”".
  const what = selection ? tp('sessions.onglets-selectionnes-enregistres', kept) : tp('sessions.onglets-de-l-espace-enregistres', kept, { name: space?.name ?? '' })
  const hint = full
    ? t('sessions.limite-de-sessions-max-sessions-atteinte', { SESSIONS_MAX })
    : savable === 0
      ? t('sessions.aucun-onglet-a-enregistrer')
      : [what, ...(savable > SESSION_TABS_MAX ? [t('sessions.seuls-les-premiers-sont-gardes', { max: SESSION_TABS_MAX })] : [])].join(' ')
  const tabs = tabsLabel
  const failureText = backupFailure === 'list' ? t('sessions.liste-des-copies-illisible') : backupFailure === 'restore' ? t('sessions.restauration-echouee') : backupFailure === 'copy' ? t('sessions.copie-echouee') : ''
  const backupSaid = failureText || backupNote

  return (
    <ListPanel
      className="sessions"
      icon={<TabGlyph />}
      title={t('sessions.sessions')}
      count={sessions.length}
      hue={activeSpaceHue(state.spaces, state.activeSpaceId)}
      footOption={
        <label className="sessions-target">
          <input type="checkbox" checked={newSpace} onChange={(e) => setNewSpace(e.target.checked)} />
          {t('sessions.restaurer-dans-un-nouvel-espace')}
        </label>
      }
      onDone={() => act.closeOverlay()}
      undo={undo.panel}
    >
      <div className="sessions-new">
        <label htmlFor="sessions-name">{t('sessions.nommer-et-enregistrer-la-session-actuelle')}</label>
        <div className="sessions-save">
          <input
            id="sessions-name"
            className="tk-field"
            autoFocus
            spellCheck={false}
            maxLength={SESSION_NAME_MAX}
            placeholder={t('sessions.projet-x-veille-tech')}
            value={name}
            onFocus={(e) => focus === 'save' && e.currentTarget.select()}
            onChange={(e) => {
              setTyped(e.target.value)
              setSaved(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <button type="button" className="tk-btn sessions-save-button" data-action="save" disabled={!canSave} onClick={save}>
            {t('sessions.enregistrer')}
          </button>
        </div>
        <p className="tk-status sessions-hint" data-role="hint">
          {hint}
        </p>
        {saved !== null && (
          <p className="tk-status sessions-saved" role="status" data-role="saved">
            {t('sessions.session-enregistree', { tabs: tabs(saved) })}
          </p>
        )}
      </div>

      {sessions.length === 0 && <p className="tk-status sessions-empty">{t('sessions.aucune-session-enregistree')}</p>}
      <ListGroup>
        {sessions.map((session) => {
          const meta = `${session.space ? tp('cmd.aside-tabs', session.space.tabs.length) : tabs(session.tabs.length)} · ${sessionAge(session.createdAt, now)}`
          const bringBack = () => (session.space ? reopen(session.id) : restore(session.id))
          const bringBackLabel = session.space ? t('cmd.reopen-space', { name: session.name }) : t('sessions.restaurer-name', { name: session.name })
          return (
            <li key={session.id} className="lp-row sessions-row" data-id={session.id} {...(session.space ? { 'data-aside': '1' } : {})}>
              {renaming?.id === session.id ? (
                // Not the main button of a row while its name is typed: the arrows of the panel go over it.
                <span className="sessions-editing">
                  <input
                    className="tk-field sessions-rename"
                    autoFocus
                    spellCheck={false}
                    maxLength={SESSION_NAME_MAX}
                    aria-label={t('sessions.nom-de-la-session')}
                    value={renaming.value}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setRenaming({ id: session.id, value: e.target.value })}
                    onBlur={() => commitRename(session.id, session.name)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(session.id, session.name)
                      else if (e.key === 'Escape') {
                        // Escape ends the rename, not the panel.
                        e.stopPropagation()
                        setRenaming(null)
                      }
                      // The panel sends ↓ from a field down to the rows: here it would end the rename by taking the focus away.
                      else if (e.key === 'ArrowDown') e.stopPropagation()
                    }}
                  />
                  <span className="lp-sub sessions-meta">{meta}</span>
                </span>
              ) : (
                <button type="button" className="lp-main" data-action="open" aria-label={bringBackLabel} onClick={bringBack}>
                  <span className="lp-text">
                    <span className="lp-title sessions-name">{session.name}</span>
                    <span className="lp-sub sessions-meta">{meta}</span>
                  </span>
                </button>
              )}
              <span className="sessions-actions">
                {session.space ? (
                  <button type="button" className="tk-btn" data-action="reopen" aria-label={bringBackLabel} onClick={bringBack}>
                    {t('sessions.rouvrir')}
                  </button>
                ) : (
                  <button type="button" className="tk-btn" data-action="restore" aria-label={bringBackLabel} onClick={bringBack}>
                    {t('sessions.restaurer')}
                  </button>
                )}
                <button type="button" className="tk-btn quiet" data-action="rename" aria-label={t('sessions.renommer-name', { name: session.name })} onClick={() => setRenaming({ id: session.id, value: session.name })}>
                  {t('sessions.renommer')}
                </button>
                <button
                  type="button"
                  className="tk-btn quiet danger"
                  data-action="delete"
                  aria-label={t('sessions.supprimer-name', { name: session.name })}
                  title={session.space ? t('sessions.supprime-aussi-l-espace-son-theme-et-ses-onglets') : undefined}
                  onClick={() => remove(session.id, session.name, session.space !== undefined)}
                >
                  {t('sessions.supprimer')}
                </button>
              </span>
            </li>
          )
        })}
      </ListGroup>

      <section className="lp-group">
        <h3>{t('sessions.copies-automatiques')}</h3>
        {backups !== null && !backups.enabled && (
          <p className="tk-status sessions-hint" data-role="backups-off">
            {t('sessions.copies-desactivees', { settingsPath: settingsPath('autoBackup') })}
          </p>
        )}
        {backups !== null && backups.entries.length === 0 && backups.unreadable === 0 && (
          <p className="tk-status sessions-empty" data-role="backups-empty">
            {t('sessions.aucune-copie')}
          </p>
        )}
        <ul className="lp-list backups-list" aria-label={t('sessions.copies-automatiques')}>
          {(backups?.entries ?? []).map((entry) => (
            <li key={entry.id} className="lp-row backups-row" data-id={entry.id}>
              <span className="lp-text sessions-copy">
                <span className="lp-title sessions-name">{copyWhen(entry.createdAt, now)}</span>
                <span className="lp-sub sessions-meta">
                  {tabs(entry.tabs)} · {tp('sessions.espaces', entry.spaces)} · {reasonLabel(entry.reason)}
                </span>
              </span>
              <button
                type="button"
                className={`tk-btn${restoring === entry.id ? ' primary danger' : ''}`}
                data-action="restore-backup"
                aria-label={t('sessions.restaurer-la-copie-du-when', { when: copyWhen(entry.createdAt, now) })}
                onClick={() => restoreBackup(entry.id)}
                onBlur={() => setRestoring((r) => (r === entry.id ? null : r))}
              >
                {restoring === entry.id ? t('sessions.confirmer') : t('sessions.restaurer')}
              </button>
            </li>
          ))}
        </ul>
        {restoring !== null && (
          <p className="tk-status sessions-hint" role="status" data-role="backup-confirm">
            {t('sessions.remplaces-par-cette-copie')}
          </p>
        )}
        {backups !== null && backups.unreadable > 0 && (
          <p className="tk-status sessions-hint" data-role="backups-unreadable">
            {tp('sessions.copies-illisibles', backups.unreadable)} {t('sessions.le-detail-est-dans-le-journal')}
          </p>
        )}
        {backupSaid !== '' && (
          <p className="tk-status sessions-hint" role="status" data-role="backup-note">
            {backupSaid}
          </p>
        )}
        <div className="sessions-backup-actions">
          <button type="button" className="tk-btn quiet" data-action="back-up-now" onClick={backUpNow}>
            {t('sessions.faire-une-copie-maintenant')}
          </button>
        </div>
      </section>
    </ListPanel>
  )
}

import { t, tp } from '@shared/i18n'
