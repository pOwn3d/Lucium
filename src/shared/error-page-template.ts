// The frame every error page is drawn in (one template per family, here the pages of a site that did not load): a tinted disc with an
// icon, the title, what follows it, and the actions. The colours are the design tokens (src/renderer/tokens.css), inlined: the page lives in
// the document of the failed load, where no stylesheet of the application can be reached.
//
//   errorFrame({ tone: 'neutral', icon: ICON, title: 'Impossible d’accéder à ce site', content: '<p>…</p>', actions: errorButton(href, 'Réessayer') })
//
// Class names that the engine checks find their targets through: `a.button` (the main action) and `a.proceed` (the discreet, risky one).

import tokensCss from '../renderer/tokens.css?raw'
import { escapeHtml } from './html-escape'

export type ErrorTone = 'danger' | 'warn' | 'neutral' | 'accent'

export const ERROR_TONES: readonly ErrorTone[] = ['danger', 'warn', 'neutral', 'accent']

export interface ErrorFrame {
  /** The family of the failure, as a colour: red for a refusal or an unsafe connection, amber for an address, grey for the network, accent for what was blocked. */
  tone: ErrorTone
  /** An SVG (48 x 48, `currentColor`), decorative: the title says what happened. */
  icon: string
  /** Plain text: escaped here. */
  title: string
  /** HTML that the caller built and escaped: the paragraphs, the hints, the technical code, the details. */
  content: string
  /** HTML that the caller built: the buttons (see `errorButton`). */
  actions: string
  /** HTML that the caller built, after the buttons: the technical details, folded. */
  after?: string
}

export const escapeText = escapeHtml

/** A button of the page: a link the engine answers (the page has no script). `proceed` is the discreet one, for what leaves the safe path. */
export function errorButton(href: string, label: string, className: 'button' | 'proceed' | 'quiet' = 'button'): string {
  return `<a class="${className}" href="${escapeText(href)}">${escapeText(label)}</a>`
}

export function errorFrame({ tone, icon, title, content, actions, after = '' }: ErrorFrame): string {
  return `<div class="ep-icon ${tone}">${icon}</div><h1>${escapeText(title)}</h1>${content}<div class="actions">${actions}</div>${after}`
}

const FRAME_STYLE = `
html,body{margin:0;min-height:100%;background:var(--surface);color:var(--text);font:var(--t-l)/1.55 var(--font)}
body{display:flex;align-items:center;justify-content:center;min-height:100vh}
main{box-sizing:border-box;width:100%;max-width:540px;padding:var(--sp-5) var(--sp-5)}
.ep-icon{display:grid;place-items:center;width:64px;height:64px;margin:0 0 var(--sp-4);border-radius:var(--r-xl);background:var(--tile);color:var(--text-2)}
.ep-icon.danger{background:color-mix(in srgb,var(--danger) 16%,transparent);color:var(--danger-ink)}
.ep-icon.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn-ink)}
.ep-icon.accent{background:var(--accent-soft);color:var(--accent-text)}
.ep-icon svg{width:36px;height:36px;stroke-width:var(--icon-stroke)}
h1{margin:0 0 var(--sp-3);font-size:var(--t-2xl);font-weight:var(--w-semibold);line-height:1.3}
p{margin:0 0 var(--sp-3)}ul{margin:0 0 var(--sp-3);padding-left:var(--sp-5);color:var(--text-2)}li{margin:2px 0}
.code{margin:var(--sp-4) 0 0;font:var(--t-s)/1.4 var(--mono);color:var(--text-2);user-select:text}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-3);margin-top:var(--sp-5)}
a{color:var(--link)}
a.button{display:inline-flex;align-items:center;min-height:var(--target);padding:0 var(--sp-4);border-radius:var(--r-s);background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:var(--w-semibold);font-size:var(--t-m)}
a.button:hover{background:var(--accent-strong)}
a.quiet{display:inline-flex;align-items:center;min-height:var(--target);padding:0 var(--sp-4);border-radius:var(--r-s);border:1px solid var(--line-strong);color:var(--text);text-decoration:none;font-size:var(--t-m)}
a.quiet:hover{background:var(--tile-hover)}
.ep-pill{display:inline-flex;align-items:baseline;gap:var(--sp-2);margin:0 0 var(--sp-4);padding:var(--sp-1) var(--sp-4);border-radius:999px}
.ep-pill span{font-size:var(--t-2xl);font-weight:var(--w-semibold);line-height:1.3}
.ep-pill small{font-size:var(--t-m)}
.ep-pill.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn-ink)}
.ep-pill.danger{background:color-mix(in srgb,var(--danger) 16%,transparent);color:var(--danger-ink)}
.ep-addr{display:flex;align-items:center;gap:var(--sp-2);color:var(--text-2);font-size:var(--t-s);overflow-wrap:anywhere;user-select:text}
.ep-fav{display:inline-grid;place-items:center;flex:none;width:18px;height:18px;border-radius:var(--r-s);background:var(--accent-soft);color:var(--accent-text);font-size:var(--t-xs);font-weight:var(--w-semibold)}
a.button:focus-visible,a.proceed:focus-visible,a.quiet:focus-visible{outline:var(--focus-width) solid var(--focus);outline-offset:2px}
a.proceed{display:inline-flex;align-items:center;min-height:var(--target);color:var(--danger);font-size:var(--t-m)}
p.addr{margin:0 0 var(--sp-3);font:var(--t-s)/1.4 var(--mono);color:var(--text-2);word-break:break-all;user-select:text}
details{margin-top:var(--sp-4);color:var(--text-2);font-size:var(--t-m)}summary{cursor:default}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px var(--sp-3);margin:var(--sp-2) 0 0}dt{color:var(--text-2)}dd{margin:0;color:var(--text);word-break:break-all;user-select:text}
`

/** The tokens, without their comments and indentation: what is put into the page. */
const TOKENS = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{};])\s*/g, '$1')

/** The stylesheet of an error page: the design tokens, then the frame. */
export const ERROR_PAGE_STYLE = `${TOKENS}${FRAME_STYLE.replace(/\n/g, '')}`
