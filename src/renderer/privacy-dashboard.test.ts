// The privacy dashboard rendered to markup (no window): the figures it was given, what it says when there is nothing to count, and that it says what
// it does not know. The part that reads the counters (a timer and the main process) is the pane's own; this is what a person reads.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { defaultSettings } from '@shared/model'
import { DashboardRows } from './PrivacyDashboard'

const tabs = [
  { id: '1', url: 'https://news.example/a' },
  { id: '2', url: 'https://shop.example/' },
  { id: '3', url: 'https://friend.example/' }
]
const render = (over: Partial<ReturnType<typeof defaultSettings>>, counted = tabs, counts: Record<string, number> = { '1': 1200, '2': 3 }, sessionTotal = 0) =>
  renderToStaticMarkup(createElement(DashboardRows, { settings: { ...defaultSettings(), blockAds: true, ...over }, counted, counts, sessionTotal }))

beforeEach(() => vi.stubGlobal('window', { lucium: {} }))
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('the privacy dashboard', () => {
  it('shows the requests stopped on the open pages, by site, and the sites where nothing is blocked', () => {
    const html = render({ blockExceptions: ['friend.example'] }, tabs, { '1': 1200, '2': 3 }, 1500)
    expect(html).toMatch(/Depuis l/)
    expect(html).toMatch(/ouverture/)
    expect(html).toContain('Requêtes bloquées sur les pages ouvertes')
    expect(html).toMatch(/insight-num[^>]*>1[\s,]*203</)
    // The totals move while a page loads: a live region would have a screen reader say a bare number at each refresh.
    expect(html).not.toContain('aria-live')
    expect(html.indexOf('news.example')).toBeLessThan(html.indexOf('shop.example'))
    expect(html).toContain('bloquées')
    expect(html).toMatch(/Sans blocage/)
  })

  it('says that the counts stay in memory and what each one covers', () => {
    const html = render({})
    expect(html).toMatch(/rien n.est écrit ni envoyé/)
  })

  it('says the blocker is off, or that nothing is open, or that nothing was blocked, with no figure for it', () => {
    expect(render({ blockAds: false, blockTrackers: false, blockCookieBanners: false })).toMatch(/Le bloqueur est désactivé/)
    expect(render({}, [], {})).toMatch(/Aucune page du web n.est ouverte/)
    const quiet = render({}, tabs, {})
    expect(quiet).toMatch(/Rien n.a été bloqué sur les pages/)
    expect(quiet).not.toContain('bloquées</')
  })

  it('gives the state of each protection in words', () => {
    const html = render({ blockCookieBanners: false, reduceFingerprint: false, httpsUpgrade: true, sendGpc: false, stripTrackingParams: false, dohCustom: false })
    expect(html.match(/insight-chip on">Activée</g)).toHaveLength(2)
    expect(html.match(/insight-chip ">Désactivée</g)).toHaveLength(5)
  })

  it('answers in English when the language is English', () => {
    setLanguage('en')
    const html = render({})
    expect(html).toContain('Requests blocked on the open pages')
    expect(html).toContain('1,203')
  })
})
