// The update feed is read by Electron's net.fetch (the proxy and the DNS of the session), in the background (Réglages › Général) and from
// the menu (Lucium › Rechercher les mises à jour…). net.fetch sends the cookies and the HTTP credentials of the application's session
// unless told not to: neither way of reading the feed carries them. The address built into the application is read by the menu, and in the
// background by the built application only, which says what it found in a notice of the sidebar, never in a box.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { UPDATE_NOTICE_MS } from '@shared/auto-update'
import { formatSize } from '@shared/translate-local'
import { t } from '@shared/i18n'
import type { UpdateSources } from './update-source'

const electron = vi.hoisted(() => ({ fetch: vi.fn(), showMessageBox: vi.fn(), openExternal: vi.fn() }))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', getPath: () => '/nonexistent', isPackaged: false, on: vi.fn(), off: vi.fn() },
  net: { fetch: electron.fetch },
  dialog: { showMessageBox: electron.showMessageBox },
  shell: { openExternal: electron.openExternal },
  contentTracing: {},
  autoUpdater: {},
  BrowserWindow: { getFocusedWindow: () => null }
}))
// The keys of this file are a throw-away pair: the application under test is built with its public half, and the feeds below are signed with the
// private one. `stranger` is a pair the application does not know.
const keys = await vi.hoisted(async () => {
  const { newFeedKeyPair } = await import('../update-feed-signature')
  return { ours: newFeedKeyPair(), stranger: newFeedKeyPair() }
})
vi.mock('../update-feed-keys', () => ({ UPDATE_FEED_PUBLIC_KEYS: [keys.ours.publicKey] }))
// The facts of the run (built or not, the built-in address) are update-source.test.ts's: here the sources are given as they would come out,
// and whether the run is the built application.
const run = vi.hoisted(() => ({ sources: null as UpdateSources | null, built: false }))
vi.mock('./update-source', async (original) => {
  const actual = await original<typeof import('./update-source')>()
  return { ...actual, currentUpdateSources: (settings: { updateFeedUrl: string; updateChannel: Settings['updateChannel'] }) => run.sources ?? actual.currentUpdateSources(settings) }
})
vi.mock('../runtime', async (original) => ({ ...(await original<typeof import('../runtime')>()), isBuiltApp: () => run.built }))

const { currentUpdateSources } = await import('./update-source')
const { createAutoUpdater, withdrawnInFeed } = await import('./auto-update')
const { checkForUpdates } = await import('./menu-actions')
const { UpdateInstaller, setUpdateInstaller } = await import('./app-update')

const FEED = 'https://feed.example/releases/latest'
const BUILT_IN = 'https://test.lucium.app/updates/darwin-arm64/feed.json'
const settings: Settings = { ...defaultSettings(), autoUpdate: true, updateFeedUrl: FEED }
const release = { tag_name: 'v0.1.0', html_url: 'https://feed.example/releases/v0.1.0', body: '' }
const ZIP = 'https://test.lucium.app/updates/darwin-arm64/Lucium-0.1.1-arm64.zip'
const squirrelFile = { currentRelease: '0.1.1', page: 'https://test.lucium.app/telecharger/', releases: [{ version: '0.1.1', updateTo: { version: '0.1.1', url: ZIP, notes: 'Essai.', size: 1000 } }] }
const { signFeedText } = await import('../update-feed-signature')
const bodyOf = (text: string) => async (): Promise<ArrayBuffer> => new TextEncoder().encode(text).buffer as ArrayBuffer
const written = (json: unknown): string => `${JSON.stringify(json, null, 2)}\n`
/** The feed as the publication leaves it on the server: signed with the key the application carries. */
const signedBody = (json: unknown, privatePem = keys.ours.privatePem) => bodyOf(signFeedText(written(json), [privatePem]))
const answering = (json: unknown, url = FEED) => async () => ({ ok: true, status: 200, url, arrayBuffer: signedBody(json) })

// The built application that installs is the macOS one (update-source.ts, `updateSources`): these tests play it on any machine. What another
// system reads and installs is update-source.test.ts's, on facts.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
  vi.stubEnv('MAIN_VITE_UPDATE_FEED', undefined)
  run.sources = null
  run.built = false
  setUpdateInstaller(null)
  electron.fetch.mockReset().mockImplementation(answering(release))
  electron.showMessageBox.mockReset().mockResolvedValue({ response: 1 })
  electron.openExternal.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  vi.unstubAllEnvs()
  setUpdateInstaller(null)
})

const sentInit = (expected = FEED): RequestInit => {
  expect(electron.fetch).toHaveBeenCalledOnce()
  const [url, init] = electron.fetch.mock.calls[0]! as [string, RequestInit]
  expect(url).toBe(expected)
  return init
}
const shown = (at = 0) => electron.showMessageBox.mock.calls[at]![1] as { message: string; detail: string; buttons?: string[] }
const target = (showToast = vi.fn()) => ({ win: { isDestroyed: () => false }, browser: { showToast } }) as unknown as Parameters<typeof checkForUpdates>[0]

/** The background look as main() makes it: the settings of a profile, a memory written back into them, and the window in front (or none). */
function background(over: Partial<Settings> = {}, front: 'normal' | 'none' = 'normal') {
  let current: Settings = { ...settings, ...over }
  const showToast = vi.fn()
  const updater = createAutoUpdater({
    settings: () => current,
    update: (patch) => {
      current = { ...current, ...patch }
    },
    noticeWindow: () => (front === 'normal' ? ({ win: { isDestroyed: () => false }, browser: { showToast } } as never) : null)
  })
  return { updater, showToast, settings: () => current }
}

/** A stand-in of Electron's autoUpdater, for the download « Installer » starts. */
class FakeSquirrel extends EventEmitter {
  calls: string[] = []
  /** What the autoUpdater was given as its feed. */
  feeds: unknown[] = []
  setFeedURL(options?: unknown): void {
    this.calls.push('setFeedURL')
    this.feeds.push(options)
  }
  checkForUpdates(): void {
    this.calls.push('checkForUpdates')
  }
  quitAndInstall(): void {
    this.calls.push('quitAndInstall')
  }
}

describe('the requests for the update feed', () => {
  it('in the background carry no cookie or credential of the session', async () => {
    expect(await background().updater.check()).toEqual({ kind: 'up-to-date', current: '0.1.0' })
    expect(sentInit().credentials).toBe('omit')
  })

  it('from the menu carry none either', async () => {
    await checkForUpdates({ win: {} } as Parameters<typeof checkForUpdates>[0], settings)
    expect(sentInit().credentials).toBe('omit')
    expect(electron.showMessageBox).toHaveBeenCalledOnce()
  })
})

describe('the background look at the built-in address', () => {
  it('in the built application, reads the built-in address with no cookie, and offers « Installer » in a notice of the sidebar, not in a box', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN)
    run.built = true
    const squirrel = new FakeSquirrel()
    setUpdateInstaller(new UpdateInstaller({ feed: () => BUILT_IN, updater: () => squirrel, prepareQuit: vi.fn(), report: vi.fn() }))
    electron.fetch.mockImplementation(answering(squirrelFile, BUILT_IN))
    const t = background({ updateFeedUrl: '' })
    expect((await t.updater.check())?.kind).toBe('available')
    expect(sentInit(BUILT_IN).credentials).toBe('omit')
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    expect(t.showToast).toHaveBeenCalledOnce()
    const [message, action, duration] = t.showToast.mock.calls[0]! as [string, { label: string; run: () => void; second: { label: string } }, number]
    expect(message).toBe(`Lucium 0.1.1 est disponible (${formatSize(1000)}).`)
    expect([action.label, action.second.label]).toEqual(['Installer', 'Plus tard'])
    expect(duration).toBe(UPDATE_NOTICE_MS)
    expect(t.settings().updateNotices).toEqual({ version: '0.1.1', shown: 1 })
    // « Installer » goes the way of the menu: the download, said in the sidebar; the showing is not counted as passed over.
    action.run()
    expect(squirrel.calls).toEqual(['setFeedURL', 'checkForUpdates'])
    expect(t.showToast).toHaveBeenLastCalledWith(expect.stringMatching(/^Téléchargement de Lucium 0\.1\.1/), undefined, expect.any(Number))
    expect(t.settings().updateNotices).toEqual({ version: '0.1.1', shown: 0 })
  })

  it('from the sources, is never read in the background: without a feed given by hand, it asks nobody', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN)
    run.built = false
    expect(await background({ updateFeedUrl: '' }).updater.check()).toBeNull()
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it('asks nothing with « Rechercher les mises à jour automatiquement » off, even in the built application', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN)
    run.built = true
    const t = background({ autoUpdate: false, updateFeedUrl: '' })
    expect(await t.updater.check()).toBeNull()
    expect(electron.fetch).not.toHaveBeenCalled()
    expect(t.showToast).not.toHaveBeenCalled()
  })

  it('shows nothing when the look fails (no box, no notice), and tries again at the next look', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN)
    run.built = true
    electron.fetch.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED')).mockImplementation(answering(squirrelFile, BUILT_IN))
    const t = background({ updateFeedUrl: '' })
    expect((await t.updater.check())?.kind).toBe('failed')
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    expect(t.showToast).not.toHaveBeenCalled()
    expect(t.settings().updateNotices).toEqual({ version: '', shown: 0 })
    expect((await t.updater.check())?.kind).toBe('available')
    expect(t.showToast).toHaveBeenCalledOnce()
  })

  it('opens the download page from the notice when this run cannot install', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN)
    run.built = true
    electron.fetch.mockImplementation(answering(squirrelFile, BUILT_IN))
    const t = background({ updateFeedUrl: '' })
    await t.updater.check()
    const [, action] = t.showToast.mock.calls[0]! as [string, { label: string; run: () => void }]
    expect(action.label).toBe('Page de téléchargement')
    action.run()
    expect(electron.openExternal).toHaveBeenCalledWith('https://test.lucium.app/telecharger/')
  })

  it('waits when no normal window is in front (a private window alone): nothing shown, nothing counted', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN)
    run.built = true
    electron.fetch.mockImplementation(answering(squirrelFile, BUILT_IN))
    const t = background({ updateFeedUrl: '' }, 'none')
    expect((await t.updater.check())?.kind).toBe('available')
    expect(t.showToast).not.toHaveBeenCalled()
    expect(t.settings().updateNotices).toEqual({ version: '', shown: 0 })
  })
})

describe('the built-in address, from the menu', () => {

  it('is read by the menu, which says « Recherche… », then offers « Télécharger et installer » for the archive the feed names', async () => {
    run.sources = { check: BUILT_IN, install: BUILT_IN }
    setUpdateInstaller(new UpdateInstaller({ feed: () => BUILT_IN, updater: vi.fn(), prepareQuit: vi.fn(), report: vi.fn() }))
    electron.fetch.mockImplementation(answering(squirrelFile, BUILT_IN))
    const showToast = vi.fn()
    await checkForUpdates(target(showToast), settings)
    expect(sentInit(BUILT_IN).credentials).toBe('omit')
    expect(showToast).toHaveBeenCalledWith('Recherche des mises à jour…')
    expect(shown().message).toBe('La version 0.1.1 est disponible')
    expect(shown().buttons).toEqual(['Télécharger et installer', 'Plus tard'])
  })

  it('says nothing in the sidebar for the About window, whose button says « Recherche… » itself', async () => {
    run.sources = { check: BUILT_IN, install: BUILT_IN }
    const showToast = vi.fn()
    await checkForUpdates(target(showToast), settings, { searching: false })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('installs nothing in a run that cannot: the same file only opens its page', async () => {
    run.sources = { check: BUILT_IN, install: null }
    setUpdateInstaller(new UpdateInstaller({ feed: () => null, updater: vi.fn(), prepareQuit: vi.fn(), report: vi.fn() }))
    electron.fetch.mockImplementation(answering(squirrelFile, BUILT_IN))
    electron.showMessageBox.mockResolvedValue({ response: 0 })
    await checkForUpdates(target(), settings)
    expect(shown().buttons).toEqual(['Télécharger manuellement', 'Plus tard'])
    expect(electron.openExternal).toHaveBeenCalledWith('https://test.lucium.app/telecharger/')
  })

  it('never offers to install what another feed than the built-in one names, even with an installer at hand', async () => {
    run.sources = { check: FEED, install: null }
    setUpdateInstaller(new UpdateInstaller({ feed: () => BUILT_IN, updater: vi.fn(), prepareQuit: vi.fn(), report: vi.fn() }))
    electron.fetch.mockImplementation(answering(squirrelFile))
    await checkForUpdates(target(), settings)
    expect(shown().buttons).toEqual(['Télécharger manuellement', 'Plus tard'])
  })

  it('says Lucium is up to date when the feed is not newer', async () => {
    run.sources = { check: BUILT_IN, install: BUILT_IN }
    electron.fetch.mockImplementation(answering({ ...squirrelFile, currentRelease: '0.1.0', releases: [{ version: '0.1.0', updateTo: { url: ZIP } }] }, BUILT_IN))
    await checkForUpdates(target(), settings)
    expect(shown().message).toBe('Lucium est à jour')
  })
})

describe('the two update channels, from the menu and in the background', () => {
  const STABLE = 'https://lucium.app/updates/darwin-arm64/feed.json'
  const ZIP_STABLE = 'https://lucium.app/updates/darwin-arm64/Lucium-0.1.1-arm64.zip'
  const stableFile = { ...squirrelFile, page: 'https://lucium.app/telecharger/', releases: [{ version: '0.1.1', updateTo: { version: '0.1.1', url: ZIP_STABLE, notes: 'Stable.', size: 1000 } }] }
  /** A build of the two feeds, in the built application. */
  const twoFeeds = (): void => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', STABLE)
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', BUILT_IN)
    run.built = true
  }
  /** What each address answers: the feed of the channel asked for, nothing for the other. */
  const serving = (files: Record<string, unknown>) => async (url: string) => (url in files ? { ok: true, status: 200, url, arrayBuffer: signedBody(files[url]) } : { ok: false, status: 404, url, arrayBuffer: bodyOf('{}') })
  const olderFile = { currentRelease: '0.0.9', releases: [{ version: '0.0.9', updateTo: { version: '0.0.9', url: ZIP } }] }
  const urlsAsked = (): string[] => electron.fetch.mock.calls.map(([url]) => url as string)

  it('the menu reads the stable feed by default, and the test feed once updateChannel is test', async () => {
    twoFeeds()
    electron.fetch.mockImplementation(serving({ [STABLE]: stableFile, [BUILT_IN]: squirrelFile }))
    await checkForUpdates(target(), settings)
    expect(urlsAsked()).toEqual([STABLE])
    await checkForUpdates(target(), { ...settings, updateChannel: 'test' })
    expect(urlsAsked()).toEqual([STABLE, BUILT_IN])
  })

  it('the background look reads the same feed as the menu, and none other than the one of the channel', async () => {
    twoFeeds()
    electron.fetch.mockImplementation(serving({ [STABLE]: stableFile, [BUILT_IN]: squirrelFile }))
    await background({ updateFeedUrl: '' }).updater.check()
    expect(urlsAsked()).toEqual([STABLE])
    await background({ updateFeedUrl: '', updateChannel: 'test' }).updater.check()
    expect(urlsAsked()).toEqual([STABLE, BUILT_IN])
  })

  it('a build with one feed reads it whatever the setting says: exactly what it always did', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', STABLE)
    run.built = true
    electron.fetch.mockImplementation(serving({ [STABLE]: stableFile }))
    await background({ updateFeedUrl: '', updateChannel: 'test' }).updater.check()
    await checkForUpdates(target(), { ...settings, updateChannel: 'test' })
    expect(urlsAsked()).toEqual([STABLE, STABLE])
  })

  it('« Installer » gives Squirrel the feed of the channel the setting follows at that moment', async () => {
    twoFeeds()
    const squirrel = new FakeSquirrel()
    let channel: Settings['updateChannel'] = 'stable'
    setUpdateInstaller(new UpdateInstaller({ feed: () => currentUpdateSources({ ...settings, updateChannel: channel }).install, updater: () => squirrel, prepareQuit: vi.fn(), report: vi.fn() }))
    electron.fetch.mockImplementation(serving({ [STABLE]: stableFile, [BUILT_IN]: squirrelFile }))
    channel = 'test'
    const t = background({ updateFeedUrl: '', updateChannel: 'test' })
    await t.updater.check()
    const [, action] = t.showToast.mock.calls[0]! as [string, { run: () => void }]
    action.run()
    expect(squirrel.feeds).toEqual([{ url: BUILT_IN, serverType: 'json' }])
  })

  it('moving to a channel whose newest version is older than the running one offers and installs nothing: Lucium is up to date', async () => {
    twoFeeds()
    const squirrel = new FakeSquirrel()
    setUpdateInstaller(new UpdateInstaller({ feed: () => BUILT_IN, updater: () => squirrel, prepareQuit: vi.fn(), report: vi.fn() }))
    electron.fetch.mockImplementation(serving({ [STABLE]: stableFile, [BUILT_IN]: olderFile }))
    // The menu says so, and offers no button.
    await checkForUpdates(target(), { ...settings, updateChannel: 'test' })
    expect(shown().message).toBe('Lucium est à jour')
    expect(shown().buttons).toBeUndefined()
    // The background look finds nothing to say, and nothing is downloaded.
    const t = background({ updateFeedUrl: '', updateChannel: 'test' })
    expect(await t.updater.check()).toEqual({ kind: 'up-to-date', current: '0.1.0' })
    expect(t.showToast).not.toHaveBeenCalled()
    expect(squirrel.calls).toEqual([])
  })

  it('a stable feed that answers 404 before its first publication: the background look stays quiet, the menu says the look failed, and nothing is offered', async () => {
    twoFeeds()
    electron.fetch.mockImplementation(serving({ [BUILT_IN]: squirrelFile }))
    const t = background({ updateFeedUrl: '' })
    expect((await t.updater.check())?.kind).toBe('failed')
    expect(t.showToast).not.toHaveBeenCalled()
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    await checkForUpdates(target(), settings)
    expect(shown().message).toBe('La vérification des mises à jour a échoué')
    expect(shown().detail).toBe('Réponse 404')
  })
})

describe('the failures of the look, in plain words', () => {
  it('a server that cannot be reached', async () => {
    electron.fetch.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'))
    await checkForUpdates(target(), settings)
    expect(shown().message).toBe('La vérification des mises à jour a échoué')
    expect(shown().detail).toMatch(/^Le serveur des mises à jour est injoignable.*net::ERR_NAME_NOT_RESOLVED$/s)
  })

  it('an answer that is not a release file', async () => {
    electron.fetch.mockImplementation(async () => ({ ok: true, status: 200, url: FEED, arrayBuffer: async () => Promise.reject(new SyntaxError('Unexpected token <')) }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await checkForUpdates(target(), settings)
    expect(shown().detail).toMatch(/^Le flux de mises à jour n’est pas valide/)
    expect(warn).toHaveBeenCalledWith('[update] the feed is not JSON:', expect.any(SyntaxError))
    electron.fetch.mockImplementation(answering({ nothing: true }))
    await checkForUpdates(target(), settings)
    expect(shown(1).detail).toBe('Le flux de mises à jour n’est pas lisible')
  })
})

// Whoever can write on the server of the feed, or answer in its place, is not believed: only a feed signed by a key of the application is.
describe('a feed without a valid signature', () => {
  const withdrawing = { ...squirrelFile, withdrawn: ['0.1.0'] }
  const SOBER = /^Le flux de mises à jour n’a pas de signature valide\s: aucune mise à jour n’est proposée\.$/
  const unsigned = (json: unknown, url = BUILT_IN) => async () => ({ ok: true, status: 200, url, arrayBuffer: bodyOf(written(json)) })
  const byStranger = (json: unknown, url = BUILT_IN) => async () => ({ ok: true, status: 200, url, arrayBuffer: signedBody(json, keys.stranger.privatePem) })
  let logged: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN)
    run.built = true
    setUpdateInstaller(new UpdateInstaller({ feed: () => BUILT_IN, updater: () => new FakeSquirrel(), prepareQuit: vi.fn(), report: vi.fn() }))
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => logged.mockRestore())

  it('signed, the same feed is offered from the menu and in the background (the feeds below differ by their signature only)', async () => {
    electron.fetch.mockImplementation(answering(withdrawing, BUILT_IN))
    await checkForUpdates(target(), settings)
    expect(shown().message).toBe('Cette version a été retirée')
    const look = background()
    expect(await look.updater.check()).toMatchObject({ kind: 'withdrawn' })
    expect(look.showToast).toHaveBeenCalledOnce()
    expect(logged).not.toHaveBeenCalled()
  })

  it.each([
    ['that carries no signature', unsigned, 'it carries no signature'],
    ['signed by a key the application does not carry', byStranger, 'none of its 1 signature(s) is by a key of this build']
  ])('%s: the menu offers nothing, says no version is withdrawn, and says one sober sentence', async (_name, serve, why) => {
    electron.fetch.mockImplementation(serve(withdrawing))
    await checkForUpdates(target(), settings)
    expect(electron.showMessageBox).toHaveBeenCalledOnce()
    expect(shown().message).toBe('La vérification des mises à jour a échoué')
    expect(shown().detail).toMatch(SOBER)
    expect(shown().buttons).toBeUndefined()
    expect(electron.openExternal).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith(`[update] the update feed ${BUILT_IN} is refused: ${why}. No update is offered and no version is said withdrawn`)
  })

  it.each([
    ['that carries no signature', unsigned],
    ['signed by a key the application does not carry', byStranger]
  ])('%s: the background look shows no notice, and writes the refusal to the log', async (_name, serve) => {
    electron.fetch.mockImplementation(serve(withdrawing))
    const look = background()
    expect(await look.updater.check()).toEqual({ kind: 'failed', reason: expect.stringMatching(SOBER) })
    expect(look.updater.offer()).toBe(false)
    expect(look.showToast).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^\[update\] the update feed https:\/\/test\.lucium\.app\/updates\/darwin-arm64\/feed\.json is refused: /))
  })

  it('on the test channel is refused as on the stable one', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', 'https://lucium.app/updates/darwin-arm64/feed.json')
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', BUILT_IN)
    electron.fetch.mockImplementation(unsigned(squirrelFile))
    await checkForUpdates(target(), { ...settings, updateChannel: 'test' })
    expect(electron.fetch.mock.calls.map(([url]) => url)).toEqual([BUILT_IN])
    expect(shown().detail).toMatch(SOBER)
    expect(await background({ updateChannel: 'test' }).updater.check()).toMatchObject({ kind: 'failed' })
  })

  it('at an address given by hand is refused too, whatever its shape', async () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', undefined)
    run.built = false
    electron.fetch.mockImplementation(async () => ({ ok: true, status: 200, url: FEED, arrayBuffer: bodyOf(JSON.stringify({ tag_name: 'v9.0.0', html_url: 'https://feed.example/releases/v9.0.0' })) }))
    await checkForUpdates(target(), settings)
    expect(shown().detail).toMatch(SOBER)
    expect(shown().buttons).toBeUndefined()
  })

  it('a signed feed changed on the way is refused: its signature no longer holds', async () => {
    const text = signFeedText(written(squirrelFile), [keys.ours.privatePem]).replace('Lucium-0.1.1-arm64.zip', 'Lucium-0.1.1-arm64.zip?other')
    electron.fetch.mockImplementation(async () => ({ ok: true, status: 200, url: BUILT_IN, arrayBuffer: bodyOf(text) }))
    await checkForUpdates(target(), settings)
    expect(shown().detail).toMatch(SOBER)
  })
})

describe('an update downloaded in this run, then withdrawn from the signed feed', () => {
  const ZIP_2 = ZIP.replace('0.1.1', '0.1.2')
  /** The feed once 0.1.1 was withdrawn and 0.1.2 published in its place. */
  const withdrawnFile = { currentRelease: '0.1.2', withdrawn: ['0.1.1'], releases: [{ version: '0.1.2', updateTo: { version: '0.1.2', url: ZIP_2, notes: '' } }] }

  /** A built application whose download of 0.1.1 ended: Squirrel staged it for the quit. */
  async function downloaded() {
    // The built application with one channel: the menu and the background look read the feed Squirrel installs from.
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN)
    run.built = true
    const squirrel = new FakeSquirrel()
    const discard = vi.fn(async () => {})
    const installer = new UpdateInstaller({ feed: () => BUILT_IN, updater: () => squirrel, prepareQuit: vi.fn(), report: vi.fn(), discard, log: () => {} })
    setUpdateInstaller(installer)
    const download = installer.download('0.1.1')
    squirrel.emit('update-downloaded')
    await download
    electron.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, url, arrayBuffer: signedBody(withdrawnFile) }))
    return { squirrel, discard, installer }
  }

  it('is dropped by the menu check, which says so in the sidebar, then offers the version that replaces it', async () => {
    const { squirrel, discard, installer } = await downloaded()
    const showToast = vi.fn()
    await checkForUpdates(target(showToast), settings, { searching: false })
    expect(discard).toHaveBeenCalledOnce()
    expect(installer.isReady()).toBe(false)
    expect(showToast).toHaveBeenCalledWith(t('auto-update.la-version-version-a-ete-retiree-elle-n-est-pas-installee', { version: '0.1.1' }), undefined, UPDATE_NOTICE_MS)
    expect(shown().message).toBe(t('app-update.la-version-version-est-disponible', { version: '0.1.2' }))
    expect(squirrel.calls).not.toContain('quitAndInstall')
  })

  it('is dropped by the background look, whose notice says so and offers to install the version that replaces it', async () => {
    const { discard } = await downloaded()
    const look = background({ updateFeedUrl: '' })
    await look.updater.check()
    expect(discard).toHaveBeenCalledOnce()
    const [message, action] = look.showToast.mock.calls[0]! as [string, { label: string }]
    expect(message).toBe(t('auto-update.la-version-dropped-a-ete-retiree-elle-n-est-pas-installee-installez-version', { dropped: '0.1.1', version: '0.1.2' }))
    expect(action.label).toBe(t('auto-update.installer'))
  })

  it('is read again before the quit, with the signature checked as at every read', async () => {
    electron.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, url, arrayBuffer: signedBody(withdrawnFile) }))
    expect(await withdrawnInFeed(BUILT_IN)).toEqual(['0.1.1'])
    // A feed no key of the application signed withdraws nothing, and the log says why.
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    electron.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, url, arrayBuffer: signedBody(withdrawnFile, keys.stranger.privatePem) }))
    expect(await withdrawnInFeed(BUILT_IN)).toBeNull()
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(`[update] the feed ${BUILT_IN} could not be read: `))
    logged.mockRestore()
    expect(await withdrawnInFeed(null)).toBeNull()
  })
})
