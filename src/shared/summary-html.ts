// The page of a summary tab: the markup written into the tab when the summary is known. The text is escaped, the model's markdown is read by
// markdown-lite, so no HTML of the model is interpreted.

import { parseMarkdown, type Span } from './markdown-lite'
import { escapeHtml } from './html-escape'

export type SummaryTabState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; summary: string; model: string; duration: number }

export interface SummaryLabels {
  title: string
  loading: string
  copy: string
  copied: string
  model: (model: string, duration: number) => string
}

/** Every text of the page goes through the one escape of the application. */
const esc = escapeHtml

const spansHtml = (spans: Span[]): string =>
  spans.map((run) => (run.kind === 'strong' ? `<strong>${esc(run.text)}</strong>` : run.kind === 'em' ? `<em>${esc(run.text)}</em>` : esc(run.text))).join('')

/** The inner markup of the summary page for this state, for a tab page of a given source. */
export function summaryBodyHtml(state: SummaryTabState, labels: SummaryLabels): string {
  if (state.status === 'loading') return `<p class="muted">${esc(labels.loading)}</p>`
  if (state.status === 'error') return `<p class="error">${esc(state.message)}</p>`
  const blocks = parseMarkdown(state.summary).map((block) => {
    if (block.kind === 'table') {
      const head = `<tr>${block.header.map((cell) => `<th>${spansHtml(cell)}</th>`).join('')}</tr>`
      const body = block.rows.map((row) => `<tr>${row.map((cell) => `<td>${spansHtml(cell)}</td>`).join('')}</tr>`).join('')
      return `<div class="table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`
    }
    if (block.kind === 'heading') return `<h${block.level + 2}>${spansHtml(block.spans)}</h${block.level + 2}>`
    if (block.kind === 'list') {
      const tag = block.ordered ? 'ol' : 'ul'
      return `<${tag}>${block.items.map((item) => `<li>${spansHtml(item)}</li>`).join('')}</${tag}>`
    }
    return `<p>${spansHtml(block.spans)}</p>`
  })
  return `${blocks.join('')}<p class="meta">${esc(labels.model(state.model, state.duration))}</p>`
}

/** The style of the summary page: it follows the system's light or dark appearance. */
export const SUMMARY_PAGE_STYLE = `
  :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
  body { margin: 0; padding: 40px 24px; background: #ffffff; color: #1b1c20; line-height: 1.6; font-size: 16px; }
  @media (prefers-color-scheme: dark) { body { background: #1d1f25; color: #eceef2; } .muted, .meta { color: #a2a6b0; } }
  main { max-width: 680px; margin: 0 auto; }
  h3 { font-size: 18px; margin: 0 0 16px; }
  h4, h5, h6 { margin: 18px 0 8px; font-weight: 600; }
  p { margin: 0 0 12px; }
  ul, ol { margin: 0 0 12px; padding-left: 22px; }
  .meta { margin-top: 24px; padding-top: 12px; border-top: 1px solid rgba(127,127,127,.3); font-size: 13px; color: #5d6068; }
  .error { color: #c93a2f; }
  .table { overflow-x: auto; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid rgba(127,127,127,.35); padding: 6px 8px; text-align: left; vertical-align: top; }
  th { font-weight: 600; }
  .toolbar { display: flex; justify-content: flex-end; margin-bottom: 16px; }
  button { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; cursor: pointer; }
`

/** The whole page: the source's name at the top, a copy button, then the summary. The copy takes the text as shown, from the button's click. */
export function summaryPageHtml(source: string, state: SummaryTabState, labels: SummaryLabels): string {
  const copy = state.status === 'ok' ? `<div class="toolbar"><button id="copy">${esc(labels.copy)}</button></div>` : ''
  // The copy handler is not in the page: a <script> written with innerHTML never runs. It is attached by summaryCopyScript, after the page is written.
  return `<main><h3>${esc(labels.title)} · ${esc(source)}</h3>${copy}<div id="summary-body">${summaryBodyHtml(state, labels)}</div></main><style>${SUMMARY_PAGE_STYLE}</style>`
}

/** Attaches the copy button once the page is written (run from the main process, where scripts do run). */
export function summaryCopyScript(copied: string): string {
  return `(function(){var b=document.getElementById('copy');if(!b)return;b.onclick=function(){navigator.clipboard.writeText(document.getElementById('summary-body').innerText).then(function(){b.textContent=${JSON.stringify(copied)}})}})()`
}

/**
 * The script that writes the summary into the tab, run in the page of that tab. It writes only while the tab still shows about:blank:
 * the answer comes later, and the user may have gone to another site in the meantime, which must not receive the summary.
 */
export function summaryPaintScript(source: string, state: SummaryTabState, labels: SummaryLabels): string {
  const copy = state.status === 'ok' ? summaryCopyScript(labels.copied) : ''
  return `if (location.href === 'about:blank') { document.title = ${JSON.stringify(source)}; document.body.innerHTML = ${JSON.stringify(summaryPageHtml(source, state, labels))}; ${copy} }`
}
