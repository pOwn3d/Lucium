import { beforeEach, describe, expect, it, vi } from 'vitest'

// The choice of Edit › Spelling and Grammar › Check Spelling While Typing, applied to the engine's sessions. Electron is replaced by stand-ins that
// record what the sessions are told, and the platform by one that has (macOS) or has not (elsewhere) a checker of its own.
const world = vi.hoisted(() => ({
  systemChecker: true,
  listeners: [] as Array<(event: unknown, contents: unknown) => void>,
  created: [] as Array<(session: unknown) => void>,
  open: [] as Array<{ session: unknown }>
}))
vi.mock('electron', () => ({
  app: {
    on: (event: string, listener: (...args: never[]) => void) => {
      if (event === 'web-contents-created') world.listeners.push(listener as (event: unknown, contents: unknown) => void)
      if (event === 'session-created') world.created.push(listener as (session: unknown) => void)
    }
  },
  BrowserWindow: {},
  dialog: {},
  shell: {},
  ShareMenu: class {},
  webContents: { getAllWebContents: () => world.open }
}))
vi.mock('../platform', () => ({ currentPlatform: () => ({ facts: { systemSpellChecker: world.systemChecker } }) }))

type Module = typeof import('./page-commands')
const load = async (): Promise<Module> => {
  vi.resetModules()
  return import('./page-commands')
}
/**
 * A session that records what it is told, in order: `enabled:true`, `languages:fr,en`, `languages:` (none). Like Electron's, it starts with the languages of
 * the system, and a call for the languages it does not understand does not exist (the checker is not asked about languages on macOS).
 */
const fakeSession = (system: string[] = ['fr']) => {
  const log: string[] = []
  let languages = system
  const session = {
    setSpellCheckerEnabled: (enabled: boolean) => void log.push(`enabled:${enabled}`),
    setSpellCheckerLanguages: (next: string[]) => {
      languages = next
      log.push(`languages:${next.join(',')}`)
    },
    getSpellCheckerLanguages: () => languages
  }
  return { log, languages: () => languages, session }
}
/** A web contents whose session records what it is told. */
const contents = () => {
  const fake = fakeSession()
  return {
    fake,
    /** What the checker was switched to, in order (the calls about languages left out). */
    get told(): boolean[] {
      return fake.log.filter((line) => line.startsWith('enabled:')).map((line) => line === 'enabled:true')
    },
    value: { session: fake.session }
  }
}
/** A session Electron has just made: the application is told, as it is of the default session and of every partition. */
const newSession = (system?: string[]) => {
  const fake = fakeSession(system)
  for (const listener of world.created) listener(fake.session)
  return fake
}
/** What a window opened now is told. */
const newWindow = (): boolean[] => {
  const fresh = contents()
  for (const listener of world.listeners) listener({}, fresh.value)
  return fresh.told
}

beforeEach(() => {
  world.systemChecker = true
  world.listeners.length = 0
  world.created.length = 0
  world.open.length = 0
})

describe('Check Spelling While Typing, across launches', () => {
  it('applies the choice saved by the last launch to every window opened afterwards, over the system default', async () => {
    const { followSpellChecking, isSpellChecking } = await load()
    followSpellChecking('off', () => {})
    expect(isSpellChecking()).toBe(false)
    expect(newWindow()).toEqual([false])

    world.listeners.length = 0
    world.systemChecker = false
    const second = await load()
    second.followSpellChecking('on', () => {})
    expect(second.isSpellChecking()).toBe(true)
    expect(newWindow()).toEqual([true])
  })

  it('follows the system while the user has not chosen: on where it has a checker, off elsewhere', async () => {
    const { followSpellChecking, isSpellChecking } = await load()
    followSpellChecking('auto', () => {})
    expect(isSpellChecking()).toBe(true)
    expect(newWindow()).toEqual([true])

    world.listeners.length = 0
    world.systemChecker = false
    const second = await load()
    second.followSpellChecking('auto', () => {})
    expect(second.isSpellChecking()).toBe(false)
    expect(newWindow()).toEqual([false])
  })

  it('applies a click to the open windows and to the next ones, and records it as the user’s own choice for the next launch', async () => {
    const { followSpellChecking, setSpellChecking, isSpellChecking } = await load()
    const remembered: string[] = []
    followSpellChecking('auto', (choice) => void remembered.push(choice))
    const a = contents()
    const b = contents()
    world.open.push(a.value, b.value)

    setSpellChecking(false)
    expect([a.told, b.told, isSpellChecking(), newWindow()]).toEqual([[false], [false], false, [false]])
    expect(remembered).toEqual(['off'])

    setSpellChecking(true)
    expect([a.told, isSpellChecking(), newWindow()]).toEqual([[false, true], true, [true]])
    expect(remembered).toEqual(['off', 'on'])
  })

  it('records nothing at launch: applying the saved choice is not a new choice', async () => {
    const { followSpellChecking } = await load()
    const remembered: string[] = []
    followSpellChecking('off', (choice) => void remembered.push(choice))
    newWindow()
    expect(remembered).toEqual([])
  })
})

// Away from macOS Chromium fetches the dictionary of the languages a session checks as soon as the session exists, whatever the checker is switched to
// (a first launch downloaded fr-FR-3-0.bdic from the CDN one second after the start, with the checker "off"). A session is made without a language, so
// there is no dictionary to fetch, and gets its languages back when the user switches the checker on.
describe('No dictionary is fetched before the user switches the checker on', () => {
  it('makes every new session without a language and with the checker off, whichever session it is, before any window uses it', async () => {
    world.systemChecker = false
    const { holdSpellDictionaries } = await load()
    holdSpellDictionaries()
    const defaultSession = newSession(['fr'])
    const profile = newSession(['fr', 'en-US'])
    expect(defaultSession.log).toEqual(['languages:', 'enabled:false'])
    expect(profile.log).toEqual(['languages:', 'enabled:false'])
    expect([defaultSession.languages(), profile.languages()]).toEqual([[], []])
  })

  it('gives the languages back, then switches the checker on, when the user does; and takes them away again when the user switches it off', async () => {
    world.systemChecker = false
    const { holdSpellDictionaries, followSpellChecking, setSpellChecking } = await load()
    holdSpellDictionaries()
    followSpellChecking('auto', () => {})
    const session = newSession(['fr'])
    const window = { session: session.session }
    world.open.push(window)
    session.log.length = 0

    setSpellChecking(true)
    expect(session.log).toEqual(['languages:fr', 'enabled:true'])
    expect(session.languages()).toEqual(['fr'])

    session.log.length = 0
    setSpellChecking(false)
    expect(session.log).toEqual(['languages:', 'enabled:false'])
    setSpellChecking(true)
    expect(session.languages()).toEqual(['fr'])
  })

  it('reaches, with the choice the settings hold, the sessions made before that choice was known', async () => {
    world.systemChecker = false
    const { holdSpellDictionaries, followSpellChecking } = await load()
    holdSpellDictionaries()
    const early = newSession(['fr'])
    world.open.push({ session: early.session })
    followSpellChecking('on', () => {})
    expect(early.languages()).toEqual(['fr'])
    expect(early.log.at(-1)).toBe('enabled:true')

    // A session made afterwards, with a window of its own, is told by that window.
    const later = fakeSession(['en-US'])
    later.session.setSpellCheckerLanguages([])
    for (const listener of world.listeners) listener({}, { session: later.session })
    expect(later.log.at(-1)).toBe('enabled:true')
  })

  it('leaves macOS alone: no session is listened to and no language is touched, the checker being the system’s', async () => {
    world.systemChecker = true
    const { holdSpellDictionaries, followSpellChecking, setSpellChecking } = await load()
    holdSpellDictionaries()
    expect(world.created).toEqual([])
    followSpellChecking('auto', () => {})
    const window = contents()
    world.open.push(window.value)
    setSpellChecking(false)
    expect(window.fake.log).toEqual(['enabled:false'])
  })
})
