// The downloads extensions asked for (chrome.downloads.download), waiting for Chromium to start them, and the rule that tells which
// download that starts is one of them.

import { isRequestedDownload } from '@shared/chrome-compat'

/** A download an extension asked for: the session it runs in, the address, what to name the file, and who gets the id. */
export interface RequestedDownload<S> {
  ses: S
  url: string
  filename?: string
  resolve: (id: string) => void
}

export class RequestedDownloads<S> {
  private readonly waiting: Array<RequestedDownload<S>> = []

  add(request: RequestedDownload<S>): void {
    this.waiting.push(request)
  }

  /** A request that never started (the server is unreachable) leaves the list. */
  drop(request: RequestedDownload<S>): void {
    const at = this.waiting.indexOf(request)
    if (at >= 0) this.waiting.splice(at, 1)
  }

  get size(): number {
    return this.waiting.length
  }

  /**
   * The request a download that just started answers, if one is waiting: it gets the download's id and leaves the list.
   * Only a download with no page behind it (`source` null) can be one. The engine starts an extension's download with `session.downloadURL`,
   * which Chromium ties to no web contents, while everything the user downloads comes from a page (a link, "Save link as", a navigation).
   * Matched on the address alone, a download the user started at the same address within the wait took the name and the folder the
   * extension chose, skipped "Save as", and its id went to the extension.
   */
  take(ses: S, source: object | null | undefined, urls: readonly string[], id: string): RequestedDownload<S> | undefined {
    if (source != null) return undefined
    const at = this.waiting.findIndex((request) => request.ses === ses && isRequestedDownload(request.url, urls))
    if (at < 0) return undefined
    const [request] = this.waiting.splice(at, 1)
    request!.resolve(id)
    return request
  }
}
