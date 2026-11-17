// The model's answer is text: a tag in it is shown as text, never run in the summary tab (guard: escaping).
import { describe, expect, it } from 'vitest'
import { summaryPageHtml, type SummaryLabels } from './summary-html'

const labels: SummaryLabels = { title: 'Résumé', loading: 'En cours', copy: 'Copier', copied: 'Copié', model: (model, duration) => `${model} ${duration}` }

describe('the summary page escapes the model answer', () => {
  it('shows a tag of the answer as text', () => {
    const html = summaryPageHtml('example.com', { status: 'ok', summary: '<img src=x onerror="alert(1)"> **point**', model: 'llama', duration: 1 }, labels)
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })

  it('escapes the five characters HTML reads, the apostrophe too, in the answer, the source and the labels', () => {
    const html = summaryPageHtml(`l'exemple.com`, { status: 'ok', summary: `l'été "chaud" & **d'ici**`, model: `m'1`, duration: 1 }, { ...labels, title: `Résumé d'une page` })
    expect(html).toContain('l&#39;été &quot;chaud&quot; &amp; <strong>d&#39;ici</strong>')
    expect(html).toContain('<h3>Résumé d&#39;une page · l&#39;exemple.com</h3>')
    expect(html).toContain('m&#39;1 1')
    expect(html.slice(0, html.indexOf('<style>'))).not.toContain("'")
  })

  // The message of a failure comes from the local model server: it goes through the same escape as an answer.
  it('shows a tag of an error message as text, and the loading label as well', () => {
    const failed = summaryPageHtml('example.com', { status: 'error', message: '<img src=x onerror="alert(1)">' }, labels)
    expect(failed).toContain('<p class="error">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>')
    expect(failed).not.toContain('<img')
    const loading = summaryPageHtml('example.com', { status: 'loading' }, { ...labels, loading: '<b>En cours</b>' })
    expect(loading).toContain('<p class="muted">&lt;b&gt;En cours&lt;/b&gt;</p>')
  })
})
