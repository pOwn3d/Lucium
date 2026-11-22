// The blocker's row in the settings of the site control center: its switch for the site on screen, what it has blocked on this
// tab, and the reload that makes a change reach the page. Kept out of Panels.tsx; the toolbar carries nothing of it.

import { useEffect, useState } from 'react'
import { blockerIsOn, isBlockingExempt, normalizeBlockHost, siteBlockModeOf } from '@shared/blocker'
import { blockedLabel } from '@shared/filter-lists'
import type { BlockMode } from '@shared/model'
import { bypassExceptionsWith, bypassRowOf } from '@shared/redirect-bypass'
import { api, useSnapshot } from './api'
import './shields.css'

const COUNT_REFRESH_MS = 1000

export function Shields({ url, tabId }: { url: string; tabId: string }) {
  const snapshot = useSnapshot()
  const [count, setCount] = useState(0)
  // The page only follows after a reload: remember that the switch was used while this panel was open.
  const [changed, setChanged] = useState(false)
  const act = api()
  const settings = snapshot?.state.settings
  // The switch of the site also turns the fingerprint protection off for the site: it is there while one of the three protections is on.
  const blocking = settings ? blockerIsOn(settings) : false
  const on = blocking || (settings?.reduceFingerprint ?? false)

  useEffect(() => {
    if (!on) return
    let live = true
    const refresh = () => void act.blockedCount(tabId).then((n) => live && setCount(n))
    refresh()
    const timer = setInterval(refresh, COUNT_REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [on, tabId, act])

  const host = /^https?:/.test(url) ? normalizeBlockHost(url) : null
  if (!settings || !host) return null
  // The list of exceptions is kept on disk: a private tab has no switch for it.
  if (on && snapshot?.state.tabs.some((t) => t.id === tabId && t.private === true)) return null
  const active = !isBlockingExempt(url, settings.blockExceptions)

  const toggle = () => {
    void act.dispatch({ type: 'blocking/exempt-site', site: host, exempt: active, tabId })
    setChanged(true)
  }

  // The mode of the site: its own choice (or the one of a parent domain it follows), else the general mode. Changing it takes a reload too.
  const siteMode = siteBlockModeOf(settings.blockModeSites, url)
  const changeMode = (value: string) => {
    void act.dispatch({ type: 'blocking/site-mode', site: host, mode: value === 'general' ? null : (value as BlockMode), tabId })
    setChanged(true)
  }

  // The links of this site: unwrapped (tracking redirects, AMP), or left as they are. Shown only while the option is on.
  const bypass = bypassRowOf(url, settings)
  const toggleBypass = () => {
    if (!bypass) return
    void act.dispatch({ type: 'settings/update', patch: { unwrapExceptions: bypassExceptionsWith(settings.unwrapExceptions, bypass.host, bypass.active) } })
  }

  return (
    <>
      {bypass && (
        <button className="scc-setting shields-row" role="switch" aria-checked={bypass.active} onClick={toggleBypass}>
          <span className={`scc-badge ${bypass.active ? 'on' : ''}`}>
            <LinkIcon />
          </span>
          <span className="scc-setting-text">
            <strong>{t('shields.liens-de-suivi-et-amp')}</strong>
            <span>{bypass.active ? t('shields.adresses-finales-ouvertes-pour-ce-site') : t('shields.liens-laisses-tels-quels-pour-ce-site')}</span>
          </span>
          <span className={`shields-switch ${bypass.active ? 'on' : ''}`} aria-hidden="true" />
        </button>
      )}
      {on ? (
        <button className="scc-setting shields-row" role="switch" aria-checked={active} onClick={toggle}>
          <span className={`scc-badge ${active ? 'on' : ''}`}>
            <ShieldIcon />
          </span>
          <span className="scc-setting-text">
            <strong>{t('shields.blocage-pour-ce-site')}</strong>
            <span>{!active ? t('site-panel.desactive-pour-ce-site') : blocking ? blockedLabel(count) : t('shields.empreinte-numerique-reduite')}</span>
          </span>
          <span className={`shields-switch ${active ? 'on' : ''}`} aria-hidden="true" />
        </button>
      ) : (
        <button className="scc-setting shields-row" onClick={() => act.openOverlay({ panel: 'settings', pane: 'protection' })}>
          <span className="scc-badge">
            <ShieldIcon />
          </span>
          <span className="scc-setting-text">
            <strong>{t('shields.blocage-desactive')}</strong>
            <span>{t('shields.activer-dans-les-reglages')}</span>
          </span>
        </button>
      )}
      {/* The mode only judges the requests of a site that is blocked: it is offered only then. */}
      {blocking && active && (
        <label className="shields-mode">
          <span>{t('shields.mode-pour-ce-site')}</span>
          <select className="field pop" value={siteMode ?? 'general'} onChange={(e) => changeMode(e.target.value)}>
            <option value="general">{t('shields.mode-general')}</option>
            <option value="standard">{t('blocking-settings.standard')}</option>
            <option value="strict">{t('blocking-settings.strict')}</option>
          </select>
        </label>
      )}
      {changed && on && (
        <div className="shields-note" role="status">
          <span>{t('shields.rechargez-la-page-pour-appliquer-ce-changement')}</span>
          <button
            className="link-button"
            onClick={() => {
              act.nav('reload')
              act.closeOverlay()
            }}
          >
            {t('shields.recharger')}
          </button>
        </div>
      )}
    </>
  )
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.500 11.500a3 3 0 0 0 4.200 0l2.300-2.300a3 3 0 0 0-4.200-4.200L9.700 6.100M11.500 8.500a3 3 0 0 0-4.200 0L5 10.800a3 3 0 0 0 4.200 4.200l1.100-1.100" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 2.500 16 5v4.500c0 3.600-2.400 6.600-6 8-3.600-1.400-6-4.400-6-8V5l6-2.500Z" />
    </svg>
  )
}

import { t } from '@shared/i18n'