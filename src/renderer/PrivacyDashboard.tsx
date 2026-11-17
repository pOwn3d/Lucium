// Settings › Protection › Tableau de bord: what the blocker did on the pages that are open, and the protections that are on.
// A read-only view of what Lucium already keeps (shared/privacy-dashboard.ts): the counter of each open page, read from the main process while this
// pane is on screen and not otherwise. Nothing is stored, counted for the occasion or sent.

import { useEffect, useState } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import { blockerIsOn, countedTabs, protections, summarizeBlocked } from '@shared/privacy-dashboard'
import { api } from './api'
import { Group, Row } from './settings-parts'
import { getLanguage, t, tp } from '@shared/i18n'
import './insight.css'

/** How often the counters are read again while the pane is seen. */
const REFRESH_MS = 3000
/** The sites listed; the others are counted in one line. */
const SITES_SHOWN = 10

export function PrivacyDashboard({ snapshot }: { snapshot: UiSnapshot }) {
  const { settings, tabs } = snapshot.state
  const on = blockerIsOn(settings)
  const counted = countedTabs(tabs)
  const countedKey = counted.map((tab) => tab.id).join(',')
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [sessionTotal, setSessionTotal] = useState(0)
  const [split, setSplit] = useState({ ads: 0, banners: 0 })

  useEffect(() => {
    if (!on || counted.length === 0) {
      setCounts({})
      return
    }
    let live = true
    const read = () => {
      if (document.hidden) return
      Promise.all([
        Promise.all(counted.map(async (tab) => [tab.id, await api().blockedCount(tab.id)] as const)),
        api().sessionBlockedCount(),
        api().sessionBlockedByKind()
      ])
        .then(([entries, session, kinds]) => {
          if (live) {
            setCounts(Object.fromEntries(entries))
            setSessionTotal(session)
            setSplit(kinds)
          }
        })
        // The window is closing or the application is locked: the figures on screen stay what they were, and the log says why they did not move.
        .catch((error: unknown) => console.warn('[privacy] the counters of the open pages could not be read:', error))
    }
    read()
    const timer = setInterval(read, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [on, countedKey])

  return <DashboardRows settings={settings} counted={counted} counts={counts} sessionTotal={sessionTotal} split={split} />
}

/** What the dashboard says of the counters it was given (the part that reads them is above). */
export function DashboardRows({ settings, counted, counts, sessionTotal, split = { ads: 0, banners: 0 } }: { settings: UiSnapshot['state']['settings']; counted: Array<{ id: string; url: string }>; counts: Readonly<Record<string, number>>; sessionTotal: number; split?: { ads: number; banners: number } }) {
  const on = blockerIsOn(settings)
  const summary = summarizeBlocked(counted, counts, settings.blockExceptions)
  const hidden = Math.max(0, summary.sites.length - SITES_SHOWN)
  const [resetting, setResetting] = useState(false)

  const handleReset = async () => {
    setResetting(true)
    try {
      await api().resetSessionBlockedCount()
    } catch (error) {
      console.error('[privacy] reset session counter failed:', error)
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      <Group placement="more" title={t('privacy-dashboard.tableau-de-bord')} footnote={t('privacy-dashboard.compte-sur-ce-mac-rien-n-est-ecrit-ni-envoye')} more={t('privacy-dashboard.compte-en-memoire-sur-ce-mac-depuis-le-dernier-chargement')}>
        {!on ? (
          <Row label={<span className="muted">{t('privacy-dashboard.le-bloqueur-est-desactive-rien-n-est-bloque-ni-compte')}</span>} />
        ) : counted.length === 0 ? (
          <Row label={<span className="muted">{t('privacy-dashboard.aucune-page-du-web-ouverte-rien-a-compter')}</span>} />
        ) : (
          <>
            <Row label={t('privacy-dashboard.depuis-l-ouverture')}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span className="insight-num">
                  {sessionTotal.toLocaleString(getLanguage())}
                </span>
                <span className="muted">{t('privacy-dashboard.dont-publicites-et-traqueurs', { count: split.ads.toLocaleString(getLanguage()) })} · {t('privacy-dashboard.dont-bannieres', { count: split.banners.toLocaleString(getLanguage()) })}</span>
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={resetting}
                  style={{ padding: '2px 8px', fontSize: '0.875rem', cursor: resetting ? 'not-allowed' : 'pointer' }}
                >
                  {t('privacy-dashboard.reinitialiser')}
                </button>
              </div>
            </Row>
            <Row label={t('privacy-dashboard.requetes-bloquees-sur-les-pages-ouvertes')} hint={summary.total === 0 ? t('privacy-dashboard.rien-n-a-ete-bloque-sur-les-pages-ouvertes') : undefined}>
              <span className="insight-num">
                {summary.total.toLocaleString(getLanguage())}
              </span>
            </Row>
            {summary.sites.slice(0, SITES_SHOWN).map((site) => (
              <Row key={site.host} label={site.host}>
                {site.exempt ? <span className="insight-chip">{t('privacy-dashboard.sans-blocage')}</span> : <span className="insight-num">{tp('privacy-dashboard.count-bloquees', site.blocked, { count: site.blocked.toLocaleString(getLanguage()) })}</span>}
              </Row>
            ))}
            {hidden > 0 && <Row label={<span className="muted">{tp('privacy-dashboard.et-count-autres-sites', hidden)}</span>} />}
          </>
        )}
      </Group>
      <Group placement="more" title={t('privacy-dashboard.protections')}>
        {protections(settings).map((protection) => (
          <Row key={protection.id} label={protection.label}>
            <span className={`insight-chip ${protection.on ? 'on' : ''}`}>{protection.on ? t('privacy-dashboard.activee') : t('privacy-dashboard.desactivee')}</span>
          </Row>
        ))}
      </Group>
    </>
  )
}
