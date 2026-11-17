// A download that starts in a private context or in a container goes where the shell says for the tab it started from: such a context is of no
// profile, so the engine hands the page of the download to the resolver of the context. The real `will-download` listener of the engine runs
// with stand-ins of the session and of the download.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type DownloadListener = (event: { preventDefault(): void }, item: unknown, source: unknown) => void

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ app: { getPath: (name: string) => `/tmp/lucium-test-${name}` }, session: { defaultSession: {} } }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { ReservedPaths } = await import('./download-paths')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

// The folder the stand-in of `app.getPath('downloads')` gives, as the path module of the system writes it back (`\tmp\…` on Windows).
const systemFolder = join('/tmp', 'lucium-test-downloads')
const made: string[] = []
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A download of `rapport.pdf` started by the page `pageKey` of a context whose pages are named `ephemeral:1/<tab>`. */
function downloadIn(resolver: ((context: string, pageId?: string) => string | undefined) | null, pageKey: string | undefined) {
  let listener: DownloadListener | undefined
  const ses = { on: (name: string, given: DownloadListener) => void (name === 'will-download' && (listener = given)) }
  const source = { id: 7 }
  const scope = { key: 'ephemeral:1', prefix: 'ephemeral:1/', namer: null, dirResolver: resolver, downloadPolicy: { ask: null, openUnsaved: false }, downloadListeners: [] }
  const engine = Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    pages: new Map(pageKey === undefined ? [] : [[pageKey, { webContents: source }]]),
    popups: { ownerKeyOf: () => undefined },
    reservedPaths: new ReservedPaths(),
    downloads: new Map(),
    downloadCounter: 0,
    resume: null
  })
  methods['installDownloads']!.call(engine, ses, scope.key, scope)
  const item = {
    getURL: () => 'https://site.example/rapport.pdf',
    getURLChain: () => ['https://site.example/rapport.pdf'],
    getMimeType: () => 'application/pdf',
    getFilename: () => 'rapport.pdf',
    setSavePath: vi.fn(),
    getState: () => 'progressing',
    getReceivedBytes: () => 0,
    getTotalBytes: () => 10,
    isPaused: () => false,
    canResume: () => false,
    on: () => undefined,
    once: () => undefined
  }
  listener!({ preventDefault: () => undefined }, item, pageKey === undefined ? null : source)
  return item.setSavePath.mock.calls[0]?.[0] as string | undefined
}

describe('the folder of a download started in a private context or a container', () => {
  it('is the one the shell gives for the tab the download started from, named without the mark of its context', () => {
    const own = mkdtempSync(join(tmpdir(), 'lucium-scope-downloads-'))
    made.push(own)
    const resolver = vi.fn((_context: string, pageId?: string) => (pageId === 'tab-9' ? own : undefined))
    const path = downloadIn(resolver, 'ephemeral:1/tab-9')
    expect(resolver).toHaveBeenCalledWith('ephemeral:1', 'tab-9')
    expect(path).toBe(join(own, 'rapport.pdf'))
  })

  it('is the folder of the system when no page started the download, when the page is of another context, and when the shell names none', () => {
    const resolver = vi.fn((_context: string, pageId?: string) => (pageId === undefined ? undefined : '/nowhere/that/exists'))
    expect(dirname(downloadIn(resolver, undefined)!)).toBe(systemFolder)
    expect(dirname(downloadIn(resolver, 'tab-of-a-profile')!)).toBe(systemFolder)
    expect(resolver.mock.calls.map((call) => call[1])).toEqual([undefined, undefined])
    expect(dirname(downloadIn(null, 'ephemeral:1/tab-9')!)).toBe(systemFolder)
  })
})
