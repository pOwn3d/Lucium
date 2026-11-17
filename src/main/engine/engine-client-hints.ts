// The Client Hints of the engine, read from the engine itself: a page of the interface runs in the same Chromium as the pages, so its
// `navigator.userAgentData` holds the brands, the mobile flag and the system Chromium puts in `Sec-CH-UA…` on the requests of a page. They are
// read once a run, as soon as the page of the main window commits (again when it has its document, should the first read come too early), and
// kept; the header hook of the sessions of pages adds them to the navigations (electron-engine-network.ts, shared/client-hints.ts).
// The tabs a launch restores start loading while the page of the interface is still on its way: from the moment the main window hands its page
// in, a navigation waits for the hints, `HINTS_WAIT_MS` at most from that moment, so that the first page of a launch carries them like the
// others. Nothing is worked out here: when the read does not come in time, or fails, a navigation leaves as Chromium sends it, without them, and
// the log says so once. Electron-free: the window hands in its web contents.

import { clientHintsOf, UA_DATA_SCRIPT, type ClientHintHeaders } from '@shared/client-hints'

/** The longest the navigations of a launch wait for the hints, counted from the moment the main window hands its page in: once a run. */
export const HINTS_WAIT_MS = 2000

/** The part of the web contents of a page of the interface the read needs. */
export interface HintSource {
  executeJavaScript(code: string): Promise<unknown>
  on(event: 'did-navigate', listener: () => void): unknown
  on(event: 'dom-ready', listener: () => void): unknown
  removeListener(event: 'did-navigate', listener: () => void): unknown
  removeListener(event: 'dom-ready', listener: () => void): unknown
  isDestroyed(): boolean
}

/** What a read that failed answered, short enough for a line of the log. */
const shortly = (answer: unknown): string => (JSON.stringify(answer) ?? String(answer)).slice(0, 200)

export class EngineClientHints {
  private known: ClientHintHeaders | null = null
  private told = false
  /** Armed when the main window hands its page in, until the hints are read or `HINTS_WAIT_MS` has passed; the navigations wait meanwhile. */
  private deadline: ReturnType<typeof setTimeout> | null = null
  private armed = false
  private waiting: Array<(hints: ClientHintHeaders | null) => void> = []

  constructor(private readonly warn: (message: string) => void = (message) => console.warn(message)) {}

  /**
   * The hints for a navigation: those read, a promise while the read is awaited (it settles with them, or with null once `HINTS_WAIT_MS` has
   * passed), or null when nothing is awaited any more, which the log says once.
   */
  forNavigation(): ClientHintHeaders | null | Promise<ClientHintHeaders | null> {
    if (this.known !== null) return this.known
    if (this.deadline !== null) return new Promise((resolve) => this.waiting.push(resolve))
    this.tell('[engine] the Client Hints of the engine are not known (no page of the interface has given them): navigations leave without Sec-CH-UA, as Chromium sends them, until they are')
    return null
  }

  /** Reads them from a page of the interface as soon as it commits, and at each document it has after, until a read gives them; a read that fails is written to the log. */
  learnFrom(ui: HintSource, waitMs: number = HINTS_WAIT_MS): void {
    if (this.known !== null) return
    if (!this.armed) {
      this.armed = true
      this.deadline = setTimeout(() => {
        this.deadline = null
        this.tell(`[engine] the Client Hints of the engine were not read within ${waitMs} ms of the launch: navigations leave without Sec-CH-UA, as Chromium sends them, until they are`)
        this.release(null)
      }, waitMs)
    }
    const read = (): void => {
      if (this.known !== null || ui.isDestroyed()) return
      ui.executeJavaScript(UA_DATA_SCRIPT).then(
        (answer) => {
          if (this.known !== null) return
          const hints = clientHintsOf(answer)
          if (hints === null) return this.warn(`[engine] the interface gave no usable navigator.userAgentData (${shortly(answer)}): navigations leave without Client Hints until it does`)
          this.known = hints
          ui.removeListener('did-navigate', read)
          ui.removeListener('dom-ready', read)
          this.release(hints)
        },
        (error: unknown) => this.warn(`[engine] cannot read navigator.userAgentData in the interface (${error instanceof Error ? error.message : String(error)}): navigations leave without Client Hints until it can`)
      )
    }
    ui.on('did-navigate', read)
    ui.on('dom-ready', read)
  }

  /** The navigations that waited go on, with the hints or without. */
  private release(hints: ClientHintHeaders | null): void {
    if (this.deadline !== null) clearTimeout(this.deadline)
    this.deadline = null
    const waiting = this.waiting
    this.waiting = []
    for (const resume of waiting) resume(hints)
  }

  private tell(message: string): void {
    if (this.told) return
    this.told = true
    this.warn(message)
  }
}

/** The one of the application: the header hook of the sessions of pages reads it, and the main window hands it its page (`ElectronEngine.learnClientHints`). */
export const engineClientHints = new EngineClientHints()
