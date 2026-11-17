import { describe, expect, it } from 'vitest'
import { defaultSettings, type RuntimeState, type SidebarState, type TabItem } from './model'
import { activeTab, createInitialState, normalize, reduce, type Action, type Ctx } from './sidebar'
import {
  PRESSURE_AWAKE_MAX,
  SLEEP_HOSTS_MAX,
  SLEEP_LEVELS,
  checkSleepHost,
  cleanSleepHosts,
  cleanSleepSettings,
  isSiteExcluded,
  normalizeSleepHost,
  planSweep,
  pressureOfFreeMemory,
  pressureOfLevel,
  setSiteExcluded,
  sleepToastMessage,
  sleepVerdict,
  sweepLimits,
  tabsToWakeAtLaunch,
  wakesAtLaunch,
  withSleepingEntries,
  type PageProbe,
  type SleepFacts,
  type SleepRules,
  type SweepEntry
} from './sleep'
import { frenchSpaces } from './french-typography'

const MINUTE = 60_000
const rules = (patch: Partial<SleepRules> = {}): SleepRules => ({ sleepAfterMinutes: 30, sleepExcludedHosts: [], sleepSkipAudible: true, sleepSkipPinned: false, ...patch })
const clean: PageProbe = { pictureInPicture: false, unsentInput: false }
/** A background tab left for 31 minutes, nothing playing, the page asked and clean: it may sleep. */
const facts = (patch: Partial<SleepFacts> = {}): SleepFacts => ({ awake: true, selected: false, visiblePane: false, loading: false, audible: false, downloading: false, idleMs: 31 * MINUTE, probe: clean, ...patch })
const tab = (patch: Partial<Pick<TabItem, 'url' | 'pinned' | 'keepAwake'>> = {}) => ({ url: 'https://example.com/page', pinned: false, ...patch })

const reason = (verdict: ReturnType<typeof sleepVerdict>) => (verdict.sleep ? 'sleep' : verdict.reason)

describe('sleepVerdict (automatic)', () => {
  it('puts a tab to sleep once it was left for the delay and nothing holds it back', () => {
    expect(sleepVerdict(tab(), rules(), facts())).toEqual({ sleep: true })
  })

  it('never sleeps the selected tab, nor a pane of the split view on screen', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ selected: true })))).toBe('selected')
    expect(reason(sleepVerdict(tab(), rules(), facts({ visiblePane: true })))).toBe('split-pane')
  })

  it('never sleeps a tab whose page floats in Lucium’s window: the main process knows it, whatever the page says', () => {
    // The page of Lucium's window is not a Picture in Picture of the system: its own probe answers no.
    expect(reason(sleepVerdict(tab(), rules(), facts({ floating: true, probe: { pictureInPicture: false, unsentInput: false } })))).toBe('floating')
    expect(reason(sleepVerdict(tab(), rules({ sleepFreezeAfterMinutes: 5 }), facts({ floating: true, idleMs: 600 * MINUTE }), 'freeze'))).toBe('floating')
    expect(reason(sleepVerdict(tab(), rules(), facts({ floating: true, overCap: true }), 'auto'))).toBe('floating')
    expect(reason(sleepVerdict(tab(), rules(), facts({ floating: false })))).toBe('sleep')
  })

  it('has nothing to do for a tab without a live page', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ awake: false })))).toBe('no-page')
  })

  it('waits for the delay, to the millisecond', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ idleMs: 30 * MINUTE - 1 })))).toBe('recent')
    expect(reason(sleepVerdict(tab(), rules(), facts({ idleMs: 30 * MINUTE })))).toBe('sleep')
  })

  it('does nothing when the delay is "never", or is not a usable number', () => {
    for (const sleepAfterMinutes of [0, -5, Number.NaN]) expect(reason(sleepVerdict(tab(), rules({ sleepAfterMinutes }), facts({ idleMs: 1e12 })))).toBe('disabled')
  })

  it('leaves a tab marked "never put to sleep" alone', () => {
    expect(reason(sleepVerdict(tab({ keepAwake: true }), rules(), facts()))).toBe('keep-awake')
    expect(reason(sleepVerdict(tab({ keepAwake: undefined }), rules(), facts()))).toBe('sleep')
  })

  it('leaves the sites of the list alone, subdomains included', () => {
    const excluded = rules({ sleepExcludedHosts: ['example.com'] })
    expect(reason(sleepVerdict(tab({ url: 'https://example.com/a' }), excluded, facts()))).toBe('excluded-site')
    expect(reason(sleepVerdict(tab({ url: 'https://mail.example.com/' }), excluded, facts()))).toBe('excluded-site')
    expect(reason(sleepVerdict(tab({ url: 'https://other.org/' }), excluded, facts()))).toBe('sleep')
  })

  it('puts a pinned tab to sleep like any other, unless the setting says otherwise', () => {
    expect(reason(sleepVerdict(tab({ pinned: true }), rules(), facts()))).toBe('sleep')
    expect(reason(sleepVerdict(tab({ pinned: true }), rules({ sleepSkipPinned: true }), facts()))).toBe('pinned')
    expect(reason(sleepVerdict(tab({ pinned: false }), rules({ sleepSkipPinned: true }), facts()))).toBe('sleep')
  })

  it('leaves a tab that is loading alone', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ loading: true })))).toBe('loading')
  })

  it('leaves a tab that plays sound alone, unless the setting is off', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ audible: true })))).toBe('audible')
    expect(reason(sleepVerdict(tab(), rules({ sleepSkipAudible: false }), facts({ audible: true })))).toBe('sleep')
  })

  it('leaves a tab alone while a download it started is running', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ downloading: true })))).toBe('downloading')
  })

  it('leaves a tab shown in Picture in Picture alone, or holding text typed and not sent', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ probe: { ...clean, pictureInPicture: true } })))).toBe('picture-in-picture')
    expect(reason(sleepVerdict(tab(), rules(), facts({ probe: { ...clean, unsentInput: true } })))).toBe('unsent-input')
  })

  it('does not guess about a page it was not allowed to ask: no probe, no sleep', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ probe: undefined })))).toBe('unchecked')
  })

  it('asks the page only of a tab that every other rule lets through', () => {
    // Each of these is decided before the page matters: the verdict is not "unchecked".
    const blockers: Array<[string, ReturnType<typeof sleepVerdict>]> = [
      ['selected', sleepVerdict(tab(), rules(), facts({ selected: true, probe: undefined }))],
      ['keep-awake', sleepVerdict(tab({ keepAwake: true }), rules(), facts({ probe: undefined }))],
      ['recent', sleepVerdict(tab(), rules(), facts({ idleMs: MINUTE, probe: undefined }))],
      ['audible', sleepVerdict(tab(), rules(), facts({ audible: true, probe: undefined }))]
    ]
    for (const [expected, verdict] of blockers) expect(reason(verdict)).toBe(expected)
  })
})

describe('sleepVerdict (asked by hand)', () => {
  it('puts the tab to sleep whatever the user chose to protect and whatever the page holds', () => {
    const everything = facts({ audible: true, loading: true, downloading: true, idleMs: 0, probe: { pictureInPicture: true, unsentInput: true } })
    const protectedRules = rules({ sleepExcludedHosts: ['example.com'], sleepSkipPinned: true, sleepAfterMinutes: 0 })
    expect(sleepVerdict(tab({ pinned: true, keepAwake: true }), protectedRules, everything, 'manual')).toEqual({ sleep: true })
  })

  it('still refuses what cannot be done: a page on screen, or no page at all', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ selected: true }), 'manual'))).toBe('selected')
    expect(reason(sleepVerdict(tab(), rules(), facts({ visiblePane: true }), 'manual'))).toBe('split-pane')
    // The page in Lucium's floating window is on screen there: « Mettre en veille » asked by hand does not take it either.
    expect(reason(sleepVerdict(tab(), rules(), facts({ floating: true }), 'manual'))).toBe('floating')
    expect(reason(sleepVerdict(tab(), rules(), facts({ awake: false }), 'manual'))).toBe('no-page')
  })
})

describe('sleepVerdict (after "Actualiser tous les onglets" woke the tab)', () => {
  /** A tab woken a moment ago whose page just loaded: never left the screen, nothing playing, the page asked and clean. */
  const woken = (patch: Partial<SleepFacts> = {}): SleepFacts => facts({ idleMs: 2000, shownMeanwhile: false, ...patch })
  const again = (patch: Partial<SleepFacts> = {}, rulesPatch: Partial<SleepRules> = {}, tabPatch: Parameters<typeof tab>[0] = {}) => reason(sleepVerdict(tab(tabPatch), rules(rulesPatch), woken(patch), 'reload'))

  it('puts the tab back to sleep at once: the delay, the time since it loaded and a load that never ended do not count', () => {
    expect(again()).toBe('sleep')
    expect(again({ idleMs: 0 })).toBe('sleep')
    expect(again({ loading: true })).toBe('sleep')
    // The delay "Jamais" leaves the tabs asleep that the launch left asleep: the reload puts them back as they were.
    expect(again({}, { sleepAfterMinutes: 0 })).toBe('sleep')
  })

  it('keeps the tab the user shows, or showed since it was woken', () => {
    expect(again({ selected: true })).toBe('selected')
    expect(again({ visiblePane: true })).toBe('split-pane')
    expect(again({ shownMeanwhile: true })).toBe('shown-meanwhile')
    // The sweep does not read it: a tab shown and left is "recent" there, by its own clock.
    expect(reason(sleepVerdict(tab(), rules(), facts({ shownMeanwhile: true })))).toBe('sleep')
  })

  it('keeps what the user wants alive: a tab marked so, one that reloads itself, a site never put to sleep (subdomains too), a pinned tab while they are spared', () => {
    expect(again({}, {}, { keepAwake: true })).toBe('keep-awake')
    expect(reason(sleepVerdict({ ...tab(), autoReload: { seconds: 60 } }, rules(), woken(), 'reload'))).toBe('auto-reload')
    expect(again({}, { sleepExcludedHosts: ['example.com'] }, { url: 'https://app.example.com/' })).toBe('excluded-site')
    expect(again({}, { sleepExcludedHosts: ['example.com'] }, { url: 'https://example.org/' })).toBe('sleep')
    expect(again({}, { sleepSkipPinned: true }, { pinned: true })).toBe('pinned')
    expect(again({}, {}, { pinned: true })).toBe('sleep')
  })

  it('keeps a tab that plays sound, whatever the setting of the sweep says, and one that downloads', () => {
    expect(again({ audible: true })).toBe('audible')
    expect(again({ audible: true }, { sleepSkipAudible: false })).toBe('audible')
    expect(again({ downloading: true })).toBe('downloading')
  })

  it('asks the page last, and keeps a page in Picture in Picture, holding text typed and not sent, or that did not answer', () => {
    expect(again({ probe: { ...clean, pictureInPicture: true } })).toBe('picture-in-picture')
    expect(again({ probe: { ...clean, unsentInput: true } })).toBe('unsent-input')
    expect(again({ probe: undefined })).toBe('unchecked')
    expect(again({ probe: undefined, shownMeanwhile: true })).toBe('shown-meanwhile')
  })

  it('has nothing to put back to sleep when the page is gone already', () => {
    expect(again({ awake: false })).toBe('no-page')
  })
})

describe('excluded sites', () => {
  it('reads a host from what the user types', () => {
    expect(normalizeSleepHost('Example.COM')).toBe('example.com')
    expect(normalizeSleepHost('  www.example.com ')).toBe('example.com')
    expect(normalizeSleepHost('https://www.example.com:8080/a/b?c#d')).toBe('example.com')
    expect(normalizeSleepHost('example.com/path')).toBe('example.com')
    expect(normalizeSleepHost('*.example.com')).toBe('example.com')
    expect(normalizeSleepHost('localhost')).toBe('localhost')
    expect(normalizeSleepHost('192.168.1.10:3000')).toBe('192.168.1.10')
    expect(normalizeSleepHost('example.com.')).toBe('example.com')
    // A pasted address with a long query string is still an address.
    expect(normalizeSleepHost(`https://example.com/search?q=${'a'.repeat(400)}`)).toBe('example.com')
  })

  it('takes a site reached by its IPv6 address, which can then be kept awake like any other', () => {
    expect(normalizeSleepHost('http://[::1]:3000')).toBe('[::1]')
    expect(normalizeSleepHost('[2001:DB8::1]:8443/app')).toBe('[2001:db8::1]')
    for (const bad of ['[::1', '[zz::1]', '::1']) expect(normalizeSleepHost(bad), bad).toBeNull()
    const hosts = setSiteExcluded([], 'http://[::1]:3000', true)
    expect(hosts).toEqual(['[::1]'])
    expect(isSiteExcluded('http://[::1]:5173/', hosts)).toBe(true)
    expect(isSiteExcluded('http://[::2]:5173/', hosts)).toBe(false)
    expect(cleanSleepHosts(['[::1]', 'example.com'])).toEqual(['[::1]', 'example.com'])
  })

  it('refuses what is not a host', () => {
    expect(normalizeSleepHost(`https://example.com/${'a'.repeat(3000)}`)).toBeNull()
    for (const bad of ['', '   ', 'not a host', 'a b.com', 'exa_mple.com', '-bad.com', 'ftp://example.com', 'javascript:alert(1)', 'http://', '.', 'a..b', `${'a'.repeat(64)}.com`, 42, null, undefined, {}]) {
      expect(normalizeSleepHost(bad)).toBeNull()
    }
  })

  it('cleans a saved list: valid hosts, each once, in order, bounded', () => {
    expect(cleanSleepHosts(['b.com', 'https://www.a.com/x', 'b.com', 'oops!', 7, null])).toEqual(['b.com', 'a.com'])
    expect(cleanSleepHosts('example.com')).toEqual([])
    expect(cleanSleepHosts(undefined)).toEqual([])
    const many = Array.from({ length: SLEEP_HOSTS_MAX + 50 }, (_, i) => `site${i}.com`)
    expect(cleanSleepHosts(many)).toHaveLength(SLEEP_HOSTS_MAX)
  })

  it('matches a host and its subdomains, and nothing that merely ends the same way', () => {
    expect(isSiteExcluded('https://example.com/', ['example.com'])).toBe(true)
    expect(isSiteExcluded('https://www.example.com/', ['example.com'])).toBe(true)
    expect(isSiteExcluded('https://a.b.example.com:8443/x', ['example.com'])).toBe(true)
    expect(isSiteExcluded('https://notexample.com/', ['example.com'])).toBe(false)
    expect(isSiteExcluded('https://example.com.evil.org/', ['example.com'])).toBe(false)
    expect(isSiteExcluded('https://mail.example.com/', ['mail.example.com'])).toBe(true)
    expect(isSiteExcluded('https://example.com/', ['mail.example.com'])).toBe(false)
    expect(isSiteExcluded('not a url', ['example.com'])).toBe(false)
    expect(isSiteExcluded('https://example.com/', [])).toBe(false)
  })

  it('adds a site once, and does not add one a listed domain already covers', () => {
    expect(setSiteExcluded([], 'https://www.example.com/page', true)).toEqual(['example.com'])
    expect(setSiteExcluded(['example.com'], 'example.com', true)).toEqual(['example.com'])
    expect(setSiteExcluded(['example.com'], 'mail.example.com', true)).toEqual(['example.com'])
    expect(setSiteExcluded(['other.org'], 'example.com', true)).toEqual(['other.org', 'example.com'])
  })

  it('takes a site out, and the listed domain that covered it with it', () => {
    expect(setSiteExcluded(['example.com', 'other.org'], 'example.com', false)).toEqual(['other.org'])
    expect(setSiteExcluded(['example.com', 'other.org'], 'mail.example.com', false)).toEqual(['other.org'])
    expect(setSiteExcluded(['mail.example.com'], 'example.com', false)).toEqual(['mail.example.com'])
  })

  it('leaves the list alone for something that is not a site', () => {
    expect(setSiteExcluded(['example.com'], 'nonsense!', true)).toEqual(['example.com'])
    expect(setSiteExcluded(['example.com'], 'nonsense!', false)).toEqual(['example.com'])
  })

  it('checks what the settings list is given, and says why not in French', () => {
    expect(checkSleepHost('https://www.Example.com/a', ['other.org'])).toEqual({ host: 'example.com' })
    expect(checkSleepHost('???', [])).toEqual({ error: 'Cette adresse de site n’est pas valide.' })
    expect(checkSleepHost('example.com', ['example.com'])).toEqual({ error: 'Ce site est déjà dans la liste.' })
    expect(checkSleepHost('mail.example.com', ['example.com'])).toEqual({ error: frenchSpaces('Ce site est déjà couvert par « example.com ».') })
    expect(checkSleepHost('new.org', Array.from({ length: SLEEP_HOSTS_MAX }, (_, i) => `s${i}.com`))).toEqual({ error: 'La liste est pleine.' })
  })
})

describe('reading a saved file', () => {
  const settings = (patch: Record<string, unknown>) => ({ ...defaultSettings(), ...patch }) as ReturnType<typeof defaultSettings>

  it('keeps valid sleep settings', () => {
    const valid = { sleepAfterMinutes: 5, sleepAwakeMax: 20, sleepFreezeAfterMinutes: 2, sleepMode: 'freeze', sleepExcludedHosts: ['a.com'], sleepExcludedKeepAll: true, sleepSkipAudible: false, sleepSkipPinned: true, sleepNotify: true, loadAllTabsAtLaunch: true } as const
    expect(cleanSleepSettings(settings(valid))).toEqual(valid)
  })

  it('replaces values of the wrong kind by the defaults instead of passing them on', () => {
    const defaults = defaultSettings()
    const garbage = settings({ sleepAfterMinutes: '30', sleepAwakeMax: '12', sleepFreezeAfterMinutes: -2, sleepMode: 'hibernate', sleepExcludedHosts: 'a.com', sleepExcludedKeepAll: 'oui', sleepSkipAudible: 'yes', sleepSkipPinned: 1, sleepNotify: null, loadAllTabsAtLaunch: 'oui' })
    expect(cleanSleepSettings(garbage)).toEqual({
      sleepAfterMinutes: defaults.sleepAfterMinutes,
      sleepAwakeMax: defaults.sleepAwakeMax,
      sleepFreezeAfterMinutes: defaults.sleepFreezeAfterMinutes,
      sleepMode: 'discard',
      sleepExcludedHosts: [],
      sleepExcludedKeepAll: false,
      sleepSkipAudible: defaults.sleepSkipAudible,
      sleepSkipPinned: defaults.sleepSkipPinned,
      sleepNotify: defaults.sleepNotify,
      loadAllTabsAtLaunch: false
    })
    for (const sleepAfterMinutes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(cleanSleepSettings(settings({ sleepAfterMinutes })).sleepAfterMinutes).toBe(defaults.sleepAfterMinutes)
    expect(cleanSleepSettings(settings({ sleepAfterMinutes: 0 })).sleepAfterMinutes).toBe(0)
    // The cap is a count of tabs: a fraction, a negative number or one beyond the limit is not one.
    for (const sleepAwakeMax of [2.5, -1, 501, Number.NaN, Number.POSITIVE_INFINITY]) expect(cleanSleepSettings(settings({ sleepAwakeMax })).sleepAwakeMax, String(sleepAwakeMax)).toBe(defaults.sleepAwakeMax)
    expect(cleanSleepSettings(settings({ sleepAwakeMax: 0 })).sleepAwakeMax).toBe(0)
    expect(cleanSleepSettings(settings({ sleepAwakeMax: 500 })).sleepAwakeMax).toBe(500)
    for (const sleepFreezeAfterMinutes of [Number.NaN, Number.POSITIVE_INFINITY, '5']) expect(cleanSleepSettings(settings({ sleepFreezeAfterMinutes })).sleepFreezeAfterMinutes).toBe(0)
  })

  it('gives a file of an older build the cap and the level of the defaults, and keeps the delay it had', () => {
    const { sleepAwakeMax: _cap, sleepFreezeAfterMinutes: _freeze, sleepExcludedKeepAll: _all, ...older } = defaultSettings()
    const migrated = normalize({ ...createInitialState({ now: 1, newId: () => 'id' }), settings: { ...older, sleepAfterMinutes: 15 } as ReturnType<typeof defaultSettings> }).settings
    expect(migrated).toMatchObject({ sleepAfterMinutes: 15, sleepAwakeMax: 12, sleepFreezeAfterMinutes: 0, sleepExcludedKeepAll: false })
  })

  it('defaults are what the feature promises: sound spared, pinned tabs not, no chatter, a launch that loads only what is shown', () => {
    expect(defaultSettings()).toMatchObject({ sleepAfterMinutes: 30, sleepAwakeMax: 12, sleepFreezeAfterMinutes: 0, sleepMode: 'discard', sleepExcludedHosts: [], sleepExcludedKeepAll: false, sleepSkipAudible: true, sleepSkipPinned: false, sleepNotify: false, loadAllTabsAtLaunch: false })
    expect(defaultSettings()).toMatchObject(SLEEP_LEVELS.balanced)
  })
})

describe('the launch', () => {
  const launch = (patch: Partial<Pick<ReturnType<typeof defaultSettings>, 'loadAllTabsAtLaunch' | 'sleepExcludedHosts'>> = {}) => ({ loadAllTabsAtLaunch: false, sleepExcludedHosts: ['messages.example'], ...patch })
  const plain = { url: 'https://news.example/article' }

  it('leaves a tab that no window shows asleep: nothing wakes it but what the user wants alive', () => {
    expect(wakesAtLaunch(plain, launch())).toBeNull()
    // Pinned, in a folder, a favourite: still a tab like the others (none of them is loaded before it is shown).
    expect(wakesAtLaunch({ ...plain, pinned: true, folderId: 'f' } as typeof plain, launch())).toBeNull()
  })

  it('wakes the tab of a site in the list of sites never put to sleep, and of its subdomains', () => {
    expect(wakesAtLaunch({ url: 'https://messages.example/inbox' }, launch())).toBe('excluded-site')
    expect(wakesAtLaunch({ url: 'https://app.messages.example/' }, launch())).toBe('excluded-site')
    expect(wakesAtLaunch({ url: 'https://messages.example.org/' }, launch())).toBeNull()
    expect(wakesAtLaunch({ url: 'https://messages.example/inbox' }, launch({ sleepExcludedHosts: [] }))).toBeNull()
  })

  it('wakes the tab marked "never put to sleep" and the tab that reloads itself (its countdown needs a page), not one that cannot be reloaded', () => {
    expect(wakesAtLaunch({ ...plain, keepAwake: true }, launch())).toBe('keep-awake')
    expect(wakesAtLaunch({ ...plain, autoReload: { seconds: 30 } }, launch())).toBe('auto-reload')
    expect(wakesAtLaunch({ url: 'about:blank', autoReload: { seconds: 30 } }, launch())).toBeNull()
  })

  it('wakes every tab with "Charger tous les onglets au lancement", and never a private one', () => {
    expect(wakesAtLaunch(plain, launch({ loadAllTabsAtLaunch: true }))).toBe('all-tabs')
    expect(wakesAtLaunch({ url: 'about:blank' }, launch({ loadAllTabsAtLaunch: true }))).toBe('all-tabs')
    expect(wakesAtLaunch({ ...plain, private: true }, launch({ loadAllTabsAtLaunch: true }))).toBeNull()
    expect(wakesAtLaunch({ url: 'https://messages.example/', private: true }, launch())).toBeNull()
  })


  it('gives a tab that never had a page the entry of a tab put to sleep, so that it reads as asleep everywhere', () => {
    const awake = { loading: false, audible: true, muted: false, awake: true }
    const runtime: RuntimeState = { canGoBack: false, canGoForward: false, tabs: { shown: awake } } as unknown as RuntimeState
    const next = withSleepingEntries(runtime, [{ id: 'shown' }, { id: 'behind' }])
    expect(next.tabs['behind']).toEqual({ loading: false, audible: false, muted: false, awake: false })
    // What a live page told is kept as it is.
    expect(next.tabs['shown']).toBe(awake)
    expect(next.canGoBack).toBe(false)
    // Nothing missing: the same object (no new snapshot for nothing).
    expect(withSleepingEntries(next, [{ id: 'shown' }, { id: 'behind' }])).toBe(next)
    expect(withSleepingEntries(runtime, [{ id: 'shown' }])).toBe(runtime)
  })
})

describe('the tabs woken at the launch (tabsToWakeAtLaunch)', () => {
  const initial = createInitialState({ now: 1, newId: () => 'first' })
  const spaceOf = (id: string) => ({ ...initial.spaces[0]!, id, name: id })
  const tabOf = (id: string, spaceId: string, url: string, patch: Partial<TabItem> = {}): TabItem => ({ id, spaceId, url, title: id, pinned: false, createdAt: 1, lastActiveAt: 1, ...patch })
  /** Three spaces (a, b, c), the sites "chat.example" and "mail.example" never put to sleep, and the tabs given, in that order in the state. */
  const profile = (tabs: TabItem[], patch: Partial<SidebarState> = {}, settings: Partial<SidebarState['settings']> = {}): SidebarState => ({
    ...initial,
    spaces: ['a', 'b', 'c'].map(spaceOf),
    tabs,
    folders: [],
    favorites: [],
    ...patch,
    settings: { ...initial.settings, sleepExcludedHosts: ['chat.example', 'mail.example'], loadAllTabsAtLaunch: false, ...settings }
  })
  /** What the windows show: nothing by default, on space a. */
  const screen = (shown: string[] = [], spaces: string[] = ['a'], locked?: (tab: TabItem) => boolean) => ({ shown: new Set(shown), spaces, ...(locked ? { locked } : {}) })
  const woken = (state: SidebarState, on = screen()) => tabsToWakeAtLaunch(state, on).map((tab) => tab.id)

  it('wakes one tab per site never put to sleep, looked for in the space on screen first, then in the other spaces in their order', () => {
    const tabs = [
      tabOf('b-chat', 'b', 'https://chat.example/b'),
      tabOf('a-news', 'a', 'https://news.example/'),
      tabOf('a-chat', 'a', 'https://chat.example/a'),
      tabOf('a-chat-2', 'a', 'https://chat.example/a2'),
      tabOf('c-mail', 'c', 'https://mail.example/c'),
      tabOf('b-mail', 'b', 'https://mail.example/b'),
      tabOf('c-mail-2', 'c', 'https://mail.example/c2')
    ]
    expect(woken(profile(tabs))).toEqual(['a-chat', 'b-mail'])
    // Another space on screen: the site is looked for there first, then in the others in the order of the spaces.
    expect(woken(profile(tabs), screen([], ['c']))).toEqual(['c-mail', 'a-chat'])
    // Several windows: the spaces they show come before the others, the main window's first.
    expect(woken(profile(tabs), screen([], ['c', 'b']))).toEqual(['c-mail', 'b-chat'])
    expect(woken(profile(tabs), screen([], ['b', 'c']))).toEqual(['b-chat', 'b-mail'])
  })

  it('wakes no tab of a folder marked « à ne pas réveiller », nor of a folder inside it, even with every tab loaded at the launch', () => {
    const folders: SidebarState['folders'] = [
      { id: 'old', spaceId: 'a', name: 'Anciens sites', collapsed: true, noWake: true },
      { id: 'old-sub', spaceId: 'a', name: 'Dedans', collapsed: true, parentId: 'old' },
      { id: 'live', spaceId: 'a', name: 'Courants', collapsed: false }
    ]
    const tabs = [
      tabOf('in-old', 'a', 'https://old.example/', { pinned: true, folderId: 'old' }),
      tabOf('in-sub', 'a', 'https://old.example/sub', { pinned: true, folderId: 'old-sub' }),
      tabOf('in-live', 'a', 'https://live.example/', { pinned: true, folderId: 'live' }),
      tabOf('keep', 'a', 'https://keep.example/', { pinned: true, folderId: 'old', keepAwake: true })
    ]
    expect(woken(profile(tabs, { folders }, { loadAllTabsAtLaunch: true }))).toEqual(['in-live'])
    // Unmarked, the same folders wake everything.
    const unmarked = folders.map(({ noWake: _no, ...f }) => f)
    expect(woken(profile(tabs, { folders: unmarked }, { loadAllTabsAtLaunch: true })).sort()).toEqual(['in-live', 'in-old', 'in-sub', 'keep'])
  })

  it('takes the first tab in the order of the sidebar, not of the state: the favourites, the loose pinned tabs, the folders, Today, the folders at the bottom', () => {
    const folders: SidebarState['folders'] = [
      { id: 'top', spaceId: 'a', name: 'Haut', collapsed: true },
      { id: 'bottom', spaceId: 'a', name: 'Bas', collapsed: false, atBottom: true }
    ]
    const today = tabOf('today', 'a', 'https://chat.example/today')
    const inBottom = tabOf('in-bottom', 'a', 'https://chat.example/bottom', { pinned: true, folderId: 'bottom' })
    const inTop = tabOf('in-top', 'a', 'https://chat.example/top', { pinned: true, folderId: 'top' })
    const loose = tabOf('loose', 'a', 'https://chat.example/loose', { pinned: true })
    const favorite = tabOf('favorite', 'a', 'https://chat.example/favorite', { favoriteId: 'fav' })
    const state = (tabs: TabItem[]) => profile(tabs, { folders, favorites: [{ id: 'fav', url: 'https://chat.example/', title: 'Chat', profileId: 'default' }] })
    expect(woken(state([inBottom, today, inTop, loose, favorite]))).toEqual(['favorite'])
    expect(woken(state([inBottom, today, inTop, loose]))).toEqual(['loose'])
    expect(woken(state([inBottom, today, inTop]))).toEqual(['in-top'])
    expect(woken(state([inBottom, today]))).toEqual(['today'])
    expect(woken(state([inBottom]))).toEqual(['in-bottom'])
  })

  it('counts a subdomain as its site, as the sweep does, and leaves alone a host that only looks alike', () => {
    const tabs = [tabOf('app', 'a', 'https://app.chat.example/'), tabOf('root', 'a', 'https://chat.example/'), tabOf('alike', 'a', 'https://chat.example.org/'), tabOf('alike-2', 'a', 'https://mychat.example/')]
    expect(woken(profile(tabs))).toEqual(['app'])
  })

  it('wakes nothing more for a site a tab on screen is on, in any window, a subdomain included', () => {
    const tabs = [tabOf('shown', 'a', 'https://web.chat.example/'), tabOf('chat', 'a', 'https://chat.example/'), tabOf('mail', 'b', 'https://mail.example/'), tabOf('shown-2', 'c', 'https://mail.example/inbox')]
    expect(woken(profile(tabs), screen(['shown']))).toEqual(['mail'])
    expect(woken(profile(tabs), screen(['shown', 'shown-2'], ['a', 'c']))).toEqual([])
  })

  it('wakes every tab marked "never put to sleep" and every tab that reloads itself, and a site they are on gets no other tab', () => {
    const tabs = [
      tabOf('chat', 'a', 'https://chat.example/'),
      tabOf('marked-chat', 'b', 'https://chat.example/marked', { keepAwake: true }),
      tabOf('marked-chat-2', 'c', 'https://chat.example/marked-2', { keepAwake: true }),
      tabOf('mail', 'a', 'https://mail.example/'),
      tabOf('reloading-mail', 'c', 'https://mail.example/reloading', { autoReload: { seconds: 60 } }),
      tabOf('marked', 'a', 'https://news.example/', { keepAwake: true }),
      // A blank page has nothing to reload: it does not wake for that.
      tabOf('reloading-blank', 'a', 'about:blank', { autoReload: { seconds: 60 } })
    ]
    expect(woken(profile(tabs))).toEqual(['marked', 'marked-chat', 'marked-chat-2', 'reloading-mail'])
  })

  it('skips a tab of a locked space: the next tab of its site stands for it, and a locked tab marked awake stands for nothing', () => {
    const tabs = [tabOf('locked-chat', 'a', 'https://chat.example/'), tabOf('chat', 'b', 'https://chat.example/b'), tabOf('locked-marked-mail', 'a', 'https://mail.example/', { keepAwake: true }), tabOf('mail', 'c', 'https://mail.example/c')]
    expect(woken(profile(tabs), screen([], ['a'], (tab) => tab.spaceId === 'a'))).toEqual(['chat', 'mail'])
  })

  it('never wakes a tab on screen (it has its page) nor a private tab', () => {
    const tabs = [tabOf('shown-marked', 'a', 'https://news.example/', { keepAwake: true }), tabOf('private-chat', 'a', 'https://chat.example/p', { private: true }), tabOf('chat', 'b', 'https://chat.example/')]
    expect(woken(profile(tabs), screen(['shown-marked']))).toEqual(['chat'])
  })

  it('wakes every tab with "Charger tous les onglets au lancement", in the order of the sidebar, but the ones on screen, of a locked space or private', () => {
    const tabs = [tabOf('b1', 'b', 'https://one.example/'), tabOf('a1', 'a', 'https://chat.example/'), tabOf('a2', 'a', 'https://chat.example/2'), tabOf('c1', 'c', 'https://two.example/'), tabOf('p', 'a', 'https://three.example/', { private: true }), tabOf('shown', 'a', 'about:blank')]
    expect(woken(profile(tabs, {}, { loadAllTabsAtLaunch: true }), screen(['shown'], ['a'], (tab) => tab.spaceId === 'c'))).toEqual(['a1', 'a2', 'b1'])
  })

  it('counts a tab on two entries of a list edited by hand (a domain and a subdomain of it) for both', () => {
    const tabs = [tabOf('sub', 'a', 'https://chat.example.com/'), tabOf('other', 'a', 'https://www2.example.com/'), tabOf('sub-2', 'b', 'https://chat.example.com/2')]
    expect(woken(profile(tabs, {}, { sleepExcludedHosts: ['example.com', 'chat.example.com'] }))).toEqual(['sub'])
  })

  it('still finds a tab of a space the state does not know (a file edited by hand), after the others', () => {
    expect(woken(profile([tabOf('lost', 'nowhere', 'https://chat.example/'), tabOf('mail', 'b', 'https://mail.example/')]))).toEqual(['mail', 'lost'])
  })

  it('on a profile shaped like a large one (136 tabs, 22 of them on 6 sites never put to sleep), wakes 6 tabs besides the marked ones', () => {
    const sites = ['chat.example', 'mail.example', 'docs.example', 'music.example', 'video.example', 'calendar.example']
    const tabs = Array.from({ length: 136 }, (_, n) => tabOf(`t${n}`, ['a', 'b', 'c'][n % 3]!, n < 22 ? `https://${sites[n % sites.length]}/${n}` : `https://site${n}.example/`, { pinned: n % 5 !== 0 }))
    tabs[40] = { ...tabs[40]!, keepAwake: true }
    const state = profile(tabs, {}, { sleepExcludedHosts: [...sites, 'absent.example'] })
    const wakes = woken(state)
    expect(wakes).toHaveLength(7)
    expect(wakes).toContain('t40')
    expect(new Set(wakes.filter((id) => id !== 't40').map((id) => tabs.find((t) => t.id === id)!.url.split('/')[2]))).toEqual(new Set(sites))
  })
})

describe('the state', () => {
  const ctx = (): Ctx => {
    let n = 0
    return { now: 1_000_000, newId: () => `id${++n}` }
  }
  const run = (c: Ctx, state: SidebarState, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, c), state)
  const open = (c: Ctx, ...urls: string[]) => run(c, createInitialState(c), ...urls.map((url): Action => ({ type: 'tab/open', url })))

  it('marks a tab "never put to sleep", and unmarks it', () => {
    const c = ctx()
    const s = open(c, 'https://a.fr/', 'https://b.fr/')
    const [a, b] = s.tabs
    const marked = run(c, s, { type: 'tab/keep-awake', id: a!.id, keep: true })
    expect(marked.tabs.find((t) => t.id === a!.id)?.keepAwake).toBe(true)
    expect(marked.tabs.find((t) => t.id === b!.id)?.keepAwake).toBeUndefined()
    const unmarked = run(c, marked, { type: 'tab/keep-awake', id: a!.id, keep: false })
    expect('keepAwake' in unmarked.tabs.find((t) => t.id === a!.id)!).toBe(false)
  })

  it('changes nothing for a tab that does not exist, a mark already there, or a value that is not a boolean', () => {
    const c = ctx()
    const s = open(c, 'https://a.fr/')
    const a = s.tabs[0]!
    expect(reduce(s, { type: 'tab/keep-awake', id: 'nope', keep: true }, c)).toBe(s)
    expect(reduce(s, { type: 'tab/keep-awake', id: a.id, keep: false }, c)).toBe(s)
    const marked = run(c, s, { type: 'tab/keep-awake', id: a.id, keep: true })
    expect(reduce(marked, { type: 'tab/keep-awake', id: a.id, keep: true }, c)).toBe(marked)
    expect(reduce(s, { type: 'tab/keep-awake', id: a.id, keep: 'yes' as unknown as boolean }, c)).toBe(s)
  })

  it('keeps the mark when the tab is pinned, moved or navigated', () => {
    const c = ctx()
    let s = open(c, 'https://a.fr/')
    const id = s.tabs[0]!.id
    s = run(c, s, { type: 'tab/keep-awake', id, keep: true }, { type: 'tab/pin', id }, { type: 'tab/update', id, patch: { url: 'https://a.fr/other', title: 'other' } })
    expect(s.tabs[0]).toMatchObject({ keepAwake: true, pinned: true, url: 'https://a.fr/other' })
    expect(activeTab(s)?.keepAwake).toBe(true)
  })

  it('excludes a site by its host, and brings it back', () => {
    const c = ctx()
    const s = createInitialState(c)
    const excluded = run(c, s, { type: 'sleep/exclude-site', site: 'https://www.youtube.com/watch?v=1', excluded: true })
    expect(excluded.settings.sleepExcludedHosts).toEqual(['youtube.com'])
    expect(run(c, excluded, { type: 'sleep/exclude-site', site: 'music.youtube.com', excluded: true })).toBe(excluded)
    expect(run(c, excluded, { type: 'sleep/exclude-site', site: 'music.youtube.com', excluded: false }).settings.sleepExcludedHosts).toEqual([])
    expect(run(c, s, { type: 'sleep/exclude-site', site: 'nonsense!', excluded: true })).toBe(s)
    expect(run(c, s, { type: 'sleep/exclude-site', site: 'a.com', excluded: false })).toBe(s)
  })

  it('cleans the sleep settings when they are updated', () => {
    const c = ctx()
    const s = run(c, createInitialState(c), { type: 'settings/update', patch: { sleepExcludedHosts: ['A.com', 'https://b.com/x', 'oops!', 'a.com'], sleepMode: 'hibernate' as never, sleepAfterMinutes: Number.NaN } })
    expect(s.settings.sleepExcludedHosts).toEqual(['a.com', 'b.com'])
    expect(s.settings.sleepMode).toBe('discard')
    expect(s.settings.sleepAfterMinutes).toBe(30)
  })

  it('fills the new settings missing from a file saved before, and drops what a hand-edited file got wrong', () => {
    const c = ctx()
    const base = createInitialState(c)
    const { sleepMode: _m, sleepExcludedHosts: _h, sleepSkipAudible: _a, sleepSkipPinned: _p, sleepNotify: _n, ...old } = base.settings
    const fixed = normalize({ ...base, settings: old as SidebarState['settings'] })
    expect(fixed.settings).toMatchObject({ sleepMode: 'discard', sleepExcludedHosts: [], sleepSkipAudible: true, sleepSkipPinned: false, sleepNotify: false })

    const opened = open(c, 'https://a.fr/', 'https://b.fr/')
    const hand = {
      ...opened,
      settings: { ...opened.settings, sleepExcludedHosts: ['ok.com', 'bad host', 3], sleepSkipAudible: 'nope', sleepMode: 'x' },
      tabs: [{ ...opened.tabs[0]!, keepAwake: 'yes' }, { ...opened.tabs[1]!, keepAwake: true }]
    } as unknown as SidebarState
    const normalized = normalize(hand)
    expect(normalized.settings).toMatchObject({ sleepExcludedHosts: ['ok.com'], sleepSkipAudible: true, sleepMode: 'discard' })
    expect('keepAwake' in normalized.tabs[0]!).toBe(false)
    expect(normalized.tabs[1]!.keepAwake).toBe(true)
  })
})

describe('the notice', () => {
  it('says one tab, or how many', () => {
    expect(sleepToastMessage(1)).toBe('Onglet mis en veille')
    expect(sleepToastMessage(3)).toBe('3 onglets mis en veille')
  })
})

describe('sleepVerdict: the cap, the sites never put to sleep, the camera (the sweep plan)', () => {
  it('puts a tab over the cap to sleep before its delay, and only in the sweep', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ idleMs: MINUTE, overCap: true })))).toBe('sleep')
    expect(reason(sleepVerdict(tab(), rules(), facts({ idleMs: MINUTE, overCap: false })))).toBe('recent')
    // Over the cap changes nothing to what protects a tab.
    expect(reason(sleepVerdict(tab(), rules(), facts({ idleMs: MINUTE, overCap: true, audible: true })))).toBe('audible')
    expect(reason(sleepVerdict(tab(), rules(), facts({ idleMs: MINUTE, overCap: true, probe: { ...clean, unsentInput: true } })))).toBe('unsent-input')
  })

  it('spares one tab per site never put to sleep (the one kept for the site), every tab with "Garder tous les onglets", and every tab of a caller that does not plan', () => {
    const excluded = rules({ sleepExcludedHosts: ['example.com'] })
    expect(reason(sleepVerdict(tab(), excluded, facts({ siteKeeper: true })))).toBe('excluded-site')
    expect(reason(sleepVerdict(tab(), excluded, facts({ siteKeeper: false })))).toBe('sleep')
    expect(reason(sleepVerdict(tab(), { ...excluded, sleepExcludedKeepAll: true }, facts({ siteKeeper: false })))).toBe('excluded-site')
    expect(reason(sleepVerdict(tab(), excluded, facts()))).toBe('excluded-site')
    expect(reason(sleepVerdict(tab(), excluded, facts({ siteKeeper: false }), 'reload'))).toBe('sleep')
  })

  it('leaves a page given the camera, the microphone or the screen alone, even with the sound setting off', () => {
    expect(reason(sleepVerdict(tab(), rules({ sleepSkipAudible: false }), facts({ capturing: true })))).toBe('capturing')
    expect(reason(sleepVerdict(tab(), rules(), facts({ capturing: true, overCap: true })))).toBe('capturing')
    expect(reason(sleepVerdict(tab(), rules(), facts({ capturing: true }), 'reload'))).toBe('capturing')
    expect(reason(sleepVerdict(tab(), rules(), facts({ capturing: false })))).toBe('sleep')
  })
})

describe('sleepVerdict (freeze first, then free)', () => {
  const freezing = (patch: Partial<SleepRules> = {}) => rules({ sleepFreezeAfterMinutes: 5, ...patch })

  it('freezes a tab hidden for the freeze delay, to the millisecond', () => {
    expect(reason(sleepVerdict(tab(), freezing(), facts({ idleMs: 5 * MINUTE - 1 }), 'freeze'))).toBe('recent')
    expect(reason(sleepVerdict(tab(), freezing(), facts({ idleMs: 5 * MINUTE }), 'freeze'))).toBe('sleep')
  })

  it('freezes nothing while the option is off, or the sleep is', () => {
    expect(reason(sleepVerdict(tab(), rules(), facts({ idleMs: 1e9 }), 'freeze'))).toBe('disabled')
    expect(reason(sleepVerdict(tab(), freezing({ sleepFreezeAfterMinutes: 0 }), facts({ idleMs: 1e9 }), 'freeze'))).toBe('disabled')
    expect(reason(sleepVerdict(tab(), freezing({ sleepAfterMinutes: 0 }), facts({ idleMs: 1e9 }), 'freeze'))).toBe('disabled')
  })

  it('never freezes a tab with sound (whatever the setting), a call, a download, or any tab of a site never put to sleep', () => {
    expect(reason(sleepVerdict(tab(), freezing({ sleepSkipAudible: false }), facts({ audible: true }), 'freeze'))).toBe('audible')
    expect(reason(sleepVerdict(tab(), freezing(), facts({ capturing: true }), 'freeze'))).toBe('capturing')
    expect(reason(sleepVerdict(tab(), freezing(), facts({ downloading: true }), 'freeze'))).toBe('downloading')
    expect(reason(sleepVerdict(tab(), freezing({ sleepExcludedHosts: ['example.com'] }), facts({ siteKeeper: false }), 'freeze'))).toBe('excluded-site')
  })

  it('asks the page last, and freezes neither a floating video nor text not sent', () => {
    expect(reason(sleepVerdict(tab(), freezing(), facts({ probe: undefined }), 'freeze'))).toBe('unchecked')
    expect(reason(sleepVerdict(tab(), freezing(), facts({ probe: { ...clean, pictureInPicture: true } }), 'freeze'))).toBe('picture-in-picture')
    expect(reason(sleepVerdict(tab(), freezing(), facts({ probe: { ...clean, unsentInput: true } }), 'freeze'))).toBe('unsent-input')
  })

  it('does not freeze earlier for being over the cap: the cap frees', () => {
    expect(reason(sleepVerdict(tab(), freezing(), facts({ idleMs: MINUTE, overCap: true }), 'freeze'))).toBe('recent')
  })
})

describe('the memory pressure', () => {
  it('reads what sysctl prints: 1 normal, 2 warning, 4 critical, anything else unknown', () => {
    expect(pressureOfLevel('1\n')).toBe('normal')
    expect(pressureOfLevel(' 2 ')).toBe('warning')
    expect(pressureOfLevel('4')).toBe('critical')
    for (const printed of ['', '0', '3', '12', 'abc', '1 2', '-1']) expect(pressureOfLevel(printed), printed).toBeNull()
  })

  it('falls back on the share of free memory: under 10 % a warning, under 5 % critical', () => {
    expect(pressureOfFreeMemory(50, 100)).toBe('normal')
    expect(pressureOfFreeMemory(10, 100)).toBe('normal')
    expect(pressureOfFreeMemory(9.9, 100)).toBe('warning')
    // Exactly 5 % is not under 5 %: critical pressure takes every tab's page away, so its edge is held to the letter.
    expect(pressureOfFreeMemory(5, 100)).toBe('warning')
    expect(pressureOfFreeMemory(4.9, 100)).toBe('critical')
    expect(pressureOfFreeMemory(1, 0)).toBe('normal')
    expect(pressureOfFreeMemory(Number.NaN, 100)).toBe('normal')
  })

  it('shortens the delay to 5 minutes and lowers the cap to 4 under a warning; under critical pressure the cap is 0', () => {
    const settings = { ...rules(), sleepAwakeMax: 12 }
    expect(sweepLimits(settings, 'normal')).toEqual({ rules: settings, cap: 12 })
    expect(sweepLimits(settings, 'warning')).toEqual({ rules: { ...settings, sleepAfterMinutes: 5 }, cap: PRESSURE_AWAKE_MAX })
    expect(sweepLimits(settings, 'critical')).toEqual({ rules: settings, cap: 0 })
    // A shorter delay and a lower cap than the pressure's are kept.
    expect(sweepLimits({ ...settings, sleepAfterMinutes: 2, sleepAwakeMax: 3 }, 'warning')).toEqual({ rules: { ...settings, sleepAfterMinutes: 2, sleepAwakeMax: 3 }, cap: 3 })
    // No cap is Infinity, until the pressure sets one.
    expect(sweepLimits({ ...settings, sleepAwakeMax: 0 }, 'normal').cap).toBe(Number.POSITIVE_INFINITY)
    expect(sweepLimits({ ...settings, sleepAwakeMax: 0 }, 'warning').cap).toBe(PRESSURE_AWAKE_MAX)
  })

  it('does not turn a sleep the user turned off back on', () => {
    const off = { ...rules({ sleepAfterMinutes: 0 }), sleepAwakeMax: 12 }
    expect(sweepLimits(off, 'warning').rules.sleepAfterMinutes).toBe(0)
    expect(sweepLimits(off, 'critical').cap).toBe(12)
  })
})

describe('planSweep (the cap, over every window)', () => {
  let n = 0
  const entry = (minutes: number, patch: Partial<Omit<SweepEntry, 'facts' | 'tab'>> & { facts?: Partial<SleepFacts>; tab?: Partial<SweepEntry['tab']> } = {}): SweepEntry => ({
    id: patch.id ?? `t${++n}`,
    tab: { ...tab(), ...patch.tab },
    facts: { ...facts({ idleMs: minutes * MINUTE, probe: undefined }), ...patch.facts },
    frozen: patch.frozen ?? 'no',
    ...(patch.kept !== undefined ? { kept: patch.kept } : {})
  })
  const over = (entries: SweepEntry[], cap: number, rulesPatch: Partial<SleepRules> = {}, mode: 'discard' | 'freeze' = 'discard') => [...planSweep(entries, rules(rulesPatch), cap, mode).overCap].sort()

  it('puts nothing over the cap while the tabs fit, and the oldest beyond it', () => {
    const entries = [entry(3, { id: 'c' }), entry(10, { id: 'a' }), entry(1, { id: 'd' }), entry(5, { id: 'b' })]
    expect(over(entries, 4)).toEqual([])
    expect(over(entries, Number.POSITIVE_INFINITY)).toEqual([])
    expect(over(entries, 2)).toEqual(['a', 'b'])
    expect(over(entries, 0)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does not count what is protected: on screen, sound, download, camera, marked, reloading itself, a page that said it holds something', () => {
    const protectedOnes = [
      entry(90, { facts: { selected: true } }),
      entry(90, { facts: { visiblePane: true } }),
      entry(90, { facts: { audible: true } }),
      entry(90, { facts: { downloading: true } }),
      entry(90, { facts: { capturing: true } }),
      entry(90, { tab: { keepAwake: true } }),
      entry(90, { tab: { autoReload: { seconds: 60 } as SweepEntry['tab']['autoReload'] } }),
      entry(90, { kept: true }),
      entry(90, { facts: { awake: false } })
    ]
    expect(over([...protectedOnes, entry(1, { id: 'only' })], 1)).toEqual([])
    expect(over([...protectedOnes, entry(1, { id: 'only' })], 0)).toEqual(['only'])
  })

  it('counts a tab that loads or was left a moment ago: the cap is about pages that hold memory', () => {
    expect(over([entry(0, { id: 'new' }), entry(1, { id: 'loading', facts: { loading: true } })], 1)).toEqual(['loading'])
  })

  it('counts pinned tabs, unless they are spared', () => {
    const pinned = [entry(9, { id: 'p', tab: { pinned: true } }), entry(1, { id: 'q' })]
    expect(over(pinned, 1)).toEqual(['p'])
    expect(over(pinned, 1, { sleepSkipPinned: true })).toEqual([])
  })

  it('keeps one tab awake per site never put to sleep, the one left last, and counts the others', () => {
    const site = { tab: { url: 'https://mail.example.com/inbox' } }
    const entries = [entry(30, { id: 'old', ...site }), entry(2, { id: 'last', ...site }), entry(20, { id: 'other', tab: { url: 'https://news.example.org/' } })]
    const plan = planSweep(entries, rules({ sleepExcludedHosts: ['example.com'] }), 1, 'discard')
    expect([...plan.keepers]).toEqual(['last'])
    expect([...plan.overCap]).toEqual(['old'])
    // A tab of the site on screen keeps it awake: no other is kept.
    const shown = planSweep([...entries, entry(0, { id: 'shown', ...site, facts: { selected: true } })], rules({ sleepExcludedHosts: ['example.com'] }), 10, 'discard')
    expect([...shown.keepers]).toEqual([])
    // With "Garder tous les onglets de ces sites", none of them counts.
    const all = planSweep(entries, rules({ sleepExcludedHosts: ['example.com'], sleepExcludedKeepAll: true }), 0, 'discard')
    expect([[...all.keepers], [...all.overCap]]).toEqual([[], ['other']])
  })

  it('counts a page the sweep froze on its way to being freed, and no other frozen page', () => {
    const entries = [entry(40, { id: 'auto', frozen: 'auto' }), entry(50, { id: 'byHand', frozen: 'other' }), entry(1, { id: 'live' })]
    expect(over(entries, 1)).toEqual(['auto'])
    // In the mode "Garder en mémoire" a frozen page is asleep already.
    expect(over(entries, 0, {}, 'freeze')).toEqual(['live'])
  })

  it('a frozen page does not keep its site awake', () => {
    const site = { tab: { url: 'https://example.com/' } }
    const plan = planSweep([entry(1, { id: 'frozen', frozen: 'other', ...site }), entry(5, { id: 'live', ...site })], rules({ sleepExcludedHosts: ['example.com'] }), 10, 'discard')
    expect([...plan.keepers]).toEqual(['live'])
  })
})

describe('the levels of the sleep', () => {
  it('are the three levels, with the delays, caps and freezing of the report', () => {
    expect(SLEEP_LEVELS).toEqual({
      moderate: { sleepAfterMinutes: 120, sleepAwakeMax: 30, sleepFreezeAfterMinutes: 0 },
      balanced: { sleepAfterMinutes: 30, sleepAwakeMax: 12, sleepFreezeAfterMinutes: 0 },
      maximum: { sleepAfterMinutes: 10, sleepAwakeMax: 6, sleepFreezeAfterMinutes: 5 }
    })
  })
})
