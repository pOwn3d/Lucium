// The copies of the icons of sites the interface draws (shared/site-icon.ts). The interface asks for no site: it asks here, by the address the
// page declared, and gets the copy made of it. A copy is downloaded once, through the session of the profile the icon is shown in: the request
// has the cookies of that profile and passes its blocker, as the picture would if the page loaded it, and the site learns nothing a visit of
// the tab would not tell it. Nothing is downloaded for an address nobody is known to show: an icon is one a page of this run declared
// (`declare`), or one the state names (`owner`), never one the interface merely asks for.
//
// A copy lives in memory, and what the session keeps of it lives in the cache of the profile: erasing the profile's data erases it. What comes
// back is bounded in size and must be a picture (`acceptIcon`); it is served under the type its bytes are, never the one the site gave.
//
// No Electron here: the session is a function handed in, so the rules are tested against a fake one. The engine gives the real one.

import { setBounded } from '@shared/bounded'
import { FAVICON_FILE_MAX, acceptIcon, iconAllowedFor } from '@shared/favicon'
import { iconAddressOf, servedIconType, type SiteIconOwner } from '@shared/site-icon'

export interface SiteIconLimits {
  /** Copies kept; the least lately asked go first. */
  copies: number
  /** The bytes of all the copies together. */
  bytes: number
  /** Icons remembered as declared by a page of this run. */
  declared: number
  /** Addresses remembered as having given nothing. */
  failures: number
  /** An address that gave nothing is asked again after this long. */
  retryAfterMs: number
  /** One download. */
  timeoutMs: number
  /** Downloads at the same time: a window restored with hundreds of tabs asks for all their icons at once. */
  concurrency: number
  /** Downloads waiting for their turn; past it an icon is simply not drawn this time. */
  waiting: number
}

export const SITE_ICON_LIMITS: SiteIconLimits = { copies: 512, bytes: 32 * 1024 * 1024, declared: 2000, failures: 2000, retryAfterMs: 10 * 60_000, timeoutMs: 8000, concurrency: 6, waiting: 600 }

export interface SiteIconDeps {
  /** A GET through the session of the profile, with its cookies. It rejects when the signal aborts. */
  fetch(profileId: string, url: string, signal: AbortSignal): Promise<Response>
  /** Whether the blocker of the profile's pages would stop this picture on that page. */
  blocked(iconUrl: string, pageUrl: string): boolean
  /** Who the state says shows the icon (a tab restored and not loaded yet, a favourite, a bookmark), or null. */
  owner(iconUrl: string): SiteIconOwner | null
  /** A line for the log. It never holds an address: the log would otherwise list the sites of the tabs. */
  warn(line: string): void
  now?(): number
  limits?: Partial<SiteIconLimits>
}

interface Copy {
  /** A buffer of its own: the caller's may be a view of something larger, or change afterwards. */
  bytes: Uint8Array<ArrayBuffer>
  type: string
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'Error')

/** Reads a body up to `max` bytes; null when it is longer (by the length the server declares, then chunk by chunk: the rest is never downloaded). */
async function readBounded(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (declared > max || !response.body) {
    await response.body?.cancel()
    return declared > max ? null : new Uint8Array(0)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const

export class SiteIconCopies {
  private readonly limits: SiteIconLimits
  private readonly now: () => number
  private readonly copies = new Map<string, Copy>()
  private held = 0
  private readonly declared = new Map<string, SiteIconOwner>()
  private readonly failed = new Map<string, number>()
  private readonly running = new Map<string, Promise<Copy | null>>()
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly deps: SiteIconDeps) {
    this.limits = { ...SITE_ICON_LIMITS, ...deps.limits }
    this.now = deps.now ?? Date.now
  }

  /** A page of this run declared this icon (already judged by the blocker of the page, declared-icon.ts): it may be downloaded for that page. */
  declare(iconUrl: string, owner: SiteIconOwner): void {
    if (!isIconAddress(iconUrl)) return
    setBounded(this.declared, iconUrl, owner, this.limits.declared)
  }

  /**
   * Bytes already downloaded for this icon by a lookup of the application (the search for the icon of a site that never loaded): they are
   * the copy, and no second request is made. Refused, with nothing kept, when they are not a picture an icon may be.
   */
  keep(iconUrl: string, bytes: Uint8Array, contentType: string | null): boolean {
    if (!isIconAddress(iconUrl)) return false
    return this.store(iconUrl, bytes, contentType) !== null
  }

  /** The answer to a request of the interface: the copy, or 404 when there is none to give. */
  async serve(request: string): Promise<Response> {
    const address = iconAddressOf(request)
    if (address === null) return new Response(null, { status: 400, headers: HEADERS })
    const copy = await this.copyOf(address)
    if (copy === null) return new Response(null, { status: 404, headers: HEADERS })
    return new Response(copy.bytes, { status: 200, headers: { ...HEADERS, 'content-type': copy.type, 'content-length': String(copy.bytes.length) } })
  }

  /** Forgets everything: the data of a profile were erased, and what was copied from its sites goes with them. */
  clear(): void {
    this.copies.clear()
    this.held = 0
    this.declared.clear()
    this.failed.clear()
  }

  stats(): { copies: number; bytes: number; declared: number; failed: number; running: number; waiting: number } {
    return { copies: this.copies.size, bytes: this.held, declared: this.declared.size, failed: this.failed.size, running: this.running.size, waiting: this.queue.length }
  }

  private copyOf(address: string): Promise<Copy | null> {
    const known = this.copies.get(address)
    if (known) {
      // Asked again: it is the newest, and the last to go.
      this.copies.delete(address)
      this.copies.set(address, known)
      return Promise.resolve(known)
    }
    const running = this.running.get(address)
    if (running) return running
    const failedAt = this.failed.get(address)
    if (failedAt !== undefined) {
      if (this.now() - failedAt < this.limits.retryAfterMs) return Promise.resolve(null)
      this.failed.delete(address)
    }
    const owner = this.declared.get(address) ?? this.ownerInState(address)
    // Nobody shows it: nothing is asked, and nothing is remembered either (the state may name it a moment later).
    if (owner === null) return Promise.resolve(null)
    const job = this.download(address, owner).finally(() => this.running.delete(address))
    this.running.set(address, job)
    return job
  }

  private ownerInState(address: string): SiteIconOwner | null {
    try {
      return this.deps.owner(address)
    } catch (error) {
      this.deps.warn(`[icons] the state could not be asked who shows an icon, so it is not downloaded (${errorName(error)})`)
      return null
    }
  }

  private async download(address: string, owner: SiteIconOwner): Promise<Copy | null> {
    const copy = await this.attempt(address, owner)
    if (copy === 'later') return null
    if (copy === null) setBounded(this.failed, address, this.now(), this.limits.failures)
    return copy
  }

  /** The copy, null when the address gives none (it is then left alone for a while), or 'later' when it was not asked at all for want of a place. */
  private async attempt(address: string, owner: SiteIconOwner): Promise<Copy | null | 'later'> {
    // What a page may have as its icon, whoever named it: never an http picture for an https page.
    if (!iconAllowedFor(address, owner.pageUrl)) return null
    try {
      if (this.deps.blocked(address, owner.pageUrl)) return null
    } catch (error) {
      // No icon costs a letter in a row; an unjudged one would cost a request the blocker may have refused.
      this.deps.warn(`[icons] the blocker failed on an icon, so it is not downloaded (${errorName(error)})`)
      return null
    }
    if (!(await this.turn())) return 'later'
    try {
      const response = await this.deps.fetch(owner.profileId, address, AbortSignal.timeout(this.limits.timeoutMs))
      if (!response.ok) {
        await response.body?.cancel()
        return null
      }
      const bytes = await readBounded(response, FAVICON_FILE_MAX)
      return bytes === null ? null : this.store(address, bytes, response.headers.get('content-type'))
    } catch (error) {
      // A site that is slow, gone or refused only leaves the letter of the row. The line names the kind of failure, never the address.
      this.deps.warn(`[icons] an icon could not be downloaded (${errorName(error)})`)
      return null
    } finally {
      this.release()
    }
  }

  /** Keeps the bytes as the copy of the address when they are a picture an icon may be. */
  private store(address: string, bytes: Uint8Array, contentType: string | null): Copy | null {
    const type = acceptIcon(contentType, bytes) ? servedIconType(bytes) : null
    if (type === null) return null
    const own = new Uint8Array(bytes.length)
    own.set(bytes)
    const copy: Copy = { bytes: own, type }
    const before = this.copies.get(address)
    if (before) this.held -= before.bytes.length
    this.copies.delete(address)
    this.copies.set(address, copy)
    this.held += bytes.length
    while (this.copies.size > this.limits.copies || this.held > this.limits.bytes) {
      const oldest = this.copies.entries().next()
      if (oldest.done || oldest.value[0] === address) break
      this.copies.delete(oldest.value[0])
      this.held -= oldest.value[1].bytes.length
    }
    this.failed.delete(address)
    return copy
  }

  /** Waits for one of the places of the downloads. False when too many already wait. */
  private turn(): Promise<boolean> {
    if (this.active < this.limits.concurrency) {
      this.active++
      return Promise.resolve(true)
    }
    if (this.queue.length >= this.limits.waiting) return Promise.resolve(false)
    return new Promise((resolve) => this.queue.push(() => resolve(true)))
  }

  private release(): void {
    const next = this.queue.shift()
    // The place goes to the next one as it is.
    if (next) next()
    else this.active--
  }
}

/** Whether an icon may have this address at all: a web one, without a login, short enough (what `iconAllowedFor` asks of any page; an http page allows both schemes). */
function isIconAddress(iconUrl: string): boolean {
  return iconAllowedFor(iconUrl, 'http://page.invalid/')
}
