// What a refused launch says to a person who cannot read a terminal (launch-refusal.ts, carte 469). The case: the AppImage on Ubuntu 24.04, whose AppRun adds
// `--no-sandbox` when AppArmor restricts user namespaces. Lucium refuses the switch (runtime.ts) and, before this, wrote one line on the standard error and ended:
// the person saw only the system's « the application quit unexpectedly ». The box is drawn by a program of the system that outlives the launch, which ends at once
// (a process kept alive carries the launcher's --no-sandbox to the GPU process and the network service Chromium starts by itself: see the head of
// launch-refusal.ts). The wiring of index.ts is main-wiring.test.ts's; the pieces are here, on stand-ins, and the shell command that carries the box is run for real.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLanguage, setLanguage } from '@shared/i18n'
import { frenchSpaces } from '@shared/french-typography'

vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }))
// The programs are not started: the stand-in keeps what was asked of `spawn`, and the test ends each child itself.
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ path: string; args: string[]; options: Record<string, unknown> }>, children: [] as Array<import('node:events').EventEmitter & { unref: () => void }> }))
vi.mock('node:child_process', async (original) => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    ...(await original<typeof import('node:child_process')>()),
    spawn: (path: string, args: string[], options: Record<string, unknown>) => {
      const child = Object.assign(new Emitter(), { unref: vi.fn() })
      spawned.calls.push({ path, args, options })
      spawned.children.push(child)
      return child
    }
  }
})

const { BOX_COMMAND, BOX_HELPERS, OPEN_PROGRAM, RESTRICTION_FILE, endRefusedLaunch, hasRefusalBox, helperArguments, helperEnv, localeOfEnv, readRestrictionFile, refusalBox, sandboxCause, startBox } = await import('./launch-refusal')
type LaunchEnd = import('./launch-refusal').LaunchEnd
type RefusalBox = import('./launch-refusal').RefusalBox

/** Stand-ins for everything the end of a refused launch touches, and what each was asked. */
function system(over: Partial<LaunchEnd> = {}) {
  const exits: number[] = []
  const boxes: Array<{ helper: string; box: RefusalBox; page: string }> = []
  const logged: Array<[string, unknown]> = []
  const deps: LaunchEnd = {
    platform: 'linux',
    env: { DISPLAY: ':0', LANG: 'fr_FR.UTF-8' },
    readRestriction: () => '1\n',
    findHelper: () => 'zenity',
    startBox: async (helper, box, page) => void boxes.push({ helper, box, page }),
    exit: (code) => void exits.push(code),
    log: (line, error) => void logged.push([line, error]),
    ...over
  }
  return { deps, exits, boxes, logged }
}
/** The microtasks of the chain `startBox().catch().finally()` have run. */
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

describe('the box as it is started', () => {
  const box: RefusalBox = { title: 'Titre', message: 'Message', detail: 'Détail', buttons: ['Ouvrir', 'Fermer'] }

  it('is started by /bin/sh, detached with no input or output, not waited for, with the program, the opener and the page as parameters and the arguments of the box after them', async () => {
    vi.stubEnv('LD_LIBRARY_PATH', '/tmp/.mount_x/usr/lib')
    vi.stubEnv('DISPLAY', ':7')
    const started = startBox('zenity', box, 'https://lucium.app/telecharger/')
    expect(spawned.calls).toHaveLength(1)
    const call = spawned.calls[0]!
    expect(call.path).toBe('/bin/sh')
    expect(call.args).toEqual(['-c', BOX_COMMAND, 'lucium-box', '/usr/bin/zenity', '/usr/bin/xdg-open', 'https://lucium.app/telecharger/', ...helperArguments('zenity', box)])
    expect(call.options['stdio']).toBe('ignore')
    expect(call.options['detached']).toBe(true)
    const env = call.options['env'] as NodeJS.ProcessEnv
    expect(env['DISPLAY']).toBe(':7')
    expect(env).not.toHaveProperty('LD_LIBRARY_PATH')
    // It is on its way once the system says so, and the launch lets go of it (it ends at once).
    spawned.children[0]!.emit('spawn')
    await expect(started).resolves.toBeUndefined()
    expect(spawned.children[0]!.unref).toHaveBeenCalledOnce()
    const kdialog = startBox('kdialog', box, 'https://lucium.app/en/download/')
    expect(spawned.calls[1]!.args.slice(3, 6)).toEqual(['/usr/bin/kdialog', '/usr/bin/xdg-open', 'https://lucium.app/en/download/'])
    spawned.children[1]!.emit('spawn')
    await kdialog
  })

  it('rejects when the command cannot be started', async () => {
    const missing = startBox('zenity', box, 'https://lucium.app/telecharger/')
    spawned.children[0]!.emit('error', new Error('spawn /bin/sh ENOENT'))
    await expect(missing).rejects.toThrow('ENOENT')
  })

  // The command itself, run for real with stand-ins for the box and the opener (a shell is not there on every system the unit tests run on).
  describe.skipIf(process.platform === 'win32')('the shell command that carries the box, run', () => {
    const folder = mkdtempSync(join(tmpdir(), 'lucium-box-'))
    afterAll(() => rmSync(folder, { recursive: true, force: true }))
    /** A program that records what it was given, one line per argument, and ends with `code`. */
    const stand = (name: string, code: number): string => {
      const path = join(folder, name)
      writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${path}.args"\nexit ${code}\n`)
      chmodSync(path, 0o755)
      return path
    }
    const run = (program: string, opener: string, page: string, args: string[]): void => void execFileSync('/bin/sh', ['-c', BOX_COMMAND, 'lucium-box', program, opener, page, ...args])
    const recorded = (program: string): string[] | null => {
      try {
        return readFileSync(`${program}.args`, 'utf8').split('\n').slice(0, -1)
      } catch {
        return null
      }
    }
    const awkward = ['--title=Lucium "cannot" start', "--text=It's $(touch /tmp/never-made) `id` ; a*b\n\nnext line", '--ok-label=Open']

    it('hands the box its arguments as they are, whatever they hold, and opens the page when the first button answers 0', () => {
      const box = stand('box-ok', 0)
      const opener = stand('opener-ok', 0)
      // The page too is one argument, whatever it holds (the addresses of the site hold none of this: the command does not rely on it).
      const page = 'https://lucium.app/en/download/?a=1&b=$(touch /tmp/never-made) c;d'
      run(box, opener, page, awkward)
      expect(recorded(box)).toEqual(['--title=Lucium "cannot" start', "--text=It's $(touch /tmp/never-made) `id` ; a*b", '', 'next line', '--ok-label=Open'])
      expect(recorded(opener)).toEqual([page])
    })

    it('opens nothing when the second button answers 1, or the box is closed another way', () => {
      for (const [name, code] of [['box-no', 1], ['box-closed', 255]] as const) {
        const box = stand(name, code)
        const opener = stand(`opener-${name}`, 0)
        run(box, opener, 'https://lucium.app/telecharger/', awkward)
        expect(recorded(box), name).not.toBeNull()
        expect(recorded(opener), name).toBeNull()
      }
    })
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
  it('starts the box on Linux with a screen and a program to draw it, and ends with code 1 at once, not waiting for the person: the box outlives the launch', async () => {
    const stand = system()
    endRefusedLaunch(['no-sandbox'], stand.deps)
    await settle()
    expect(stand.boxes).toHaveLength(1)
    expect(stand.boxes[0]!.helper).toBe('zenity')
    expect(stand.exits).toEqual([1])
    expect(stand.logged).toEqual([])
  })

  it('ends only once the box is started: a launch that ended first would take the command with it before it ran', async () => {
    let started!: () => void
    const stand = system({ startBox: (helper, box, page) => (stand.boxes.push({ helper, box, page }), new Promise<void>((resolve) => (started = resolve))) })
    endRefusedLaunch(['no-sandbox'], stand.deps)
    await settle()
    expect(stand.boxes).toHaveLength(1)
    expect(stand.exits).toEqual([])
    started()
    await settle()
    expect(stand.exits).toEqual([1])
  })

  it('hands the box to the program it found, kdialog when that is the only one', async () => {
    const stand = system({ findHelper: () => 'kdialog' })
    endRefusedLaunch(['no-sandbox'], stand.deps)
    await settle()
    expect(stand.boxes.map(({ helper }) => helper)).toEqual(['kdialog'])
  })

  it('writes the box in the language of the system, and gives its button the page of that language, the profile being unread: French for a French locale, English for any other', async () => {
    const french = system({ env: { DISPLAY: ':0', LANGUAGE: 'fr_CA:fr:en' } })
    endRefusedLaunch(['no-sandbox'], french.deps)
    await settle()
    expect(french.boxes[0]!.box.title).toBe('Lucium ne peut pas démarrer')
    expect(french.boxes[0]!.page).toBe('https://lucium.app/telecharger/')
    const english = system({ env: { DISPLAY: ':0', LANG: 'en_US.UTF-8' } })
    endRefusedLaunch(['no-sandbox'], english.deps)
    await settle()
    expect(english.boxes[0]!.box.title).toBe('Lucium cannot start')
    expect(english.boxes[0]!.page).toBe('https://lucium.app/en/download/')
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

  it('ends with code 1, once, and logs why, when the box cannot be started', async () => {
    const broken = system({ startBox: async () => Promise.reject(new Error('spawn /bin/sh ENOENT')) })
    endRefusedLaunch(['no-sandbox'], broken.deps)
    await settle()
    expect(broken.exits).toEqual([1])
    expect(broken.logged).toHaveLength(1)
    expect(broken.logged[0]![0]).toContain('zenity could not be started to show why the launch was refused')
    expect((broken.logged[0]![1] as Error).message).toBe('spawn /bin/sh ENOENT')
  })
})
