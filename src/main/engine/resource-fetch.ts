// Downloads the images of a page for an archive. The only network this feature does, and only when the user asks to save with the
// images: nothing but the addresses the page itself lists as images, fetched with the session of the tab (its cookies, as the page's own
// <img> would send them). Every answer is checked before a byte is kept: status, type, declared size, size actually read, total size,
// number of images and time. A failure never stops the export: the image stays a link in the file, and the reason goes in the report.

import { IMAGE_LIMITS, IMAGE_TYPES, archiveImageName, type MdImage } from '@shared/markdown-export'
import { t, tp } from '@shared/i18n'

export type FetchFn = (url: string, init: { signal: AbortSignal; credentials: 'include'; redirect: 'follow'; headers?: Record<string, string> }) => Promise<Response>

export interface DownloadedImage {
  /** The reference the Markdown uses (`image-3`). */
  reference: string
  /** Where it goes in the archive (`images/image-001.png`). */
  name: string
  data: Uint8Array
}

export interface ImageDownload {
  files: DownloadedImage[]
  /** One line per image that could not be kept, and for the limits that stopped the rest. */
  failures: string[]
}

export type ImageLimits = { -readonly [K in keyof typeof IMAGE_LIMITS]: number }

export interface DownloadOptions {
  /** The page the images are on. What each request says of it is decided by `refererFor`: never more than a page's own request would. */
  referrer?: string
  /** Replaces some of the limits of `IMAGE_LIMITS` (the tests make them small). */
  limits?: Partial<ImageLimits>
  /** Stops everything under way. */
  signal?: AbortSignal
  progress?(done: number, total: number): void
}

class Refusal extends Error {}

/**
 * What a request for `image` says of the `page` it is on, by the rule a browser applies when the page declares none
 * (`strict-origin-when-cross-origin`): the address of the page without its fragment or credentials to the page's own site, its origin alone
 * to another site, and nothing from an https page to an address in clear. The path and the parameters of the page (which may hold a token,
 * or name a document) are thus never given to the hosts of its images. Undefined: no `Referer` at all.
 */
export function refererFor(page: string | undefined, image: string): string | undefined {
  if (!page) return undefined
  let from: URL
  let to: URL
  try {
    from = new URL(page)
    to = new URL(image)
  } catch {
    // An address that cannot be read names no page: the request goes without a referrer, the strictest answer.
    return undefined
  }
  if (from.protocol !== 'https:' && from.protocol !== 'http:') return undefined
  if (from.protocol === 'https:' && to.protocol !== 'https:') return undefined
  if (from.origin !== to.origin) return `${from.origin}/`
  from.hash = ''
  from.username = ''
  from.password = ''
  return from.href
}

const shown = (url: string): string => (url.length > 200 ? `${url.slice(0, 200)}…` : url)

/** Reads the body of a response, up to `perImage` bytes; `spend` counts each chunk against the total of all the downloads that run together. */
async function readBody(response: Response, perImage: number, spend: (bytes: number) => boolean): Promise<Uint8Array> {
  if (!response.body) throw new Refusal(t('resource-fetch.reponse-vide'))
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > perImage) throw new Refusal(t('resource-fetch.image-trop-volumineuse'))
      if (!spend(value.length)) throw new Refusal(t('resource-fetch.limite-de-taille-totale-atteinte'))
      chunks.push(value)
    }
  } finally {
    // The rest of a body we refuse is never downloaded.
    await reader.cancel().catch((error: unknown) => console.debug('[markdown] cannot cancel the body of an image:', error instanceof Error ? error.message : String(error)))
  }
  if (size === 0) throw new Refusal(t('resource-fetch.image-vide'))
  const data = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return data
}

export async function downloadImages(fetchFn: FetchFn, images: readonly Pick<MdImage, 'reference' | 'url'>[], options: DownloadOptions = {}): Promise<ImageDownload> {
  const limits: ImageLimits = { ...IMAGE_LIMITS, ...options.limits }
  const failures: string[] = []
  const wanted = images.slice(0, limits.count)
  if (images.length > wanted.length) failures.push(tp('resource-fetch.limite-de-limit-images-les-count-autres-restent', images.length - wanted.length, { limit: limits.count }))
  const outcomes: Array<{ ext: string; data: Uint8Array } | null> = wanted.map(() => null)
  const deadline = Date.now() + limits.deadlineMs
  let bytes = 0
  let next = 0
  let done = 0
  let late = false
  const spend = (count: number): boolean => {
    bytes += count
    return bytes <= limits.totalBytes
  }

  async function fetchOne(url: string): Promise<{ ext: string; data: Uint8Array }> {
    if (!/^https?:\/\//i.test(url)) throw new Refusal(t('resource-fetch.adresse-non-prise-en-charge'))
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort()
    }, limits.timeoutMs)
    try {
      const referer = refererFor(options.referrer, url)
      const response = await fetchFn(url, { signal: controller.signal, credentials: 'include', redirect: 'follow', ...(referer ? { headers: { Referer: referer } } : {}) })
      if (!response.ok) throw new Refusal(`HTTP ${response.status}`)
      // A redirect must not have led away from the web.
      if (response.url && !/^https?:\/\//i.test(response.url)) throw new Refusal(t('resource-fetch.redirection-non-prise-en-charge'))
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      // Only a type the table itself lists: `constructor` or `__proto__` are names every object answers to, not image types.
      const ext = Object.hasOwn(IMAGE_TYPES, type) ? IMAGE_TYPES[type] : undefined
      if (!ext) throw new Refusal(t('resource-fetch.la-reponse-n-est-pas-une-image-prise-en-charge'))
      if (Number(response.headers.get('content-length')) > limits.perImageBytes) throw new Refusal(t('resource-fetch.image-trop-volumineuse'))
      if (bytes >= limits.totalBytes) throw new Refusal(t('resource-fetch.limite-de-taille-totale-atteinte'))
      return { ext, data: await readBody(response, limits.perImageBytes, spend) }
    } catch (error) {
      if (error instanceof Refusal) throw error
      throw new Refusal(timedOut ? t('network.delai-depasse') : options.signal?.aborted ? t('resource-fetch.annule') : String((error as Error).message ?? error))
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      const image = wanted[index]
      if (!image || options.signal?.aborted) return
      if (Date.now() >= deadline) {
        if (!late) failures.push(t('resource-fetch.delai-de-recuperation-des-images-atteint-les'))
        late = true
        return
      }
      try {
        outcomes[index] = await fetchOne(image.url)
      } catch (error) {
        failures.push(t('resource-fetch.url-reason-lien-conserve', { url: shown(image.url), reason: (error as Error).message }))
      }
      options.progress?.(++done, wanted.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limits.parallel, wanted.length) }, worker))
  // Named by order of success, not by position: the archive has no gap in its numbers.
  const files: DownloadedImage[] = []
  wanted.forEach((image, index) => {
    const outcome = outcomes[index]
    if (outcome) files.push({ reference: image.reference, name: archiveImageName(files.length, outcome.ext), data: outcome.data })
  })
  return { files, failures }
}
