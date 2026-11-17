import { useEffect, useState } from 'react'
import { CATEGORY_LABELS, canRunImport, canUndoImport, defaultCategories, isImportPreview, type ImportCategory, type ImportReport, type ImportSourceInfo } from '@shared/import-sources'
import { GUIDED_SETUP_REQUEST } from '@shared/settings-guide'
import { api } from './api'
import { holdOverlay } from './overlay-hold'
import './import-sheet.css'

/**
 * "Import from Another Browser…": which browser (named as its application calls itself on this Mac), which profile, what to bring along. "Importer" reads and shows what would come in
 * (nothing is written yet); "Confirmer l’import" brings it in; "Annuler l’import" takes it back while it is the latest one. Once an import is in,
 * the sheet offers the complete configuration of the Settings (never opened by itself).
 */
export function ImportSheet() {
  const act = api()
  const [sources, setSources] = useState<ImportSourceInfo[] | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [profile, setProfile] = useState<string | undefined>(undefined)
  const [ticked, setTicked] = useState<ImportCategory[]>([])
  /** What the sheet is waiting for ('' when idle): the label of the main button while it does. */
  const [working, setWorking] = useState('')
  const busy = working !== ''
  const [report, setReport] = useState<ImportReport | null>(null)
  // An import is being written, or taken back: the sheet cannot be left until it is over. Leaving would stop nothing (the import goes to its end)
  // and would take away the report, with the only button that takes the import back.
  const [writing, setWriting] = useState(false)
  useEffect(() => (writing ? holdOverlay() : undefined), [writing])

  useEffect(() => {
    let live = true
    act.importSources().then(
      (list) => live && setSources(list),
      (error: unknown) => {
        console.warn('[import] cannot list the browsers:', error)
        if (live) setSources([])
      }
    )
    return () => {
      live = false
    }
  }, [act])

  const source = sources?.find((s) => s.id === chosen)
  const choose = (next: ImportSourceInfo) => {
    setChosen(next.id)
    setProfile(next.profiles[0]?.id)
    setTicked(defaultCategories(next))
    setReport(null)
  }
  // While a request is under way (`busy`) the choices cannot be changed: the preview that comes back was read for the choices as they were when it was asked,
  // and it would be shown beside other ones.
  /** A preview shows what was ticked when it was made: changing a choice withdraws it, so that "Confirmer" never confirms something other than what is on screen. */
  const withdraw = () => setReport((current) => (current?.token !== undefined ? null : current))
  const toggle = (category: ImportCategory) => {
    withdraw()
    setTicked((current) => (current.includes(category) ? current.filter((c) => c !== category) : [...current, category]))
  }
  const changeProfile = (id: string) => {
    withdraw()
    setProfile(id)
  }

  /** Runs a request of the sheet and shows its report in place of the previous one; a failure of the request is shown the same way, and logged. */
  const ask = async (label: string, work: () => Promise<ImportReport>) => {
    setWorking(label)
    setReport(null)
    try {
      setReport(await work())
    } catch (error) {
      console.warn('[import] the request failed:', error)
      setReport({ ok: false, message: t('import-sheet.echec'), bookmarks: 0, folders: 0, history: 0, skipped: 0 })
    } finally {
      setWorking('')
    }
  }

  const run = async (pick = false) => {
    if (!source || !canRunImport(source, ticked, busy)) return
    await ask(t('import-sheet.lecture'), () => act.importPreview({ source: source.id, categories: ticked, ...(profile ? { profile } : {}), ...(pick ? { pick: true } : {}) }))
  }
  /** A request that writes: the sheet stays until its report is on screen. */
  const write = async (label: string, work: () => Promise<ImportReport>) => {
    if (busy) return
    setWriting(true)
    try {
      await ask(label, work)
    } finally {
      setWriting(false)
    }
  }
  const confirm = (token: string) => write(t('import-sheet.import'), () => act.importCommit(token))
  const undo = (token: string) => write(t('import-sheet.annulation'), () => act.importUndo(token))
  const leave = () => {
    if (!writing) act.closeOverlay()
  }

  /** The preview waits for the user's answer: nothing has been written. */
  const confirming = isImportPreview(report)

  return (
    <div className="card import" role="dialog" aria-label={t('import-sheet.importer-depuis-un-autre-navigateur')} onKeyDown={(e) => e.key === 'Escape' && leave()}>
      <h3>{t('import-sheet.importer-depuis-votre-ancien-navigateur')}</h3>
      <p className="muted import-intro">{t('import-sheet.intro')}</p>

      {sources === null && <p className="muted">{t('import-sheet.recherche-des-navigateurs')}</p>}
      <ul className="import-sources" role="radiogroup" aria-label={t('import-sheet.navigateur')}>
        {sources?.map((s) => (
          <li key={s.id}>
            <label className={`import-row ${s.id === chosen ? 'chosen' : ''}`}>
              <input type="radio" name="import-source" checked={s.id === chosen} disabled={busy} onChange={() => choose(s)} />
              <span className="import-text">
                <strong>{s.name}</strong>
                <span>{s.blurb}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {source && (
        <div className="import-options">
          {source.profiles.length > 1 && (
            <label className="import-profile">
              <span>{t('import-sheet.profil')}</span>
              <select className="field" value={profile} disabled={busy} onChange={(e) => changeProfile(e.target.value)}>
                {source.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {source.categories.map((category) => (
            <label key={category} className="import-category">
              <input type="checkbox" checked={ticked.includes(category)} disabled={busy} onChange={() => toggle(category)} />
              <span>
                {CATEGORY_LABELS[category]}
                {source.missing?.includes(category) && <em className="import-missing">{t('import-sheet.fichier-a-choisir')}</em>}
              </span>
            </label>
          ))}
        </div>
      )}

      {report && (
        <>
          <p className={`import-report ${report.ok ? 'ok' : 'failed'}`} role={report.ok ? 'status' : 'alert'}>
            {report.message}
          </p>
          {confirming && <p className="muted import-pending">{t('import-sheet.rien-n-est-encore-importe-confirmez-pour-l')}</p>}
          {report.details && report.details.length > 0 && (
            <ul className="import-details" aria-label={t('import-sheet.detail-de-l-import')}>
              {report.details.map((line, index) => (
                // Two lines can read the same (two files that failed alike): the position keeps them apart.
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          )}
          {canUndoImport(report) && <p className="muted import-pending">{t('import-sheet.configuration-rapide-aide')}</p>}
        </>
      )}

      <div className="row end">
        {report?.needsDiskAccess && (
          <button className="button" onClick={() => act.openDiskAccessSettings()}>
            {t('import-sheet.ouvrir-reglages-systeme')}
          </button>
        )}
        {(report?.needsDiskAccess || report?.canPick || (!report && source?.missing?.some((category) => ticked.includes(category)))) && (
          <button className="button" disabled={busy} onClick={() => void run(true)}>
            {t('import-sheet.choisir-le-fichier')}
          </button>
        )}
        {confirming && (
          <button className="button" disabled={busy} onClick={() => setReport(null)}>
            {t('import-sheet.retour')}
          </button>
        )}
        {canUndoImport(report) && (
          <button className="button" disabled={busy} onClick={() => void undo(report!.undoToken!)}>
            {t('import-sheet.annuler-l-import')}
          </button>
        )}
        {canUndoImport(report) && (
          <button
            className="button"
            disabled={busy}
            onClick={() => {
              act.closeOverlay()
              act.openOverlay(GUIDED_SETUP_REQUEST)
            }}
          >
            {t('import-sheet.configuration-rapide')}
          </button>
        )}
        <button className="button" disabled={writing} onClick={leave}>
          {report?.ok && !confirming ? t('settings.termine') : t('import-sheet.annuler')}
        </button>
        {confirming ? (
          <button className="button primary" disabled={busy} onClick={() => void confirm(report!.token!)}>
            {busy ? working : t('import-sheet.confirmer-l-import')}
          </button>
        ) : (
          !report?.ok && (
            <button className="button primary" disabled={!canRunImport(source, ticked, busy)} onClick={() => void run()}>
              {busy ? working : t('import-sheet.importer')}
            </button>
          )
        )}
      </div>
    </div>
  )
}

import { t } from '@shared/i18n'