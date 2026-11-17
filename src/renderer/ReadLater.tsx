import { useMemo, useRef, useState } from 'react'
import { READ_LATER_FOLDER_NAME_MAX, type ReadLaterFolder, type ReadLaterItem } from '@shared/model'
import { filterReadLater, readLaterAge, readLaterGroups, readLaterStep } from '@shared/read-later'
import { hostOf } from '@shared/url'
import { api, useSnapshot } from './api'
import { useNoticeHold } from './notice-hold'
import { useUndoQueue } from './templates/useUndoQueue'
import './read-later.css'

/** The icon of a saved page: its favicon, or the initial of its site when it has none (or the image cannot be shown). */
function ItemIcon({ item }: { item: ReadLaterItem }) {
  const [failed, setFailed] = useState(false)
  const source = iconSource(item.faviconUrl)
  if (source && !failed) return <img className="favicon readlater-icon" src={source} alt="" draggable={false} onError={() => setFailed(true)} />
  return <span className="favicon readlater-icon fallback">{(hostOf(item.url) || item.title || '?').charAt(0).toUpperCase()}</span>
}

/** What a drag of a page carries: its id. A type of ours, so that the surface lets it through (see surface-guard.ts). */
export const DRAG_READLATER_TYPE = 'application/x-lucium-readlater'

/** Where a dragged page would land: into a folder (null: out of all of them), before a page, or at the end of a folder. */
interface DropMark {
  key: string
  folderId: string | null
  beforeId?: string | null
}

/** What the undo queue holds while the whole list is being emptied: no page has this id. */
const CLEARED = '\u0000every-page'

/**
 * "Liste de lecture…": the pages kept with "Lire plus tard", newest first. A page is opened in a new tab (it stays in the list, as
 * in the Toolkit's list until the user deletes it); "Tout effacer" asks a second click before it empties the list. A page deleted, or the
 * list emptied, can be taken back for a few seconds as in the other lists: nothing else keeps a copy of this list. With the setting
 * "Classer « Lire plus tard » dans des dossiers" the pages can be put in named folders, by dragging them or with the menu of a row.
 */
export function ReadLater() {
  const snapshot = useSnapshot()
  const [filter, setFilter] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  // Return and the loss of focus both end a name being typed: whichever comes first counts, once.
  const nameEnded = useRef(false)
  const [dragged, setDragged] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // The ages are computed once per opening of the panel: they do not need to tick while it is on screen.
  const [now] = useState(() => Date.now())
  const undo = useUndoQueue()
  const undoHold = useNoticeHold(undo.hold, undo.notice !== null)
  const saved = snapshot?.state.readLater
  // What is waiting to be deleted is already out of the list the person sees.
  const list = useMemo(() => (saved === undefined ? undefined : undo.hidden.has(CLEARED) ? [] : saved.filter((item) => !undo.hidden.has(item.id))), [saved, undo.hidden])
  const folders = snapshot?.state.readLaterFolders
  const useFolders = snapshot?.state.settings.useReadLaterFolders === true
  const shown = useMemo(() => filterReadLater(list ?? [], filter), [list, filter])
  const groups = useMemo(() => readLaterGroups(shown, useFolders ? (folders ?? []) : []), [shown, folders, useFolders])
  const act = api()
  if (!snapshot || !list || !folders) return null

  const open = (id: string) => {
    void act.dispatch({ type: 'readlater/open', id })
    act.closeOverlay()
  }
  const filtering = filter.trim() !== ''

  const move = (id: string, folderId: string | null, beforeId?: string | null) => void act.dispatch({ type: 'readlater/move', id, folderId, beforeId })
  const dropHandlers = (mark: DropMark) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_READLATER_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (over !== mark.key) setOver(mark.key)
    },
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(DRAG_READLATER_TYPE)
      setOver(null)
      setDragged(null)
      if (!id) return
      e.preventDefault()
      e.stopPropagation()
      move(id, mark.folderId, mark.beforeId)
    }
  })

  // The order of the pages of a folder is changed by dragging, or with these two buttons for who has no pointer.
  const stepButton = (item: ReadLaterItem, group: readonly ReadLaterItem[], direction: 'up' | 'down') => {
    const step = readLaterStep(group, item.id, direction)
    return (
      <button
        className="readlater-button readlater-step"
        data-action={direction === 'up' ? 'move-up' : 'move-down'}
        aria-label={t(direction === 'up' ? 'read-later.monter-name' : 'read-later.descendre-name', { name: item.title })}
        title={t(direction === 'up' ? 'read-later.monter' : 'read-later.descendre')}
        disabled={step === null}
        onClick={() => step && move(item.id, item.folderId ?? null, step.beforeId)}
      >
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={direction === 'up' ? 'm2.500 7.500 3.500-4 3.500 4' : 'm2.500 4.500 3.500 4 3.500-4'} />
        </svg>
      </button>
    )
  }

  const row = (item: ReadLaterItem, _index: number, group: readonly ReadLaterItem[]) => (
    <li
      key={item.id}
      className={`readlater-row${dragged === item.id ? ' dragging' : ''}${over === `before:${item.id}` ? ' drop-before' : ''}`}
      data-id={item.id}
      draggable={useFolders && !filtering}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_READLATER_TYPE, item.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragged(item.id)
      }}
      onDragEnd={() => {
        setDragged(null)
        setOver(null)
      }}
      {...(useFolders ? dropHandlers({ key: `before:${item.id}`, folderId: item.folderId ?? null, beforeId: item.id }) : {})}
    >
      <ItemIcon item={item} />
      <span className="readlater-text" title={item.url}>
        <span className="readlater-title">{item.title}</span>
        <span className="readlater-meta">
          {hostOf(item.url)} · {readLaterAge(item.savedAt, now)}
        </span>
      </span>
      {useFolders && folders.length > 0 && (
        <select
          className="readlater-folder-select"
          data-action="classify"
          aria-label={t('read-later.dossier-de-title', { title: item.title })}
          value={item.folderId ?? ''}
          onChange={(e) => move(item.id, e.target.value === '' ? null : e.target.value)}
        >
          <option value="">{t('read-later.sans-dossier')}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
      {useFolders && !filtering && stepButton(item, group, 'up')}
      {useFolders && !filtering && stepButton(item, group, 'down')}
      <button className="readlater-button" data-action="open" aria-label={t('read-later.ouvrir-name', { name: item.title })} onClick={() => open(item.id)}>
        {t('read-later.ouvrir')}
      </button>
      <button
        className="readlater-button danger"
        data-action="remove"
        aria-label={t('read-later.supprimer-name', { name: item.title })}
        onClick={() => undo.remove(item.id, t('read-later.page-retiree-title', { title: item.title }), () => void act.dispatch({ type: 'readlater/remove', id: item.id }))}
      >
        {t('read-later.supprimer')}
      </button>
    </li>
  )

  const folderBlock = (folder: ReadLaterFolder, items: ReadLaterItem[]) => {
    // A search shows what it found, folded or not.
    const folded = folder.collapsed === true && !filtering
    const editing = renaming?.id === folder.id
    const commitRename = () => {
      if (nameEnded.current) return
      nameEnded.current = true
      if (renaming && renaming.name.trim() !== '') void act.dispatch({ type: 'readlater-folder/rename', id: folder.id, name: renaming.name })
      setRenaming(null)
    }
    const beginRename = () => {
      nameEnded.current = false
      setRenaming({ id: folder.id, name: folder.name })
    }
    return (
      <li key={folder.id} className="readlater-folder" data-folder={folder.id}>
        <div className={`readlater-folder-head${over === `into:${folder.id}` ? ' drop-into' : ''}`} {...dropHandlers({ key: `into:${folder.id}`, folderId: folder.id })}>
          <button
            className="readlater-fold"
            data-action="fold"
            aria-expanded={!folded}
            aria-label={folded ? t('read-later.deplier-name', { name: folder.name }) : t('read-later.replier-name', { name: folder.name })}
            onClick={() => void act.dispatch({ type: 'readlater-folder/collapse', id: folder.id, collapsed: !folded })}
          >
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={folded ? 'm4.500 2.500 4 3.500-4 3.500' : 'm2.500 4.500 3.500 4 3.500-4'} />
            </svg>
          </button>
          {editing ? (
            <input
              className="field readlater-folder-name"
              aria-label={t('sidebar.nom-du-dossier')}
              autoFocus
              maxLength={READ_LATER_FOLDER_NAME_MAX}
              value={renaming.name}
              onChange={(e) => setRenaming({ id: folder.id, name: e.target.value })}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') {
                  e.stopPropagation()
                  nameEnded.current = true
                  setRenaming(null)
                }
              }}
            />
          ) : (
            <span className="readlater-folder-title" onDoubleClick={beginRename}>
              {folder.name} <span className="muted">{items.length}</span>
            </span>
          )}
          <button className="readlater-button" data-action="rename-folder" aria-label={t('read-later.renommer-le-dossier', { name: folder.name })} onClick={beginRename}>
            {t('read-later.renommer')}
          </button>
          <button
            className="readlater-button danger"
            data-action="delete-folder"
            aria-label={t('read-later.supprimer-le-dossier-name', { name: folder.name })}
            title={t('read-later.les-pages-du-dossier-restent-dans-la-liste')}
            onClick={() => void act.dispatch({ type: 'readlater-folder/delete', id: folder.id })}
          >
            {t('read-later.supprimer')}
          </button>
        </div>
        {!folded && items.length > 0 && <ul className="readlater-list inner">{items.map(row)}</ul>}
        {!folded && items.length === 0 && !filtering && <p className="muted readlater-empty folder-empty">{t('read-later.glissez-des-pages-ici')}</p>}
      </li>
    )
  }

  const createFolder = () => {
    if (nameEnded.current) return
    nameEnded.current = true
    if (naming !== null && naming.trim() !== '') void act.dispatch({ type: 'readlater-folder/create', name: naming })
    setNaming(null)
  }
  // A search hides the folders that hold nothing it found.
  const visibleFolders = groups.folders.filter((g) => !filtering || g.items.length > 0)

  return (
    <div className="card readlater" role="dialog" aria-label={t('menu.lire-plus-tard')}>
      <h2>
        {t('menu.lire-plus-tard')} <span className="muted readlater-count">{filtering ? `${shown.length} / ${list.length}` : list.length}</span>
      </h2>
      {list.length > 0 && (
        <input
          className="field"
          autoFocus
          spellCheck={false}
          aria-label={t('read-later.filtrer-la-liste')}
          placeholder={t('read-later.filtrer-la-liste')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && shown[0] && open(shown[0].id)}
        />
      )}
      {useFolders && (
        <div className="readlater-tools">
          {naming === null ? (
            <button
              className="link-button"
              data-action="new-folder"
              onClick={() => {
                nameEnded.current = false
                setNaming('')
              }}
            >
              {t('read-later.nouveau-dossier')}
            </button>
          ) : (
            <input
              className="field readlater-folder-name"
              data-field="new-folder"
              autoFocus
              aria-label={t('read-later.nom-du-nouveau-dossier')}
              placeholder={t('sidebar.nom-du-dossier')}
              maxLength={READ_LATER_FOLDER_NAME_MAX}
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onBlur={createFolder}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createFolder()
                else if (e.key === 'Escape') {
                  e.stopPropagation()
                  nameEnded.current = true
                  setNaming(null)
                }
              }}
            />
          )}
        </div>
      )}
      {list.length === 0 && folders.length === 0 && (
        <p className="muted readlater-empty">{t('read-later.aucune-page-enregistree')}</p>
      )}
      {list.length > 0 && shown.length === 0 && <p className="muted readlater-empty">{t('manage-panels.aucun-resultat')}</p>}
      <ul className="readlater-list">
        {useFolders ? (
          <>
            {visibleFolders.map((g) => folderBlock(g.folder, g.items))}
            {groups.loose.length > 0 && visibleFolders.length > 0 && (
              <li className={`readlater-loose-head${over === 'into:' ? ' drop-into' : ''}`} {...dropHandlers({ key: 'into:', folderId: null, beforeId: null })}>
                {t('read-later.sans-dossier')}
              </li>
            )}
            {groups.loose.map(row)}
          </>
        ) : (
          shown.map(row)
        )}
      </ul>
      {undo.notice && (
        <div className="readlater-undo" role="status" {...undoHold}>
          <span className="readlater-undo-text">{undo.notice.message}</span>
          <button type="button" className="link-button" data-action="undo" onClick={() => undo.undo()}>
            {t('templates.annuler')}
          </button>
        </div>
      )}
      <div className="row between">
        {confirmClear ? (
          <span className="row tight">
            {/* « Annuler » takes the place « Tout effacer » had: the second click of a double click lands on it, not on the button that empties the list. */}
            <button className="link-button" data-action="clear-cancel" onClick={() => setConfirmClear(false)}>
              {t('read-later.annuler')}
            </button>
            <button
              className="button readlater-confirm"
              data-action="clear-confirm"
              onClick={() => {
                setConfirmClear(false)
                undo.remove(CLEARED, t('read-later.liste-videe'), () => void act.dispatch({ type: 'readlater/clear' }))
              }}
            >
              {list.length === 1 ? t('read-later.retirer-cette-page') : t('read-later.retirer-les-length-pages', { length: list.length })}
            </button>
          </span>
        ) : (
          <button className="link-button" data-action="clear" disabled={list.length === 0} onClick={() => setConfirmClear(true)}>
            {t('read-later.tout-effacer')}
          </button>
        )}
        <button className="button primary" onClick={() => act.closeOverlay()}>
          {t('settings.termine')}
        </button>
      </div>
    </div>
  )
}

import { t } from '@shared/i18n'
import { iconSource } from '@shared/site-icon'