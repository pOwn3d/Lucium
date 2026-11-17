// @vitest-environment happy-dom
// « Effacer les données du site » mounted in a document: what a static render cannot show. A long list of sites typed or pasted at once, the
// sentence shown when the run fails, the question that holds the focus while it is asked, and the help of a box as a screen reader gets it.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { SITE_DATA_HOSTS_MAX, type SiteDataBatchRequest, type SiteDataSiteResult } from '@shared/site-data'
import { addSheetSites, sheetProblemText } from '@shared/site-data-sheet'
import { SiteData } from './SiteData'
import { click, mount, settle, type, type Mounted } from './dom.test-support'

const sites = (count: number): string[] => Array.from({ length: count }, (_, index) => `site${index}.example`)

let mounted: Mounted | null = null
let siteCookieCount: ReturnType<typeof vi.fn<(host: string, subdomains: boolean) => Promise<number>>>
let clearSites: ReturnType<typeof vi.fn<(request: SiteDataBatchRequest) => Promise<SiteDataSiteResult[]>>>

/** The sheet over a window with no web page, with these settings. */
async function sheet(settings: Partial<Settings> = {}): Promise<HTMLElement> {
  const ctx = { now: 1, newId: () => 'id' }
  const state = reduce(createInitialState(ctx), { type: 'settings/update', patch: settings }, ctx)
  const snapshot = { state, extensions: [], runtime: { tabs: {} }, platform: 'darwin', private: false } as unknown as UiSnapshot
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = {
    getSnapshot: async () => snapshot,
    onSnapshot: () => () => undefined,
    dispatch: async () => undefined,
    closeOverlay: () => undefined,
    siteCookieCount,
    clearSites
  }
  mounted = mount(createElement(SiteData))
  await settle()
  return mounted.container
}

const input = (container: Element): HTMLInputElement => container.querySelector<HTMLInputElement>('.sd-input')!
const alerts = (container: Element): string[] => [...container.querySelectorAll('[role="alert"]')].map((one) => one.textContent ?? '')
const tags = (container: Element): string[] => [...container.querySelectorAll('.sd-tag-label')].map((one) => one.textContent ?? '')

beforeEach(() => {
  setLanguage('fr')
  siteCookieCount = vi.fn(async () => 1)
  clearSites = vi.fn(async () => [])
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

describe('the sites added to the list', () => {
  it('are each there once, and never more than a run takes', () => {
    expect(addSheetSites(['a.example'], ['b.example', 'a.example', 'not a site'])).toEqual({ tags: ['a.example', 'b.example'], refused: false })
    const full = addSheetSites([], sites(SITE_DATA_HOSTS_MAX + 5))
    expect(full.tags).toEqual(sites(SITE_DATA_HOSTS_MAX))
    expect(full.refused).toBe(true)
    expect(addSheetSites(sites(SITE_DATA_HOSTS_MAX), ['one.more.example'])).toEqual({ tags: sites(SITE_DATA_HOSTS_MAX), refused: true })
    expect(addSheetSites(sites(SITE_DATA_HOSTS_MAX), ['site3.example']).refused).toBe(false)
  })

  it('stop at the limit when a long list comes at once: the tags, the sentence that says why, and the cookies counted', async () => {
    vi.useFakeTimers()
    const container = await sheet()
    type(input(container), `${sites(300).join(' ')} `)
    expect(tags(container)).toEqual(sites(SITE_DATA_HOSTS_MAX))
    expect(alerts(container)).toEqual([sheetProblemText('too-many')])
    await settle(() => void vi.advanceTimersByTime(200))
    expect(siteCookieCount.mock.calls.map(([host]) => host)).toEqual(sites(SITE_DATA_HOSTS_MAX))
  })

  it('has no cookie counted for a site typed past the limit: the count is of the sites a run can take', async () => {
    vi.useFakeTimers()
    const container = await sheet()
    type(input(container), `${sites(SITE_DATA_HOSTS_MAX).join(' ')} `)
    await settle(() => void vi.advanceTimersByTime(200))
    siteCookieCount.mockClear()
    type(input(container), 'typed.example')
    await settle(() => void vi.advanceTimersByTime(200))
    expect(siteCookieCount).not.toHaveBeenCalled()
  })
})

describe('a run that fails', () => {
  it('shows the sentence of the main process without the name of the channel, and writes the error to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    clearSites.mockRejectedValue(new Error("Error invoking remote method 'lucium:clear-sites': Error: Invalid site data request"))
    const container = await sheet({ siteDataConfirm: false, siteDataAutoClose: false })
    type(input(container), 'a.example ')
    await click(container.querySelector('.sd-cta')!)
    expect(alerts(container)).toEqual([t('site-data.effacement-impossible-error', { error: 'Invalid site data request' })])
    expect(warn).toHaveBeenCalledWith('[site-data] the run failed:', expect.any(Error))
    warn.mockRestore()
  })

  it('shows a sentence of the catalogue when the error says nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    clearSites.mockRejectedValue(new Error(''))
    const container = await sheet({ siteDataConfirm: false, siteDataAutoClose: false })
    type(input(container), 'a.example ')
    await click(container.querySelector('.sd-cta')!)
    expect(alerts(container)).toEqual([t('site-data.effacement-impossible-error', { error: t('errors.erreur-inattendue') })])
    vi.restoreAllMocks()
  })
})

describe('the question « Effacer les données ? »', () => {
  it('keeps Tab on its two buttons: the sheet under it is not reached', async () => {
    const container = await sheet({ siteDataConfirm: true })
    type(input(container), 'a.example ')
    await click(container.querySelector('.sd-cta')!)
    const no = container.querySelector<HTMLButtonElement>('.sd-no')!
    const yes = container.querySelector<HTMLButtonElement>('.sd-yes')!
    yes.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    yes.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(no)
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    no.dispatchEvent(back)
    expect(document.activeElement).toBe(yes)
  })
})

describe('the help of a box', () => {
  it('is its description for a screen reader, not a tooltip only: each type, the two scopes and the two switches', async () => {
    const container = await sheet()
    const described = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((box) => box.getAttribute('aria-description'))
    expect(described.length).toBeGreaterThan(8)
    expect(described.every((text) => typeof text === 'string' && text.length > 10)).toBe(true)
    expect(described).toContain(t('site-data.sous-domaines-aide'))
    expect(described).toContain(t('site-data.fermeture-auto-aide'))
  })
})
