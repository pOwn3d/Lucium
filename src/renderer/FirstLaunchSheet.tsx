import { useEffect, useState } from 'react'
import { CATEGORY_LABELS, canUndoImport, defaultCategories, importSource, type ImportCategory, type ImportReport, type ImportSourceInfo } from '@shared/import-sources'
import { adsBlockingOn } from '@shared/privacy-dashboard'
import type { Settings } from '@shared/model'
import { api, useSnapshot } from './api'
import { FIRST_LAUNCH_COLORS, NO_CHOICES, firstLaunchActions, firstLaunchFollowUp, firstLaunchRequest, runFirstLaunchImport, type FirstLaunchChoices, type FirstLaunchColor } from './first-launch'
import { t } from '@shared/i18n'
import './first-launch.css'

/** The name of a colour of the guide, as VoiceOver reads it and the tooltip shows it. */
const colorName = (id: FirstLaunchColor | null): string => {
  switch (id) {
    case null:
      return t('first-launch.couleur-actuelle')
    case 'persimmon':
      return t('first-launch.couleur-rouge')
    case 'bluegreen':
      return t('first-launch.couleur-bleu-vert')
    case 'deepviolet':
      return t('first-launch.couleur-violet')
    case 'sunburst':
      return t('first-launch.couleur-jaune')
  }
}

const appearanceName = (value: Settings['interfaceAppearance']): string => (value === 'light' ? t('menu.clair') : value === 'dark' ? t('menu.sombre') : t('menu.automatique'))

/**
 * First-launch guide: a sheet of three steps on a new profile.
 * Step 1: the browsers found on this Mac, the one to take data from (or none), its profile and what to bring along.
 * Step 2: the appearance, and the colour of the space on screen.
 * Step 3: the blocker, and a summary of what the last button does.
 * The last button records the choices (settings, colour of the space) and runs the import chosen through the import service; « Plus tard »
 * records nothing.
 */
/**
 * Puts the focus on the title of a step when it is drawn: each step is another element, so this runs once per step shown. A screen reader then
 * reads the title of the new step; before, « Suivant » replaced what the sheet showed without a word, and the focus stayed on a button.
 */
const focusNode = (node: HTMLElement | null): void => node?.focus()

export function FirstLaunchSheet() {
  const act = api()
  const snapshot = useSnapshot()
  const [step, setStep] = useState(1)
  // Whether « Suivant » or « Retour » was pressed: from then on the title of the step drawn takes the focus (the sheet opens with the focus where the host puts it).
  const [moved, setMoved] = useState(false)
  const goTo = (next: number) => {
    setMoved(true)
    setStep(next)
  }
  const title = { tabIndex: -1, ...(moved ? { ref: focusNode } : {}) }
  const [sources, setSources] = useState<ImportSourceInfo[] | null>(null)
  const [choices, setChoices] = useState<FirstLaunchChoices>(NO_CHOICES)
  /** What the sheet is waiting for ('' when idle): the label of the main button while it does. */
  const [working, setWorking] = useState('')
  /** The answer of the import, once it ran: the sheet then shows it in place of the steps. */
  const [report, setReport] = useState<ImportReport | null>(null)
  const busy = working !== ''
  /** Why the last button did nothing, when the choices could not be recorded. */
  const [problem, setProblem] = useState('')
  // The last button is being answered: set at once, before the next draw, so that a second press that comes with the first starts nothing. One object for
  // the life of the sheet, changed in place (never drawn).
  const [running] = useState({ current: false })

  useEffect(() => {
    let live = true
    act.importSources().then(
      // The browsers found on this Mac; the sources that are only a file to choose stay in the import sheet of the menu.
      (list) => live && setSources(list.filter((source) => importSource(source.id)?.pickOnly !== true)),
      (error: unknown) => {
        console.warn('[first-launch] cannot list the browsers:', error)
        if (live) setSources([])
      }
    )
    return () => {
      live = false
    }
  }, [act])

  const settings = snapshot?.state.settings
  const appearance = choices.appearance ?? settings?.interfaceAppearance ?? 'auto'
  const blocker = choices.blocker ?? (settings ? adsBlockingOn(settings) : true)
  const space = snapshot?.state.spaces.find((sp) => sp.id === snapshot.state.activeSpaceId)
  const source = sources?.find((s) => s.id === choices.source)
  const change = (patch: Partial<FirstLaunchChoices>) => setChoices((current) => ({ ...current, ...patch }))

  const choose = (next: ImportSourceInfo | null) =>
    change(next ? { source: next.id, profile: next.profiles[0]?.id, categories: defaultCategories(next) } : { source: null, profile: undefined, categories: [] })
  const toggle = (category: ImportCategory) => change({ categories: choices.categories.includes(category) ? choices.categories.filter((c) => c !== category) : [...choices.categories, category] })

  // « Plus tard » and Escape. Not while an import runs: it goes on in the main process, and a sheet closed then never shows what was brought in,
  // nor its « Annuler l'import ».
  const close = () => {
    if (!busy) act.closeOverlay()
  }
  const onEscape = (e: { key: string }) => {
    if (e.key === 'Escape') close()
  }
  // The end of the guide (not « Plus tard »): the complete configuration follows when its box was ticked.
  const done = () => {
    close()
    const next = firstLaunchFollowUp(choices)
    if (next) act.openOverlay(next)
  }

  /** Runs one import request of the sheet and shows its answer; a failure of the request is shown the same way, and logged. */
  const importing = async (work: () => Promise<ImportReport>) => {
    setWorking(t('first-launch.import-en-cours'))
    try {
      setReport(await work())
    } catch (error) {
      console.warn('[first-launch] the import failed:', error)
      setReport({ ok: false, message: t('import-sheet.echec'), bookmarks: 0, folders: 0, history: 0, skipped: 0 })
    } finally {
      setWorking('')
    }
  }

  const finish = async (pick = false) => {
    if (busy || running.current) return
    running.current = true
    setProblem('')
    setWorking(t('first-launch.enregistrement'))
    try {
      if (snapshot) for (const action of firstLaunchActions(choices, snapshot.state)) await act.dispatch(action)
    } catch (error) {
      // Nothing is imported over choices that were not recorded: the sheet stays, says so, and the button works again.
      console.warn('[first-launch] the choices could not be recorded:', error)
      setProblem(t('first-launch.choix-non-enregistres'))
      setWorking('')
      running.current = false
      return
    }
    const request = firstLaunchRequest(choices)
    try {
      if (request) await importing(() => runFirstLaunchImport(act, pick ? { ...request, pick: true } : request))
    } finally {
      setWorking('')
      running.current = false
    }
    if (!request) done()
  }

  const request = firstLaunchRequest(choices)
  const what = choices.categories.map((category) => CATEGORY_LABELS[category]).join(', ')

  if (report) {
    return (
      <div className="card first-launch" role="dialog" aria-label={t('first-launch.titre')} aria-busy={busy} onKeyDown={onEscape}>
        <h3>{t('first-launch.titre')}</h3>
        <div className="first-launch-step">
          <p className={`import-report ${report.ok ? 'ok' : 'failed'}`} role={report.ok ? 'status' : 'alert'}>
            {report.message}
          </p>
          {report.details && report.details.length > 0 && (
            <ul className="import-details" aria-label={t('import-sheet.detail-de-l-import')}>
              {report.details.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="first-launch-nav">
          {/* « Choisir le fichier » records the choices again before it imports: said here too when that fails. */}
          {problem && (
            <p className="muted" role="alert">
              {problem}
            </p>
          )}
          {report.needsDiskAccess && (
            <button type="button" className="btn secondary" onClick={() => act.openDiskAccessSettings()}>
              {t('import-sheet.ouvrir-reglages-systeme')}
            </button>
          )}
          {(report.needsDiskAccess || report.canPick) && (
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void finish(true)}>
              {t('import-sheet.choisir-le-fichier')}
            </button>
          )}
          {canUndoImport(report) && (
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void importing(() => act.importUndo(report.undoToken!))}>
              {t('import-sheet.annuler-l-import')}
            </button>
          )}
          <button type="button" className="btn primary" disabled={busy} onClick={done}>
            {busy ? working : t('settings.termine')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="card first-launch" role="dialog" aria-label={t('first-launch.titre')} aria-busy={busy} onKeyDown={onEscape}>
      <h3>{t('first-launch.titre')}</h3>

      {step === 1 && (
        <div className="first-launch-step">
          <h4 {...title}>{t('first-launch.etape-1-titre')}</h4>
          <p className="muted">{t('first-launch.etape-1-intro')}</p>
          {sources === null && <p className="muted">{t('first-launch.recherche')}</p>}
          {sources !== null && sources.length === 0 && <p className="muted">{t('first-launch.aucun-autre-navigateur-trouve-sur-ce-mac')}</p>}
          <ul className="first-launch-sources" role="radiogroup" aria-label={t('import-sheet.navigateur')}>
            {/* The list is the group of the radios: its items are not announced as a list inside it. */}
            {sources?.map((s) => (
              <li key={s.id} role="presentation">
                <label className={`first-launch-source ${s.id === choices.source ? 'chosen' : ''}`}>
                  <input type="radio" name="first-launch-source" checked={s.id === choices.source} onChange={() => choose(s)} />
                  <span className="first-launch-source-text">
                    <strong>{s.name}</strong>
                    <span>{s.blurb}</span>
                  </span>
                </label>
              </li>
            ))}
            <li role="presentation">
              <label className={`first-launch-source ${choices.source === null ? 'chosen' : ''}`}>
                <input type="radio" name="first-launch-source" checked={choices.source === null} onChange={() => choose(null)} />
                <span className="first-launch-source-text">
                  <strong>{t('first-launch.commencer-vide')}</strong>
                  <span>{t('first-launch.commencer-vide-aide')}</span>
                </span>
              </label>
            </li>
          </ul>
          {source && (
            <div className="first-launch-what">
              {source.profiles.length > 1 && (
                <label className="first-launch-option">
                  <span>{t('import-sheet.profil')}</span>
                  <select className="field" value={choices.profile} onChange={(e) => change({ profile: e.target.value })}>
                    {source.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {source.categories.map((category) => (
                <label key={category} className="first-launch-check">
                  <input type="checkbox" checked={choices.categories.includes(category)} onChange={() => toggle(category)} />
                  <span>
                    {CATEGORY_LABELS[category]}
                    {source.missing?.includes(category) && <em className="import-missing">{t('import-sheet.fichier-a-choisir')}</em>}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="first-launch-step">
          <h4 {...title}>{t('first-launch.etape-2-titre')}</h4>
          <p className="muted">{t('first-launch.etape-2-intro')}</p>

          <label className="first-launch-option">
            <span>{t('first-launch.etape-2-theme')}</span>
            <select className="field" value={appearance} onChange={(e) => change({ appearance: e.target.value as Settings['interfaceAppearance'] })}>
              <option value="auto">{t('menu.automatique')}</option>
              <option value="light">{t('menu.clair')}</option>
              <option value="dark">{t('menu.sombre')}</option>
            </select>
          </label>

          <div className="first-launch-option" role="group" aria-labelledby="first-launch-color-label">
            <span id="first-launch-color-label">{t('first-launch.couleur-de-l-espace', { name: space?.name ?? '' })}</span>
            <div className="first-launch-colors">
              {[null, ...FIRST_LAUNCH_COLORS.map((color) => color.id)].map((id) => (
                <button
                  key={id ?? 'current'}
                  type="button"
                  className={`color-chip ${choices.color === id ? 'selected' : ''}`}
                  data-color={id ?? 'current'}
                  style={id === null && space ? { background: space.theme.baseColors[0] } : undefined}
                  onClick={() => change({ color: id })}
                  title={colorName(id)}
                  aria-label={colorName(id)}
                  aria-pressed={choices.color === id}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="first-launch-step">
          <h4 {...title}>{t('first-launch.etape-3-titre')}</h4>
          <p className="muted">{t('first-launch.etape-3-intro')}</p>

          <div className="first-launch-summary">
            <label className="first-launch-check">
              <input type="checkbox" checked={blocker} onChange={(e) => change({ blocker: e.target.checked })} />
              <span>{t('first-launch.etape-3-blocker')}</span>
            </label>

            <div className="summary-note">
              <strong>{t('first-launch.resume')}</strong>
              <ul>
                <li>{request && source ? t('first-launch.resume-import', { browser: source.name, what }) : t('first-launch.resume-sans-import')}</li>
                <li>{t('first-launch.resume-apparence', { appearance: appearanceName(appearance), color: colorName(choices.color) })}</li>
                <li>{blocker ? t('first-launch.resume-bloqueur-oui') : t('first-launch.resume-bloqueur-non')}</li>
              </ul>
            </div>

            <label className="first-launch-check">
              <input type="checkbox" checked={choices.quickSetup} onChange={(e) => change({ quickSetup: e.target.checked })} />
              <span>{t('first-launch.ensuite-configuration-rapide')}</span>
            </label>
          </div>
        </div>
      )}

      <div className="first-launch-nav">
        {problem ? (
          <p className="muted" role="alert">
            {problem}
          </p>
        ) : (
          <p className="muted">{t('first-launch.reprenez-quand-vous-voulez')}</p>
        )}
        <button type="button" className="btn secondary" onClick={close} disabled={busy}>
          {t('first-launch.plus-tard')}
        </button>
        {step > 1 && (
          <button type="button" className="btn secondary" onClick={() => goTo(step - 1)} disabled={busy}>
            {t('import-sheet.retour')}
          </button>
        )}
        {step < 3 && (
          <button type="button" className="btn primary" onClick={() => goTo(step + 1)} disabled={busy || (choices.source !== null && choices.categories.length === 0)}>
            {t('first-launch.suivant')}
          </button>
        )}
        {step === 3 && (
          <button type="button" className="btn primary" onClick={() => void finish()} disabled={busy || snapshot === null}>
            {busy ? working : request ? t('first-launch.importer-et-commencer') : t('first-launch.c-est-pret')}
          </button>
        )}
      </div>
    </div>
  )
}
