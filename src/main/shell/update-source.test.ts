// Where the check reads and where Squirrel installs from (update-source.ts): the built application installs only from the address built into it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const BUILT_IN_FEED = 'https://test.lucium.app/updates/darwin-arm64/feed.json'
const STABLE_FEED = 'https://lucium.app/updates/darwin-arm64/feed.json'

const { backgroundFeed, builtInFeed, builtInTestFeed, channelFeed, currentBackgroundFeed, currentUpdateSources, hasTestFeed, testChannelAvailable, testChannelOfSnapshot, updateSources } = await import('./update-source')

// The tests of the built-in addresses are the ones of macOS, the system that installs from them: the system is set, whatever machine runs them (a Windows or Linux
// run reads no built-in address: the tests of that are below).
// The two switches of the look in the background: macOS and Linux read `autoUpdate`, Windows `windowsAutoUpdate` (shared/platform.ts, `autoUpdateOn`).
const MAC_ON = { autoUpdate: true, windowsAutoUpdate: false }
const WIN_ON = { autoUpdate: false, windowsAutoUpdate: true }
const ALL_OFF = { autoUpdate: false, windowsAutoUpdate: false }
const BOTH_ON = { autoUpdate: true, windowsAutoUpdate: true }
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const runningOn = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform })
beforeEach(() => runningOn('darwin'))
afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', realPlatform)
})

describe('builtInFeed', () => {
  it('is the address electron-vite wrote at build time (MAIN_VITE_UPDATE_FEED), and none for a build made without it', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', ` ${BUILT_IN_FEED} `)
    expect(builtInFeed()).toBe(BUILT_IN_FEED)
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', undefined)
    expect(builtInFeed()).toBe('')
  })

  it('is what a run from the sources checks when nothing else is given, and installs nothing there', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN_FEED)
    vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
    expect(currentUpdateSources({ updateFeedUrl: '', updateChannel: 'stable' })).toEqual({ check: BUILT_IN_FEED, install: null })
  })
})

describe('builtInTestFeed: the second address sealed into a build', () => {
  it('is the address electron-vite wrote at build time (MAIN_VITE_UPDATE_FEED_TEST), and none for a build made without it', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', ` ${BUILT_IN_FEED} `)
    expect(builtInTestFeed()).toBe(BUILT_IN_FEED)
    expect(testChannelAvailable()).toBe(true)
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', undefined)
    expect(builtInTestFeed()).toBe('')
    expect(testChannelAvailable()).toBe(false)
  })

  it('is a different variable from the stable address: one never stands for the other', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', STABLE_FEED)
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', undefined)
    expect(builtInFeed()).toBe(STABLE_FEED)
    expect(builtInTestFeed()).toBe('')
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', undefined)
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', BUILT_IN_FEED)
    expect(builtInFeed()).toBe('')
    expect(builtInTestFeed()).toBe(BUILT_IN_FEED)
  })

  it('is said in the snapshot of a window (the Settings show their choice from it) while the build carries one, and not otherwise', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', undefined)
    expect(testChannelOfSnapshot()).toEqual({})
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', 'http://test.lucium.app/feed.json')
    expect(testChannelOfSnapshot()).toEqual({})
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', BUILT_IN_FEED)
    expect(testChannelOfSnapshot()).toEqual({ updateTestChannel: true })
  })
})

const BUILT_IN = BUILT_IN_FEED
const facts = (over: Partial<Parameters<typeof updateSources>[0]> = {}): Parameters<typeof updateSources>[0] => ({
  builtIn: BUILT_IN,
  builtInTest: '',
  channel: 'stable',
  builtApp: true,
  platform: 'darwin',
  env: undefined,
  setting: '',
  ...over
})

describe('updateSources', () => {
  it('in the built application on macOS, installs from the built-in address and checks that same address', () => {
    expect(updateSources(facts())).toEqual({ check: BUILT_IN, install: BUILT_IN })
  })

  it('never lets the environment or the setting replace the built-in address there, for the check or the installation', () => {
    const elsewhere = 'https://elsewhere.example/feed.json'
    expect(updateSources(facts({ env: elsewhere }))).toEqual({ check: BUILT_IN, install: BUILT_IN })
    expect(updateSources(facts({ setting: elsewhere }))).toEqual({ check: BUILT_IN, install: BUILT_IN })
  })

  it('installs nothing from the sources, even with a built-in address: the check reads it, the download page opens', () => {
    expect(updateSources(facts({ builtApp: false }))).toEqual({ check: BUILT_IN, install: null })
    // A development run keeps what it had: the variable, then the setting, before the built-in address.
    expect(updateSources(facts({ builtApp: false, env: 'https://dev.example/latest', setting: 'https://set.example/latest' }))).toEqual({ check: 'https://dev.example/latest', install: null })
    expect(updateSources(facts({ builtApp: false, setting: 'https://set.example/latest' }))).toEqual({ check: 'https://set.example/latest', install: null })
  })

  it('installs nothing outside macOS, nor from a built-in address that is not https', () => {
    expect(updateSources(facts({ platform: 'linux' })).install).toBeNull()
    expect(updateSources(facts({ builtIn: 'http://test.lucium.app/feed.json' })).install).toBeNull()
    expect(updateSources(facts({ builtIn: 'https://bad host/feed.json' })).install).toBeNull()
  })

  it('without a built-in address, changes nothing: the setting is read, and nothing installs', () => {
    expect(updateSources(facts({ builtIn: '' }))).toEqual({ check: '', install: null })
    expect(updateSources(facts({ builtIn: '  ', setting: ' https://set.example/latest ' }))).toEqual({ check: 'https://set.example/latest', install: null })
  })
})

describe('backgroundFeed: what « Rechercher les mises à jour automatiquement » reads', () => {
  it('in the built application, reads the built-in address, the one the menu reads and Squirrel installs from', () => {
    expect(backgroundFeed(facts(), MAC_ON)).toBe(BUILT_IN)
    expect(backgroundFeed(facts({ setting: 'https://set.example/latest' }), MAC_ON)).toBe(BUILT_IN)
  })

  it('reads nothing at all with the setting off, whatever is configured', () => {
    expect(backgroundFeed(facts(), ALL_OFF)).toBeNull()
    expect(backgroundFeed(facts({ setting: 'https://set.example/latest' }), ALL_OFF)).toBeNull()
    expect(backgroundFeed(facts({ builtApp: false, env: 'https://dev.example/latest' }), ALL_OFF)).toBeNull()
  })

  it('never reads the built-in address from the sources: only an address given by hand, else nothing', () => {
    expect(backgroundFeed(facts({ builtApp: false }), MAC_ON)).toBeNull()
    expect(backgroundFeed(facts({ builtApp: false, setting: 'https://set.example/latest' }), MAC_ON)).toBe('https://set.example/latest')
    expect(backgroundFeed(facts({ builtApp: false, env: 'https://dev.example/latest', setting: 'https://set.example/latest' }), MAC_ON)).toBe('https://dev.example/latest')
  })

  it('in a built application without a built-in address, reads the address written by hand, and nothing without one', () => {
    expect(backgroundFeed(facts({ builtIn: '' }), MAC_ON)).toBeNull()
    expect(backgroundFeed(facts({ builtIn: '', setting: 'https://set.example/latest' }), MAC_ON)).toBe('https://set.example/latest')
  })

  it('reads only an https address', () => {
    expect(backgroundFeed(facts({ builtIn: 'http://test.lucium.app/feed.json' }), MAC_ON)).toBeNull()
    expect(backgroundFeed(facts({ builtApp: false, setting: 'http://set.example/latest' }), MAC_ON)).toBeNull()
  })

  it('in this run (from the sources), leaves the built-in address alone', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN_FEED)
    vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
    expect(currentBackgroundFeed({ autoUpdate: true, windowsAutoUpdate: false, updateFeedUrl: '', updateChannel: 'stable' })).toBeNull()
    expect(currentBackgroundFeed({ autoUpdate: true, windowsAutoUpdate: false, updateFeedUrl: 'https://set.example/latest', updateChannel: 'stable' })).toBe('https://set.example/latest')
  })
})

describe('the two channels: the setting chooses between two addresses sealed into the build, and names none', () => {
  // A build of the two feeds: the stable address is `builtIn`, the test one `builtInTest`.
  const both = (over: Partial<Parameters<typeof updateSources>[0]> = {}) => facts({ builtIn: STABLE_FEED, builtInTest: BUILT_IN, ...over })

  it('follows the stable address by default, though the build carries a test one', () => {
    expect(updateSources(both())).toEqual({ check: STABLE_FEED, install: STABLE_FEED })
    expect(backgroundFeed(both(), MAC_ON)).toBe(STABLE_FEED)
    expect(channelFeed(both())).toBe(STABLE_FEED)
  })

  it('follows the test address once the setting asks for it, for the check, the installation and the background look alike', () => {
    expect(updateSources(both({ channel: 'test' }))).toEqual({ check: BUILT_IN, install: BUILT_IN })
    expect(backgroundFeed(both({ channel: 'test' }), MAC_ON)).toBe(BUILT_IN)
    expect(channelFeed(both({ channel: 'test' }))).toBe(BUILT_IN)
  })

  it('comes back to the stable address when the setting does', () => {
    const asked = both({ channel: 'test' })
    expect(updateSources(asked).install).toBe(BUILT_IN)
    expect(updateSources({ ...asked, channel: 'stable' }).install).toBe(STABLE_FEED)
  })

  it('never lets the environment or the setting replace either address in the built application', () => {
    const elsewhere = 'https://elsewhere.example/feed.json'
    for (const channel of ['stable', 'test'] as const) {
      const expected = channel === 'test' ? BUILT_IN : STABLE_FEED
      expect(updateSources(both({ channel, env: elsewhere }))).toEqual({ check: expected, install: expected })
      expect(updateSources(both({ channel, setting: elsewhere }))).toEqual({ check: expected, install: expected })
      expect(backgroundFeed(both({ channel, env: elsewhere, setting: elsewhere }), MAC_ON)).toBe(expected)
    }
  })

  it('behaves as it always did in a build that carries one address: the test channel asked for changes nothing', () => {
    expect(updateSources(facts({ channel: 'test' }))).toEqual(updateSources(facts({ channel: 'stable' })))
    expect(updateSources(facts({ channel: 'test' }))).toEqual({ check: BUILT_IN, install: BUILT_IN })
    expect(backgroundFeed(facts({ channel: 'test' }), MAC_ON)).toBe(BUILT_IN)
    // Nor does it make a build without a stable address read the test one by itself.
    expect(updateSources(facts({ builtIn: '', channel: 'stable', builtInTest: BUILT_IN }))).toEqual({ check: '', install: null })
  })

  it('takes a test address that is not an https address for none: the stable channel is followed, and the choice is not offered', () => {
    for (const bad of ['http://test.lucium.app/feed.json', 'https://bad host/feed.json', '', '   ']) {
      expect(hasTestFeed(bad), bad).toBe(false)
      expect(updateSources(both({ channel: 'test', builtInTest: bad })), bad).toEqual({ check: STABLE_FEED, install: STABLE_FEED })
    }
    expect(hasTestFeed(` ${BUILT_IN} `)).toBe(true)
  })

  it('installs nothing from the sources whatever the channel: the check reads the test address there, as it reads the stable one', () => {
    expect(updateSources(both({ builtApp: false }))).toEqual({ check: STABLE_FEED, install: null })
    expect(updateSources(both({ builtApp: false, channel: 'test' }))).toEqual({ check: BUILT_IN, install: null })
    expect(backgroundFeed(both({ builtApp: false, channel: 'test' }), MAC_ON)).toBeNull()
  })

  it('reads nothing at all with « Rechercher les mises à jour automatiquement » off, on either channel', () => {
    expect(backgroundFeed(both({ channel: 'test' }), ALL_OFF)).toBeNull()
    expect(backgroundFeed(both(), ALL_OFF)).toBeNull()
  })

  it('reads its facts from the build and from the setting of the profile (the current run)', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', STABLE_FEED)
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', BUILT_IN)
    vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
    // A run from the sources checks, and never installs, whichever address it follows.
    expect(currentUpdateSources({ updateFeedUrl: '', updateChannel: 'stable' })).toEqual({ check: STABLE_FEED, install: null })
    expect(currentUpdateSources({ updateFeedUrl: '', updateChannel: 'test' })).toEqual({ check: BUILT_IN, install: null })
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', undefined)
    expect(currentUpdateSources({ updateFeedUrl: '', updateChannel: 'test' })).toEqual({ check: STABLE_FEED, install: null })
  })
})

// Linux builds carry the address of their feed (linux.yml), and nothing reads it yet: the client of Linux is a later lot.
describe('Linux, which updates by hand, reads no built-in address', () => {
  const both = (over: Partial<Parameters<typeof updateSources>[0]> = {}) => facts({ builtIn: STABLE_FEED, builtInTest: BUILT_IN, ...over })

  it('checks and installs nothing from it, on either channel, in the menu or in the background', () => {
    for (const channel of ['stable', 'test'] as const) {
      const there = both({ platform: 'linux', channel })
      expect(updateSources(there), channel).toEqual({ check: '', install: null })
      expect(backgroundFeed(there, MAC_ON), channel).toBeNull()
    }
  })

  it('still reads an address given by hand, as it did before the build carried one', () => {
    expect(updateSources(both({ platform: 'linux', env: 'https://env.example/latest', setting: 'https://set.example/latest' }))).toEqual({ check: 'https://env.example/latest', install: null })
    expect(backgroundFeed(both({ platform: 'linux', setting: 'https://set.example/latest' }), MAC_ON)).toBe('https://set.example/latest')
  })

  it('does not offer the test channel in the Settings, which would show a switch that changes nothing', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', BUILT_IN)
    runningOn('linux')
    expect(testChannelAvailable()).toBe(false)
    expect(testChannelOfSnapshot()).toEqual({})
    runningOn('darwin')
    expect(testChannelAvailable()).toBe(true)
  })

  it('reads the built-in addresses of this run as nothing, through the current facts', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', STABLE_FEED)
    vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
    runningOn('linux')
    expect(currentUpdateSources({ updateFeedUrl: '', updateChannel: 'stable' })).toEqual({ check: '', install: null })
    expect(currentBackgroundFeed({ updateFeedUrl: '', updateChannel: 'stable', autoUpdate: true, windowsAutoUpdate: false })).toBeNull()
  })
})

// Windows builds carry the address of their feed (windows.yml) and read it (windows-update.ts): the lot of the client lifted the rule above for them. The look in
// the background follows a switch of its own, `windowsAutoUpdate`, OFF by default (the maintainer's decision of 23 November 2026; shared/platform.ts `autoUpdateOn`).
describe('Windows reads the built-in address, when asked', () => {
  const WIN_STABLE = 'https://lucium.app/updates/win32-x64/feed.json'
  const WIN_TEST = 'https://test.lucium.app/updates/win32-x64/feed.json'
  const win = (over: Partial<Parameters<typeof updateSources>[0]> = {}) => facts({ builtIn: WIN_STABLE, builtInTest: WIN_TEST, platform: 'win32', ...over })

  it('checks and installs from the built-in address of the channel the setting follows, in the built application', () => {
    expect(updateSources(win())).toEqual({ check: WIN_STABLE, install: WIN_STABLE })
    expect(updateSources(win({ channel: 'test' }))).toEqual({ check: WIN_TEST, install: WIN_TEST })
  })

  it('never installs from an address given by hand (the environment, the setting), nor from a run from the sources', () => {
    expect(updateSources(win({ env: 'https://env.example/feed.json', setting: 'https://set.example/feed.json' }))).toEqual({ check: WIN_STABLE, install: WIN_STABLE })
    expect(updateSources(win({ builtIn: '', builtInTest: '', env: 'https://env.example/feed.json' }))).toEqual({ check: 'https://env.example/feed.json', install: null })
    expect(updateSources(win({ builtApp: false }))).toEqual({ check: WIN_STABLE, install: null })
  })

  it('refuses a built-in address that is not https', () => {
    expect(updateSources(win({ builtIn: 'http://lucium.app/updates/win32-x64/feed.json' }))).toEqual({ check: 'http://lucium.app/updates/win32-x64/feed.json', install: null })
  })

  it('looks in the background only while ITS OWN switch is on, on either channel; the old autoUpdate decides nothing there', () => {
    for (const channel of ['stable', 'test'] as const) {
      expect(backgroundFeed(win({ channel }), WIN_ON), channel).toBe(channel === 'test' ? WIN_TEST : WIN_STABLE)
      // The old switch, on in every profile of the 1.1.5 though nobody chose it, reads nothing: the new one is off by default.
      expect(backgroundFeed(win({ channel }), MAC_ON), channel).toBeNull()
      expect(backgroundFeed(win({ channel }), ALL_OFF), channel).toBeNull()
    }
    expect(backgroundFeed(win(), BOTH_ON)).toBe(WIN_STABLE)
    expect(backgroundFeed(win(), { autoUpdate: true, windowsAutoUpdate: 'yes' as unknown as boolean })).toBeNull()
  })

  it('keeps the built-in address out of a run from the sources, switch on: only an address given by hand is read', () => {
    expect(backgroundFeed(win({ builtApp: false }), WIN_ON)).toBeNull()
    expect(backgroundFeed(win({ builtApp: false, setting: 'https://set.example/feed.json' }), WIN_ON)).toBe('https://set.example/feed.json')
    expect(backgroundFeed(win({ builtApp: false, setting: 'https://set.example/feed.json' }), MAC_ON)).toBeNull()
  })

  it('never reads the Windows switch on the other systems: macOS and Linux follow autoUpdate alone', () => {
    expect(backgroundFeed(facts({ platform: 'darwin' }), WIN_ON)).toBeNull()
    expect(backgroundFeed(facts({ platform: 'darwin' }), MAC_ON)).toBe(BUILT_IN)
    // Linux reads no built-in address (its client is a later lot), only one written by hand, as before.
    expect(backgroundFeed(facts({ platform: 'linux' }), WIN_ON)).toBeNull()
    expect(backgroundFeed(facts({ platform: 'linux', setting: 'https://set.example/feed.json' }), WIN_ON)).toBeNull()
    expect(backgroundFeed(facts({ platform: 'linux' }), MAC_ON)).toBeNull()
    expect(backgroundFeed(facts({ platform: 'linux', setting: 'https://set.example/feed.json' }), MAC_ON)).toBe('https://set.example/feed.json')
  })

  it('offers the test channel in the Settings when the build carries a test address, and not otherwise', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', WIN_TEST)
    runningOn('win32')
    expect(testChannelAvailable()).toBe(true)
    expect(testChannelOfSnapshot()).toEqual({ updateTestChannel: true })
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', undefined)
    expect(testChannelOfSnapshot()).toEqual({})
  })

  it('reads the built-in addresses of this run for the menu, and the switch of this system for the background, through the current facts', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', WIN_STABLE)
    vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
    runningOn('win32')
    // A run from the sources (the test is not a built application) reads the built-in address for the menu and installs nothing, and reads none in the background.
    expect(currentUpdateSources({ updateFeedUrl: '', updateChannel: 'stable' })).toEqual({ check: WIN_STABLE, install: null })
    expect(currentBackgroundFeed({ updateFeedUrl: '', updateChannel: 'stable', ...WIN_ON })).toBeNull()
    expect(currentBackgroundFeed({ updateFeedUrl: 'https://set.example/feed.json', updateChannel: 'stable', ...WIN_ON })).toBe('https://set.example/feed.json')
    expect(currentBackgroundFeed({ updateFeedUrl: 'https://set.example/feed.json', updateChannel: 'stable', ...MAC_ON })).toBeNull()
  })
})
