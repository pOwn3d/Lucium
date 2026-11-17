import { beforeEach, describe, expect, it, vi } from 'vitest'

// The choice of Edit › Spelling and Grammar › Check Spelling While Typing, applied to the engine's sessions. Electron is replaced by stand-ins that
// record what the sessions are told, and the platform by one that has (macOS) or has not (elsewhere) a checker of its own.
const world = vi.hoisted(() => ({
  systemChecker: true,
  listeners: [] as Array<(event: unknown, contents: unknown) => void>,
  open: [] as Array<{ session: { setSpellCheckerEnabled: (enabled: boolean) => void } }>
}))
vi.mock('electron', () => ({
  app: { on: (event: string, listener: (event: unknown, contents: unknown) => void) => void (event === 'web-contents-created' && world.listeners.push(listener)) },
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
/** A web contents whose session records what it is told. */
const contents = () => {
  const told: boolean[] = []
  return { told, value: { session: { setSpellCheckerEnabled: (enabled: boolean) => void told.push(enabled) } } }
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
