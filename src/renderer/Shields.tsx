// The blocker's row in the settings of the site control center: its switch for the site on screen, what it has blocked on this
// tab, and the reload that makes a change reach the page. Kept out of Panels.tsx; the toolbar carries nothing of it.

import { useEffect, useState } from 'react'
import type { BlockedHost } from '@shared/blocked-hosts'
import { blockerIsOn, isBlockingExempt, normalizeBlockHost, siteBlockModeOf } from '@shared/blocker'
import { blockedLabel } from '@shared/filter-lists'
import type { BlockMode } from '@shared/model'
import { api, useSnapshot } from './api'
import './shields.css'

const COUNT_REFRESH_MS = 1000

export function Shields({ url, tabId }: { url: string; tabId: string }) {
  const snapshot = useSnapshot()
  const [count, setCount] = useState(0)
  // The detail (which hosts were blocked) is asked only while the list is open: nothing is read for it otherwise.
  const [detailOpen, setDetailOpen] = useState(false)
  const [hosts, setHosts] = useState<BlockedHost[]>([])
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
    const refresh = () => {
      void act.blockedCount(tabId).then((n) => live && setCount(n))
      if (detailOpen) void act.blockedHosts(tabId).then((list) => live && setHosts(list))
    }
    refresh()
    const timer = setInterval(refresh, COUNT_REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [on, tabId, act, detailOpen])

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

  return (
    <>
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
      {/* Which hosts were blocked on this page, from its last load: in memory in the main process, never in a private tab. */}
      {blocking && active && count > 0 && (
        <div className="shields-detail">
          <button className="link-button" aria-expanded={detailOpen} onClick={() => setDetailOpen(!detailOpen)}>
            {detailOpen ? t('shields.masquer-le-detail') : t('shields.detail-des-traqueurs')}
          </button>
          {detailOpen && <BlockedHostsList hosts={hosts} />}
        </div>
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

/** The hosts blocked on the page, one line each with the number of requests (the host as text: it is a page's own word, never markup). */
export function BlockedHostsList({ hosts }: { hosts: readonly BlockedHost[] }) {
  return (
    <ul>
      {hosts.length === 0 && <li className="muted">{t('shields.aucun-detail-pour-cette-page')}</li>}
      {hosts.map((entry) => (
        <li key={entry.host}>
          <span className="shields-host">{entry.host}</span>
          <span className="muted">{tp('shields.host-requetes', entry.count)}</span>
        </li>
      ))}
    </ul>
  )
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 2.500 16 5v4.500c0 3.600-2.400 6.600-6 8-3.600-1.400-6-4.400-6-8V5l6-2.500Z" />
    </svg>
  )
}

import { t, tp } from '@shared/i18n'