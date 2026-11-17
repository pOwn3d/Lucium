// The memory of "HTTPS first": which pages have an upgrade under way, what to do if it fails, and the guard against loops.
// The rules for the address itself are in shared/privacy.ts; this file holds the state per page (a page is a web contents id) and
// knows nothing of Electron, so it is tested on its own (https-upgrade.test.ts).

import { HTTPS_UPGRADE_TIMEOUT_MS, httpsUpgradeOf } from '@shared/privacy'
import { urlHostname } from '@shared/url'

/** What the upgrade needs from a page, to fall back to the address it came from. */
export interface UpgradeTarget {
  /** Opens `url` in the page. */
  navigate(url: string): void
  isLoading(): boolean
  /** Cancels what is loading. */
  stop(): void
  /** The page went back to http: lets the user know. */
  fellBack(host: string): void
}

interface Pending {
  http: string
  https: string
  timer: ReturnType<typeof setTimeout>
}

/** ERR_ABORTED: a navigation that was replaced, cancelled or became a download. It says nothing about the site. */
const ERR_ABORTED = -3

/**
 * What became of a failed main-frame load. `none`: it was not an upgrade's failure, the error page shows as usual. `fell-back`: the site did not
 * answer over https, the page went back to http by itself (no error page; a notice says so). `refused`: the site answered over https with a
 * certificate that is not valid, which is never a reason to go to http by itself (someone on the way can present any certificate): the error page
 * shows, and offers the http address, on the user's click only.
 */
export type UpgradeFailure = { kind: 'none' } | { kind: 'fell-back' } | { kind: 'refused'; http: string }

export class HttpsUpgrades {
  private readonly targets = new Map<number, UpgradeTarget>()
  private readonly pending = new Map<number, Pending>()
  /** The http addresses upgraded during the navigation under way, per page: one is never upgraded twice, so a site that sends its https visitors back to http cannot loop. */
  private readonly tried = new Map<number, Set<string>>()
  /** The http addresses a page was sent back to after a failure: they go through once without being upgraded. */
  private readonly letThrough = new Map<number, Set<string>>()

  constructor(private readonly timeoutMs: number = HTTPS_UPGRADE_TIMEOUT_MS) {}

  attach(id: number, target: UpgradeTarget): void {
    this.targets.set(id, target)
  }

  detach(id: number): void {
    this.forget(id)
    this.targets.delete(id)
  }

  /** The request hook asks: may this http address, loaded by page `id`, go to https now? Returns the https address, or null. */
  upgrade(id: number, httpUrl: string): string | null {
    // A request that belongs to no page of ours (a worker, an extension) is not ours to rewrite.
    if (!this.targets.has(id)) return null
    if (this.letThrough.get(id)?.delete(httpUrl)) return null
    const tried = this.tried.get(id) ?? new Set<string>()
    if (tried.has(httpUrl)) return null
    const https = httpsUpgradeOf(httpUrl)
    if (!https) return null
    tried.add(httpUrl)
    this.tried.set(id, tried)
    this.clearPending(id)
    this.pending.set(id, { http: httpUrl, https, timer: setTimeout(() => this.timedOut(id), this.timeoutMs) })
    return https
  }

  /** A main-frame navigation starts: a new one forgets the loop guard, and an upgrade that was under way is dropped if it is another address. */
  navigationStarted(id: number, url: string): void {
    this.tried.delete(id)
    const pending = this.pending.get(id)
    if (pending && url !== pending.http && url !== pending.https) this.clearPending(id)
  }

  /** The page committed a document: nothing is under way any more. */
  committed(id: number): void {
    this.forget(id)
  }

  /**
   * A main-frame load failed. When it is the upgraded one that did, the page goes back to the http address (`fell-back`): the failure is not
   * shown. A certificate the upgraded load was refused (`certificate`) is shown instead (`refused`, with the http address the page may offer).
   * Anything else (another address, a cancelled load) is `none`.
   */
  failed(id: number, failedUrl: string, code: number, certificate = false): UpgradeFailure {
    if (code === ERR_ABORTED) return { kind: 'none' }
    const pending = this.pending.get(id)
    if (!pending || urlHostname(pending.https) !== urlHostname(failedUrl)) {
      this.forget(id)
      return { kind: 'none' }
    }
    this.clearPending(id)
    this.tried.delete(id)
    if (certificate) return { kind: 'refused', http: pending.http }
    this.fallBack(id, pending)
    return { kind: 'fell-back' }
  }

  /** « Continuer en HTTP (non sécurisé) » on the page of a certificate the upgrade was refused: the page goes to `http`, once, without the upgrade. */
  continueOverHttp(id: number, http: string): void {
    if (!/^http:\/\//i.test(http) || !this.targets.has(id)) return
    this.letGo(id, http)
    this.targets.get(id)!.navigate(http)
  }

  /** Addresses with an upgrade under way, for the engine test. */
  pendingCount(): number {
    return this.pending.size
  }

  private timedOut(id: number): void {
    const pending = this.pending.get(id)
    const target = this.targets.get(id)
    this.pending.delete(id)
    // Done loading (a download, a page that settled on its own): the upgrade did not fail.
    if (!pending || !target || !target.isLoading()) return
    target.stop()
    this.fallBack(id, pending)
  }

  private fallBack(id: number, pending: Pending): void {
    const target = this.targets.get(id)
    if (!target) return
    this.letGo(id, pending.http)
    target.navigate(pending.http)
    target.fellBack(urlHostname(pending.http))
  }

  /** The next request of the page for `http` goes through as it is. */
  private letGo(id: number, http: string): void {
    const through = this.letThrough.get(id) ?? new Set<string>()
    through.add(http)
    this.letThrough.set(id, through)
  }

  private clearPending(id: number): void {
    const pending = this.pending.get(id)
    if (pending) clearTimeout(pending.timer)
    this.pending.delete(id)
  }

  private forget(id: number): void {
    this.clearPending(id)
    this.tried.delete(id)
    this.letThrough.delete(id)
  }
}
