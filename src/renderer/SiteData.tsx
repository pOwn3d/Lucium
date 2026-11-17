import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { SITE_DATA_HOSTS_MAX, SITE_DATA_LABELS, SITE_DATA_TYPES, parseSiteHost, siteHostOf, siteOrigins, splitSiteHosts, type SiteDataSiteResult, type SiteDataType } from '@shared/site-data'
import {
  addSheetSites,
  licencesNoteKey,
  offeredSiteDataTypes,
  rememberedChoices,
  resultChip,
  resultErrors,
  resultsSummary,
  sheetHosts,
  sheetKeyAction,
  sheetProblem,
  sheetProblemText,
  sheetRequest,
  sheetStart,
  SITE_DATA_SETTINGS_REQUEST,
  type SheetProblem
} from '@shared/site-data-sheet'
import { acceleratorKeys, effectiveAccelerator, formatAccelerator } from '@shared/keybindings'
import { platformOf } from '@shared/platform'
import { activeTab } from '@shared/sidebar'
import type { UiSnapshot } from '@shared/ipc'
import { t, tp } from '@shared/i18n'
import { ipcErrorText } from '@shared/ipc-error'
import { api, useSnapshot } from './api'
import { useFocusScope } from './templates/useFocusScope'
import { SHEET_ICONS, StrokeGlyph } from './stroke-glyph'
import './site-data.css'
import { NBSP } from '@shared/french-typography'

/** A view to open the sheet on, for the tests that draw it without a window. */
export interface SiteDataInitial {
  draft?: string
  cookies?: number
  problem?: SheetProblem
  failure?: string
  confirming?: boolean
  results?: SiteDataSiteResult[]
}

/** Waits for the first snapshot: the sites, the ticked types and the other choices all start from it. */
export function SiteData({ initial }: { initial?: SiteDataInitial }) {
  const snapshot = useSnapshot()
  if (!snapshot) return null
  return <SiteDataSheet snapshot={snapshot} initial={initial ?? {}} />
}

/** A comma, a semicolon or a space ends a site while it is typed or pasted. */
const SEPARATOR = /[\s,;]/

/**
 * "Effacer les données du site…", laid out as the extension « Clear Domain Data » it comes from: the domains as tags (the site of the tab
 * first), the two scopes, the domains erased before, the types in a grid, the two switches and the button. The rules live in
 * shared/site-data-sheet.ts; the confirmation, the notice and the animation on the page are set in Réglages › Vie privée et sécurité.
 * Afterwards the sheet shows one card per site, or closes at once and lets the run end in the background.
 */
function SiteDataSheet({ snapshot, initial }: { snapshot: UiSnapshot; initial: SiteDataInitial }) {
  const { state } = snapshot
  const { settings } = state
  const act = api()
  const isPrivate = snapshot.private === true
  const offered = useMemo(() => offeredSiteDataTypes(isPrivate), [isPrivate])
  const [start] = useState(() => sheetStart(activeTab(state)?.url, settings, { private: isPrivate }))
  const [tags, setTags] = useState<string[]>(start.tags)
  const [draft, setDraft] = useState(initial.draft ?? '')
  const [types, setTypes] = useState<ReadonlySet<SiteDataType>>(() => new Set(start.types))
  const [http, setHttp] = useState(start.http)
  const [httpChosen, setHttpChosen] = useState(false)
  const [subdomains, setSubdomains] = useState(start.subdomains)
  const [reload, setReload] = useState(start.reload)
  const [autoClose, setAutoClose] = useState(start.autoClose)
  const [cookies, setCookies] = useState<number | null>(initial.cookies ?? null)
  const [results, setResults] = useState<SiteDataSiteResult[] | null>(initial.results ?? null)
  const [confirming, setConfirming] = useState(initial.confirming ?? false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<SheetProblem | null>(initial.problem ?? null)
  const [failure, setFailure] = useState<string | null>(initial.failure ?? null)
  const inputRef = useRef<HTMLInputElement>(null)
  const ctaRef = useRef<HTMLButtonElement>(null)

  const { hosts, draftInvalid } = sheetHosts(tags, draft)
  const chosen = SITE_DATA_TYPES.filter((type) => types.has(type) && offered.includes(type))
  const licencesNote = licencesNoteKey(chosen)
  const sites = hosts.flatMap((host) => parseSiteHost(host) ?? [])
  const onlyIps = sites.length > 0 && sites.every((site) => site.kind === 'ip')
  const recents = isPrivate ? [] : settings.siteDataRecents.filter((host) => !hosts.includes(host))
  // What a problem found on the press says; the field says at once that what is typed is not a site.
  const shownProblem = problem ?? (draftInvalid ? 'invalid' : null)
  const origins = sites.flatMap((site) => siteOrigins(site.host, { http }))
  const platform = platformOf(snapshot.platform)
  const quickKeys = effectiveAccelerator('clearSiteDataNow', settings.keyBindings, platform)

  // The cookie count is asked of the main process once typing pauses; a slower answer for an older list is dropped.
  const latest = useRef(0)
  // Never more sites than a run takes: the count is one request per site.
  const counted = hosts.slice(0, SITE_DATA_HOSTS_MAX)
  const hostsKey = counted.join(' ')
  useEffect(() => {
    const ticket = ++latest.current
    if (counted.length === 0) {
      setCookies(null)
      return
    }
    const timer = setTimeout(() => {
      Promise.all(counted.map((host) => act.siteCookieCount(host, subdomains))).then(
        (counts) => ticket === latest.current && setCookies(counts.reduce((sum, n) => sum + n, 0)),
        (error: unknown) => {
          // The count is a convenience: without it the tile shows no number.
          console.warn('[site-data] cannot count the cookies:', error)
          if (ticket === latest.current) setCookies(null)
        }
      )
    }, 150)
    return () => clearTimeout(timer)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `hostsKey` is the content of `counted`, a new array at each draw; `act` is the bridge of the window and never changes
  }, [hostsKey, subdomains, results])

  // Any change of the choices makes the last answer and the last complaint stale.
  const touched = () => {
    setResults(null)
    setFailure(null)
    setProblem(null)
    setConfirming(false)
  }
  const addSites = (list: readonly string[]) => {
    touched()
    const next = addSheetSites(tags, list)
    setTags(next.tags)
    // Said at once, under the switches, as the button would say it.
    if (next.refused) setProblem('too-many')
  }
  const removeSite = (host: string) => {
    touched()
    setTags((current) => current.filter((tag) => tag !== host))
  }
  /** Turns the text into tags: the valid sites become tags, what is not valid (or still being typed, unless `final`) stays in the field. */
  const take = (text: string, final: boolean) => {
    const parts = splitSiteHosts(text)
    const open = !final && !/[\s,;]$/.test(text) ? parts.pop() : undefined
    addSites(parts.filter((part) => parseSiteHost(part)))
    setDraft([...parts.filter((part) => !parseSiteHost(part)), ...(open ? [open] : [])].join(' '))
  }

  const toggle = (type: SiteDataType) => {
    touched()
    setTypes((current) => {
      const next = new Set(current)
      if (!next.delete(type)) next.add(type)
      return next
    })
  }
  const setAll = (all: boolean) => {
    touched()
    setTypes(new Set(all ? offered : []))
  }

  /** The button, and Enter in an empty field: the checks of the extension, then the confirmation when Réglages asks for one. */
  const press = () => {
    if (busy) return
    const found = sheetProblem({ hosts, draftInvalid, types: chosen })
    if (found) {
      setProblem(found)
      if (found === 'no-site' || found === 'invalid') inputRef.current?.focus()
      return
    }
    if (settings.siteDataConfirm) setConfirming(true)
    else void clear()
  }

  const clear = async () => {
    if (busy || sheetProblem({ hosts, draftInvalid, types: chosen })) return
    setBusy(true)
    setFailure(null)
    setConfirming(false)
    // What was typed became part of the list: it is shown as tags from now on.
    setTags(hosts)
    setDraft('')
    const choices = { types: chosen, http, subdomains, reload, autoClose }
    // The choices are remembered for next time, as they were when the run started (a private window keeps none: its dispatch refuses them).
    void act.dispatch({ type: 'settings/update', patch: rememberedChoices(choices, { httpChosen, settings }) })
    try {
      const answer = await act.clearSites(sheetRequest(hosts, choices))
      if (autoClose) act.closeOverlay()
      else setResults(answer)
    } catch (error) {
      // The sentence the main process wrote, without the name of the channel it came through.
      console.warn('[site-data] the run failed:', error)
      setFailure(ipcErrorText(error) || t('errors.erreur-inattendue'))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    const action = sheetKeyAction(e.key, draft, tags.length)
    if (action === 'take') {
      e.preventDefault()
      take(draft, true)
    } else if (action === 'clear') {
      e.preventDefault()
      press()
    } else if (action === 'remove-last') removeSite(tags[tags.length - 1]!)
  }

  const back = () => {
    touched()
    // The button is back on screen at the next paint.
    requestAnimationFrame(() => ctaRef.current?.focus())
  }

  return (
    <div className="card sitedata sd-sheet" role="dialog" aria-label={t('cmd.effacer-les-donnees-du-site')}>
      <header className="sd-header">
        <span className="sd-logo">
          <StrokeGlyph parts={SHEET_ICONS.trash} size={14} stroke={2.25} />
        </span>
        <h2>{t('cmd.effacer-les-donnees-du-site')}</h2>
        <button type="button" className="sd-icon-button" aria-label={t('site-data.reglages-de-l-effacement')} title={t('site-data.reglages-de-l-effacement')} onClick={() => act.openOverlay(SITE_DATA_SETTINGS_REQUEST)}>
          <StrokeGlyph parts={SHEET_ICONS.sliders} />
        </button>
      </header>

      {results ? (
        <Results results={results} reload={reload} onBack={back} />
      ) : (
        <div className="sd-body">
          <section className="sd-section">
            <div className="sd-section-header">
              <h3 className="sd-label">{t('site-data.domaines')}</h3>
              {hosts.length > 0 && <span className="sd-meta">{tp('site-data.count-domaines', hosts.length)}</span>}
            </div>
            <div className={`sd-field${draftInvalid || problem === 'no-site' ? ' is-invalid' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), inputRef.current?.focus())}>
              {tags.length > 0 && (
                <div className="sd-tags">
                  {tags.map((host) => (
                    <span key={host} className="sd-tag">
                      <span className="sd-tag-label" title={host}>
                        {host}
                      </span>
                      <button type="button" className="sd-tag-remove" aria-label={t('settings.retirer-name', { name: host })} title={t('settings.retirer-name', { name: host })} disabled={busy} onClick={() => removeSite(host)}>
                        <StrokeGlyph parts={SHEET_ICONS.cross} size={12} stroke={2.5} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="sd-input-row">
                <input
                  ref={inputRef}
                  className="field sd-input"
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={t('site-data.ajouter-le-domaine')}
                  placeholder={t('site-data.ajouter-un-domaine')}
                  aria-invalid={draftInvalid}
                  value={draft}
                  disabled={busy}
                  onChange={(e) => {
                    const value = e.target.value
                    touched()
                    if (SEPARATOR.test(value)) take(value, false)
                    else setDraft(siteHostOf(value))
                  }}
                  onPaste={(e) => {
                    // Several sites pasted at once become several tags; one site goes the usual way.
                    const text = e.clipboardData.getData('text')
                    if (!SEPARATOR.test(text.trim())) return
                    e.preventDefault()
                    touched()
                    take(`${draft} ${text}`, true)
                  }}
                  onKeyDown={onKeyDown}
                />
                <button
                  type="button"
                  className="sd-icon-button sd-add"
                  aria-label={t('site-data.ajouter-le-domaine')}
                  title={t('site-data.ajouter-le-domaine')}
                  disabled={busy}
                  onClick={() => {
                    if (draft.trim() !== '') take(draft, true)
                    inputRef.current?.focus()
                  }}
                >
                  <StrokeGlyph parts={SHEET_ICONS.plus} size={15} />
                </button>
              </div>
            </div>
            <div className="sd-scopes" title={origins.length > 0 ? `${t('site-data.un-effacement-ne-touche-que-ces-origines')}${NBSP}: ${origins.join(' · ')}${subdomains && !onlyIps ? ` · ${t('site-data.et-les-sous-domaines-qui-ont-des-donnees')}` : ''}` : undefined}>
              <Scope
                label={t('site-data.inclure-http')}
                hint={t('site-data.inclure-http-aide')}
                checked={http}
                disabled={busy}
                onChange={(on) => {
                  touched()
                  setHttp(on)
                  setHttpChosen(true)
                }}
              />
              <Scope
                label={t('site-data.sous-domaines')}
                hint={t('site-data.sous-domaines-aide')}
                checked={subdomains}
                disabled={busy || onlyIps}
                onChange={(on) => {
                  touched()
                  setSubdomains(on)
                }}
              />
            </div>
          </section>

          {recents.length > 0 && (
            <section className="sd-recents" aria-labelledby="sd-recents-label">
              <h3 id="sd-recents-label" className="sd-label">
                {t('site-data.recents')}
              </h3>
              <ul className="sd-recents-list">
                {recents.map((host) => (
                  <li key={host}>
                    <button type="button" className="sd-recent" title={t('site-data.ajouter-host', { host })} disabled={busy} onClick={() => addSites([host])}>
                      {host}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="sd-text-button" title={t('site-data.effacer-les-recents')} onClick={() => void act.dispatch({ type: 'settings/update', patch: { siteDataRecents: [] } })}>
                {t('app.effacer')}
              </button>
            </section>
          )}

          <section className="sd-section">
            <div className="sd-section-header">
              <h3 className="sd-label">{t('site-data.types-de-donnees')}</h3>
              <span className={`sd-count${chosen.length === 0 ? ' is-empty' : ''}`}>
                {chosen.length}/{offered.length}
              </span>
              <span className="sd-select">
                <button type="button" className="sd-text-button" disabled={busy} onClick={() => setAll(true)}>
                  {t('history-days.tout')}
                </button>
                <button type="button" className="sd-text-button" disabled={busy} onClick={() => setAll(false)}>
                  {t('lock-settings.aucun')}
                </button>
              </span>
            </div>
            <ul className="sd-types">
              {offered.map((type) => {
                const { label, hint } = SITE_DATA_LABELS[type]
                return (
                  <li key={type}>
                    <label className="sd-tile" title={hint}>
                      <input type="checkbox" className="sd-check" checked={types.has(type)} disabled={busy} aria-description={hint} onChange={() => toggle(type)} />
                      <strong className="sd-tile-label">{label}</strong>
                      {type === 'cookies' && cookies !== null && cookies > 0 && (
                        <span className="sd-badge" title={tp('site-data.cookies-trouves', cookies)}>
                          {cookies}
                        </span>
                      )}
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>

          <div className="sd-action">
            <div className="sd-switches">
              <Switch
                label={t('site-data.recharger-l-onglet')}
                hint={t('site-data.recharger-l-onglet-aide')}
                checked={reload}
                disabled={busy}
                onChange={(on) => {
                  touched()
                  setReload(on)
                }}
              />
              <Switch label={t('site-data.fermeture-auto')} hint={t('site-data.fermeture-auto-aide')} checked={autoClose} disabled={busy} onChange={setAutoClose} />
            </div>
            {chosen.includes('cookies') && <p className="sd-note">{t('site-data.note-http-auth')}</p>}
            {licencesNote && <p className="sd-note">{t(licencesNote)}</p>}
            {shownProblem && (
              <p className="sd-error" role="alert">
                {sheetProblemText(shownProblem)}
              </p>
            )}
            {failure && (
              <p className="sd-error" role="alert">
                {t('site-data.effacement-impossible-error', { error: failure })}
              </p>
            )}
            <button ref={ctaRef} type="button" className="sd-cta" aria-busy={busy} disabled={busy} onClick={press}>
              <StrokeGlyph parts={busy ? SHEET_ICONS.busy : SHEET_ICONS.trash} stroke={busy ? 2.5 : 2} />
              <span className="sd-cta-label">{busy ? t('site-data.effacement') : t('site-data.effacer-les-donnees')}</span>
              {quickKeys && acceleratorKeys(quickKeys, platform).length > 0 && (
                <span className="sd-keys" aria-hidden="true" title={t('site-data.raccourci-sans-la-feuille', { keys: formatAccelerator(quickKeys, platform) })}>
                  {acceleratorKeys(quickKeys, platform).map((key, i) => (
                    <kbd key={i}>{key}</kbd>
                  ))}
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {confirming && !results && <Confirm hosts={hosts} typeCount={chosen.length} onCancel={() => setConfirming(false)} onConfirm={() => void clear()} />}
    </div>
  )
}

/** A scope pill (« Inclure HTTP », « Sous-domaines »): a check box drawn as a pill, a plus that becomes a tick. Its help is a tooltip for the pointer and the description of the box for a screen reader, which reads no tooltip of a label. */
function Scope({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="sd-scope" title={hint}>
      <input type="checkbox" aria-description={hint} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <StrokeGlyph parts={checked ? SHEET_ICONS.check : SHEET_ICONS.plus} size={12} stroke={checked ? 3 : 2.5} />
      <span>{label}</span>
    </label>
  )
}

/** A small switch under the types (« Recharger l'onglet », « Fermeture auto »). */
function Switch({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="sd-switch" title={hint}>
      <input type="checkbox" role="switch" className="sd-toggle" aria-description={hint} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/** The answer: a banner, one card per site with its score and a chip per type, the failures in words, and « Retour » to the form. */
function Results({ results, reload, onBack }: { results: SiteDataSiteResult[]; reload: boolean; onBack: () => void }) {
  const summary = resultsSummary(results, { reload })
  return (
    <div className="sd-body sd-answer" aria-live="polite">
      <div className={`sd-banner ${summary.ok ? 'is-ok' : 'is-error'}`} role="status">
        <span className="sd-banner-icon">
          <StrokeGlyph parts={summary.ok ? SHEET_ICONS.check : SHEET_ICONS.warning} stroke={summary.ok ? 2.5 : 2} />
        </span>
        <div className="sd-banner-text">
          <strong>{summary.title}</strong>
          <span>{summary.detail}</span>
        </div>
      </div>
      <div className="sd-cards">
        {results.map((site, index) => {
          const ok = site.results.filter((result) => result.ok).length
          const failed = site.results.length === 0 || ok < site.results.length
          return (
            <article key={site.host} className={`sd-card${failed ? ' has-error' : ''}`} style={{ animationDelay: `${index * 50}ms` }}>
              <header>
                <span className="sd-dot" />
                <strong className="sd-card-host" title={site.host}>
                  {site.host}
                </strong>
                <span className="sd-score">
                  {ok}/{site.results.length}
                </span>
              </header>
              <ul className="sd-chips">
                {site.results.map((result) => {
                  const chip = resultChip(result)
                  return (
                    <li key={chip.type} className={`sd-result ${chip.ok ? 'is-ok' : 'is-err'}`} title={chip.title}>
                      <StrokeGlyph parts={chip.ok ? SHEET_ICONS.check : SHEET_ICONS.cross} size={10} stroke={3} />
                      {chip.label}
                      {chip.count !== null && <span className="sd-result-count">{chip.count}</span>}
                    </li>
                  )
                })}
              </ul>
              {resultErrors(site.results).map((line) => (
                <p key={line} className="sd-result-error">
                  {line}
                </p>
              ))}
            </article>
          )
        })}
      </div>
      <button type="button" className="sd-secondary" autoFocus onClick={onBack}>
        {t('site-data.retour')}
      </button>
    </div>
  )
}

/** « Effacer les données ? »: over the sheet, the sites named, « Annuler » first (a Return typed at once keeps things as they are). Escape cancels. */
function Confirm({ hosts, typeCount, onCancel, onConfirm }: { hosts: string[]; typeCount: number; onCancel: () => void; onConfirm: () => void }) {
  // It says it is modal: Tab goes round its two buttons and does not reach the sheet under it.
  const root = useRef<HTMLDivElement>(null)
  useFocusScope(root, { trap: true, initial: '.sd-no' })
  return (
    <div
      ref={root}
      className="sd-modal"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        // The sheet stays: only the question goes.
        e.stopPropagation()
        onCancel()
      }}
    >
      <div className="sd-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sd-confirm-title" aria-describedby="sd-confirm-text">
        <span className="sd-dialog-icon">
          <StrokeGlyph parts={SHEET_ICONS.warning} size={18} />
        </span>
        <div className="sd-dialog-copy">
          <h3 id="sd-confirm-title">{t('site-data.effacer-les-donnees-question')}</h3>
          <p id="sd-confirm-text">{tp('site-data.suppression-definitive-types', typeCount)}</p>
        </div>
        <ul className="sd-dialog-domains">
          {hosts.map((host) => (
            <li key={host} className="sd-chip" title={host}>
              {host}
            </li>
          ))}
        </ul>
        <div className="sd-dialog-actions">
          <button type="button" className="sd-no" autoFocus onClick={onCancel}>
            {t('confirm-box.annuler')}
          </button>
          <button type="button" className="sd-yes" onClick={onConfirm}>
            {t('app.effacer')}
          </button>
        </div>
      </div>
    </div>
  )
}
