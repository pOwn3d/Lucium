// « Signaler un problème… » (shared/problem-report.ts) wired in the main process: an entry of the Aide menu that opens the sheet (greyed out in a private window,
// which has no extension to list), a panel the interface cannot ask for, three channels registered for each window and exposed by the bridge, and nothing that
// reaches the network.

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { Channel, type LuciumApi, type OverlayRequest } from '@shared/ipc'
import { defaultSettings } from '@shared/model'
import { canOpenInPrivate } from '@shared/private-window'
import { PROBLEM_REPORT_REQUEST } from '@shared/problem-report'
import { createInitialState } from '@shared/sidebar'
import { canOpenWhileLocked } from '@shared/lock'
import { fakeBrowser, methodsOf, overlayHost, showedPanel } from './browser-fake.test-support'
import { invokeFrom, ipcHost, sendFrom } from './ipc-fake.test-support'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))

const { registerIpc, validOverlay } = await import('./ipc')
const { buildMenu } = await import('./menu')
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

interface Item {
  label?: string
  role?: string
  enabled?: boolean
  click?: () => void
  submenu?: Item[]
}

function helpMenu(options: { private?: boolean } = {}): { entries: Item[]; opened: OverlayRequest[] } {
  const opened: OverlayRequest[] = []
  const browser = new Proxy(
    { openOverlay: (request: OverlayRequest) => void opened.push(request), menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
  )
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: defaultSettings() }
  const template = buildMenu(browser as never, { get: () => state } as never, actions as never, options) as unknown as Item[]
  return { entries: template.find((entry) => entry.role === 'help')?.submenu ?? [], opened }
}

describe('the Aide menu', () => {
  it('has « Signaler un problème… », after « État de Lucium… » and before the troubleshooting submenu, that opens the sheet', () => {
    const { entries, opened } = helpMenu()
    const labels = entries.map((entry) => entry.label)
    const at = labels.indexOf(t('menu.signaler-un-probleme'))
    expect(at).toBeGreaterThan(-1)
    expect(labels[at]).toBe('Signaler un problème…')
    expect(labels.slice(at - 1, at + 2)).toEqual([t('menu.etat-d-lucium'), t('menu.signaler-un-probleme'), t('menu.depannage')])
    expect(entries[at]!.enabled).toBe(true)
    entries[at]!.click!()
    expect(opened).toEqual([PROBLEM_REPORT_REQUEST])
  })

  it('is greyed out in a private window', () => {
    const entry = helpMenu({ private: true }).entries.find((item) => item.label === t('menu.signaler-un-probleme'))
    expect(entry?.enabled).toBe(false)
  })
})

describe('the sheet', () => {
  const store = { get: () => ({ ...createInitialState({ now: 0, newId: () => 'x' }), settings: defaultSettings() }) }

  it('cannot be asked for by the interface: the menu opens it from the main process', () => {
    expect(validOverlay({ panel: 'problemreport' }, store)).toBe(false)
    expect(validOverlay({ panel: 'problemreport', report: 'forgé' }, store)).toBe(false)
  })

  it('is opened in a window, and not in a private window nor over the lock screen', () => {
    const fake = overlayHost()
    shell['openOverlay']!.call(fake.self, PROBLEM_REPORT_REQUEST)
    expect(showedPanel(fake, 'problemreport')).toBe(true)

    expect(canOpenInPrivate('problemreport')).toBe(false)
    const privateWindow = overlayHost({}, { isPrivate: () => true })
    shell['openOverlay']!.call(privateWindow.self, PROBLEM_REPORT_REQUEST)
    expect(showedPanel(privateWindow, 'problemreport')).toBe(false)

    expect(canOpenWhileLocked('problemreport', true)).toBe(false)
    expect(canOpenWhileLocked('problemreport', false)).toBe(true)
  })
})

// Contract: the overlay draws its panel in a window, which a unit test does not have; without this case the sheet would be an empty panel, and without
// its place in the modal set a click outside would not close it.
describe('the sheet in the overlay', () => {
  const host = readFileSync(new URL('../../renderer/OverlayHost.tsx', import.meta.url), 'utf8')

  it('is a modal panel and draws ProblemReport for its request', () => {
    expect(host).toMatch(/const MODAL = new Set<OverlayRequest\['panel'\]>\(\[[^\]]*'problemreport'[^\]]*\]\)/)
    expect(host).toMatch(/case 'problemreport':\s*return <ProblemReport key=\{version\} \/>/)
  })
})

// Contract: Lucium sends nothing. The report leaves by the clipboard or a file the user names; the only address in these files is the page of the site, which a
// tab opens when the user clicks the link (and the files are read as text here because the guarantee is that no line of them makes a request).
describe('the files of the report', () => {
  const files = ['../../shared/problem-report.ts', '../../shared/log-redaction.ts', './problem-report.ts', '../../renderer/ProblemReport.tsx', '../../renderer/problem-report-actions.ts']
  const source = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')

  it('make no request: no fetch, no net module, no socket, no beacon, no external opener, no http module', () => {
    for (const file of files) expect(source(file), file).not.toMatch(/\bfetch\(|\bnet\.(?:request|fetch)|XMLHttpRequest|WebSocket|sendBeacon|openExternal|from '(?:node:)?https?'|from 'electron-fetch'/)
  })

  it('hold no address but the two pages of the site, written once', () => {
    const addresses = files.flatMap((file) => source(file).match(/https?:\/\/[a-z0-9][^\s'"`)]*/gi) ?? [])
    expect(addresses.sort()).toEqual(['https://lucium.app/communaute/', 'https://lucium.app/en/community/'])
  })
})

describe('the channels', () => {
  it('are registered for each window with its guard: a page of the window is answered, any other sender is not', async () => {
    const state = createInitialState({ now: 0, newId: () => 'x' })
    registerIpc(fakeBrowser().self as never, { get: () => state, subscribe: () => () => {} } as never, {} as never, new Set([1]))
    expect(ipcHost.handle.has(Channel.problemReport)).toBe(true)
    expect(ipcHost.handle.has(Channel.saveProblemReport)).toBe(true)
    expect(ipcHost.on.has(Channel.openProblemSite)).toBe(true)
    // Nothing was asked of the engine by the sheet that did not open: a stranger gets no report, no dialog and no tab.
    expect(await invokeFrom(99, Channel.problemReport)).toBeUndefined()
    expect(await invokeFrom(99, Channel.saveProblemReport)).toBeUndefined()
    expect(() => sendFrom(99, Channel.openProblemSite)).not.toThrow()
  })

  it('are the three methods of the bridge, each on its own channel, and none of them carries an address or a text', async () => {
    vi.stubGlobal('location', { search: '' })
    await import('../../preload/index')
    const api = ipcHost.exposed.get('lucium') as LuciumApi
    ipcHost.sent.length = 0
    void api.problemReport()
    void api.saveProblemReport()
    api.openProblemSite()
    expect(ipcHost.sent).toEqual([
      { kind: 'invoke', channel: Channel.problemReport, args: [] },
      { kind: 'invoke', channel: Channel.saveProblemReport, args: [] },
      { kind: 'send', channel: Channel.openProblemSite, args: [] }
    ])
    vi.unstubAllGlobals()
  })
})
