// The installation of an update (app-update.ts) on a stand-in of Electron's autoUpdater: a real EventEmitter, so that an `error` with no
// listener throws here as it does in the main process. Nothing opens a window: the boxes are a mock of `dialog`.
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateOffer } from '@shared/update-check'

const electron = vi.hoisted(() => ({ showMessageBox: vi.fn(), openExternal: vi.fn(), focused: null as unknown }))
vi.mock('electron', () => ({
  autoUpdater: {},
  BrowserWindow: { getFocusedWindow: () => electron.focused },
  dialog: { showMessageBox: electron.showMessageBox },
  shell: { openExternal: electron.openExternal }
}))

const { UpdateInstaller, offerInstall, offerWithdrawn, showUpdateNotice } = await import('./app-update')

const FEED = 'https://test.lucium.app/updates/darwin-arm64/feed.json'
const STABLE_FEED = 'https://lucium.app/updates/darwin-arm64/feed.json'

class FakeUpdater extends EventEmitter {
  calls: string[] = []
  feeds: unknown[] = []
  throwOnFeed: Error | null = null
  setFeedURL(options: unknown): void {
    // The order matters: an `error` emitted from here on must find its listener.
    this.calls.push(`setFeedURL listeners:${this.listenerCount('error')}`)
    if (this.throwOnFeed) throw this.throwOnFeed
    this.feeds.push(options)
  }
  checkForUpdates(): void {
    this.calls.push('checkForUpdates')
  }
  quitAndInstall(): void {
    this.calls.push('quitAndInstall')
    // Electron emits it before closing the windows (electron_api_auto_updater.cc, QuitAndInstall), and again once they are closed.
    this.emit('before-quit-for-update')
  }
}

function setup(feed: string | null | (() => string | null) = FEED, globalPrivacyControl?: () => boolean) {
  const updater = new FakeUpdater()
  const reported: string[] = []
  const prepareQuit = vi.fn()
  const reach = vi.fn(() => updater)
  const installer = new UpdateInstaller({ feed: typeof feed === 'function' ? feed : () => feed, updater: reach, prepareQuit, report: (reason) => reported.push(reason), log: () => {}, ...(globalPrivacyControl ? { globalPrivacyControl } : {}) })
  return { updater, installer, reported, prepareQuit, reach }
}

const squirrelError = (code: number, domain: string, message: string) => Object.assign(new Error(message), { code, domain })

describe('UpdateInstaller', () => {
  it('touches nothing of the autoUpdater before the first download, and nothing at all without a built-in feed', async () => {
    const off = setup(null)
    expect(off.installer.canInstall()).toBe(false)
    expect(await off.installer.download()).toMatchObject({ kind: 'failed' })
    expect(off.reach).not.toHaveBeenCalled()
    const on = setup()
    expect(on.installer.canInstall()).toBe(true)
    expect(on.reach).not.toHaveBeenCalled()
    expect(on.updater.listenerCount('error')).toBe(0)
  })

  it('reads the release file (serverType json) of the built-in feed, with the error listener in place before setFeedURL', async () => {
    const { updater, installer } = setup()
    const pending = installer.download()
    expect(updater.feeds).toEqual([{ url: FEED, serverType: 'json' }])
    expect(updater.calls).toEqual(['setFeedURL listeners:1', 'checkForUpdates'])
    updater.emit('update-downloaded', {}, 'notes', 'Lucium 0.2.1', new Date(), 'https://…')
    expect(await pending).toEqual({ kind: 'downloaded' })
    expect(installer.isReady()).toBe(true)
  })

  it('downloads once at a time: a second demand gets the same answer, never a second checkForUpdates (which would download twice)', async () => {
    const { updater, installer } = setup()
    const first = installer.download()
    const second = installer.download()
    expect(second).toBe(first)
    expect(installer.isDownloading()).toBe(true)
    updater.emit('update-not-available')
    expect(await first).toEqual({ kind: 'not-available' })
    expect(installer.isDownloading()).toBe(false)
    // A later demand asks again, without giving the feed a second time.
    void installer.download()
    expect(updater.calls).toEqual(['setFeedURL listeners:1', 'checkForUpdates', 'checkForUpdates'])
    expect(updater.listenerCount('error')).toBe(1)
  })

  // Squirrel reads the feed with its own network code: no hook of a session puts the header of Global Privacy Control on it.
  it('gives Squirrel the header of Global Privacy Control with the feed while the option is on, and gives the feed again when the option changes', async () => {
    let signal = true
    const { updater, installer } = setup(FEED, () => signal)
    const first = installer.download()
    expect(updater.feeds).toEqual([{ url: FEED, serverType: 'json', headers: { 'Sec-GPC': '1' } }])
    updater.emit('update-not-available')
    await first
    // Asked again with the option unchanged: the feed Squirrel has is the right one.
    const second = installer.download()
    expect(updater.feeds).toHaveLength(1)
    updater.emit('update-not-available')
    await second
    signal = false
    void installer.download()
    expect(updater.feeds[1]).toEqual({ url: FEED, serverType: 'json' })
  })

  it('turns an error of Squirrel into the reason the user reads, and the process does not fall', async () => {
    const { updater, installer } = setup()
    const pending = installer.download()
    expect(() => updater.emit('error', squirrelError(-1, 'SQRLCodeSignatureErrorDomain', 'Code signature at URL did not pass validation'))).not.toThrow()
    const outcome = await pending
    expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/^La signature de la mise à jour a été refusée/) })
    expect(installer.isReady()).toBe(false)
  })

  it('keeps listening for errors no download waits for (the relaunch), and tells the user', () => {
    const { updater, installer, reported } = setup()
    void installer.download()
    updater.emit('update-downloaded')
    expect(() => updater.emit('error', squirrelError(3, 'SQRLUpdaterErrorDomain', 'Could not prepare the update job'))).not.toThrow()
    expect(reported).toEqual([expect.stringMatching(/^La mise à jour n’a pas pu se faire\./)])
  })

  it('reports a feed Squirrel refuses to take (an application it cannot read the signature of) as a failure, not a throw', async () => {
    const { updater, installer } = setup()
    updater.throwOnFeed = new Error('Could not get code signature for running application')
    expect(await installer.download()).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/signature/) })
    expect(updater.calls).toEqual(['setFeedURL listeners:1'])
    // The next demand gives the feed again: it was never taken.
    updater.throwOnFeed = null
    void installer.download()
    expect(updater.feeds).toEqual([{ url: FEED, serverType: 'json' }])
  })

  it('gives Squirrel the address again when the channel changed since the last download, and only then', async () => {
    // The user moved to the test channel between two looks: what Squirrel downloads is what the check just offered, not the address of the first look.
    let channel = STABLE_FEED
    const { updater, installer } = setup(() => channel)
    void installer.download()
    updater.emit('update-not-available')
    await Promise.resolve()
    void installer.download()
    updater.emit('update-not-available')
    await Promise.resolve()
    expect(updater.feeds).toEqual([{ url: STABLE_FEED, serverType: 'json' }])
    channel = FEED
    void installer.download()
    expect(updater.feeds).toEqual([{ url: STABLE_FEED, serverType: 'json' }, { url: FEED, serverType: 'json' }])
    expect(updater.calls.filter((call) => call.startsWith('checkForUpdates'))).toHaveLength(3)
  })

  it('asks the channel each time whether it can install: a feed that went away (a build that carries none) installs nothing', async () => {
    let feed: string | null = FEED
    const { installer, reach } = setup(() => feed)
    expect(installer.canInstall()).toBe(true)
    feed = null
    expect(installer.canInstall()).toBe(false)
    expect(await installer.download()).toMatchObject({ kind: 'failed' })
    expect(reach).not.toHaveBeenCalled()
  })

  it('restarts only once an update was downloaded, and lifts the questions of the quit on before-quit-for-update', () => {
    const { updater, installer, prepareQuit } = setup()
    expect(installer.restart()).toBe(false)
    void installer.download()
    updater.emit('update-downloaded')
    expect(installer.restart()).toBe(true)
    expect(updater.calls.at(-1)).toBe('quitAndInstall')
    expect(prepareQuit).toHaveBeenCalledOnce()
    // The quit that follows is the install's: the check of the feed before quitting leaves it alone.
    expect(installer.isInstalling()).toBe(true)
  })
})

describe('UpdateInstaller: what must be done before Squirrel replaces the application', () => {
  /** An installer whose update was downloaded and waits, with what must be done before installing it. */
  async function ready(beforeInstall: () => Promise<void>) {
    const updater = new FakeUpdater()
    const logs: string[] = []
    const reported: string[] = []
    const installer = new UpdateInstaller({ feed: () => FEED, updater: () => updater, prepareQuit: vi.fn(), report: (reason) => void reported.push(reason), log: (line) => void logs.push(line), beforeInstall })
    const download = installer.download('1.0.2')
    updater.emit('update-downloaded')
    await download
    return { updater, installer, logs, reported }
  }

  it('is done, and waited for, before « Installer et relancer » quits and installs', async () => {
    let done: () => void = () => undefined
    const beforeInstall = vi.fn(() => new Promise<void>((resolve) => (done = resolve)))
    const { updater, installer } = await ready(beforeInstall)
    expect(installer.restart()).toBe(true)
    expect(installer.isInstalling()).toBe(true)
    await vi.waitFor(() => expect(beforeInstall).toHaveBeenCalledOnce())
    expect(updater.calls).not.toContain('quitAndInstall')
    done()
    await vi.waitFor(() => expect(updater.calls.at(-1)).toBe('quitAndInstall'))
  })

  it('never stops the installation: a failure is written to the log, and Squirrel installs all the same', async () => {
    const { updater, installer, logs } = await ready(() => Promise.reject(new Error('the bundle cannot be written')))
    await expect(installer.prepareInstall()).resolves.toBeUndefined()
    expect(logs).toEqual(['[update] the application could not be prepared for the installation, which goes on: the bundle cannot be written'])
    installer.restart()
    await vi.waitFor(() => expect(updater.calls.at(-1)).toBe('quitAndInstall'))
  })

  it('tells the user when the installation cannot start after it, and the quit that follows is not the install’s', async () => {
    const { updater, installer, logs, reported } = await ready(async () => undefined)
    updater.quitAndInstall = () => {
      throw new Error('No update available, can’t quit and install')
    }
    installer.restart()
    await vi.waitFor(() => expect(reported).toHaveLength(1))
    expect(reported[0]).toContain('No update available')
    expect(logs).toEqual([expect.stringContaining('[update] the installation could not start: No update available')])
    expect(installer.isInstalling()).toBe(false)
  })
})

describe('UpdateInstaller.dropWithdrawn: a downloaded update the feed then withdrew', () => {
  /** An installer whose update of 0.2.2 was downloaded and waits, with a way to take back what Squirrel staged (or none). */
  async function ready(discard?: () => Promise<void>) {
    const updater = new FakeUpdater()
    const logs: string[] = []
    const installer = new UpdateInstaller({ feed: () => FEED, updater: () => updater, prepareQuit: vi.fn(), report: () => {}, log: (line) => void logs.push(line), ...(discard ? { discard } : {}) })
    const download = installer.download('0.2.2')
    updater.emit('update-downloaded')
    await download
    return { updater, installer, logs }
  }

  it('takes back what Squirrel staged, offers it no more, and never installs it', async () => {
    const discard = vi.fn(async () => {})
    const { updater, installer, logs } = await ready(discard)
    expect(await installer.dropWithdrawn(['0.2.0', '0.2.2'])).toEqual({ kind: 'dropped', version: '0.2.2' })
    expect(discard).toHaveBeenCalledOnce()
    expect(installer.isReady()).toBe(false)
    expect(installer.readyVersion()).toBe('')
    expect(installer.restart()).toBe(false)
    expect(updater.calls).not.toContain('quitAndInstall')
    expect(logs).toEqual([expect.stringContaining('0.2.2 was withdrawn from the feed: the downloaded update was dropped')])
  })

  it('keeps an update the feed does not list, and has nothing to drop before a download', async () => {
    const discard = vi.fn(async () => {})
    const { installer } = await ready(discard)
    expect(await installer.dropWithdrawn(['0.2.1'])).toEqual({ kind: 'kept' })
    expect(installer.isReady()).toBe(true)
    expect(await setup().installer.dropWithdrawn(['0.2.2'])).toEqual({ kind: 'kept' })
    expect(discard).not.toHaveBeenCalled()
  })

  it('says, in its answer and in the log, that what Squirrel staged could not be removed, and offers the update no more all the same', async () => {
    const { installer, logs } = await ready(() => Promise.reject(new Error('cannot remove /x/update.Kp4sLeM: busy')))
    expect(await installer.dropWithdrawn(['0.2.2'])).toEqual({ kind: 'failed', version: '0.2.2' })
    expect(installer.isReady()).toBe(false)
    expect(logs).toEqual([expect.stringContaining('could not be removed: cannot remove /x/update.Kp4sLeM: busy')])
    // A run with no way to take it back says the same.
    const without = await ready()
    expect(await without.installer.dropWithdrawn(['0.2.2'])).toEqual({ kind: 'failed', version: '0.2.2' })
    expect(without.logs).toEqual([expect.stringContaining('this run has no way to take back what Squirrel staged')])
  })
})

describe('offerInstall: what the user sees', () => {
  const offer: UpdateOffer = { version: '0.2.1', url: 'https://test.lucium.app/telecharger/', notes: 'Essai du parcours de mise à jour.', archive: 'https://test.lucium.app/updates/darwin-arm64/Lucium-0.2.1-arm64.zip', size: 128172732 }
  const win = { isDestroyed: () => false }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    electron.showMessageBox.mockReset()
    electron.openExternal.mockReset()
  })

  it('offers « Télécharger et installer », says the download in the sidebar, then offers « Installer et relancer »', async () => {
    const { updater, installer } = setup()
    const showToast = vi.fn()
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 0 })
    await offerInstall({ win: win as never, browser: { showToast } }, offer, '0.2.0', installer)
    const [, first] = electron.showMessageBox.mock.calls[0]! as [unknown, { message: string; detail: string; buttons: string[] }]
    expect(first.message).toBe('La version 0.2.1 est disponible')
    expect(first.buttons).toEqual(['Télécharger et installer', 'Plus tard'])
    expect(first.detail).toMatch(/Vous utilisez Lucium 0\.2\.0\./)
    expect(first.detail).toMatch(/Essai du parcours de mise à jour\./)
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/^Téléchargement de Lucium 0\.2\.1 \(122,2 Mo\)…/), undefined, expect.any(Number))
    updater.emit('update-downloaded')
    await flush()
    const [, second] = electron.showMessageBox.mock.calls[1]! as [unknown, { message: string; buttons: string[] }]
    expect(second.message).toBe('Lucium 0.2.1 est prêt')
    expect(second.buttons).toEqual(['Installer et relancer', 'À la prochaine fermeture'])
    expect(updater.calls.at(-1)).toBe('quitAndInstall')
  })

  it('downloads nothing on « Plus tard », and leaves the update for the next quit on « À la prochaine fermeture »', async () => {
    const { updater, installer } = setup()
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await offerInstall({ win: win as never }, offer, '0.2.0', installer)
    expect(updater.calls).toEqual([])
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await offerInstall({ win: win as never }, offer, '0.2.0', installer)
    updater.emit('update-downloaded')
    await flush()
    expect(updater.calls).not.toContain('quitAndInstall')
    // Asked again in the same run: the update is ready, the question is the restart.
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await offerInstall({ win: win as never }, offer, '0.2.0', installer)
    expect((electron.showMessageBox.mock.calls.at(-1)![1] as { message: string }).message).toBe('Lucium 0.2.1 est prêt')
  })

  it('says why a download failed, and offers the download page', async () => {
    const { updater, installer } = setup()
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 0 })
    await offerInstall({ win: win as never }, offer, '0.2.0', installer)
    updater.emit('error', squirrelError(-1003, 'NSURLErrorDomain', 'A server with the specified hostname could not be found.'))
    await flush()
    const [, failure] = electron.showMessageBox.mock.calls[1]! as [unknown, { message: string; detail: string; buttons: string[] }]
    expect(failure.message).toBe('La mise à jour n’a pas pu être téléchargée')
    expect(failure.detail).toMatch(/^Le serveur des mises à jour est injoignable/)
    expect(failure.buttons).toEqual(['Télécharger manuellement', 'Fermer'])
    expect(electron.openExternal).toHaveBeenCalledWith('https://test.lucium.app/telecharger/')
  })

  it('hangs the last box from the focused window when the one that asked was closed meanwhile', async () => {
    const { updater, installer } = setup()
    const closed = { isDestroyed: () => false }
    const focused = { isDestroyed: () => false }
    electron.focused = focused
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await offerInstall({ win: closed as never }, offer, '0.2.0', installer)
    closed.isDestroyed = () => true
    updater.emit('update-downloaded')
    await flush()
    expect(electron.showMessageBox.mock.calls[1]![0]).toBe(focused)
  })
})

describe('offerWithdrawn: the running version was withdrawn', () => {
  const lower: UpdateOffer = { version: '0.3.1', url: 'https://test.lucium.app/telecharger/', notes: '', archive: 'https://test.lucium.app/updates/darwin-arm64/Lucium-0.3.1-arm64.zip', size: 128172732 }
  const higher: UpdateOffer = { ...lower, version: '0.3.3', archive: 'https://test.lucium.app/updates/darwin-arm64/Lucium-0.3.3-arm64.zip' }
  const win = { isDestroyed: () => false }
  type Box = { type: string; message: string; detail: string; buttons: string[] }
  const shown = (at = 0): Box => (electron.showMessageBox.mock.calls[at]! as [unknown, Box])[1]

  beforeEach(() => {
    electron.showMessageBox.mockReset()
    electron.openExternal.mockReset().mockResolvedValue(undefined)
  })

  it('says so and names the version to install; an earlier version only opens the download page, even in a run that installs updates', async () => {
    const { updater, installer } = setup()
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await offerWithdrawn({ win: win as never }, { offer: lower, current: '0.3.2', newer: false }, installer)
    expect(shown()).toMatchObject({ type: 'warning', message: 'Cette version a été retirée', detail: 'Lucium 0.3.2 a été retiré. La version à installer est Lucium 0.3.1.', buttons: ['Télécharger manuellement', 'Plus tard'] })
    // Squirrel would refuse the older bundle: nothing of the installer is touched.
    expect(updater.calls).toEqual([])
    expect(electron.openExternal).toHaveBeenCalledWith('https://test.lucium.app/telecharger/')
  })

  it('offers « Télécharger et installer » for a version above the withdrawn one, in a run that installs updates', async () => {
    const { updater, installer } = setup()
    const showToast = vi.fn()
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await offerWithdrawn({ win: win as never, browser: { showToast } }, { offer: higher, current: '0.3.2', newer: true }, installer)
    expect(shown()).toMatchObject({ message: 'Cette version a été retirée', detail: 'Lucium 0.3.2 a été retiré. La version à installer est Lucium 0.3.3.', buttons: ['Télécharger et installer', 'Plus tard'] })
    expect(updater.calls).toEqual(['setFeedURL listeners:1', 'checkForUpdates'])
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('opens the download page for a version above it when this run installs nothing, or the feed names no archive', async () => {
    for (const [offer, available] of [[higher, null], [higher, setup(null).installer], [{ ...higher, archive: undefined }, setup().installer]] as Array<[UpdateOffer, InstanceType<typeof UpdateInstaller> | null]>) {
      electron.showMessageBox.mockReset().mockResolvedValueOnce({ response: 0 })
      electron.openExternal.mockClear()
      await offerWithdrawn({ win: win as never }, { offer, current: '0.3.2', newer: true }, available)
      expect(shown().buttons).toEqual(['Télécharger manuellement', 'Plus tard'])
      expect(electron.openExternal).toHaveBeenCalledWith('https://test.lucium.app/telecharger/')
    }
  })

  it('does nothing on « Plus tard »', async () => {
    const { updater, installer } = setup()
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await offerWithdrawn({ win: win as never }, { offer: higher, current: '0.3.2', newer: true }, installer)
    expect(updater.calls).toEqual([])
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('says that a download is under way, or offers the restart, instead of starting a second download', async () => {
    const { updater, installer } = setup()
    void installer.download('0.3.3')
    electron.showMessageBox.mockResolvedValue({ response: 1 })
    await offerWithdrawn({ win: win as never }, { offer: higher, current: '0.3.2', newer: true }, installer)
    expect(shown().message).toBe('Le téléchargement de Lucium 0.3.3 est déjà en cours')
    updater.emit('update-downloaded')
    await offerWithdrawn({ win: win as never }, { offer: higher, current: '0.3.2', newer: true }, installer)
    expect(shown(1).message).toBe('Lucium 0.3.3 est prêt')
    expect(updater.calls.filter((call) => call === 'checkForUpdates')).toHaveLength(1)
  })

  it('speaks English to an interface in English', async () => {
    const { setLanguage } = await import('@shared/i18n')
    setLanguage('en')
    try {
      electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
      await offerWithdrawn({ win: win as never }, { offer: lower, current: '0.3.2', newer: false }, null)
      expect(shown()).toMatchObject({ message: 'This version has been withdrawn', detail: 'Lucium 0.3.2 has been withdrawn. The version to install is Lucium 0.3.1.', buttons: ['Download Manually', 'Later'] })
    } finally {
      setLanguage('fr')
    }
  })
})

describe('showUpdateNotice: the notice of the background look', () => {
  const offer: UpdateOffer = { version: '0.2.2', url: 'https://test.lucium.app/telecharger/', notes: '', archive: 'https://test.lucium.app/updates/darwin-arm64/Lucium-0.2.2-arm64.zip', size: 128172732 }
  const win = { isDestroyed: () => false }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  type Shown = [string, { label: string; run: () => void; second: { label: string; run: () => void } }, number]

  beforeEach(() => {
    electron.showMessageBox.mockReset()
    electron.openExternal.mockReset().mockResolvedValue(undefined)
  })

  function show(kind: 'install' | 'restart' | 'page', installer: InstanceType<typeof UpdateInstaller> | null, version = offer.version, withdrawn = false) {
    const showToast = vi.fn()
    const accepted = vi.fn()
    showUpdateNotice({ win: win as never, browser: { showToast } }, { kind, version, offer, current: '0.2.1', accepted, ...(withdrawn ? { withdrawn } : {}) }, installer)
    return { showToast, accepted, shown: () => showToast.mock.calls[0] as Shown }
  }

  it('is a notice of the sidebar, never a box: « Installer » then the download, then « Installer et relancer »', async () => {
    const { updater, installer } = setup()
    const n = show('install', installer)
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    const [message, action] = n.shown()
    expect(message).toBe('Lucium 0.2.2 est disponible (122,2 Mo).')
    expect([action.label, action.second.label]).toEqual(['Installer', 'Plus tard'])
    action.run()
    expect(n.accepted).toHaveBeenCalledOnce()
    expect(updater.calls).toEqual(['setFeedURL listeners:1', 'checkForUpdates'])
    expect(n.showToast).toHaveBeenLastCalledWith(expect.stringMatching(/^Téléchargement de Lucium 0\.2\.2 \(122,2\sMo\)…/), undefined, expect.any(Number))
    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    updater.emit('update-downloaded')
    await flush()
    const [, ready] = electron.showMessageBox.mock.calls[0]! as [unknown, { message: string; buttons: string[] }]
    expect(ready.message).toBe('Lucium 0.2.2 est prêt')
    expect(ready.buttons).toEqual(['Installer et relancer', 'À la prochaine fermeture'])
    expect(updater.calls.at(-1)).toBe('quitAndInstall')
  })

  it('« Plus tard » only closes it: nothing is downloaded, nothing is counted as accepted', () => {
    const { updater, installer } = setup()
    const n = show('install', installer)
    n.shown()[1].second.run()
    expect(updater.calls).toEqual([])
    expect(n.accepted).not.toHaveBeenCalled()
  })

  it('for an update already downloaded, offers « Installer et relancer », which relaunches at once', async () => {
    const { updater, installer } = setup()
    void installer.download('0.2.2')
    updater.emit('update-downloaded')
    expect(installer.readyVersion()).toBe('0.2.2')
    const n = show('restart', installer)
    const [message, action] = n.shown()
    expect(message).toBe('Lucium 0.2.2 est prêt à être installé.')
    expect(action.label).toBe('Installer et relancer')
    action.run()
    expect(updater.calls.at(-1)).toBe('quitAndInstall')
    expect(electron.showMessageBox).not.toHaveBeenCalled()
  })

  it('says that the running version was withdrawn, in the same notice with the same buttons', () => {
    const page = show('page', null, offer.version, true)
    expect(page.shown()[0]).toBe('Cette version a été retirée. Installez Lucium 0.2.2.')
    expect([page.shown()[1].label, page.shown()[1].second.label]).toEqual(['Page de téléchargement', 'Plus tard'])
    page.shown()[1].run()
    expect(electron.openExternal).toHaveBeenCalledWith('https://test.lucium.app/telecharger/')
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    const { updater, installer } = setup()
    const install = show('install', installer, offer.version, true)
    expect(install.shown()[0]).toBe('Cette version a été retirée. Installez Lucium 0.2.2.')
    install.shown()[1].run()
    expect(updater.calls).toEqual(['setFeedURL listeners:1', 'checkForUpdates'])
  })

  it('opens the download page when the run installs nothing', () => {
    const n = show('page', null)
    const [, action] = n.shown()
    expect(action.label).toBe('Page de téléchargement')
    action.run()
    expect(electron.openExternal).toHaveBeenCalledWith('https://test.lucium.app/telecharger/')
  })
})
