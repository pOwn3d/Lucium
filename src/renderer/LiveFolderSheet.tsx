import { useState } from 'react'
import { GITHUB_WHATS, LIVE_FOLDERS_MAX, LIVE_INTERVAL_MS, isLiveFolder, parseLiveSource, type GithubWhat, type LiveSource } from '@shared/live-folders'
import type { UiSnapshot } from '@shared/ipc'
import { NAME_MAX } from '@shared/state-clean'
import { api, useSnapshot } from './api'
import './bookmarks.css'
import { t } from '@shared/i18n'

const INTERVAL_MINUTES = Math.round(LIVE_INTERVAL_MS / 60_000)

/** What a source is called in the field: the address of a feed, `owner/name` for a repository. */
const sourceText = (source: LiveSource): string => (source.kind === 'feed' ? source.url : source.repo)

/**
 * The sheet of a live folder (setting `liveFolders`): the address of a feed (RSS, Atom) or a public GitHub repository, and a name. It makes the
 * folder, or, opened from the menu of a live folder (`folderId`), changes its source and its name. Nothing is asked of the network from here:
 * the first look is made by the scheduler of the main process, a moment after the folder exists.
 */
export function LiveFolderSheet({ folderId }: { folderId?: string }) {
  // Waits for the first snapshot: the fields start from the source and the name of the folder, which no render before it knows.
  const snapshot = useSnapshot()
  if (!snapshot) return null
  return <LiveFolderForm snapshot={snapshot} folderId={folderId} />
}

function LiveFolderForm({ snapshot, folderId }: { snapshot: UiSnapshot; folderId?: string }) {
  const existing = snapshot.state.folders.find((f) => f.id === folderId && f.live)
  const [text, setText] = useState(() => (existing?.live ? sourceText(existing.live.source) : ''))
  const [what, setWhat] = useState<GithubWhat>(() => (existing?.live?.source.kind === 'github' ? existing.live.source.what : 'releases'))
  const [name, setName] = useState(() => existing?.name ?? '')
  const act = api()

  const liveCount = snapshot.state.folders.filter(isLiveFolder).length
  const full = existing === undefined && liveCount >= LIVE_FOLDERS_MAX
  const parsed = parseLiveSource(text, what)
  const source: LiveSource | null = parsed?.kind === 'github' ? { ...parsed, what } : parsed
  const typed = text.trim() !== ''
  const submit = () => {
    if (!source || full) return
    if (existing) void act.dispatch({ type: 'livefolder/edit', id: existing.id, source, name })
    else void act.dispatch({ type: 'livefolder/create', source, name, spaceId: snapshot.state.activeSpaceId })
    act.closeOverlay()
  }
  const onText = (value: string) => {
    setText(value)
    // A GitHub address names what to follow by its page (/issues, /pull…): the choice follows it.
    const next = parseLiveSource(value, what)
    if (next?.kind === 'github') setWhat(next.what)
  }

  return (
    <div className="card livefolder" role="dialog" aria-label={existing ? t('live-folder-sheet.source-du-dossier-en-direct') : t('live-folder-sheet.nouveau-dossier-en-direct')}>
      <h2>{existing ? t('live-folder-sheet.source-du-dossier-en-direct') : t('live-folder-sheet.nouveau-dossier-en-direct')}</h2>
      <label>
        {t('live-folder-sheet.flux-rss-ou-atom-ou-depot-github-public')}
        <input
          className="field"
          data-field="source"
          autoFocus
          spellCheck={false}
          placeholder={t('live-folder-sheet.exemple-de-saisie')}
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </label>
      {source?.kind === 'github' && (
        <label className="inline-select">
          {t('live-folder-sheet.suivre')}
          <select className="field" data-field="what" value={what} onChange={(e) => setWhat(e.target.value as GithubWhat)}>
            {GITHUB_WHATS.map((w) => (
              <option key={w.what} value={w.what}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t('live-folder-sheet.nom-du-dossier-facultatif')}
        <input className="field" data-field="name" maxLength={NAME_MAX} placeholder={t('live-folder-sheet.celui-de-la-source-si-vous-ne-dites-rien')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
      {typed && !source && <p className="muted livefolder-problem" role="alert">{t('live-folder-sheet.ni-adresse-ni-depot')}</p>}
      {full && <p className="muted livefolder-problem" role="alert">{t('live-folder-sheet.trop-de-dossiers', { max: LIVE_FOLDERS_MAX })}</p>}
      <p className="muted livefolder-note">
        {t('live-folder-sheet.sans-compte-ni-cookie-toutes-les-minutes', { minutes: INTERVAL_MINUTES })}
      </p>
      <div className="row end">
        <button className="link-button" onClick={() => act.closeOverlay()}>
          {t('confirm-box.annuler')}
        </button>
        <button className="button primary" data-action="submit" disabled={!source || full} onClick={submit}>
          {existing ? t('templates.enregistrer') : t('live-folder-sheet.creer-le-dossier')}
        </button>
      </div>
    </div>
  )
}
