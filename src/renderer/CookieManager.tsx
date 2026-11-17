import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { fieldError } from './field-error'
import { activeProfileId, profileLabel } from '@shared/profiles'
import { describeCookieCount, describeCookieOutcome, describeCookieTotals, formatBytes, isSiteKept, keepHostOf, withKeptSite, type CookieName, type CookieSite } from '@shared/cookies'
import type { UiSnapshot } from '@shared/ipc'
import { api, useSnapshot } from './api'
import { ConfirmActions } from './ConfirmActions'
import './site-data.css'
import './cookies.css'
import { t, tp } from '@shared/i18n'
import { ipcErrorText } from '@shared/ipc-error'

/** Sites drawn at once: a jar can hold thousands, and the filter is there to find one. */
const ROWS_SHOWN = 200

export function CookieManager() {
  const snapshot = useSnapshot()
  if (!snapshot) return null
  // The sheet lists the cookies of one profile and its buttons act on the profile of the space on screen: when that profile changes under the open
  // sheet, it is made again (the list read anew, a confirmation in progress dropped), so that what is removed is what is listed.
  return <CookieSheet key={activeProfileId(snapshot.state)} snapshot={snapshot} />
}

const errorText = ipcErrorText

/**
 * "Cookies par site": what the profile of the space on screen holds, by site, with the room it takes. A cookie's value is never shown here
 * or sent here: the names and sizes are all the main process gives. Each site can be removed or kept for good (the list "Garder toujours"),
 * and the clean-up removes every cookie but those of the kept sites. It looks like "Effacer les données du site", which it sits beside.
 */
function CookieSheet({ snapshot }: { snapshot: UiSnapshot }) {
  const { state } = snapshot
  const act = api()
  const keep = state.settings.cookieKeepHosts
  const profile = profileLabel(state.settings, activeProfileId(state))
  const draftErrorId = useId()
  const [sites, setSites] = useState<CookieSite[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [names, setNames] = useState<CookieName[] | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // The site whose « Supprimer » was clicked once: its cookies go at the second click only, as « Nettoyer » asks before it removes.
  const [asking, setAsking] = useState<string | null>(null)
  const latest = useRef(0)

  const load = () => {
    const ticket = ++latest.current
    act.cookieSites().then(
      (list) => {
        if (ticket !== latest.current) return
        setSites(list)
        setFailure(null)
      },
      (error: unknown) => {
        // The list is the whole point of the view: without it the reason is shown in its place.
        console.warn('[cookies] cannot list the cookies:', error)
        if (ticket === latest.current) setFailure(errorText(error))
      }
    )
  }
  useEffect(load, [act])

  useEffect(() => {
    if (open === null) return setNames(null)
    let live = true
    setNames(null)
    act.cookieNames(open).then(
      (list) => live && setNames(list),
      (error: unknown) => {
        console.warn('[cookies] cannot list the names of a site:', error)
        if (live) setNames([])
      }
    )
    return () => {
      live = false
    }
  }, [open, act])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (sites ?? []).filter((site) => q === '' || site.host.includes(q))
  }, [sites, filter])
  const total = (sites ?? []).reduce((sum, site) => sum + site.count, 0)

  const setKeep = (site: string, kept: boolean) => {
    setMessage(null)
    void act.dispatch({ type: 'settings/update', patch: { cookieKeepHosts: withKeptSite(keep, site, kept) } })
  }
  const addDraft = () => {
    const host = keepHostOf(draft)
    if (!host) return
    setKeep(host, true)
    setDraft('')
  }
  const draftInvalid = draft.trim() !== '' && keepHostOf(draft) === null
  const draftError = fieldError(draftErrorId, draftInvalid)

  const run = async (job: () => Promise<{ removed: number; failed: number }>, what: 'site' | 'clean') => {
    setBusy(true)
    setConfirming(false)
    setAsking(null)
    setMessage(null)
    try {
      const { removed, failed } = await job()
      setMessage(describeCookieOutcome(removed, failed, what))
      setOpen(null)
      load()
    } catch (error) {
      setMessage(t('cookie-manager.retrait-impossible-error', { error: errorText(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="card sitedata cookies"
      role="dialog"
      aria-label={t('cmd.cookies-par-site')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') act.closeOverlay()
      }}
    >
      <h2>{t('cmd.cookies-par-site')}</h2>
      <p className="muted sitedata-intro">
        {t('cookie-manager.profil-profile-seuls-les-noms-et-la-taille', { profile })}
        {sites !== null && describeCookieTotals(total, sites.length) !== '' && ` ${describeCookieTotals(total, sites.length)}`}
      </p>

      {confirming ? (
        <div className="sitedata-confirm" role="alertdialog" aria-label={t('cookie-manager.confirmer-le-nettoyage')}>
          <p>{keep.length === 0 ? t('cookie-manager.retirer-les-cookies-de-tous-les-sites-sauf-aucun') : tp('cookie-manager.retirer-les-cookies-de-tous-les-sites-sauf-gardes', keep.length)}</p>
          {keep.length > 0 && (
            <ul className="sitedata-chips">
              {keep.map((host) => (
                <li key={host} className="sitedata-chip">
                  {host}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <input className="field cookies-filter" autoFocus spellCheck={false} aria-label={t('cookie-manager.filtrer-les-sites')} placeholder={t('cookie-manager.filtrer-les-sites-2')} value={filter} onChange={(e) => setFilter(e.target.value)} />

          {failure !== null ? (
            <p className="muted warning" role="alert">
              {t('cookie-manager.les-cookies-ne-peuvent-pas-etre-lus-error', { error: failure })}
            </p>
          ) : sites === null ? (
            <p className="muted">{t('cookie-manager.lecture-des-cookies')}</p>
          ) : shown.length === 0 ? (
            <p className="muted">{sites.length === 0 ? t('cookie-manager.aucun-cookie-dans-ce-profil') : t('cookie-manager.aucun-site-ne-correspond')}</p>
          ) : (
            <ul className="cookies-sites" aria-label={t('cookie-manager.sites')}>
              {shown.slice(0, ROWS_SHOWN).map((site) => {
                const kept = isSiteKept(site.host, keep)
                return (
                  <li key={site.host} className={`cookies-site ${kept ? 'kept' : ''}`}>
                    <div className="cookies-line">
                      <button type="button" className="cookies-name" aria-expanded={open === site.host} title={t('cookie-manager.voir-les-noms-des-cookies')} onClick={() => setOpen(open === site.host ? null : site.host)}>
                        <span className="cookies-host">{site.host}</span>
                        <span className="muted">
                          {describeCookieCount(site.count)} · {formatBytes(site.bytes)}
                        </span>
                      </button>
                      <label className="cookies-keep" title={t('cookie-manager.les-cookies-de-ce-site-et-de-ses-sous-domaines')}>
                        <input type="checkbox" checked={kept} disabled={busy || (kept && !keep.includes(keepHostOf(site.host) ?? ''))} aria-label={t('cookie-manager.garder-toujours-host', { host: site.host })} onChange={(e) => setKeep(site.host, e.target.checked)} />
                        {t('cookie-manager.garder')}
                      </label>
                      {asking === site.host ? (
                        <>
                          <button type="button" className="link-button cookies-remove-confirm" data-action="remove-confirm" disabled={busy} aria-label={t('cookie-manager.confirmer-la-suppression-host', { host: site.host })} onClick={() => void run(() => act.removeCookieSite(site.host), 'site')}>
                            {t('cookie-manager.confirmer-la-suppression')}
                          </button>
                          {/* « Annuler » is last, where « Supprimer » was: the second click of a double click lands on it. */}
                          <button type="button" className="link-button" data-action="remove-cancel" onClick={() => setAsking(null)}>
                            {t('confirm-box.annuler')}
                          </button>
                        </>
                      ) : (
                        <button type="button" className="link-button" data-action="remove" disabled={busy} aria-label={t('cookie-manager.supprimer-les-cookies-de-host', { host: site.host })} onClick={() => setAsking(site.host)}>
                          {t('site-panel.supprimer')}
                        </button>
                      )}
                    </div>
                    {open === site.host && (
                      <ul className="cookies-names" aria-label={t('cookie-manager.cookies-de-host', { host: site.host })}>
                        {names === null && <li className="muted">{t('cookie-manager.lecture')}</li>}
                        {names?.map((cookie) => (
                          <li key={`${cookie.name}|${cookie.path}`}>
                            <code>{cookie.name}</code>
                            <span className="muted">
                              {cookie.path} · {formatBytes(cookie.size)}
                              {cookie.session ? ` · ${t('cookie-manager.de-session')}` : ''}
                              {cookie.secure ? ` · ${t('cookie-manager.securise')}` : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {shown.length > ROWS_SHOWN && <p className="muted">{t('cookie-manager.shown-sites-sur-total-filtrez', { shown: ROWS_SHOWN, total: shown.length })}</p>}

          <div className="sitedata-label">
            <span className="field-label">{t('cookie-manager.garder-toujours')}</span>
            <span className="muted">{tp('site-data.count-sites', keep.length)}</span>
          </div>
          {keep.length > 0 && (
            <ul className="sitedata-chips cookies-kept">
              {keep.map((host) => (
                <li key={host} className="sitedata-tag">
                  <span className="sitedata-tag-label">{host}</span>
                  <button type="button" className="sitedata-tag-remove" aria-label={t('cookie-manager.ne-plus-garder-host', { host })} title={t('cookie-manager.ne-plus-garder-host', { host })} onClick={() => setKeep(host, false)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            className="field"
            spellCheck={false}
            aria-label={t('cookie-manager.ajouter-un-site-a-garder')}
            {...draftError.field}
            placeholder={t('cookie-manager.ajouter-un-site-a-garder-exemple-fr')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addDraft()
              }
            }}
          />
          {draftInvalid && (
            <p className="muted warning" {...draftError.message}>
              {t('cookie-manager.adresse-non-valide-domaine-avec-ou-sans-https')}
            </p>
          )}
          <p className="muted cookies-note">{t('cookie-manager.un-site-garde-couvre-ses-sous-domaines')}</p>
        </>
      )}

      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}

      <div className="row end">
        {confirming ? (
          <ConfirmActions cancelLabel={t('confirm-box.annuler')} confirmLabel={t('cookie-manager.nettoyer')} confirmClass="sitedata-clear" confirmDisabled={busy} onCancel={() => setConfirming(false)} onConfirm={() => void run(() => act.cleanCookies(), 'clean')} />
        ) : (
          <>
            <button className="button" disabled={busy || sites === null || sites.length === 0} onClick={() => setConfirming(true)}>
              {t('cookie-manager.nettoyer-2')}
            </button>
            <button className="button primary" onClick={() => act.closeOverlay()}>
              {t('extpage.fermer')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
