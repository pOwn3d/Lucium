// Test support (nothing of the application imports it): a page for `PageErrors` (error-pages.ts) without Electron. The web contents is an
// event emitter whose answers the test sets, the host records what it is asked, and the cover laid over the page is a fake the test file
// puts in the place of `PageCover` (`vi.mock('./page-cover', …)`).

import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { DOCUMENT_FACTS_SCRIPT, ERROR_SCHEME } from '@shared/error-pages'
import type { UpgradeFailure } from './https-upgrade'

/** The nonce of the buttons of an error page, read from its markup (each page draws its own). */
export function nonceIn(markup: string): string {
  const found = /lucium-error:[a-z-]+\?n=([0-9a-f-]+)/.exec(markup)
  if (!found) throw new Error('no button with a nonce in this markup')
  return found[1]!
}

const navigation = (): { preventDefault: () => void; prevented: boolean } => {
  const event = {
    prevented: false,
    preventDefault: () => {
      event.prevented = true
    }
  }
  return event
}

export class FakeCover {
  static made: FakeCover[] = []
  readonly webContents = new EventEmitter()
  readonly loaded: string[] = []
  disposed = false
  constructor() {
    FakeCover.made.push(this)
  }
  load(html: string): Promise<void> {
    this.loaded.push(html)
    return Promise.resolve()
  }
  place(): void {}
  raise(): void {}
  dispose(): void {
    this.disposed = true
  }
  /** A click on the button `action` of the page this cover shows (`nonce` to forge another one). */
  click(action: string, nonce = nonceIn(this.loaded.at(-1) ?? '')): void {
    this.webContents.emit('will-navigate', navigation(), `${ERROR_SCHEME}${action}?n=${nonce}`)
  }
}

export class FakeContents extends EventEmitter {
  url = 'https://site.example/a'
  loading = false
  destroyed = false
  canGoBack = false
  /** What the document that answered an error status says about itself (an Error: the script fails). */
  facts: unknown = { textLength: 0, hasContent: false, hasScript: false }
  readonly session = {}
  readonly navigationHistory = { canGoBack: (): boolean => this.canGoBack }
  readonly scripts: string[] = []
  readonly loadURL = vi.fn(async (_url: string) => undefined)
  /** Ends the renderer of the page; `render-process-gone` (killed) follows, the test emits it when it wants it. */
  readonly forcefullyCrashRenderer = vi.fn()
  getURL(): string {
    return this.url
  }
  isLoading(): boolean {
    return this.loading
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  /** Runs nothing: records the script, writes an error page (true), and answers the look at the document with `facts`. */
  readonly executeJavaScript = (script: string): Promise<unknown> => {
    this.scripts.push(script)
    if (script !== DOCUMENT_FACTS_SCRIPT) return Promise.resolve(true)
    return this.facts instanceof Error ? Promise.reject(this.facts) : Promise.resolve(this.facts)
  }
  /** How many times the document on screen was asked whether it shows anything. */
  looks(): number {
    return this.scripts.filter((script) => script === DOCUMENT_FACTS_SCRIPT).length
  }
  /** Chromium commits a main document of `url`, answered with the HTTP `status`. */
  commit(url: string, status: number): void {
    this.url = url
    this.emit('did-navigate', {}, url, status)
  }
  /** A main-frame load of `url` fails, and Chromium commits its error document: our page is written into it. */
  fail(url: string, code = -105, description = 'ERR_NAME_NOT_RESOLVED'): void {
    this.emit('did-fail-load', {}, code, description, url, true)
    this.emit('dom-ready')
  }
  /** A click on the button `action` of the error page written into the document (the last one). */
  click(action: string): void {
    const written = this.scripts.filter((script) => script !== DOCUMENT_FACTS_SCRIPT).at(-1) ?? ''
    this.emit('will-navigate', navigation(), `${ERROR_SCHEME}${action}?n=${nonceIn(written)}`)
  }
}

export function fakeHost() {
  return {
    win: {},
    radius: 8,
    reload: vi.fn(),
    goBack: vi.fn(),
    announceUrl: vi.fn(),
    upgradeFailed: vi.fn((_url: string, _code: number, _certificate: boolean): UpgradeFailure => ({ kind: 'none' })),
    continueOverHttp: vi.fn((_http: string) => undefined),
    toggleBlockException: vi.fn(),
    openMini: vi.fn()
  }
}

/** Lets the promises of the page (the look at the document, the load of the cover) settle. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
