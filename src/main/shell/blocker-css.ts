// The stylesheet that hides ads and banners on one page: the rules of its site at once, then (a page's markup is not there at the start, and some of it
// arrives late) the generic rules its classes, ids and links call for, at a few moments after the start. Electron-free: the page, the blocker and the
// clock come in as small ports, so it is tested without a window. A tab, a preview (Glance) and any other page of the window use the same code.

import { adsBlockingOn } from '@shared/blocker'
import type { Settings } from '@shared/model'
import { DOM_HINTS_SCRIPT } from '../blocking/dom-hints'
import type { DomHints } from '../blocking/filter-engine'

/** What the stylesheet needs of a page. */
export interface BlockerCssPage {
  applyCss(css: string, slot: 'blocker'): void
  evaluate(js: string): Promise<unknown>
}

export interface BlockerCssDeps {
  settings(): Settings
  blocker: { cosmeticCss(pageUrl: string, settings: Settings, dom?: DomHints): string }
  /** Milliseconds after the start of a page at which its markup is read again. */
  delays: readonly number[]
  /** Runs `run` after `ms`. Only the tests change it. */
  later?: (run: () => void, ms: number) => void
  /** What is said of a scan that could not run (a page that is navigating away refuses the script). */
  skipped?: (key: string, reason: string) => void
}

export class BlockerCss {
  /** The stylesheet each page was last given: a page that was given nothing and still needs nothing is not touched. */
  private readonly applied = new Map<string, string>()
  /** The scan each page is on: a scan of an older document (or an older setting) does not answer for the newer one. */
  private readonly scans = new Map<string, number>()

  constructor(private readonly deps: BlockerCssDeps) {}

  /** The page loaded a new document: what it was given before is gone with the old one. */
  fresh(key: string): void {
    this.applied.delete(key)
  }

  /** The page is gone. */
  forget(key: string): void {
    this.applied.delete(key)
    this.scans.delete(key)
  }

  /**
   * Hides ads and banners on one page. `urlOf` is the address it shows now (undefined: the page is not there any more), `isCurrent` whether this page is
   * still the one that answers to `key`.
   */
  apply(key: string, page: BlockerCssPage, urlOf: () => string | undefined, isCurrent: () => boolean): void {
    const url = urlOf()
    if (url === undefined) return
    const settings = this.deps.settings()
    const give = (css: string): void => {
      if ((this.applied.get(key) ?? '') === css) return
      this.applied.set(key, css)
      page.applyCss(css, 'blocker')
    }
    give(this.deps.blocker.cosmeticCss(url, settings))
    const generation = (this.scans.get(key) ?? 0) + 1
    this.scans.set(key, generation)
    if (!(adsBlockingOn(settings) && settings.blockCosmetic) && !settings.blockCookieBanners) return
    const scan = async (): Promise<void> => {
      // A page that is navigating away refuses the script: the cosmetic pass is skipped for it, and the journal says so.
      const hints = (await page.evaluate(DOM_HINTS_SCRIPT).catch((error: unknown) => {
        this.deps.skipped?.(key, error instanceof Error ? error.message : String(error))
        return undefined
      })) as DomHints | undefined
      // The page may have moved on while the script ran, or the options changed.
      if (!hints || this.scans.get(key) !== generation || !isCurrent()) return
      const current = urlOf()
      if (current !== undefined) give(this.deps.blocker.cosmeticCss(current, this.deps.settings(), hints))
    }
    const later = this.deps.later ?? ((run, ms) => void setTimeout(run, ms).unref())
    for (const delay of this.deps.delays) later(() => void scan(), delay)
  }
}
