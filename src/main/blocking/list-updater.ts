// Downloads one filter list. A conditional request (ETag, Last-Modified) so an unchanged list costs a few bytes; the
// text is checked before anything is replaced; on any failure the installed copy stays and the failure is recorded.
// Nothing is sent but a plain GET to the list's own host: no cookie, no referrer, no identifier.

import { validateFilterList, type FilterListSpec } from '@shared/filter-lists'
import type { ListStore } from './list-store'
import { t } from '@shared/i18n'
import { readPiecesWithin } from '@shared/bounded-stream'

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; credentials: 'omit'; referrerPolicy: 'no-referrer'; cache: 'no-store' }) => Promise<Response>

export type UpdateOutcome = 'updated' | 'unchanged' | 'failed'

export interface UpdateContext {
  store: ListStore
  fetch: FetchLike
  now: () => number
  timeoutMs: number
  /** Accept a list served over plain http (the tests' local server). Never set in the application. */
  allowInsecure?: boolean
}

/** A heavier answer than any list is refused before it is read. */
const MAX_BYTES = 30_000_000

/**
 * The body as text, read piece by piece and given up (the connection is cancelled) as soon as it passes `limit` bytes: a server that announces no
 * length can stream without end, and `response.text()` would keep all of it in memory until the time is up. Null when it is too long.
 */
export async function readBoundedText(response: Response, limit: number): Promise<string | null> {
  const body = response.body
  if (!body) {
    const whole = await response.text()
    return Buffer.byteLength(whole) > limit ? null : whole
  }
  const reader = body.getReader()
  const pieces = await readPiecesWithin(reader, limit)
  if (pieces === null) {
    await reader.cancel().catch(() => undefined)
    return null
  }
  return Buffer.concat(pieces).toString('utf8')
}

/** What the user can act on: no stack, no internal detail. */
export function describeFailure(error: unknown): string {
  const e = error as { name?: string; message?: string; cause?: { code?: string } }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return t('list-updater.delai-depasse')
  const code = e?.cause?.code
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return t('list-updater.serveur-introuvable-pas-de-connexion')
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return t('list-updater.connexion-refusee-ou-interrompue')
  return String(e?.message ?? error).slice(0, 200) || t('list-updater.erreur-inconnue')
}

export async function updateList(spec: FilterListSpec, ctx: UpdateContext): Promise<UpdateOutcome> {
  const { store } = ctx
  const fail = (message: string): UpdateOutcome => {
    store.fail(spec.id, message, ctx.now())
    return 'failed'
  }
  if (!ctx.allowInsecure && !spec.url.startsWith('https://')) return fail(t('list-updater.adresse-non-securisee-refusee'))

  const have = store.meta(spec.id)
  // Validators only count if the copy they describe is still readable.
  const current = have && store.read(spec.id) !== null ? have : undefined
  const headers: Record<string, string> = { Accept: 'text/plain, */*;q=0.1' }
  if (current?.etag) headers['If-None-Match'] = current.etag
  if (current?.lastModified) headers['If-Modified-Since'] = current.lastModified

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ctx.timeoutMs)
  try {
    const response = await ctx.fetch(spec.url, { headers, signal: abort.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
    if (response.status === 304 && current) {
      store.confirm(spec.id, ctx.now())
      return 'unchanged'
    }
    if (!response.ok) return fail(t('list-updater.reponse-du-serveur-status', { status: response.status }))
    if (!ctx.allowInsecure && response.url && !response.url.startsWith('https://')) return fail(t('list-updater.redirection-vers-une-adresse-non-securisee'))
    if (/text\/html/i.test(response.headers.get('content-type') ?? '')) return fail(t('filter-lists.le-serveur-a-repondu-par-une-page-web-et-non'))
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BYTES) return fail(t('filter-lists.la-liste-est-anormalement-volumineuse'))

    const text = await readBoundedText(response, MAX_BYTES)
    if (text === null) return fail(t('filter-lists.la-liste-est-anormalement-volumineuse'))
    const verdict = validateFilterList(text, { minRules: spec.minRules, previousRules: current?.rules })
    if (!verdict.ok) return fail(verdict.reason)
    store.install(spec.id, text, {
      checkedAt: ctx.now(),
      rules: verdict.rules,
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {})
    })
    return 'updated'
  } catch (error) {
    return fail(describeFailure(error))
  } finally {
    clearTimeout(timer)
  }
}
