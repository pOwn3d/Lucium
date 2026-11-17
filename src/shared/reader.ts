// Reader mode: the article of a page, on its own, in a clean layout. The text is extracted
// from the page by the Readability library (`@mozilla/readability`, see engine/reader-mode.ts); this file checks what comes back, since it comes from a page,
// and builds the document that shows it. The document runs no script of any kind: its Content-Security-Policy forbids them, so
// whatever markup the article holds can only be displayed; the markup is also cleaned (reader-sanitize.ts) before it goes in.

import { escapeHtml } from './error-pages'
import { READER_SPEECH_STYLE, readerSpeechMarkup, readerSpeechScript } from './read-aloud'
import { READER_PILL_STYLE, readerPillMarkup, readerPillScript, readerRootAttributes, type ReaderPrefs } from './reader-pill'
import { sanitizeArticleHtml } from './reader-sanitize'
import { t } from './i18n'

/** An article shorter than this is not an article (a menu, a login form, an error): the page has nothing to read. */
export const MIN_ARTICLE_CHARS = 200
/** What a page may hand back: more than this is cut off by the extraction, not trusted. */
export const MAX_ARTICLE_CHARS = 2_000_000
const MAX_FIELD_CHARS = 300

/** The notice when reader mode finds no article on the page. */
export const readerUnavailableNotice = (): string => t('reader.cette-page-n-a-pas-d-article-a-afficher-en-mode')

export interface ReaderArticle {
  title: string
  /** The article as HTML, as Readability serialised it (`readerDocument` cleans it before it is shown). */
  content: string
  byline: string | null
  siteName: string | null
  lang: string | null
  dir: 'ltr' | 'rtl' | null
  /** Length of its text, in characters. */
  textLength: number
}

const str = (value: unknown, max = MAX_FIELD_CHARS): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null)

/** Only web pages have an article: not a PDF viewer, a file, an extension page or one of our own error pages. */
export function canRead(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * The article a page returned, checked: null when it is not an object of the right shape or has too little text to be worth
 * showing. Everything in it is treated as hostile text: `lang` and `dir` are taken from a short list, the rest is escaped or
 * confined by the document's Content-Security-Policy.
 */
export function cleanArticle(raw: unknown): ReaderArticle | null {
  if (typeof raw !== 'object' || raw === null) return null
  const article = raw as Record<string, unknown>
  const content = typeof article['content'] === 'string' ? article['content'] : ''
  const textLength = typeof article['textLength'] === 'number' && Number.isFinite(article['textLength']) ? Math.max(0, Math.round(article['textLength'])) : 0
  if (content === '' || content.length > MAX_ARTICLE_CHARS || textLength < MIN_ARTICLE_CHARS) return null
  const lang = str(article['lang'], 20)
  return {
    title: str(article['title']) ?? '',
    content,
    byline: str(article['byline']),
    siteName: str(article['siteName'], 80),
    lang: lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(lang) ? lang : null,
    dir: article['dir'] === 'rtl' ? 'rtl' : article['dir'] === 'ltr' ? 'ltr' : null,
    textLength
  }
}

/** "5 min de lecture": about 220 words a minute, a word being about six characters. */
export function readingMinutes(textLength: number): number {
  return Math.max(1, Math.round(textLength / 6 / 220))
}

// The document may load pictures and nothing else: no script, no frame, no form, no font, no connection.
const POLICY = "default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

/** A nonce as the engine draws it: only such a value is written into the policy, and so into the document. */
export const isScriptNonce = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9+/=_-]{16,64}$/.test(value)

/** The policy of a document that has one script, the one the nonce names (reading aloud). Everything else stays forbidden. */
export const policyWithScript = (nonce: string): string => `${POLICY}; script-src 'nonce-${nonce}'`

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfbf9;--fg:#232323;--muted:#707070;--line:#dcdcd6;--link:#0a58c9;--quote:#c9c9c2;--code:#efefea}
@media (prefers-color-scheme:dark){:root{--bg:#222222;--fg:#dedede;--muted:#9a9a9f;--line:#38383b;--link:#6aa7ff;--quote:#4a4a4e;--code:#2a2a2d}}
html{background:var(--bg)}
body{margin:0;color:var(--fg);font:20px/1.65 "Iowan Old Style",Charter,Georgia,serif;-webkit-font-smoothing:antialiased}
main{max-width:680px;margin:0 auto;padding:56px 28px 96px}
header{margin-bottom:36px;padding-bottom:24px;border-bottom:1px solid var(--line);font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
.site{margin:0 0 10px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
h1{margin:0 0 14px;font-size:34px;line-height:1.2;font-weight:700}
.meta{margin:0;font-size:14px;color:var(--muted)}
article{overflow-wrap:break-word}
article h1,article h2,article h3,article h4{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;line-height:1.3;margin:1.8em 0 .6em}
article h1{font-size:28px}article h2{font-size:24px}article h3{font-size:20px}
article p,article ul,article ol{margin:0 0 1.1em}
article a{color:var(--link)}
article img,article video,article svg{max-width:100%;height:auto;border-radius:6px}
article figure{margin:1.6em 0}article figcaption{font:14px/1.4 -apple-system,system-ui,sans-serif;color:var(--muted);margin-top:8px}
article blockquote{margin:1.4em 0;padding:0 0 0 20px;border-left:3px solid var(--quote);color:var(--muted)}
article pre,article code{font:15px/1.5 ui-monospace,Menlo,monospace;background:var(--code);border-radius:4px}
article code{padding:1px 5px}article pre{padding:14px 16px;overflow-x:auto}article pre code{padding:0;background:none}
article table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto;font-size:16px}
article th,article td{border:1px solid var(--line);padding:6px 10px}
article hr{border:0;border-top:1px solid var(--line);margin:2em 0}
`

/** The pill of the reader: the nonce its script runs under (the one of the document) and the choices the reader opens with. */
export interface ReaderPill {
  nonce: string
  prefs: ReaderPrefs
}

/**
 * The page that shows an article. `siteName` falls back to the host of `url`. With a `speechNonce` the page also has the buttons that read
 * the article aloud and the one script that drives them (the policy allows that script and no other); with a `pill` it has the pill of the
 * reading settings and its script (same nonce: the policy names one). Without either, it runs no script at all and ends on "Échap pour quitter".
 */
export function readerDocument(article: ReaderArticle, url: string, speechNonce?: string, pill?: ReaderPill): string {
  const speech = isScriptNonce(speechNonce) ? speechNonce : null
  const pilled = pill && isScriptNonce(pill.nonce) ? pill : null
  const nonce = pilled?.nonce ?? speech
  const host = URL.canParse(url) ? new URL(url).host.replace(/^www\./, '') : ''
  const site = article.siteName ?? host
  const minutes = readingMinutes(article.textLength)
  const meta = [article.byline, t('reader.minutes-min-de-lecture', { minutes })].filter(Boolean).map((part) => escapeHtml(part!)).join(' · ')
  const title = article.title || host || t('menu.mode-lecture')
  const dir = article.dir ? ` dir="${article.dir}"` : ''
  return (
    `<!doctype html><html lang="${escapeHtml(article.lang ?? 'fr')}"${dir}${pilled ? readerRootAttributes(pilled.prefs) : ''}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${nonce ? policyWithScript(nonce) : POLICY}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}${speech ? READER_SPEECH_STYLE : ''}${pilled ? READER_PILL_STYLE : ''}</style></head><body><main>` +
    `<header>${site ? `<p class="site">${escapeHtml(site)}</p>` : ''}<h1>${escapeHtml(title)}</h1><p class="meta">${meta}${pilled ? '' : ` · ${escapeHtml(t('reader.echap-pour-quitter'))}`}</p>${speech ? readerSpeechMarkup() : ''}</header>` +
    `<article>${sanitizeArticleHtml(article.content)}</article></main>${pilled ? readerPillMarkup(pilled.prefs) : ''}` +
    `${nonce && pilled ? `<script nonce="${nonce}">${readerPillScript(nonce, pilled.prefs, t('reader.lu-a-percent', { percent: '{percent}' }))}</script>` : ''}` +
    `${nonce && speech ? `<script nonce="${nonce}">${readerSpeechScript()}</script>` : ''}</body></html>`
  )
}
