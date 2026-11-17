// The sheet « Signaler un problème » (ProblemReport.tsx) drawn with no window, and what its buttons do (problem-report-actions.ts) against a bridge that is a fake:
// the report to read, « Copier » and « Enregistrer… » that take it away, the link to the site, and the sentences that say how each went. Nothing is sent anywhere.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { ProblemReportSave } from '@shared/problem-report'
import { defaultSettings, type SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { elementsOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as Array<[string, unknown[]]> }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => void holder.asked.push([name, args]) }), useSnapshot: () => holder.snapshot }))

import { ProblemReport, ProblemReportSheet, type ProblemReportSheetProps } from './ProblemReport'
import { copyReport, loadReport, saveReport } from './problem-report-actions'
import { frenchSpaces } from '@shared/french-typography'

const REPORT = 'Rapport pour le support de Lucium\nLucium 0.2.12 · Electron 45.0.0\nExtensions (1)\n  uBlock Origin 1.60.0 <script>'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  setLanguage('fr')
  holder.asked = []
  const state: SidebarState = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: defaultSettings() }
  holder.snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false } }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setLanguage('fr')
})

const text = (element: Element): string => {
  const children = element.props['children']
  return (Array.isArray(children) ? children : [children]).filter((child) => typeof child === 'string').join('')
}

function sheet(over: Partial<ProblemReportSheetProps> = {}) {
  const calls: string[] = []
  const props: ProblemReportSheetProps = {
    report: { state: 'ready', text: REPORT },
    notice: null,
    onCopy: () => void calls.push('copy'),
    onSave: () => void calls.push('save'),
    onSite: () => void calls.push('site'),
    onClose: () => void calls.push('close'),
    ...over
  }
  const markup = renderToStaticMarkup(createElement(ProblemReportSheet, props))
  const elements = elementsOf(createElement(ProblemReportSheet, props))
  const buttons = elements.filter((element) => element.type === 'button')
  const button = (label: string): Element => buttons.find((candidate) => text(candidate) === label)!
  const click = (label: string): void => (button(label).props['onClick'] as () => void)()
  return { markup, elements, buttons, button, click, calls }
}

describe('the sheet', () => {
  it('is a dialog titled « Signaler un problème » that says nothing is sent and shows the report in a block that can be read and scrolled', () => {
    const { markup } = sheet()
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"/)
    expect(markup).toContain('>Signaler un problème</h2>')
    expect(markup).toContain(frenchSpaces('Lucium n’envoie rien : relisez-le'))
    expect(markup).toMatch(/<pre class="pr-text" tabindex="0" aria-label="Rapport à relire avant de le partager">Rapport pour le support de Lucium\nLucium 0\.2\.12 · Electron 45\.0\.0\nExtensions \(1\)\n  uBlock Origin 1\.60\.0 &lt;script&gt;<\/pre>/)
    // What the report holds, said before it is copied or saved.
    expect(markup).toContain('Aucune page, aucun titre d’onglet, aucun mot de passe.')
  })

  it('has the two buttons that take the report away and the link to the site, then « Fermer »', () => {
    const { buttons } = sheet()
    expect(buttons.map(text)).toEqual(['Copier', 'Enregistrer…', 'Ouvrir la page Communauté du site', 'Fermer'])
    // A button that does something is never the submit button of the form: only « Fermer » is, so that Return in the sheet does not copy or save.
    expect(buttons.map((button) => button.props['type'])).toEqual(['button', 'button', 'button', 'submit'])
    expect(buttons.map((button) => Boolean(button.props['disabled']))).toEqual([false, false, false, false])
  })

  it('« Copier » copies, « Enregistrer… » saves, the link goes to the site, and « Fermer » and Escape close', () => {
    const { click, calls, elements } = sheet()
    click('Copier')
    click('Enregistrer…')
    click('Ouvrir la page Communauté du site')
    expect(calls).toEqual(['copy', 'save', 'site'])
    const form = elements.find((element) => element.type === 'form')!
    ;(form.props['onSubmit'] as (event: { preventDefault(): void }) => void)({ preventDefault: () => undefined })
    ;(form.props['onKeyDown'] as (event: unknown) => void)({ nativeEvent: { key: 'Escape', defaultPrevented: false }, stopPropagation: () => undefined })
    expect(calls.slice(3)).toEqual(['close', 'close'])
  })

  it('offers nothing to copy or save while the report is being prepared or when it could not be, and says so', () => {
    for (const [report, words, role] of [[{ state: 'loading' }, 'Préparation du rapport…', 'status'], [{ state: 'failed' }, 'Le rapport n’a pas pu être préparé.', 'alert']] as const) {
      const { markup, button } = sheet({ report })
      expect(markup, words).toContain(`<p class="muted pr-wait" role="${role}">${words}</p>`)
      expect(markup).not.toContain('<pre')
      expect(button('Copier').props['disabled'], words).toBe(true)
      expect(button('Enregistrer…').props['disabled'], words).toBe(true)
      // The link and the way out stay.
      expect(button('Ouvrir la page Communauté du site').props['disabled']).toBeFalsy()
    }
  })

  it('says how a copy or a save went: a sentence, as a status, or as an alert when it failed', () => {
    expect(sheet({ notice: { text: 'Rapport copié · 84 caractères · rien n’a été envoyé.', failed: false } }).markup).toContain('<p class="pr-status" role="status">Rapport copié · 84 caractères · rien n’a été envoyé.</p>')
    expect(sheet({ notice: { text: frenchSpaces('Enregistrement impossible dans x.txt : écriture refusée'), failed: true } }).markup).toContain(frenchSpaces('<p class="pr-status failed" role="alert">Enregistrement impossible dans x.txt : écriture refusée</p>'))
    expect(sheet().markup).not.toContain('pr-status')
  })

  it('is all English, with no French left, when the language is', () => {
    setLanguage('en')
    const { markup, buttons } = sheet()
    expect(markup).toContain('>Report a Problem</h2>')
    expect(markup).toContain('Lucium sends nothing: read it')
    expect(buttons.map(text)).toEqual(['Copy', 'Save…', 'Open the Site’s Community Page', 'Close'])
    expect(markup).toContain('aria-label="Report to read before you share it"')
    for (const french of ['Signaler', 'Copier', 'Enregistrer', 'Fermer', 'relisez', 'Communauté', 'Dans le rapport']) expect(markup, french).not.toContain(french)
  })
})

describe('the sheet as the window opens it', () => {
  function opened() {
    const props = (): ProblemReportSheetProps => elementsOf(createElement(ProblemReport)).find((element) => element.type === ProblemReportSheet)!.props as unknown as ProblemReportSheetProps
    return { props }
  }

  it('starts on « Préparation du rapport… » with the bridge asked for nothing until the effect runs', () => {
    expect(renderToStaticMarkup(createElement(ProblemReport))).toContain('Préparation du rapport…')
    expect(holder.asked).toEqual([])
  })

  it('does not copy a report that is not there: « Copier » does nothing while it loads', () => {
    opened().props().onCopy()
    expect(holder.asked).toEqual([])
  })

  it('leaves for the site by closing the sheet, then asking for the page: the interface sends no address', () => {
    opened().props().onSite()
    expect(holder.asked).toEqual([['closeOverlay', []], ['openProblemSite', []]])
  })

  it('closes with « Fermer »', () => {
    opened().props().onClose()
    expect(holder.asked).toEqual([['closeOverlay', []]])
  })
})

describe('asking for the report', () => {
  it('gives the text the main process built', async () => {
    expect(await loadReport({ problemReport: () => Promise.resolve(REPORT) })).toEqual({ state: 'ready', text: REPORT })
  })

  it('says it failed when the main process refused (null), answered anything but a text, or failed — and logs why', async () => {
    for (const answer of [null, '', undefined, 42, { text: REPORT }]) expect(await loadReport({ problemReport: () => Promise.resolve(answer as never) }), String(answer)).toEqual({ state: 'failed' })
    expect(await loadReport({ problemReport: () => Promise.reject(new TypeError('the window is closing')) })).toEqual({ state: 'failed' })
    expect(console.warn).toHaveBeenCalledWith('[report] the report could not be asked for:', 'TypeError')
  })
})

describe('« Copier »', () => {
  it('puts the whole report on the clipboard and says so with its length', async () => {
    const written: string[] = []
    const notice = await copyReport({ writeClipboardText: (value) => (written.push(value), Promise.resolve(true)) }, REPORT)
    expect(written).toEqual([REPORT])
    expect(notice).toEqual({ text: expect.stringMatching(/^Rapport copié · \d+\D?\d* caractères · rien n’a été envoyé\.$/), failed: false })
  })

  it('says the clipboard is not available when it refuses or fails, and logs why', async () => {
    const refused = await copyReport({ writeClipboardText: () => Promise.resolve(false) }, REPORT)
    expect(refused).toEqual({ text: frenchSpaces('Le presse-papiers n’est pas accessible : le texte reste lisible dans l’aperçu.'), failed: true })
    const failed = await copyReport({ writeClipboardText: () => Promise.reject(new Error('busy')) }, REPORT)
    expect(failed.failed).toBe(true)
    expect(console.warn).toHaveBeenCalledWith('[report] the clipboard refused the report:', 'Error')
  })
})

describe('« Enregistrer… »', () => {
  const saving = (answer: ProblemReportSave) => ({ saveProblemReport: () => Promise.resolve(answer) })

  it('says where the report went, by the name of the file', async () => {
    expect(await saveReport(saving({ status: 'saved', file: 'lucium-rapport-2026-11-07.txt' }))).toEqual({ text: frenchSpaces('Rapport enregistré : lucium-rapport-2026-11-07.txt'), failed: false })
  })

  it('says nothing when the user gave up the dialog', async () => {
    expect(await saveReport(saving({ status: 'canceled' }))).toBeNull()
  })

  it('gives the reason the main process found when it could not write', async () => {
    expect(await saveReport(saving({ status: 'failed', message: frenchSpaces('Enregistrement impossible dans x.txt : disque plein') }))).toEqual({ text: frenchSpaces('Enregistrement impossible dans x.txt : disque plein'), failed: true })
  })

  it('says it failed, and logs why, when the channel itself fails', async () => {
    const notice = await saveReport({ saveProblemReport: () => Promise.reject(new Error('gone')) })
    expect(notice).toEqual({ text: 'Le rapport n’a pas pu être préparé.', failed: true })
    expect(console.warn).toHaveBeenCalledWith('[report] the report could not be saved:', 'Error')
  })
})
