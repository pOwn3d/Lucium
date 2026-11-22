// The warning before a file that can run is saved, in the real `will-download` listener of the engine (stand-ins of the session, the download and the
// temporary folder): the file waits in the temporary folder, goes to its place when the user says yes, and is cancelled when they say no; an ordinary
// file, a resumption and a policy without the warning are not stopped.

import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type DownloadListener = (event: { preventDefault(): void }, item: unknown, source: unknown) => void

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ app: { getPath: (name: string) => `/tmp/lucium-test-${name}` }, session: { defaultSession: {} } }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))
vi.mock('./download-quarantine', () => ({ earlyQuarantine: () => () => undefined, quarantineDownload: async () => ({ ok: true }) }))

const { ElectronEngine } = await import('./electron-engine')
const { ReservedPaths } = await import('./download-paths')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

/** The question is asked in a later turn of the loop: a test that says it is not asked looks after that turn. */
const later = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

const folder = join('/tmp', 'lucium-test-downloads')
const waiting = join('/tmp', 'lucium-test-staging', 'dl-1', 'setup.pkg')

afterEach(() => vi.restoreAllMocks())

interface Options {
  filename?: string
  mime?: string
  confirm?: ((request: { filename: string; host: string }) => Promise<boolean>) | null | undefined
  resumed?: boolean
}

function download(options: Options = {}) {
  let listener: DownloadListener | undefined
  const ses = { on: (name: string, given: DownloadListener) => void (name === 'will-download' && (listener = given)) }
  const staging = { allocate: vi.fn(() => waiting), moveOut: vi.fn(), release: vi.fn(), contains: () => true }
  const filename = options.filename ?? 'setup.pkg'
  const policy = { ask: null, openUnsaved: false, ...(options.confirm === undefined ? {} : { confirmExecutable: options.confirm }) }
  const engine = Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    pages: new Map(),
    popups: { ownerKeyOf: () => undefined },
    pendingDownloads: { take: () => undefined },
    unsaved: { take: () => false },
    reservedPaths: new ReservedPaths(),
    downloads: new Map(),
    downloadListeners: [],
    downloadNamer: null,
    downloadPolicy: policy,
    downloadCounter: 0,
    staging,
    resume: options.resumed
      ? { takeExpected: () => ({ id: 'dl-old', path: join(folder, filename), startTime: 1 }), track: () => null }
      : null
  })
  methods['installDownloads']!.call(engine, ses, 'profile-1')
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  const item = {
    getURL: () => 'https://files.example/get?token=secret',
    getURLChain: () => ['https://files.example/get?token=secret'],
    getMimeType: () => options.mime ?? 'application/octet-stream',
    getFilename: () => filename,
    setSavePath: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
    getState: () => 'progressing',
    getReceivedBytes: () => 0,
    getTotalBytes: () => 10,
    isPaused: () => false,
    canResume: () => false,
    on: (name: string, handler: (...args: unknown[]) => void) => void (handlers[name] = handler),
    once: (name: string, handler: (...args: unknown[]) => void) => void (handlers[name] = handler)
  }
  listener!({ preventDefault: () => undefined }, item, null)
  const finish = async () => {
    handlers['done']!({}, 'completed')
    // The end of the download is handled after the answer; the stand-in of the temporary folder is told last (`release`).
    await vi.waitFor(() => expect(staging.release).toHaveBeenCalled())
  }
  return { item, staging, finish }
}

describe('a file that can run, with the warning on', () => {
  it('waits in the temporary folder, tells the user its name and host (never its address), and goes to the downloads folder on a yes', async () => {
    const confirm = vi.fn(async () => true)
    const { item, staging, finish } = download({ confirm })
    expect(item.setSavePath).toHaveBeenCalledWith(waiting)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith({ filename: 'setup.pkg', host: 'files.example' }))
    await finish()
    expect(item.cancel).not.toHaveBeenCalled()
    expect(staging.moveOut).toHaveBeenCalledWith(waiting, join(folder, 'setup.pkg'))
  })

  it('is cancelled on a no, and nothing is moved to the downloads folder', async () => {
    const { item, staging, finish } = download({ confirm: async () => false })
    await vi.waitFor(() => expect(item.cancel).toHaveBeenCalledTimes(1))
    await finish()
    expect(staging.moveOut).not.toHaveBeenCalled()
  })

  it('is cancelled, with a line in the log, when the question itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { item, staging, finish } = download({ confirm: async () => Promise.reject(new Error('no window')) })
    await vi.waitFor(() => expect(item.cancel).toHaveBeenCalledTimes(1))
    await finish()
    expect(staging.moveOut).not.toHaveBeenCalled()
    expect(error.mock.calls.some((call) => String(call[0]).includes('the question before download'))).toBe(true)
  })
})

describe('a download that is not stopped', () => {
  it('is an ordinary file: it goes straight to the downloads folder, with no question', async () => {
    const confirm = vi.fn(async () => true)
    const { item, staging } = download({ confirm, filename: 'photo.png', mime: 'image/png' })
    await later()
    expect(confirm).not.toHaveBeenCalled()
    expect(staging.allocate).not.toHaveBeenCalled()
    expect(item.setSavePath).toHaveBeenCalledWith(join(folder, 'photo.png'))
  })

  it('is a file that can run when the warning is off: no question, the folder at once', async () => {
    for (const confirm of [null, undefined]) {
      const { item, staging } = download({ confirm })
      expect(staging.allocate).not.toHaveBeenCalled()
      expect(item.setSavePath).toHaveBeenCalledWith(join(folder, 'setup.pkg'))
    }
  })

  it('is a resumption after a restart: the record names the file, and no question is asked', async () => {
    const confirm = vi.fn(async () => true)
    const { item, staging } = download({ confirm, resumed: true })
    await later()
    expect(confirm).not.toHaveBeenCalled()
    expect(staging.allocate).not.toHaveBeenCalled()
    expect(item.setSavePath).toHaveBeenCalledWith(join(folder, 'setup.pkg'))
  })
})
