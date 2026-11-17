// The Community page of the public site, as the shots `community` and `community-voted` show it in a tab: the page itself is read from a
// checkout of the site (`../lucium-website` by default, never fetched), served by scripts/site-captures.mjs on 127.0.0.1 under the site's own
// address (`lucium.app` is mapped to the local server for the run, like the `.example` names), and its API is the stand-in below: made-up
// ideas, a vote counted in memory, a proof of work of one bit. Nothing reaches the real service, and no real vote is ever cast: the page's
// voter token is a made-up one the script writes in the throw-away profile, which the real service would refuse anyway.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

import type { Lang, Localized } from './shots'

/** The host the page is shown under: the real address of the site, which the run maps to the local server (capture.ts `hostRules`). */
export const SITE_HOST = 'lucium.app'

/** The address of the Community page in a language, as the site writes it. */
export const communityUrl = (lang: Lang): string => `https://${SITE_HOST}${lang === 'fr' ? '/communaute/' : '/en/community/'}`

/** What the page keeps in its storage once an address is confirmed (assets/community-api.js `lucium.voter`): here a made-up token. */
export const VOTER_STORAGE_KEY = 'lucium.voter'
export const DEMO_VOTER_TOKEN = 'demo-voter-of-the-captures'

/** Answered only by the stand-in: the script asks it from the page before writing the token, to be sure the page is the local copy. */
export const DEMO_CHECK_PATH = '/api/demo-check'
export const DEMO_CHECK_ANSWER = 'lucium-site-captures'

export interface CommunityIdea {
  id: string
  title: Localized<string>
  state: 'proposed' | 'studying' | 'planned' | 'in-progress'
  /** The votes before the run's own. */
  votes: number
  createdAt: string
}

/** The ideas of the board, most voted first: the first one is the one the shots point at and vote for. No real request, no real name. */
export const COMMUNITY_IDEAS: readonly CommunityIdea[] = [
  { id: 'demo-1', title: { fr: 'Exporter un espace vers un autre Mac', en: 'Export a Space to another Mac' }, state: 'planned', votes: 128, createdAt: '2026-09-14T09:00:00Z' },
  { id: 'demo-2', title: { fr: 'Des raccourcis clavier propres à chaque espace', en: 'Keyboard shortcuts of its own for each Space' }, state: 'studying', votes: 96, createdAt: '2026-09-22T10:00:00Z' },
  { id: 'demo-3', title: { fr: 'Rouvrir un onglet fermé depuis la barre de commandes', en: 'Reopen a closed tab from the command bar' }, state: 'proposed', votes: 74, createdAt: '2026-10-03T08:30:00Z' },
  { id: 'demo-4', title: { fr: 'Un mode lecture qui garde les légendes des images', en: 'A reader mode that keeps image captions' }, state: 'proposed', votes: 51, createdAt: '2026-10-11T16:00:00Z' },
  { id: 'demo-5', title: { fr: 'Attacher une note rapide à un onglet', en: 'Attach a quick note to a tab' }, state: 'proposed', votes: 37, createdAt: '2026-10-19T12:00:00Z' },
  { id: 'demo-6', title: { fr: 'Un minuteur de concentration dans la barre latérale', en: 'A focus timer in the sidebar' }, state: 'proposed', votes: 22, createdAt: '2026-10-27T18:00:00Z' }
]

/** The idea the shots vote for: the first of the board. */
export const VOTED_IDEA = COMMUNITY_IDEAS[0]!

/** The votes the run cast, by idea id: kept by the script and emptied before each scene. */
export interface CommunityVotes {
  voted: Set<string>
}

export interface ApiAnswer {
  status: number
  headers: Record<string, string>
  body: string
}

const API_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
}

const json = (status: number, value: unknown): ApiAnswer => ({ status, headers: { ...API_HEADERS }, body: JSON.stringify(value) })

/** The language of the page that asks: its address (the `Referer` of a request of the page) is under `/en/` in English. */
export function langOfReferer(referer: string | undefined): Lang {
  // No address, or one that does not parse: the default page of the site, the French one.
  return URL.canParse(referer ?? '') && new URL(referer!).pathname.startsWith('/en/') ? 'en' : 'fr'
}

/** The id of the request a vote names, from the JSON body the page sends; null when it names none of the board. */
function requestIdOf(body: string): string | null {
  try {
    const id = (JSON.parse(body) as { requestId?: unknown }).requestId
    return typeof id === 'string' && COMMUNITY_IDEAS.some((idea) => idea.id === id) ? id : null
  } catch {
    return null
  }
}

export interface ApiRequest {
  method: string
  /** The path with its query (`/api/community/requests?type=idea`). */
  url: string
  referer?: string
  /** Whether the request carries `Authorization: Bearer …` (the page sends it once its token is written). */
  signedIn: boolean
  body?: string
}

/**
 * The stand-in of the service (the routes of assets/community-api.js), or null for a path that is not one of its routes. A list in the
 * language of the page, the votes of this run added; a vote or its withdrawal only when the page is signed in; a challenge of one bit, solved
 * at once. Nothing else is answered: no code is ever sent, no proposal saved.
 */
export function communityApi(votes: CommunityVotes, request: ApiRequest): ApiAnswer | null {
  const [path, query = ''] = request.url.split('?') as [string, string?]
  if (!path.startsWith('/api/')) return null
  const method = request.method.toUpperCase()
  if (path === DEMO_CHECK_PATH && method === 'GET') return json(200, { demo: DEMO_CHECK_ANSWER })
  if (path === '/api/config' && method === 'GET') return json(200, { votingEnabled: true })
  // One bit of work: the page finds a nonce in a try or two (community-api.js wants a salt of 8 to 100 hexadecimal digits).
  if (path === '/api/community/challenge' && method === 'GET') return json(200, { challenge: 'demo-challenge', salt: '0123456789abcdef', difficulty: 1 })
  if (path === '/api/community/requests' && method === 'GET') {
    const type = new URLSearchParams(query).get('type') ?? 'idea'
    const lang = langOfReferer(request.referer)
    const list = type === 'idea' ? COMMUNITY_IDEAS : []
    return json(200, {
      signedIn: request.signedIn,
      requests: list.map((idea) => {
        const voted = request.signedIn && votes.voted.has(idea.id)
        return { id: idea.id, title: idea.title[lang], type: 'idea', state: idea.state, votes: idea.votes + (voted ? 1 : 0), voted, createdAt: idea.createdAt, issueUrl: '', note: '' }
      })
    })
  }
  if (path === '/api/community/votes' && (method === 'POST' || method === 'DELETE')) {
    if (!request.signedIn) return json(401, { error: 'authentication-required' })
    const id = requestIdOf(request.body ?? '')
    if (id === null) return json(404, { error: 'request-not-found' })
    const idea = COMMUNITY_IDEAS.find((entry) => entry.id === id)!
    if (method === 'POST') {
      if (votes.voted.has(id)) return json(409, { error: 'already-voted' })
      votes.voted.add(id)
      return json(200, { votes: idea.votes + 1, held: false })
    }
    votes.voted.delete(id)
    return json(200, { votes: idea.votes })
  }
  return json(404, { error: 'not-found' })
}

/**
 * The files of the site checkout the page needs, by the path it asks for: the two Community pages, the logo of their header (the icon of the site,
 * at the root) and the assets they load (their fonts among them).
 */
const SITE_PAGES: Readonly<Record<string, SiteFile>> = {
  '/communaute/': { file: 'communaute/index.html', contentType: 'text/html; charset=utf-8' },
  '/en/community/': { file: 'en/community/index.html', contentType: 'text/html; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', contentType: 'image/svg+xml' }
}
const ASSET_TYPES: Readonly<Record<string, string>> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  woff2: 'font/woff2'
}

export interface SiteFile {
  /** Relative to the root of the site checkout. */
  file: string
  contentType: string
}

/**
 * The file of the site checkout served at this path, or null: only the Community pages, the icon of the site and the files under /assets/ of a
 * known type, by a path of plain names (no `..`, no hidden file, no encoded character), so that nothing else of the checkout is ever served.
 */
export function siteFile(rawPath: string): SiteFile | null {
  const path = rawPath.split('?')[0]!.split('#')[0]!
  const page = SITE_PAGES[path]
  if (page) return { ...page }
  // Every folder and the file start with a letter or a digit: no `..`, no hidden file; a `%` (an encoded character) matches nothing.
  const asset = /^\/assets\/((?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9._-]*)\.([a-z0-9]+)$/i.exec(path)
  if (!asset) return null
  const type = ASSET_TYPES[asset[2]!.toLowerCase()]
  return type ? { file: `assets/${asset[1]}.${asset[2]}`, contentType: type } : null
}

/**
 * The headers of a file of the site: its scripts may run, but only from the page's own address (the local server), and they may reach only it;
 * the proof of work may run in a worker made from a `blob:` address, as on the real site.
 */
export const SITE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  // The stand-in of the API tells the language of the page by its address.
  'Referrer-Policy': 'same-origin'
}
