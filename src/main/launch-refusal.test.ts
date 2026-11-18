// What a refused launch says to a person who cannot read a terminal (launch-refusal.ts, carte 469). The case: the AppImage on Ubuntu 24.04, whose AppRun adds
// `--no-sandbox` when AppArmor restricts user namespaces. Lucium refuses the switch (runtime.ts) and, before this, wrote one line on the standard error and ended:
// the person saw only the system's « the application quit unexpectedly ». The box is drawn by a program of the system, never by Electron (which would start its
// GPU process and its network service without a sandbox: see the head of launch-refusal.ts). The wiring of index.ts is main-wiring.test.ts's; the pieces are
// here, on stand-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLanguage, setLanguage } from '@shared/i18n'
import { frenchSpaces } from '@shared/french-typography'

vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }))
// The programs are not started: the stand-in keeps what was asked of `spawn`, and the test ends each child itself.
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ path: string; args: string[]; options: Record<string, unknown> }>, children: [] as Array<import('node:events').EventEmitter & { unref: () => void }> }))
vi.mock('node:child_process', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    spawn: (path: string, args: string[], options: Record<string, unknown>) => {
      const child = Object.assign(new Emitter(), { unref: vi.fn() })
      spawned.calls.push({ path, args, options })
      spawned.children.push(child)
      return child
    }
  }
})

const { BOX_HELPERS, OPEN_PROGRAM, RESTRICTION_FILE, endRefusedLaunch, hasRefusalBox, helperArguments, helperEnv, localeOfEnv, openInBrowser, readRestrictionFile, refusalBox, runHelper, sandboxCause } = await import('./launch-refusal')
type LaunchEnd = import('./launch-refusal').LaunchEnd
type RefusalBox = import('./launch-refusal').RefusalBox

/** Stand-ins for everything the end of a refused launch touches, and what each was asked. */
function system(over: Partial<LaunchEnd> = {}) {
  const exits: number[] = []
  const boxes: Array<{ helper: string; box: RefusalBox }> = []
  const opened: string[] = []
  const logged: Array<[string, unknown]> = []
  const deps: LaunchEnd = {
    platform: 'linux',
    env: { DISPLAY: ':0', LANG: 'fr_FR.UTF-8' },
    readRestriction: () => '1\n',
    findHelper: () => 'zenity',
    runBox: async (helper, box) => (boxes.push({ helper, box }), 1),
    openPage: async (url) => void opened.push(url),
    exit: (code) => void exits.push(code),
    log: (line, error) => void logged.push([line, error]),
    ...over
  }
  return { deps, exits, boxes, opened, logged }
}
/** The microtasks of the chain `runBox().then().catch().finally()` have run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  setLanguage('fr')
  spawned.calls.length = 0
  spawned.children.length = 0
})
afterEach(() => {
  setLanguage('fr')
  vi.unstubAllEnvs()
})

describe('which refusals have a box', () => {
  it('is the refusal of --no-sandbox on Linux and nothing else: any other switch, and any other system, ends with the line on the standard error alone', () => {
    expect(hasRefusalBox(['no-sandbox'], 'linux')).toBe(true)
    expect(hasRefusalBox(['smoke', 'no-sandbox'], 'linux')).toBe(true)
    expect(hasRefusalBox(['remote-debugging-port'], 'linux')).toBe(false)
    expect(hasRefusalBox(['no-sandbox'], 'darwin')).toBe(false)
    expect(hasRefusalBox(['no-sandbox'], 'win32')).toBe(false)
  })
})

describe('the cause the box names', () => {
  it('is the AppArmor restriction of Ubuntu when the kernel says 1, and any other reason otherwise (no AppArmor, another value, unreadable)', () => {
    expect(sandboxCause('1')).toBe('apparmor')
    expect(sandboxCause('1\n')).toBe('apparmor')
    for (const other of ['0', '0\n', '', 'yes', null]) expect(sandboxCause(other), String(other)).toBe('other')
  })

  it('is read from the file of the kernel; a system without AppArmor has none, which is not worth a line, and a file that cannot be read is told', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const asked: string[] = []
      expect(readRestrictionFile((path) => (asked.push(path), '1\n'))).toBe('1\n')
      expect(asked).toEqual(['/proc/sys/kernel/apparmor_restrict_unprivileged_userns'])
      expect(RESTRICTION_FILE).toBe(asked[0])
      expect(readRestrictionFile(() => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }) })).toBeNull()
      expect(warn).not.toHaveBeenCalled()
      expect(readRestrictionFile(() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) })).toBeNull()
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn.mock.calls[0]![0])).toContain('[launch] the restriction of user namespaces could not be read')
      expect(warn.mock.calls[0]![1]).toBeInstanceOf(Error)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the box', () => {
  it('says in French why the sandbox cannot start under AppArmor, and advises the .deb first, then the sysctl for an administrator', () => {
    const box = refusalBox('apparmor')
    expect(box.title).toBe('Lucium ne peut pas démarrer')
    expect(box.message).toBe('Le bac à sable de sécurité du moteur ne peut pas démarrer sur cet ordinateur.')
    expect(box.detail).toContain('AppArmor')
    expect(box.detail).toContain('une AppImage ne peut pas porter cette règle')
    expect(box.detail).toContain(frenchSpaces('Installez plutôt le paquet .deb de Lucium, qui apporte la règle nécessaire : la page Télécharger explique comment.'))
    expect(box.detail).toContain('kernel.apparmor_restrict_unprivileged_userns=0')
    expect(box.buttons).toEqual(['Ouvrir la page Télécharger', 'Fermer'])
  })

  it('says it in English', () => {
    setLanguage('en')
    const box = refusalBox('apparmor')
    expect(box.title).toBe('Lucium cannot start')
    expect(box.message).toBe('The security sandbox of the engine can’t start on this computer.')
    expect(box.detail).toContain('Install the .deb package of Lucium instead, which carries the rule it needs: the Download page explains how.')
    expect(box.buttons).toEqual(['Open the Download Page', 'Close'])
  })

  it('does not blame AppArmor, nor advise the .deb, for another cause, and says what to allow instead', () => {
    const box = refusalBox('other')
    expect(box.detail).not.toMatch(/AppArmor|\.deb|sysctl/)
    expect(box.detail).toContain('espaces de noms d’utilisateur')
    setLanguage('en')
    expect(refusalBox('other').detail).toContain('Allow unprivileged user namespaces on this computer')
  })

  it('never advises to run without the sandbox, in either language and for either cause', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      for (const cause of ['apparmor', 'other'] as const) expect(Object.values(refusalBox(cause)).join('\n'), `${language} ${cause}`).not.toMatch(/--no-sandbox|désactiver (?:le|son) bac|(?:turn|switch) off (?:the|its) sandbox|disable (?:the|its) sandbox/i)
    }
    // It says the opposite, in both languages, as the line of the launch does (the loop above ended on English).
    expect(refusalBox('other').detail).toContain('Lucium never starts without its sandbox')
    setLanguage('fr')
    expect(refusalBox('apparmor').detail).toContain('Lucium ne démarre jamais sans bac à sable')
  })
})

describe('the program that draws the box', () => {
  const box: RefusalBox = { title: 'Titre', message: 'Message', detail: 'Détail', buttons: ['Ouvrir', 'Fermer'] }

  it('is looked for by absolute path, zenity first, as the AppRun of the AppImage does for its own boxes', () => {
    expect(BOX_HELPERS.map(({ name, path }) => [name, path])).toEqual([
      ['zenity', '/usr/bin/zenity'],
      ['kdialog', '/usr/bin/kdialog']
    ])
    expect(OPEN_PROGRAM).toBe('/usr/bin/xdg-open')
  })

  it('is told the title, the text and the two buttons: the first one answers 0, as zenity and kdialog do for OK and Yes', () => {
    expect(helperArguments('zenity', box)).toEqual(['--question', '--no-markup', '--width=560', '--title=Titre', '--text=Message\n\nDétail', '--ok-label=Ouvrir', '--cancel-label=Fermer'])
    expect(helperArguments('kdialog', box)).toEqual(['--title', 'Titre', '--yes-label', 'Ouvrir', '--no-label', 'Fermer', '--yesno', 'Message\n\nDétail'])
  })

  it('runs without the library path of the AppImage, and with the rest of the environment', () => {
    expect(helperEnv({ LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib', DISPLAY: ':0', PATH: '/usr/bin' })).toEqual({ DISPLAY: ':0', PATH: '/usr/bin' })
  })
})

describe('the programs as they are started', () => {
  const box: RefusalBox = { title: 'Titre', message: 'Message', detail: 'Détail', buttons: ['Ouvrir', 'Fermer'] }

  it('starts the box by its absolute path, with its arguments, with no input and no output, and the environment of the launch minus the library path of the AppImage', async () => {
    vi.stubEnv('LD_LIBRARY_PATH', '/tmp/.mount_x/usr/lib')
    vi.stubEnv('DISPLAY', ':7')
    const done = runHelper('zenity', box)
    expect(spawned.calls).toHaveLength(1)
    const call = spawned.calls[0]!
    expect(call.path).toBe('/usr/bin/zenity')
    expect(call.args).toEqual(helperArguments('zenity', box))
    expect(call.options['stdio']).toBe('ignore')
    expect(call.options['detached']).toBeUndefined()
    const env = call.options['env'] as NodeJS.ProcessEnv
    expect(env['DISPLAY']).toBe(':7')
    expect(env).not.toHaveProperty('LD_LIBRARY_PATH')
    spawned.children[0]!.emit('close', 0)
    await expect(done).resolves.toBe(0)
    const kdialog = runHelper('kdialog', box)
    expect(spawned.calls[1]!.path).toBe('/usr/bin/kdialog')
    spawned.children[1]!.emit('close', 1)
    await expect(kdialog).resolves.toBe(1)
  })

  it('answers with the button the program reports, 1 for a program ended by a signal, and rejects a program that cannot be started', async () => {
    const signalled = runHelper('zenity', box)
    spawned.children[0]!.emit('close', null)
    await expect(signalled).resolves.toBe(1)
    const missing = runHelper('zenity', box)
    spawned.children[1]!.emit('error', new Error('spawn /usr/bin/zenity ENOENT'))
    await expect(missing).rejects.toThrow('ENOENT')
  })

  it('opens the page with xdg-open, by its absolute path, detached and not waited for, and rejects when it cannot be started', async () => {
    vi.stubEnv('LD_LIBRARY_PATH', '/tmp/.mount_x/usr/lib')
    const opened = openInBrowser('https://lucium.app/telecharger/')
    const call = spawned.calls[0]!
    expect(call.path).toBe('/usr/bin/xdg-open')
    expect(call.args).toEqual(['https://lucium.app/telecharger/'])
    expect(call.options['detached']).toBe(true)
    expect(call.options['stdio']).toBe('ignore')
    expect(call.options['env']).not.toHaveProperty('LD_LIBRARY_PATH')
    spawned.children[0]!.emit('spawn')
    await expect(opened).resolves.toBeUndefined()
    expect(spawned.children[0]!.unref).toHaveBeenCalledOnce()
    const missing = openInBrowser('https://lucium.app/telecharger/')
    spawned.children[1]!.emit('error', new Error('spawn /usr/bin/xdg-open ENOENT'))
    await expect(missing).rejects.toThrow('ENOENT')
  })
})

describe('the language of the box, read from the environment (the profile is not read)', () => {
  it('follows the variables the way the programs of the system do: LANGUAGE (its first entry), LC_ALL, LC_MESSAGES, LANG; C and POSIX name none', () => {
    expect(localeOfEnv({ LANGUAGE: 'fr:en', LANG: 'en_US.UTF-8' })).toBe('fr')
    expect(localeOfEnv({ LC_ALL: 'en_GB.UTF-8', LC_MESSAGES: 'fr_FR.UTF-8', LANG: 'fr_FR.UTF-8' })).toBe('en_GB.UTF-8')
    expect(localeOfEnv({ LC_MESSAGES: 'fr_CA.UTF-8', LANG: 'en_US.UTF-8' })).toBe('fr_CA.UTF-8')
    expect(localeOfEnv({ LANG: 'fr_FR.UTF-8' })).toBe('fr_FR.UTF-8')
    expect(localeOfEnv({ LC_ALL: 'C', LANG: 'POSIX' })).toBe('')
    expect(localeOfEnv({})).toBe('')
  })
})

describe('the end of a refused launch', () => {
  it('shows the box on Linux with a screen and a program to draw it, and ends with code 1 only after the person closed it', async () => {
    let close!: (button: number) => void
    const stand = system({ runBox: (helper, box) => (stand.boxes.push({ helper, box }), new Promise<number>((resolve) => (close = resolve))) })
    endRefusedLaunch(['no-sandbox'], stand.deps)
    await settle()
    expect(stand.boxes).toHaveLength(1)
    expect(stand.boxes[0]!.helper).toBe('zenity')
    expect(stand.exits).toEqual([])
    close(1)
    await settle()
    expect(stand.exits).toEqual([1])
    expect(stand.opened).toEqual([])
    expect(stand.logged).toEqual([])
  })

  it('hands the box to the program it found, kdialog when that is the only one', async () => {
    const stand = system({ findHelper: () => 'kdialog' })
    endRefusedLaunch(['no-sandbox'], stand.deps)
    await settle()
    expect(stand.boxes.map(({ helper }) => helper)).toEqual(['kdialog'])
  })

  it('writes the box in the language of the system, the profile being unread: French for a French locale, English for any other', async () => {
    const french = system({ env: { DISPLAY: ':0', LANGUAGE: 'fr_CA:fr:en' } })
    endRefusedLaunch(['no-sandbox'], french.deps)
    await settle()
    expect(french.boxes[0]!.box.title).toBe('Lucium ne peut pas démarrer')
    const english = system({ env: { DISPLAY: ':0', LANG: 'en_US.UTF-8' } })
    endRefusedLaunch(['no-sandbox'], english.deps)
    await settle()
    expect(english.boxes[0]!.box.title).toBe('Lucium cannot start')
    const none = system({ env: { DISPLAY: ':0' } })
    endRefusedLaunch(['no-sandbox'], none.deps)
    await settle()
    expect(none.boxes[0]!.box.title).toBe('Lucium cannot start')
    expect(getLanguage()).toBe('en')
  })

  it('names the cause the kernel gave: AppArmor for 1, another reason for a missing or different value', async () => {
    const restricted = system({ readRestriction: () => '1\n' })
    endRefusedLaunch(['no-sandbox'], restricted.deps)
    const missing = system({ readRestriction: () => null })
    endRefusedLaunch(['no-sandbox'], missing.deps)
    await settle()
    expect(restricted.boxes[0]!.box.detail).toContain('AppArmor')
    expect(missing.boxes[0]!.box.detail).not.toContain('AppArmor')
  })

  it('opens the download page of the site, in the language of the box, from its first button, and nothing from the second', async () => {
    const french = system({ runBox: async () => 0 })
    endRefusedLaunch(['no-sandbox'], french.deps)
    await settle()
    expect(french.opened).toEqual(['https://lucium.app/telecharger/'])
    expect(french.exits).toEqual([1])
    const english = system({ env: { DISPLAY: ':0', LANG: 'en_GB.UTF-8' }, runBox: async () => 0 })
    endRefusedLaunch(['no-sandbox'], english.deps)
    await settle()
    expect(english.opened).toEqual(['https://lucium.app/en/download/'])
    const closed = system({ runBox: async () => 1 })
    endRefusedLaunch(['no-sandbox'], closed.deps)
    await settle()
    expect(closed.opened).toEqual([])
    // A box closed another way (a signal, the window's cross) is not the first button.
    const crossed = system({ runBox: async () => 255 })
    endRefusedLaunch(['no-sandbox'], crossed.deps)
    await settle()
    expect(crossed.opened).toEqual([])
    expect(crossed.exits).toEqual([1])
  })

  it('takes a Wayland screen for a screen', async () => {
    const stand = system({ env: { WAYLAND_DISPLAY: 'wayland-0' } })
    endRefusedLaunch(['no-sandbox'], stand.deps)
    await settle()
    expect(stand.boxes).toHaveLength(1)
  })

  it('ends at once, looking for no program, with no screen, off Linux, or for a refusal that is not the sandbox', () => {
    const findHelper = vi.fn((): 'zenity' => 'zenity')
    const cases: Array<[string, Partial<LaunchEnd>, string[]]> = [
      ['no screen', { env: {} }, ['no-sandbox']],
      ['an empty DISPLAY', { env: { DISPLAY: '' } }, ['no-sandbox']],
      ['macOS', { platform: 'darwin' }, ['no-sandbox']],
      ['Windows', { platform: 'win32' }, ['no-sandbox']],
      ['another switch', {}, ['remote-debugging-port']]
    ]
    for (const [name, over, refused] of cases) {
      const stand = system({ ...over, findHelper })
      endRefusedLaunch(refused, stand.deps)
      expect(stand.exits, name).toEqual([1])
      expect(stand.boxes, name).toEqual([])
    }
    expect(findHelper).not.toHaveBeenCalled()
  })

  it('ends at once, and says that nothing could draw the box, when the system has neither zenity nor kdialog', () => {
    const stand = system({ findHelper: () => null })
    endRefusedLaunch(['no-sandbox'], stand.deps)
    expect(stand.exits).toEqual([1])
    expect(stand.boxes).toEqual([])
    expect(stand.logged).toHaveLength(1)
    expect(stand.logged[0]![0]).toContain('no program of the system (zenity, kdialog)')
  })

  it('ends with code 1, once, and logs why, when the program cannot be started or the page cannot be opened', async () => {
    const broken = system({ runBox: async () => Promise.reject(new Error('spawn /usr/bin/zenity ENOENT')) })
    endRefusedLaunch(['no-sandbox'], broken.deps)
    await settle()
    expect(broken.exits).toEqual([1])
    expect(broken.logged).toHaveLength(1)
    expect(broken.logged[0]![0]).toContain('zenity could not show why the launch was refused')
    expect((broken.logged[0]![1] as Error).message).toBe('spawn /usr/bin/zenity ENOENT')

    const noPage = system({ runBox: async () => 0, openPage: async () => Promise.reject(new Error('no browser')) })
    endRefusedLaunch(['no-sandbox'], noPage.deps)
    await settle()
    expect(noPage.exits).toEqual([1])
    expect((noPage.logged[0]![1] as Error).message).toBe('no browser')
  })
})
