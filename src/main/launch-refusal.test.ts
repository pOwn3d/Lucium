// What a refused launch says to a person who cannot read a terminal (launch-refusal.ts, carte 469). The case: the AppImage on Ubuntu 24.04, whose AppRun adds
// `--no-sandbox` when AppArmor restricts user namespaces. Lucium refuses the switch (runtime.ts) and, before this, wrote one line on the standard error and ended:
// the person saw only the system's « the application quit unexpectedly ». The wiring of index.ts is main-wiring.test.ts's; the pieces are here, on stand-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLanguage, setLanguage } from '@shared/i18n'
import { frenchSpaces } from '@shared/french-typography'

vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }))

const { READY_TIMEOUT_MS, RESTRICTION_FILE, endRefusedLaunch, hasRefusalBox, readRestrictionFile, refusalBox, sandboxCause } = await import('./launch-refusal')
type LaunchEnd = import('./launch-refusal').LaunchEnd
type RefusalBox = import('./launch-refusal').RefusalBox

/** Stand-ins for everything the end of a refused launch touches, and what each was asked. */
function system(over: Partial<LaunchEnd> = {}) {
  const exits: number[] = []
  const boxes: RefusalBox[] = []
  const opened: string[] = []
  const logged: Array<[string, unknown]> = []
  const deps: LaunchEnd = {
    platform: 'linux',
    env: { DISPLAY: ':0' },
    readRestriction: () => '1\n',
    whenReady: () => Promise.resolve(),
    locale: () => 'fr-FR',
    showBox: async (box) => (boxes.push(box), 1),
    openPage: async (url) => void opened.push(url),
    exit: (code) => void exits.push(code),
    log: (line, error) => void logged.push([line, error]),
    ...over
  }
  return { deps, exits, boxes, opened, logged }
}
/** The microtasks of the chain `whenReady().then().catch().finally()` have run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  vi.useRealTimers()
  setLanguage('fr')
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

describe('the end of a refused launch', () => {
  it('waits for the box on Linux with a screen, shows it once, and ends with code 1 only after the person closed it', async () => {
    let close!: (button: number) => void
    const stand = system({ showBox: (box) => (stand.boxes.push(box), new Promise<number>((resolve) => (close = resolve))) })
    endRefusedLaunch(['no-sandbox'], stand.deps)
    await settle()
    expect(stand.boxes).toHaveLength(1)
    expect(stand.exits).toEqual([])
    close(1)
    await settle()
    expect(stand.exits).toEqual([1])
    expect(stand.opened).toEqual([])
    expect(stand.logged).toEqual([])
  })

  it('writes the box in the language of the system, the profile being unread: French for a French locale, English for any other', async () => {
    const french = system({ locale: () => 'fr-CA' })
    endRefusedLaunch(['no-sandbox'], french.deps)
    await settle()
    expect(french.boxes[0]!.title).toBe('Lucium ne peut pas démarrer')
    const english = system({ locale: () => 'en-US' })
    endRefusedLaunch(['no-sandbox'], english.deps)
    await settle()
    expect(english.boxes[0]!.title).toBe('Lucium cannot start')
    expect(getLanguage()).toBe('en')
  })

  it('names the cause the kernel gave: AppArmor for 1, another reason for a missing or different value', async () => {
    const restricted = system({ readRestriction: () => '1\n' })
    endRefusedLaunch(['no-sandbox'], restricted.deps)
    const missing = system({ readRestriction: () => null })
    endRefusedLaunch(['no-sandbox'], missing.deps)
    await settle()
    expect(restricted.boxes[0]!.detail).toContain('AppArmor')
    expect(missing.boxes[0]!.detail).not.toContain('AppArmor')
  })

  it('opens the download page of the site, in the language of the box, from its first button, and nothing from the second', async () => {
    const french = system({ showBox: async () => 0 })
    endRefusedLaunch(['no-sandbox'], french.deps)
    await settle()
    expect(french.opened).toEqual(['https://lucium.app/telecharger/'])
    expect(french.exits).toEqual([1])
    const english = system({ locale: () => 'en-GB', showBox: async () => 0 })
    endRefusedLaunch(['no-sandbox'], english.deps)
    await settle()
    expect(english.opened).toEqual(['https://lucium.app/en/download/'])
    const closed = system({ showBox: async () => 1 })
    endRefusedLaunch(['no-sandbox'], closed.deps)
    await settle()
    expect(closed.opened).toEqual([])
  })

  it('takes a Wayland screen for a screen', async () => {
    const stand = system({ env: { WAYLAND_DISPLAY: 'wayland-0' } })
    endRefusedLaunch(['no-sandbox'], stand.deps)
    await settle()
    expect(stand.boxes).toHaveLength(1)
  })

  it('ends at once, before Electron is even asked to be ready, with no screen, off Linux, or for a refusal that is not the sandbox', () => {
    const whenReady = vi.fn(() => Promise.resolve())
    const cases: Array<[string, Partial<LaunchEnd>, string[]]> = [
      ['no screen', { env: {} }, ['no-sandbox']],
      ['an empty DISPLAY', { env: { DISPLAY: '' } }, ['no-sandbox']],
      ['macOS', { platform: 'darwin' }, ['no-sandbox']],
      ['Windows', { platform: 'win32' }, ['no-sandbox']],
      ['another switch', {}, ['remote-debugging-port']]
    ]
    for (const [name, over, refused] of cases) {
      const stand = system({ ...over, whenReady })
      endRefusedLaunch(refused, stand.deps)
      expect(stand.exits, name).toEqual([1])
      expect(stand.boxes, name).toEqual([])
    }
    expect(whenReady).not.toHaveBeenCalled()
  })

  it('ends without the box, and says so, when Electron is not ready in time: a launch never stays as a process with no window', async () => {
    vi.useFakeTimers()
    const stand = system({ whenReady: () => new Promise(() => undefined) })
    endRefusedLaunch(['no-sandbox'], stand.deps)
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS - 1)
    expect(stand.exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(stand.exits).toEqual([1])
    expect(stand.logged).toHaveLength(1)
    expect(stand.logged[0]![0]).toContain('Electron was not ready in time')
  })

  it('does not end on the clock while the box is open: the person has as long as they need', async () => {
    vi.useFakeTimers()
    let close!: (button: number) => void
    const stand = system({ showBox: () => new Promise<number>((resolve) => (close = resolve)) })
    endRefusedLaunch(['no-sandbox'], stand.deps)
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS * 4)
    expect(stand.exits).toEqual([])
    close(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(stand.exits).toEqual([1])
  })

  it('ends with code 1, once, and logs why, when the box cannot be shown, when the page cannot be opened, and when Electron is never ready', async () => {
    const broken = system({ showBox: async () => Promise.reject(new Error('no display server')) })
    endRefusedLaunch(['no-sandbox'], broken.deps)
    await settle()
    expect(broken.exits).toEqual([1])
    expect(broken.logged).toHaveLength(1)
    expect(broken.logged[0]![0]).toContain('could not be shown')
    expect((broken.logged[0]![1] as Error).message).toBe('no display server')

    const noPage = system({ showBox: async () => 0, openPage: async () => Promise.reject(new Error('no browser')) })
    endRefusedLaunch(['no-sandbox'], noPage.deps)
    await settle()
    expect(noPage.exits).toEqual([1])
    expect((noPage.logged[0]![1] as Error).message).toBe('no browser')

    const never = system({ whenReady: async () => Promise.reject(new Error('the app failed to start')) })
    endRefusedLaunch(['no-sandbox'], never.deps)
    await settle()
    expect(never.exits).toEqual([1])
    expect((never.logged[0]![1] as Error).message).toBe('the app failed to start')
  })
})
