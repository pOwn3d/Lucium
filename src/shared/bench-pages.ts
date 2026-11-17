// The pages the comparison bench (scripts/compare-browsers.mjs) serves on the loopback address, and the count of the pages that really
// loaded in each browser. Every browser gets the same series: five kinds of page that a person leaves open (an article, a clock, a long
// list refreshed now and then, a drawing, a spinner). A page asks for nothing outside the machine (the headers forbid it) and reports
// itself to the bench, which is how the bench knows how many tabs a browser opened without driving it. Pure: the server only passes
// requests to `routeRequest`. The script loads this file with Node's type stripping: no import, no enum, no parameter property.

export type PageKind = 'article' | 'ticker' | 'list' | 'canvas' | 'spinner'
export const PAGE_KINDS: readonly PageKind[] = ['article', 'ticker', 'list', 'canvas', 'spinner']

/** The most pages one run asks for; a request beyond it is refused. */
export const MAX_PAGES = 200
export const MAX_RUNS = 64
export const TOKEN_PATTERN = /^[a-z0-9]{8,32}$/

/** Nothing leaves the machine: scripts and styles are inline, the only network a page may use is its own origin, and an image only its own data. */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
}

/** The kind of page n (from 1). Ten pages hold two of each kind, thirty hold six, and the first ten are the first ten of the thirty. */
export function pageKind(n: number): PageKind {
  return PAGE_KINDS[(((n - 1) % PAGE_KINDS.length) + PAGE_KINDS.length) % PAGE_KINDS.length] ?? 'article'
}

export function isPageNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_PAGES
}

/** The address of page n of a run. `origin` is "http://127.0.0.1:port". */
export function pageUrl(origin: string, token: string, n: number): string {
  if (!TOKEN_PATTERN.test(token) || !isPageNumber(n)) throw new Error(`not a page of the bench: ${token} ${n}`)
  return `${origin}/r/${token}/p/${n}`
}

const WORDS = [
  'lumière', 'rivière', 'montagne', 'fenêtre', 'jardin', 'horizon', 'voyage', 'silence', 'marché', 'bibliothèque', 'orage', 'sentier', 'village', 'atelier',
  'carte', 'musique', 'saison', 'vallée', 'chemin', 'matin', 'lecture', 'histoire', 'couleur', 'paysage', 'cuisine', 'écriture', 'bateau', 'colline', 'forêt',
  'tableau', 'voisin', 'mémoire', 'projet', 'réseau', 'carnet', 'ville', 'quartier', 'ruelle', 'lampe', 'pierre', 'nuage', 'plage', 'sable', 'récit', 'outil',
  'machine', 'cahier', 'idée'
]

/** A sequence that depends on nothing but its seed: the same page is served to every browser and at every run. */
function sequence(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function paragraph(next: () => number, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(next() * WORDS.length)] ?? 'mot')
  const text = out.join(' ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

const TITLES: Record<PageKind, string> = {
  article: 'article',
  ticker: 'horloge',
  list: 'liste',
  canvas: 'dessin',
  spinner: 'chargement'
}

function body(kind: PageKind, n: number, next: () => number): { html: string; script: string } {
  switch (kind) {
    case 'article': {
      const paragraphs: string[] = []
      for (let i = 0; i < 60; i++) paragraphs.push(`<p>${paragraph(next, 70)}</p>`)
      return { html: paragraphs.join('\n'), script: '' }
    }
    case 'ticker':
      return { html: '<p id="t" style="font:2rem monospace">…</p>', script: "var el=document.getElementById('t');setInterval(function(){el.textContent=new Date().toISOString()},1000);" }
    case 'list': {
      const items: string[] = []
      for (let i = 0; i < 1500; i++) items.push(`<li>${paragraph(next, 6)}</li>`)
      return {
        html: `<ul>${items.join('')}</ul>`,
        script: `setInterval(function(){var l=document.querySelectorAll('li');l[Math.floor(Math.random()*l.length)].textContent='mis à jour '+Date.now();fetch('/r/'+T+'/ping?p='+N).catch(function(){})},5000);`
      }
    }
    case 'canvas':
      return {
        html: '<canvas id="c" width="800" height="400"></canvas>',
        script: `var c=document.getElementById('c').getContext('2d');for(var i=0;i<400;i++){c.fillStyle='hsl('+((i*7+${n * 11})%360)+',60%,55%)';c.fillRect((i*37)%800,(i*53)%400,60,40)}`
      }
    case 'spinner':
      return { html: '<div class="spin"></div>', script: '' }
  }
}

/** The page n of the run `token`. Throws when either is not what the bench makes up: they end up inside a script. */
export function renderPage(n: number, token: string): string {
  if (!TOKEN_PATTERN.test(token) || !isPageNumber(n)) throw new Error(`not a page of the bench: ${token} ${n}`)
  const kind = pageKind(n)
  const { html, script } = body(kind, n, sequence(n))
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Banc d’essai ${n} (${TITLES[kind]})</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:44rem;padding:0 1rem}
.spin{width:48px;height:48px;border:6px solid #ccc;border-top-color:#07c;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
li{margin:0 0 .25rem}
</style>
</head>
<body>
<h1>Page ${n}, ${TITLES[kind]}</h1>
${html}
<script>
(function(){
var T=${JSON.stringify(token)},N=${n};
fetch('/r/'+T+'/hello?p='+N+'&v='+document.visibilityState,{keepalive:true}).catch(function(){});
document.addEventListener('visibilitychange',function(){navigator.sendBeacon('/r/'+T+'/vis?p='+N+'&v='+document.visibilityState)});
${script}
})();
</script>
</body>
</html>
`
}

type Visibility = 'visible' | 'hidden' | 'unknown'

interface PageRecord {
  loadedAt: number
  visibility: Visibility
  pings: number
}

/** Which pages of which run reported themselves, and whether they are shown. */
export class BeaconLog {
  private runs = new Map<string, Map<number, PageRecord>>()

  /** A run must be opened before its pages are answered: a tab restored from an earlier run gets nothing and counts for nothing. */
  open(token: string): void {
    if (!TOKEN_PATTERN.test(token)) throw new Error('bad token')
    if (!this.runs.has(token) && this.runs.size >= MAX_RUNS) throw new Error('too many runs')
    if (!this.runs.has(token)) this.runs.set(token, new Map())
  }

  isOpen(token: string): boolean {
    return this.runs.has(token)
  }

  hello(token: string, page: number, visibility: Visibility, now: number): void {
    const pages = this.runs.get(token)
    if (!pages || !isPageNumber(page)) return
    const known = pages.get(page)
    if (known) known.visibility = visibility
    else pages.set(page, { loadedAt: now, visibility, pings: 0 })
  }

  visibility(token: string, page: number, visibility: Visibility): void {
    const record = this.runs.get(token)?.get(page)
    if (record) record.visibility = visibility
  }

  ping(token: string, page: number): void {
    const record = this.runs.get(token)?.get(page)
    if (record) record.pings++
  }

  /** The pages that reported themselves, sorted. */
  loaded(token: string): number[] {
    return [...(this.runs.get(token)?.keys() ?? [])].sort((a, b) => a - b)
  }

  visibleCount(token: string): number {
    let count = 0
    for (const record of this.runs.get(token)?.values() ?? []) if (record.visibility === 'visible') count++
    return count
  }

  pings(token: string): number {
    let count = 0
    for (const record of this.runs.get(token)?.values() ?? []) count += record.pings
    return count
  }
}

/** The pages among 1..count that have not reported themselves. */
export function missingPages(loaded: readonly number[], count: number): number[] {
  const have = new Set(loaded)
  const missing: number[] = []
  for (let n = 1; n <= count; n++) if (!have.has(n)) missing.push(n)
  return missing
}

export interface Reply {
  status: number
  type: string
  body: string
}

const NOT_FOUND: Reply = { status: 404, type: 'text/plain; charset=utf-8', body: 'introuvable\n' }
const NO_CONTENT: Reply = { status: 204, type: 'text/plain; charset=utf-8', body: '' }

function visibilityOf(value: string | null): Visibility {
  return value === 'visible' || value === 'hidden' ? value : 'unknown'
}

/** Answers one request of a page or of a beacon. Anything that is not exactly one of the five addresses of an open run is a 404. */
export function routeRequest(method: string, rawUrl: string, log: BeaconLog, now: number): Reply {
  let url: URL
  try {
    url = new URL(rawUrl, 'http://127.0.0.1')
  } catch {
    return NOT_FOUND
  }
  const match = /^\/r\/([a-z0-9]{8,32})\/(p\/(\d{1,3})|hello|vis|ping)$/.exec(url.pathname)
  const token = match?.[1]
  if (!match || token === undefined || !log.isOpen(token)) return NOT_FOUND
  const kind = match[2]?.startsWith('p/') ? 'page' : match[2]
  if (kind === 'page') {
    if (method !== 'GET') return { status: 405, type: 'text/plain; charset=utf-8', body: 'méthode refusée\n' }
    const n = Number(match[3])
    return isPageNumber(n) ? { status: 200, type: 'text/html; charset=utf-8', body: renderPage(n, token) } : NOT_FOUND
  }
  if (method !== 'GET' && method !== 'POST') return { status: 405, type: 'text/plain; charset=utf-8', body: 'méthode refusée\n' }
  const page = Number(url.searchParams.get('p'))
  if (!isPageNumber(page)) return { status: 400, type: 'text/plain; charset=utf-8', body: 'page inconnue\n' }
  if (kind === 'hello') log.hello(token, page, visibilityOf(url.searchParams.get('v')), now)
  else if (kind === 'vis') log.visibility(token, page, visibilityOf(url.searchParams.get('v')))
  else log.ping(token, page)
  return NO_CONTENT
}

/** The Host header of a request the server accepts: its own address only (a page of another site cannot reach it by a name it controls). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}
