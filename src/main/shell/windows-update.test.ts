// The installer of Windows (windows-update.ts) on stand-ins of everything it touches: the verified download, the check of the file, the system that runs it, the quit.
// No installer is ever run, no window opens, nothing reaches the network.
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UpdateOffer } from '@shared/update-check'
import type { InstallerDownload } from '../update-installer-file'
import { INSTALLER_ARGUMENTS, WindowsUpdateInstaller, launchInstaller, type WindowsUpdateDeps } from './windows-update'

const FEED = 'https://lucium.app/updates/win32-x64/feed.json'
const FILE = 'C:\\Users\\a\\AppData\\Local\\Temp\\lucium-update\\Lucium-Setup.exe'
const SUM = 'a'.repeat(64)
const offer = (over: Partial<UpdateOffer> = {}): UpdateOffer => ({ version: '1.2.0', url: 'https://lucium.app/telecharger/', notes: '', archive: 'https://lucium.app/updates/win32-x64/Lucium-Setup-1.2.0-x64.exe', size: 1000, sha256: SUM, kind: 'nsis', ...over })

function setup(over: Partial<WindowsUpdateDeps> = {}) {
  const calls: string[] = []
  const reported: string[] = []
  const deps: WindowsUpdateDeps = {
    feed: () => FEED,
    download: vi.fn(async (): Promise<InstallerDownload> => ({ ok: true, file: FILE, sha256: SUM })),
    verify: vi.fn(async () => {
      calls.push('verify')
      return true
    }),
    launch: vi.fn(async () => {
      calls.push('launch')
    }),
    discard: vi.fn(async () => {
      calls.push('discard')
    }),
    discardNow: vi.fn(),
    withdrawn: vi.fn(async () => {
      calls.push('withdrawn')
      return [] as readonly string[] | null
    }),
    prepareQuit: vi.fn(() => void calls.push('prepareQuit')),
    quit: vi.fn(() => void calls.push('quit')),
    report: (reason) => reported.push(reason),
    log: () => {},
    ...over
  }
  return { installer: new WindowsUpdateInstaller(deps), deps, calls, reported }
}

/** Waits for what `restart` does after it returns. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => setLanguage('fr'))

describe('what the installer of Windows is', () => {
  it('installs nothing at a quit: only « Installer et relancer » runs it', () => {
    expect(setup().installer.installsAtQuit).toBe(false)
  })

  it('can install while the feed it installs from is there, and not otherwise', () => {
    expect(setup().installer.canInstall()).toBe(true)
    expect(setup({ feed: () => null }).installer.canInstall()).toBe(false)
  })

  it('has nothing to prepare before the installation', async () => {
    await expect(setup().installer.prepareInstall()).resolves.toBeUndefined()
  })
})

describe('download: only after the click, and only an installer that can be checked', () => {
  it('keeps the file that passed its checks, and waits: nothing is run, nothing quits', async () => {
    const { installer, deps, calls } = setup()
    expect(await installer.download('1.2.0', offer())).toEqual({ kind: 'downloaded' })
    expect(installer.isReady()).toBe(true)
    expect(installer.readyVersion()).toBe('1.2.0')
    expect(installer.isDownloading()).toBe(false)
    expect(installer.isInstalling()).toBe(false)
    expect(deps.download).toHaveBeenCalledWith(offer())
    expect(deps.launch).not.toHaveBeenCalled()
    expect(deps.quit).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('downloads nothing for a run that cannot install', async () => {
    const { installer, deps } = setup({ feed: () => null })
    const outcome = await installer.download('1.2.0', offer())
    expect(outcome.kind).toBe('failed')
    expect(deps.download).not.toHaveBeenCalled()
    expect(installer.isReady()).toBe(false)
  })

  it.each<[string, UpdateOffer | undefined]>([
    ['no offer', undefined],
    ['an offer of macOS (a zip)', offer({ kind: 'zip' })],
    ['an offer with no sum', offer({ sha256: undefined })],
    ['an offer with no size', offer({ size: undefined })],
    ['an offer at an address that is not https', offer({ archive: 'http://lucium.app/Lucium-Setup.exe' })]
  ])('refuses %s before asking the network, with the sentence of the offer', async (_name, bad) => {
    const { installer, deps } = setup()
    expect(await installer.download('1.2.0', bad)).toEqual({ kind: 'failed', reason: t('windows-update.le-flux-ne-decrit-pas-un-installeur') })
    expect(deps.download).not.toHaveBeenCalled()
    expect(installer.isReady()).toBe(false)
  })

  it.each<[Extract<InstallerDownload, { ok: false }>['kind'], string]>([
    ['mismatch', t('windows-update.le-fichier-telecharge-ne-correspond-pas')],
    ['network', t('update-install.le-serveur-des-mises-a-jour-est-injoignable')],
    ['disk', t('windows-update.le-fichier-n-a-pas-pu-etre-enregistre')],
    ['offer', t('windows-update.le-flux-ne-decrit-pas-un-installeur')]
  ])('says a download that failed by %s with its own sentence and the detail, and keeps nothing', async (kind, sentence) => {
    const { installer } = setup({ download: async () => ({ ok: false, kind, detail: 'the words of the cause' }) })
    const outcome = await installer.download('1.2.0', offer())
    expect(outcome).toEqual({ kind: 'failed', reason: `${sentence}\n\n${t('update-install.detail-words', { words: 'the words of the cause' })}` })
    expect(installer.isReady()).toBe(false)
    expect(installer.readyVersion()).toBe('')
  })

  it('says a download that throws is a failure, and lets the next click try again', async () => {
    const download = vi.fn<WindowsUpdateDeps['download']>().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ ok: true, file: FILE, sha256: SUM })
    const { installer } = setup({ download })
    const first = await installer.download('1.2.0', offer())
    expect(first.kind).toBe('failed')
    expect(installer.isDownloading()).toBe(false)
    expect(await installer.download('1.2.0', offer())).toEqual({ kind: 'downloaded' })
  })

  it('gives a second call during a download the same answer, never a second download', async () => {
    let release: (value: InstallerDownload) => void = () => {}
    const download = vi.fn(() => new Promise<InstallerDownload>((resolve) => (release = resolve)))
    const { installer } = setup({ download })
    const first = installer.download('1.2.0', offer())
    expect(installer.isDownloading()).toBe(true)
    const second = installer.download('1.2.0', offer())
    expect(second).toBe(first)
    release({ ok: true, file: FILE, sha256: SUM })
    expect(await first).toEqual({ kind: 'downloaded' })
    expect(download).toHaveBeenCalledOnce()
  })

  it('does not download again an installer that is ready', async () => {
    const { installer, deps } = setup()
    await installer.download('1.2.0', offer())
    expect(await installer.download('1.2.0', offer())).toEqual({ kind: 'downloaded' })
    expect(deps.download).toHaveBeenCalledOnce()
  })
})

describe('restart: « Installer et relancer »', () => {
  it('begins nothing when no installer was downloaded', async () => {
    const { installer, deps } = setup()
    expect(installer.restart()).toBe(false)
    await settled()
    expect(deps.launch).not.toHaveBeenCalled()
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('reads the feed, checks the file, runs the installer, then writes the state and quits: in that order, and once', async () => {
    const { installer, calls } = setup()
    await installer.download('1.2.0', offer())
    expect(installer.restart()).toBe(true)
    expect(installer.isInstalling()).toBe(true)
    // A second click while it goes begins nothing more.
    expect(installer.restart()).toBe(false)
    await settled()
    expect(calls).toEqual(['withdrawn', 'verify', 'launch', 'prepareQuit', 'quit'])
  })

  it('checks the file the download kept, against the offer it was downloaded for', async () => {
    const { installer, deps } = setup()
    const wanted = offer()
    await installer.download('1.2.0', wanted)
    installer.restart()
    await settled()
    expect(deps.verify).toHaveBeenCalledWith(FILE, wanted)
    expect(deps.launch).toHaveBeenCalledWith(FILE)
  })

  it('does not run a file that fails its last check: it is removed, Lucium stays open, and the person is told', async () => {
    const { installer, deps, calls, reported } = setup({
      verify: async () => false
    })
    await installer.download('1.2.0', offer())
    installer.restart()
    await settled()
    expect(deps.launch).not.toHaveBeenCalled()
    expect(deps.prepareQuit).not.toHaveBeenCalled()
    expect(deps.quit).not.toHaveBeenCalled()
    expect(calls).toContain('discard')
    expect(reported).toEqual([t('windows-update.le-fichier-telecharge-ne-correspond-pas')])
    expect(installer.isReady()).toBe(false)
    expect(installer.isInstalling()).toBe(false)
  })

  it('does not run a version the feed now lists as withdrawn: the file is dropped and the person is told', async () => {
    const { installer, deps, reported } = setup({ withdrawn: async () => ['1.1.0', '1.2.0'] })
    await installer.download('1.2.0', offer())
    installer.restart()
    await settled()
    expect(deps.verify).not.toHaveBeenCalled()
    expect(deps.launch).not.toHaveBeenCalled()
    expect(deps.quit).not.toHaveBeenCalled()
    expect(deps.discard).toHaveBeenCalledOnce()
    expect(reported).toEqual([t('auto-update.la-version-version-a-ete-retiree-elle-n-est-pas-installee', { version: '1.2.0' })])
    expect(installer.isReady()).toBe(false)
    expect(installer.isInstalling()).toBe(false)
  })

  it('runs a version when only other versions are withdrawn', async () => {
    const { installer, deps } = setup({ withdrawn: async () => ['1.1.9', '1.2.1', '1.20.0'] })
    await installer.download('1.2.0', offer())
    installer.restart()
    await settled()
    expect(deps.launch).toHaveBeenCalledOnce()
  })

  it('says it when a withdrawn installer could not be removed', async () => {
    const { installer, reported } = setup({
      withdrawn: async () => ['1.2.0'],
      discard: async () => {
        throw new Error('file in use')
      }
    })
    await installer.download('1.2.0', offer())
    installer.restart()
    await settled()
    expect(reported).toEqual([t('auto-update.la-version-version-a-ete-retiree-lucium-n-a-pas-pu-l-ecarter', { version: '1.2.0' })])
    expect(installer.isReady()).toBe(false)
  })

  it('runs the installer when the feed cannot be read, as the quit of macOS does: the person asked, and the file was checked', async () => {
    const log = vi.fn()
    const { installer, deps } = setup({ withdrawn: async () => null, log })
    await installer.download('1.2.0', offer())
    installer.restart()
    await settled()
    expect(deps.launch).toHaveBeenCalledOnce()
    expect(log.mock.calls.some(([line]) => String(line).includes('no valid answer'))).toBe(true)
  })

  it('leaves Lucium open and untouched when the installer cannot be started, says why, and keeps the file for another try', async () => {
    const launch = vi.fn<WindowsUpdateDeps['launch']>().mockRejectedValueOnce(new Error('spawn EACCES')).mockResolvedValue(undefined)
    const { installer, deps, reported } = setup({ launch })
    await installer.download('1.2.0', offer())
    installer.restart()
    await settled()
    expect(deps.prepareQuit).not.toHaveBeenCalled()
    expect(deps.quit).not.toHaveBeenCalled()
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain(t('windows-update.l-installeur-n-a-pas-pu-etre-lance'))
    expect(reported[0]).toContain('spawn EACCES')
    expect(installer.isInstalling()).toBe(false)
    expect(installer.isReady()).toBe(true)
    // The next click tries again.
    expect(installer.restart()).toBe(true)
    await settled()
    expect(deps.quit).toHaveBeenCalledOnce()
  })
})

describe('dropWithdrawn: the installer that waits, when the feed read again withdraws it', () => {
  it('keeps what nobody withdrew, and what is not there', async () => {
    const { installer, deps } = setup()
    expect(await installer.dropWithdrawn(['1.2.0'])).toEqual({ kind: 'kept' })
    await installer.download('1.2.0', offer())
    expect(await installer.dropWithdrawn([])).toEqual({ kind: 'kept' })
    expect(await installer.dropWithdrawn(['1.1.0', '1.3.0'])).toEqual({ kind: 'kept' })
    expect(installer.isReady()).toBe(true)
    expect(deps.discard).not.toHaveBeenCalled()
  })

  it('drops it: the file goes, and this run offers it no more', async () => {
    const { installer, deps } = setup()
    await installer.download('1.2.0', offer())
    expect(await installer.dropWithdrawn(['1.0.0', '1.2.0'])).toEqual({ kind: 'dropped', version: '1.2.0' })
    expect(deps.discard).toHaveBeenCalledOnce()
    expect(installer.isReady()).toBe(false)
    expect(installer.readyVersion()).toBe('')
  })

  it('says it failed when the file could not be removed, and forgets the version all the same', async () => {
    const { installer } = setup({
      discard: async () => {
        throw new Error('locked')
      }
    })
    await installer.download('1.2.0', offer())
    expect(await installer.dropWithdrawn(['1.2.0'])).toEqual({ kind: 'failed', version: '1.2.0' })
    expect(installer.isReady()).toBe(false)
  })
})

describe('leave: the application ends', () => {
  it('removes the installer that was downloaded and not run: nothing is installed at a quit, and the file does not stay', async () => {
    const { installer, deps } = setup()
    await installer.download('1.2.0', offer())
    installer.leave()
    // At once, in the turn of the quit: nothing is left to a promise the process would not wait for.
    expect(deps.discardNow).toHaveBeenCalledOnce()
    expect(deps.discard).not.toHaveBeenCalled()
    expect(installer.isReady()).toBe(false)
  })

  it('leaves the file to the installer that is about to run it', async () => {
    const { installer, deps } = setup()
    await installer.download('1.2.0', offer())
    installer.restart()
    await settled()
    installer.leave()
    expect(deps.discardNow).not.toHaveBeenCalled()
  })

  it('does nothing when nothing was downloaded', async () => {
    const { installer, deps } = setup()
    installer.leave()
    expect(deps.discardNow).not.toHaveBeenCalled()
  })

  it('says it in the log when the file could not be removed', async () => {
    const log = vi.fn()
    const { installer } = setup({
      log,
      discardNow: () => {
        throw new Error('locked')
      }
    })
    await installer.download('1.2.0', offer())
    installer.leave()
    expect(log.mock.calls.some(([line]) => String(line).includes('locked'))).toBe(true)
  })
})

describe('launchInstaller: how the installer is started', () => {
  /** A stand-in of `spawn`: records what it was given and plays the events of a child process. */
  function fakeSpawn(play: (child: EventEmitter & { unref: () => void }) => void) {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const start = vi.fn(() => {
      queueMicrotask(() => play(child))
      return child
    })
    return { start: start as unknown as typeof import('node:child_process').spawn, calls: start.mock.calls as unknown as Array<[string, string[], Record<string, unknown>]>, child }
  }

  it('runs the file itself, silently, asking to wait for Lucium and to start it again, detached and without a window or a shell', async () => {
    const { start, calls, child } = fakeSpawn((c) => c.emit('spawn'))
    await launchInstaller(FILE, start)
    expect(INSTALLER_ARGUMENTS).toEqual(['/S', '--updated', '--force-run'])
    expect(calls).toHaveLength(1)
    const [file, args, options] = calls[0]!
    expect(file).toBe(FILE)
    expect(args).toEqual(['/S', '--updated', '--force-run'])
    expect(options).toEqual({ detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    // It outlives Lucium: the child is let go.
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('does not share the list of arguments with the caller', async () => {
    const { start, calls } = fakeSpawn((c) => c.emit('spawn'))
    await launchInstaller(FILE, start)
    expect(calls[0]![1]).not.toBe(INSTALLER_ARGUMENTS)
  })

  it('rejects when the system could not start it, and lets nothing go', async () => {
    const { start, child } = fakeSpawn((c) => c.emit('error', new Error('spawn EACCES')))
    await expect(launchInstaller(FILE, start)).rejects.toThrow('spawn EACCES')
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('rejects when spawn itself throws', async () => {
    const start = vi.fn(() => {
      throw new Error('invalid argument')
    }) as unknown as typeof import('node:child_process').spawn
    await expect(launchInstaller(FILE, start)).rejects.toThrow('invalid argument')
  })
})
