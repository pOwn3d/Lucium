import { describe, expect, it } from 'vitest'
import { summaryCopyScript, summaryPageHtml, summaryPaintScript, type SummaryLabels, type SummaryTabState } from './summary-html'

const labels: SummaryLabels = { title: 'Résumé', loading: 'En cours', copy: 'Copier', copied: 'Copié', model: (model, duration) => `${model} ${duration}` }
const done: SummaryTabState = { status: 'ok', summary: 'Un **point** clé', model: 'llama', duration: 12 } as SummaryTabState

describe('the summary page', () => {
  it('has no script of its own: a script written with innerHTML never runs, so the copy is attached after the page is written', () => {
    const html = summaryPageHtml('example.com', done, labels)
    expect(html).toContain('id="copy"')
    expect(html).not.toMatch(/<script/i)
  })

  it('attaches the copy button from a script that reads the summary as shown', () => {
    const code = summaryCopyScript('Copié')
    expect(code).toContain("getElementById('copy')")
    expect(code).toContain("getElementById('summary-body').innerText")
    expect(code).toContain('navigator.clipboard.writeText')
  })

  // The summary is written only into the empty tab it was asked for: a tab that went elsewhere meanwhile keeps its page.
  describe('the script that writes it into the tab', () => {
    function runIn(href: string) {
      const document = { title: 'autre', body: { innerHTML: 'page du site' }, getElementById: () => null }
      new Function('document', 'location', summaryPaintScript('source.fr', done, labels))(document, { href })
      return document
    }

    it('writes the summary into a tab still on about:blank', () => {
      const document = runIn('about:blank')
      expect(document.body.innerHTML).toContain('Un <strong>point</strong> clé')
      expect(document.title).toBe('source.fr')
    })

    it('writes nothing into a page another site has taken over the tab', () => {
      const document = runIn('https://messagerie.exemple.fr/inbox')
      expect(document.body.innerHTML).toBe('page du site')
      expect(document.title).toBe('autre')
    })
  })
})
