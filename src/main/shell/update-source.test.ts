// Where the check reads and where Squirrel installs from (update-source.ts): the built application installs only from the address built into it.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const BUILT_IN_FEED = 'https://test.lucium.app/updates/darwin-arm64/feed.json'
const STABLE_FEED = 'https://lucium.app/updates/darwin-arm64/feed.json'

const { backgroundFeed, builtInFeed, builtInTestFeed, channelFeed, currentBackgroundFeed, currentUpdateSources, hasTestFeed, testChannelAvailable, testChannelOfSnapshot, updateSources } = await import('./update-source')

afterEach(() => vi.unstubAllEnvs())

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
    expect(backgroundFeed(facts(), true)).toBe(BUILT_IN)
    expect(backgroundFeed(facts({ setting: 'https://set.example/latest' }), true)).toBe(BUILT_IN)
    expect(backgroundFeed(facts({ platform: 'linux' }), true)).toBe(BUILT_IN)
  })

  it('reads nothing at all with the setting off, whatever is configured', () => {
    expect(backgroundFeed(facts(), false)).toBeNull()
    expect(backgroundFeed(facts({ setting: 'https://set.example/latest' }), false)).toBeNull()
    expect(backgroundFeed(facts({ builtApp: false, env: 'https://dev.example/latest' }), false)).toBeNull()
  })

  it('never reads the built-in address from the sources: only an address given by hand, else nothing', () => {
    expect(backgroundFeed(facts({ builtApp: false }), true)).toBeNull()
    expect(backgroundFeed(facts({ builtApp: false, setting: 'https://set.example/latest' }), true)).toBe('https://set.example/latest')
    expect(backgroundFeed(facts({ builtApp: false, env: 'https://dev.example/latest', setting: 'https://set.example/latest' }), true)).toBe('https://dev.example/latest')
  })

  it('in a built application without a built-in address, reads the address written by hand, and nothing without one', () => {
    expect(backgroundFeed(facts({ builtIn: '' }), true)).toBeNull()
    expect(backgroundFeed(facts({ builtIn: '', setting: 'https://set.example/latest' }), true)).toBe('https://set.example/latest')
  })

  it('reads only an https address', () => {
    expect(backgroundFeed(facts({ builtIn: 'http://test.lucium.app/feed.json' }), true)).toBeNull()
    expect(backgroundFeed(facts({ builtApp: false, setting: 'http://set.example/latest' }), true)).toBeNull()
  })

  it('in this run (from the sources), leaves the built-in address alone', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED', BUILT_IN_FEED)
    vi.stubEnv('LUCIUM_UPDATE_FEED', undefined)
    expect(currentBackgroundFeed({ autoUpdate: true, updateFeedUrl: '', updateChannel: 'stable' })).toBeNull()
    expect(currentBackgroundFeed({ autoUpdate: true, updateFeedUrl: 'https://set.example/latest', updateChannel: 'stable' })).toBe('https://set.example/latest')
  })
})

describe('the two channels: the setting chooses between two addresses sealed into the build, and names none', () => {
  // A build of the two feeds: the stable address is `builtIn`, the test one `builtInTest`.
  const both = (over: Partial<Parameters<typeof updateSources>[0]> = {}) => facts({ builtIn: STABLE_FEED, builtInTest: BUILT_IN, ...over })

  it('follows the stable address by default, though the build carries a test one', () => {
    expect(updateSources(both())).toEqual({ check: STABLE_FEED, install: STABLE_FEED })
    expect(backgroundFeed(both(), true)).toBe(STABLE_FEED)
    expect(channelFeed(both())).toBe(STABLE_FEED)
  })

  it('follows the test address once the setting asks for it, for the check, the installation and the background look alike', () => {
    expect(updateSources(both({ channel: 'test' }))).toEqual({ check: BUILT_IN, install: BUILT_IN })
    expect(backgroundFeed(both({ channel: 'test' }), true)).toBe(BUILT_IN)
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
      expect(backgroundFeed(both({ channel, env: elsewhere, setting: elsewhere }), true)).toBe(expected)
    }
  })

  it('behaves as it always did in a build that carries one address: the test channel asked for changes nothing', () => {
    expect(updateSources(facts({ channel: 'test' }))).toEqual(updateSources(facts({ channel: 'stable' })))
    expect(updateSources(facts({ channel: 'test' }))).toEqual({ check: BUILT_IN, install: BUILT_IN })
    expect(backgroundFeed(facts({ channel: 'test' }), true)).toBe(BUILT_IN)
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
    expect(backgroundFeed(both({ builtApp: false, channel: 'test' }), true)).toBeNull()
  })

  it('reads nothing at all with « Rechercher les mises à jour automatiquement » off, on either channel', () => {
    expect(backgroundFeed(both({ channel: 'test' }), false)).toBeNull()
    expect(backgroundFeed(both(), false)).toBeNull()
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
