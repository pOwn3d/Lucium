// The memory of the lookalike warnings (typo-guard.ts), by host. The shell says « this typed address looks like a site of the person »; the request
// filter then holds the first main-frame request to that host, which makes the engine show the warning page (error-pages.ts); « Continuer » lets the host
// through for the rest of the run. Pure but for the clock, which is given.

/** A typed address the load of which did not start within this time is forgotten: a later navigation to that host is not the typed one. */
export const TYPO_PENDING_MS = 30_000
/** Hosts kept at most: the memory of a run is not a list. */
export const TYPO_MEMORY_MAX = 64

type State = 'pending' | 'held' | 'allowed'
interface Entry {
  similar: string
  state: State
  at: number
}

const hostOfUrl = (url: string): string | null => (URL.canParse(url) ? new URL(url).hostname.toLowerCase() : null)

export class TypoWarnings {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly now: () => number) {}

  /** A typed address (host) looks like `similar`: the next main-frame request to it is held. A host already let through is not warned about again. */
  expect(host: string, similar: string): void {
    const key = host.toLowerCase()
    if (this.entries.get(key)?.state === 'allowed') return
    this.entries.delete(key)
    this.entries.set(key, { similar, state: 'pending', at: this.now() })
    while (this.entries.size > TYPO_MEMORY_MAX) this.entries.delete(this.entries.keys().next().value!)
  }

  /** The request filter: whether this main-frame request is held (cancelled, the page of the warning then shows). A request is held once; the page asks `warning`. */
  holds(url: string): boolean {
    const host = hostOfUrl(url)
    const entry = host === null ? undefined : this.entries.get(host)
    if (!entry || entry.state !== 'pending') return false
    if (this.now() - entry.at > TYPO_PENDING_MS) {
      this.entries.delete(host!)
      return false
    }
    entry.state = 'held'
    return true
  }

  /** The page of the warning: the site the address looks like, for an address that was held. */
  warning(url: string): { similar: string } | null {
    const host = hostOfUrl(url)
    const entry = host === null ? undefined : this.entries.get(host)
    return entry?.state === 'held' ? { similar: entry.similar } : null
  }

  /** « Continuer »: the host is let through (and its warning is not given again) until the application quits. */
  allow(url: string): void {
    const host = hostOfUrl(url)
    const entry = host === null ? undefined : this.entries.get(host)
    if (entry?.state === 'held') entry.state = 'allowed'
  }

  /** Forgets every host (the tests; the application keeps its memory until it quits). */
  forgetAll(): void {
    this.entries.clear()
  }
}
