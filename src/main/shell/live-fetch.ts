// One look at a live folder's source: a plain GET, without cookie or referrer, to a public host, following a few redirects that are each judged,
// reading at most LIVE_BODY_MAX bytes and waiting at most LIVE_TIMEOUT_MS. The network is a function handed in (`fetch`, favicon-resolver's
// `FetchLike`, which gives a redirect back as a 3xx answer), so that the rules here are tested against a fake one. Nothing here ever throws
// to its caller: a look that cannot be made says why in a sentence for the folder.

import { isPublicHost } from '@shared/favicon'
import { parseFeed, parseGithub } from '@shared/feed'
import { LIVE_BODY_MAX, LIVE_REDIRECTS_MAX, LIVE_TIMEOUT_MS, liveRequestHeaders, liveRequestUrl, type LiveItem, type LiveSource } from '@shared/live-folders'
import type { FetchLike } from './favicon-resolver'
import { t } from '@shared/i18n'
import { joinPieces, readPiecesWithin } from '@shared/bounded-stream'

export type LookResult = { ok: true; items: LiveItem[]; title: string } | { ok: false; error: string }

export interface LookOptions {
  /** `host[:port]` that may be asked although it is not on the public Internet. Only the engine test says yes: nothing in the application does. */
  allowHost?(host: string): boolean
  timeoutMs?: number
  bodyMax?: number
  now?(): number
  signal?: AbortSignal
}

class Refusal extends Error {}

const GITHUB_API_HOST = 'api.github.com'

/** The sentence for a status the server answered with. */
function statusMessage(status: number, source: LiveSource, headers: Headers): string {
  if (status === 404) return source.kind === 'github' ? t('live-fetch.depot-introuvable-ou-prive-http-404') : t('live-fetch.adresse-introuvable-http-404')
  if (status === 403 || status === 429) return source.kind === 'github' && headers.get('x-ratelimit-remaining') === '0' ? t('live-fetch.limite-de-requetes-github') : t('live-fetch.acces-refuse-http-status', { status })
  if (status === 410) return t('live-fetch.ce-flux-n-existe-plus-http-410')
  return t('live-fetch.le-serveur-a-repondu-http-status', { status })
}

/** The text of a body in the charset the server or the XML declaration names (UTF-8 when neither is usable). */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? '')?.[1]
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200))
  const fromDeclaration = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1]
  for (const label of [fromHeader, fromDeclaration]) {
    if (!label) continue
    try {
      return new TextDecoder(label).decode(bytes)
    } catch {
      // A charset name the platform does not know: the next hint, then UTF-8.
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/** Reads the body of a response up to `max` bytes: a longer one is refused (the rest is never downloaded). */
async function readBody(response: Response, max: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > max) throw new Refusal(t('live-fetch.reponse-trop-volumineuse'))
  if (!response.body) return new Uint8Array(0)
  const reader = response.body.getReader()
  try {
    const pieces = await readPiecesWithin(reader, max)
    if (pieces === null) throw new Refusal(t('live-fetch.reponse-trop-volumineuse'))
    return joinPieces(pieces)
  } finally {
    await reader.cancel().catch((error: unknown) => console.debug('[live-folders] cannot cancel the body:', error instanceof Error ? error.message : String(error)))
  }
}

const looksLikeFeed = (text: string): boolean => /<(?:rss|feed|rdf:rdf)[\s>]/i.test(text.slice(0, 4096))

/** Looks at the source once. */
export async function lookAt(fetchLike: FetchLike, source: LiveSource, options: LookOptions = {}): Promise<LookResult> {
  const timeoutMs = options.timeoutMs ?? LIVE_TIMEOUT_MS
  const bodyMax = options.bodyMax ?? LIVE_BODY_MAX
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const allowed = (url: URL): boolean => {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (url.username !== '' || url.password !== '') return false
    if (source.kind === 'github') return url.protocol === 'https:' && url.hostname === GITHUB_API_HOST
    return isPublicHost(url.hostname) || options.allowHost?.(url.host) === true
  }
  try {
    let current = liveRequestUrl(source)
    const headers = liveRequestHeaders(source)
    for (let hop = 0; ; hop++) {
      if (!URL.canParse(current) || !allowed(new URL(current))) throw new Refusal(hop === 0 ? t('live-fetch.adresse-non-prise-en-charge-reseau-local-ou') : t('live-fetch.redirection-vers-une-adresse-non-prise-en-charge'))
      const response = await fetchLike(current, { signal: controller.signal, headers })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location || hop >= LIVE_REDIRECTS_MAX) throw new Refusal(t('live-fetch.trop-de-redirections'))
        // A redirect never leads from https to http.
        const next = URL.canParse(location, current) ? new URL(location, current) : null
        if (!next || (new URL(current).protocol === 'https:' && next.protocol !== 'https:')) throw new Refusal(t('live-fetch.redirection-refusee'))
        current = next.href
        continue
      }
      if (response.status < 200 || response.status >= 300) throw new Refusal(statusMessage(response.status, source, response.headers))
      const text = decodeBody(await readBody(response, bodyMax), response.headers.get('content-type'))
      if (source.kind === 'github') {
        const items = parseGithub(text, source.repo, source.what, options.now?.() ?? Date.now())
        return { ok: true, items, title: '' }
      }
      if (!looksLikeFeed(text)) throw new Refusal(t('live-fetch.cette-adresse-n-est-pas-un-flux-rss-ou-atom'))
      const feed = parseFeed(text, current, options.now?.() ?? Date.now())
      return { ok: true, items: feed.items, title: feed.title }
    }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message }
    if (timedOut) return { ok: false, error: t('live-fetch.le-serveur-n-a-pas-repondu-a-temps') }
    if (options.signal?.aborted) return { ok: false, error: t('live-fetch.lecture-annulee') }
    // A server that is down, a name that does not resolve, a connection cut: the log keeps the detail, the folder says it could not be read.
    console.warn('[live-folders] a look failed:', error instanceof Error ? error.message : String(error))
    return { ok: false, error: t('live-fetch.le-serveur-ne-repond-pas') }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
