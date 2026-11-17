import { describe, expect, it } from 'vitest'
import {
  AUTO_RELOAD_DEFAULT_SECONDS,
  AUTO_RELOAD_EDITING_SCRIPT,
  AUTO_RELOAD_MAX_SECONDS,
  AUTO_RELOAD_MIN_SECONDS,
  AUTO_RELOAD_PRESETS,
  AUTO_RELOAD_RETRY_MS,
  autoReloadLabel,
  autoReloadSeconds,
  autoReloadTooltip,
  autoReloadVerdict,
  cleanAutoReload,
  countdownFor,
  countdownText,
  isAutoReloadable,
  isPresetInterval,
  parseAutoReloadInterval,
  recheckAt,
  restartedCountdown,
  splitInterval,
  wakeDelay,
  withReloadAt,
  type AutoReloadFacts
} from './auto-reload'
import { actionToDispatch, rankCandidates, type Candidate } from './command-bar'
import { NO_FACTS, menuKey } from './menu-state'
import { canOpenInPrivate, privateAction } from './private-window'
import { activeTab, createInitialState, reduce, type Action } from './sidebar'
import { sleepVerdict, type SleepFacts, type SleepRules } from './sleep'
import { cleanTabs } from './state-clean'
import { frenchSpaces } from './french-typography'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

describe('the interval', () => {
  it('goes from 5 seconds to 24 hours, in whole seconds', () => {
    expect(AUTO_RELOAD_MIN_SECONDS).toBe(5)
    expect(AUTO_RELOAD_MAX_SECONDS).toBe(86_400)
    expect(autoReloadSeconds(5)).toBe(5)
    expect(autoReloadSeconds(86_400)).toBe(86_400)
    expect(autoReloadSeconds(29.6)).toBe(30)
    for (const bad of [4, 4.4, 0, -30, 86_401, NaN, Infinity, -Infinity, '30', null, undefined, {}, [30], true]) expect(autoReloadSeconds(bad), String(bad)).toBeNull()
  })

  it('proposes the list of the Toolkit module, all within the bounds, and 30 s by default', () => {
    expect(AUTO_RELOAD_PRESETS).toEqual([5, 10, 30, 60, 120, 300, 600])
    expect(AUTO_RELOAD_DEFAULT_SECONDS).toBe(30)
    expect(AUTO_RELOAD_PRESETS.every((s) => autoReloadSeconds(s) === s)).toBe(true)
    expect(isPresetInterval(60)).toBe(true)
    expect(isPresetInterval(61)).toBe(false)
  })

  it('reads a saved setting: a usable interval is kept as a record of one key, anything else is no setting', () => {
    expect(cleanAutoReload({ seconds: 30 })).toEqual({ seconds: 30 })
    expect(cleanAutoReload({ seconds: 30, other: 'x' })).toEqual({ seconds: 30 })
    expect(cleanAutoReload({ seconds: 29.6 })).toEqual({ seconds: 30 })
    for (const bad of [{ seconds: 4 }, { seconds: 86_401 }, { seconds: -1 }, { seconds: '30' }, { seconds: NaN }, { seconds: null }, {}, 30, '30', true, [30], null, undefined]) {
      expect(cleanAutoReload(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('says an interval the way a person would', () => {
    expect(autoReloadLabel(5)).toBe(frenchSpaces('5 s'))
    expect(autoReloadLabel(30)).toBe(frenchSpaces('30 s'))
    expect(autoReloadLabel(60)).toBe(frenchSpaces('1 min'))
    expect(autoReloadLabel(90)).toBe(frenchSpaces('1 min 30 s'))
    expect(autoReloadLabel(600)).toBe(frenchSpaces('10 min'))
    expect(autoReloadLabel(3600)).toBe(frenchSpaces('1 h'))
    expect(autoReloadLabel(5400)).toBe(frenchSpaces('1 h 30 min'))
    expect(autoReloadLabel(3605)).toBe(frenchSpaces('1 h 5 s'))
    expect(autoReloadLabel(86_400)).toBe(frenchSpaces('24 h'))
    expect(autoReloadTooltip(30)).toBe(frenchSpaces('Recharge toutes les 30 s'))
    expect(autoReloadTooltip(300)).toBe(frenchSpaces('Recharge toutes les 5 min'))
  })

  it('says the time left on a row: seconds under a minute, minutes and seconds under an hour, rounded up, never negative', () => {
    expect(countdownText(0)).toBe(frenchSpaces('0 s'))
    expect(countdownText(1)).toBe(frenchSpaces('1 s'))
    expect(countdownText(1000)).toBe(frenchSpaces('1 s'))
    expect(countdownText(59_000)).toBe(frenchSpaces('59 s'))
    expect(countdownText(59_001)).toBe('1:00')
    expect(countdownText(60_000)).toBe('1:00')
    expect(countdownText(65_000)).toBe('1:05')
    expect(countdownText(3_599_000)).toBe('59:59')
    expect(countdownText(3_600_000)).toBe('1:00:00')
    expect(countdownText(-4000)).toBe(frenchSpaces('0 s'))
    expect(countdownText(Number.NaN)).toBe('')
    expect(countdownText(Number.POSITIVE_INFINITY)).toBe('')
  })

  it('parses a typed interval in its unit, and says what is wrong when it cannot', () => {
    expect(parseAutoReloadInterval('30', 'seconds')).toEqual({ seconds: 30 })
    expect(parseAutoReloadInterval(' 2 ', 'minutes')).toEqual({ seconds: 120 })
    expect(parseAutoReloadInterval('1,5', 'minutes')).toEqual({ seconds: 90 })
    expect(parseAutoReloadInterval('1.5', 'hours')).toEqual({ seconds: 5400 })
    expect(parseAutoReloadInterval('24', 'hours')).toEqual({ seconds: 86_400 })
    expect(parseAutoReloadInterval('5', 'seconds')).toEqual({ seconds: 5 })
    expect(parseAutoReloadInterval('', 'seconds')).toEqual({ error: 'Saisissez une durée.' })
    expect(parseAutoReloadInterval('   ', 'seconds')).toEqual({ error: 'Saisissez une durée.' })
    expect(parseAutoReloadInterval('4', 'seconds')).toEqual({ error: 'Au moins 5 secondes.' })
    expect(parseAutoReloadInterval('0', 'minutes')).toEqual({ error: 'Au moins 5 secondes.' })
    expect(parseAutoReloadInterval('25', 'hours')).toEqual({ error: '24 heures au plus.' })
    expect(parseAutoReloadInterval('100000', 'seconds')).toEqual({ error: '24 heures au plus.' })
    for (const bad of ['abc', '-5', '1e3', '0x10', '1..5', '1.', '.5', '5 s', 'NaN', 'Infinity']) {
      expect(parseAutoReloadInterval(bad, 'seconds'), bad).toEqual({ error: 'Saisissez un nombre, par exemple 30.' })
    }
  })

  it('shows an interval in the biggest unit that divides it evenly', () => {
    expect(splitInterval(30)).toEqual({ value: '30', unit: 'seconds' })
    expect(splitInterval(90)).toEqual({ value: '90', unit: 'seconds' })
    expect(splitInterval(120)).toEqual({ value: '2', unit: 'minutes' })
    expect(splitInterval(3600)).toEqual({ value: '1', unit: 'hours' })
    expect(splitInterval(7200)).toEqual({ value: '2', unit: 'hours' })
    for (const seconds of [5, 45, 60, 600, 3600, 5400, 86_400]) {
      const { value, unit } = splitInterval(seconds)
      expect(parseAutoReloadInterval(value, unit), String(seconds)).toEqual({ seconds })
    }
  })
})

describe('the pages that can be reloaded', () => {
  it('are the web and local files; nothing else', () => {
    for (const url of ['https://example.com/', 'http://localhost:3000/a?b=1#c', 'file:///Users/me/index.html']) expect(isAutoReloadable(url), url).toBe(true)
    for (const url of ['about:blank', 'chrome-extension://abc/page.html', 'devtools://devtools/bundled/inspector.html', 'view-source:https://example.com/', 'lucium-error:retry', 'not a url', '']) expect(isAutoReloadable(url), url).toBe(false)
  })
})

describe('autoReloadVerdict', () => {
  const tab = { url: 'https://example.com/', autoReload: { seconds: 30 } }
  const facts = (patch: Partial<AutoReloadFacts> = {}): AutoReloadFacts => ({ awake: true, loading: false, now: 100_000, dueAt: 100_000, editing: false, ...patch })
  const reason = (verdict: ReturnType<typeof autoReloadVerdict>) => (verdict.reload ? 'reload' : verdict.reason)

  it('reloads a tab whose countdown has ended, whose page is awake, loaded and not being typed in', () => {
    expect(autoReloadVerdict(tab, facts())).toEqual({ reload: true })
    expect(autoReloadVerdict(tab, facts({ now: 250_000 }))).toEqual({ reload: true })
  })

  it('waits for the end of the countdown', () => {
    expect(reason(autoReloadVerdict(tab, facts({ now: 99_999 })))).toBe('not-due')
  })

  it('does nothing for a tab without the setting', () => {
    expect(reason(autoReloadVerdict({ url: tab.url }, facts()))).toBe('off')
  })

  it('never acts on a tab without a live page: a tab asleep or frozen is not woken by the countdown', () => {
    expect(reason(autoReloadVerdict(tab, facts({ awake: false })))).toBe('no-page')
  })

  it('leaves a page that cannot be reloaded alone', () => {
    expect(reason(autoReloadVerdict({ ...tab, url: 'about:blank' }, facts()))).toBe('not-reloadable')
    expect(reason(autoReloadVerdict({ ...tab, url: 'chrome-extension://abc/p.html' }, facts()))).toBe('not-reloadable')
  })

  it('never reloads a page that is still loading, so that no tab has two reloads in flight', () => {
    expect(reason(autoReloadVerdict(tab, facts({ loading: true })))).toBe('loading')
  })

  it('asks the page last: without its answer the verdict is "unchecked", never a reload', () => {
    const { editing: _ignored, ...unasked } = facts()
    expect(reason(autoReloadVerdict(tab, unasked))).toBe('unchecked')
  })

  it('never cuts a typing short', () => {
    expect(reason(autoReloadVerdict(tab, facts({ editing: true })))).toBe('editing')
  })

  it('applies its rules in order: what cannot be done wins over what could wait', () => {
    expect(reason(autoReloadVerdict({ url: 'about:blank' }, facts({ awake: false, loading: true, editing: true })))).toBe('off')
    expect(reason(autoReloadVerdict({ ...tab, url: 'about:blank' }, facts({ awake: false, loading: true, editing: true })))).toBe('no-page')
    expect(reason(autoReloadVerdict({ ...tab, url: 'about:blank' }, facts({ loading: true, editing: true })))).toBe('not-reloadable')
    expect(reason(autoReloadVerdict(tab, facts({ loading: true, editing: true, now: 1 })))).toBe('loading')
    expect(reason(autoReloadVerdict(tab, facts({ editing: true, now: 1 })))).toBe('not-due')
  })
})

describe('the countdowns', () => {
  it('a tab gets a whole interval from now; it keeps its countdown while the interval is the same, and starts over when the interval changes', () => {
    const first = countdownFor(undefined, 30, 1_000)
    expect(first).toEqual({ seconds: 30, at: 31_000 })
    expect(countdownFor(first, 30, 20_000)).toBe(first)
    expect(countdownFor(first, 60, 20_000)).toEqual({ seconds: 60, at: 80_000 })
  })

  it('starts over from the load of the page, not from the previous reload', () => {
    expect(restartedCountdown(30, 50_000)).toEqual({ seconds: 30, at: 80_000 })
  })

  it('looks again soon at a tab it could not reload now, and after a whole interval at a page it can never reload', () => {
    expect(AUTO_RELOAD_RETRY_MS).toBe(5000)
    expect(recheckAt('editing', 300, 10_000)).toBe(15_000)
    expect(recheckAt('loading', 300, 10_000)).toBe(15_000)
    expect(recheckAt('unchecked', 300, 10_000)).toBe(15_000)
    expect(recheckAt('not-reloadable', 300, 10_000)).toBe(310_000)
    expect(recheckAt('no-page', 300, 10_000)).toBeNull()
    expect(recheckAt('off', 300, 10_000)).toBeNull()
  })

  it('wakes for the soonest countdown, at once when one has ended, never when there is none', () => {
    expect(wakeDelay([], 1_000)).toBeNull()
    expect(wakeDelay([{ seconds: 30, at: 31_000 }, { seconds: 5, at: 6_000 }], 1_000)).toBe(5_000)
    expect(wakeDelay([{ seconds: 30, at: 500 }], 1_000)).toBe(0)
  })
})

describe('the question put to the page', () => {
  /** A stand-in for the page's document: an element is whatever the script reads on it. */
  const answer = (active: unknown): unknown => new Function('document', `return ${AUTO_RELOAD_EDITING_SCRIPT}`)({ activeElement: active, body: { tagName: 'BODY' }, documentElement: { tagName: 'HTML' } })
  const field = (tagName: string, value: string, type = 'text') => ({ tagName, value, type })

  it('says yes for a focused field that holds text', () => {
    expect(answer(field('INPUT', 'abc'))).toBe(true)
    expect(answer(field('INPUT', 'secret', 'password'))).toBe(true)
    expect(answer(field('INPUT', '2026-10-24', 'date'))).toBe(true)
    expect(answer(field('TEXTAREA', 'a long message'))).toBe(true)
    expect(answer({ tagName: 'DIV', isContentEditable: true, textContent: 'écrit à la main' })).toBe(true)
    expect(answer({ tagName: 'SELECT' })).toBe(true)
  })

  it('says no for nothing focused, an empty field (a page that focuses its search box on its own), or a control that holds no text', () => {
    expect(answer(null)).toBe(false)
    expect(answer({ tagName: 'BODY' })).toBe(false)
    expect(answer(field('INPUT', ''))).toBe(false)
    expect(answer(field('TEXTAREA', ''))).toBe(false)
    expect(answer({ tagName: 'DIV', isContentEditable: true, textContent: '  \n ' })).toBe(false)
    expect(answer(field('INPUT', 'on', 'checkbox'))).toBe(false)
    expect(answer(field('INPUT', 'Envoyer', 'submit'))).toBe(false)
    expect(answer({ tagName: 'BUTTON' })).toBe(false)
    expect(answer({ tagName: 'A' })).toBe(false)
  })

  it('looks into shadow roots and same-origin frames, and takes a frame it cannot read for no field', () => {
    expect(answer({ tagName: 'MY-INPUT', shadowRoot: { activeElement: field('INPUT', 'abc') } })).toBe(true)
    expect(answer({ tagName: 'MY-INPUT', shadowRoot: { activeElement: null } })).toBe(false)
    expect(answer({ tagName: 'IFRAME', contentDocument: { activeElement: field('TEXTAREA', 'dans le cadre') } })).toBe(true)
    const crossOrigin = { tagName: 'IFRAME', get contentDocument(): never { throw new Error('blocked a frame with origin') } }
    expect(answer(crossOrigin)).toBe(false)
  })
})

describe('the setting on a tab', () => {
  const opened = run(createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
  const id = opened.tabs[0]!.id
  const set = (state: typeof opened, seconds: unknown) => run(state, { type: 'tab/auto-reload', id, seconds } as Action)

  it('turns on, changes and turns off', () => {
    const on = set(opened, 30)
    expect(on.tabs[0]!.autoReload).toEqual({ seconds: 30 })
    expect(set(on, 60).tabs[0]!.autoReload).toEqual({ seconds: 60 })
    const off = set(on, null)
    expect(off.tabs[0]).not.toHaveProperty('autoReload')
  })

  it('keeps the same state when nothing changes (the countdown is not restarted by choosing the interval already chosen)', () => {
    const on = set(opened, 30)
    expect(set(on, 30)).toBe(on)
    expect(set(opened, null)).toBe(opened)
  })

  it('refuses an interval the renderer made up: out of bounds, not a number', () => {
    const on = set(opened, 30)
    for (const bad of [4, 0, -5, 86_401, NaN, Infinity, '30', undefined, {}, [30], true]) expect(set(on, bad), String(bad)).toBe(on)
    expect(set(opened, 3)).toBe(opened)
  })

  it('does nothing for a tab that does not exist', () => {
    expect(reduce(opened, { type: 'tab/auto-reload', id: 'ghost', seconds: 30 }, ctx)).toBe(opened)
  })

  it('stays on the tab when it is pinned, unpinned or moved to another space; a duplicate and an archived tab do not inherit it', () => {
    const on = set(opened, 30)
    expect(run(on, { type: 'tab/pin', id }).tabs[0]!.autoReload).toEqual({ seconds: 30 })
    expect(run(on, { type: 'tab/pin', id }, { type: 'tab/unpin', id }).tabs[0]!.autoReload).toEqual({ seconds: 30 })
    const duplicated = run(on, { type: 'tab/duplicate', id })
    expect(duplicated.tabs.find((t) => t.id !== id)).not.toHaveProperty('autoReload')
    const archived = run(on, { type: 'tab/archive', id })
    expect(archived.tabs).toHaveLength(0)
    expect(JSON.stringify(archived.archive)).not.toContain('autoReload')
  })

  it('survives a round trip through the file: saved, read back through the cleaner of the tabs, unchanged', () => {
    const on = set(opened, 90)
    const spaceIds = new Set(on.spaces.map((s) => s.id))
    const read = cleanTabs(JSON.parse(JSON.stringify(on.tabs)), spaceIds, new Map())
    expect(read[0]!.autoReload).toEqual({ seconds: 90 })
    const hand = cleanTabs([{ ...on.tabs[0], autoReload: { seconds: 2 } }], spaceIds, new Map())
    expect(hand[0]).toBeDefined()
    expect(hand[0]).not.toHaveProperty('autoReload')
  })

  it('is accepted by a private window (in memory only: that window never writes its state), and so is its panel', () => {
    const action: Action = { type: 'tab/auto-reload', id, seconds: 30 }
    expect(privateAction(action)).toEqual(action)
    expect(canOpenInPrivate('autoreload')).toBe(true)
  })

  it('makes the menu of the window rebuild, so that its check mark follows the interval of the tab on screen', () => {
    const key = (state: typeof opened) => menuKey(state, [], NO_FACTS)
    expect(key(set(opened, 30))).not.toBe(key(opened))
    expect(key(set(opened, 30))).not.toBe(key(set(opened, 60)))
    expect(key(set(set(opened, 30), null))).toBe(key(opened))
    // A page that cannot be reloaded greys the entry out: the menu rebuilds when the page on screen becomes one.
    expect(key(run(opened, { type: 'tab/update', id, patch: { url: 'about:blank' } }))).not.toBe(key(opened))
  })
})

describe('the command bar', () => {
  const opened = run(createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
  const id = opened.tabs[0]!.id
  const actionsFor = (state: typeof opened, query: string) => rankCandidates(query, state).filter((c): c is Extract<Candidate, { kind: 'action' }> => c.kind === 'action' && c.action.startsWith('auto-reload'))

  it('offers to set the automatic reload of the tab on screen when typed, and opens its panel', () => {
    const found = actionsFor(opened, 'recharger')
    expect(found.map((c) => c.action)).toEqual(['auto-reload'])
    expect(found[0]!.detail).toBe('Action')
    expect(actionToDispatch('auto-reload', opened)).toBeNull()
    expect(actionsFor(opened, 'automatiquement').map((c) => c.action)).toEqual(['auto-reload'])
  })

  it('offers to stop it when it is on, and says the interval', () => {
    const on = run(opened, { type: 'tab/auto-reload', id, seconds: 90 })
    const found = actionsFor(on, 'recharger')
    expect(found.map((c) => c.action)).toEqual(['auto-reload', 'auto-reload-off'])
    expect(found[0]!.detail).toBe(frenchSpaces('Actif · toutes les 1 min 30 s'))
    expect(actionToDispatch('auto-reload-off', on)).toEqual({ type: 'tab/auto-reload', id, seconds: null })
    expect(actionToDispatch('auto-reload-off', opened)).toBeNull()
  })

  it('is not offered for a page that cannot be reloaded, nor on an empty bar', () => {
    expect(actionsFor(run(opened, { type: 'tab/update', id, patch: { url: 'about:blank' } }), 'recharger')).toEqual([])
    expect(actionsFor(opened, '')).toEqual([])
  })

  it('does not let the active tab be anything but the one on screen', () => {
    expect(activeTab(opened)?.id).toBe(id)
  })
})

describe('sleep', () => {
  const rules: SleepRules = { sleepAfterMinutes: 30, sleepExcludedHosts: [], sleepSkipAudible: true, sleepSkipPinned: false }
  const facts: SleepFacts = { awake: true, selected: false, visiblePane: false, loading: false, audible: false, downloading: false, idleMs: 31 * 60_000, probe: { pictureInPicture: false, unsentInput: false } }
  const tab = { url: 'https://example.com/', pinned: false }

  it('the delay leaves alone a tab that reloads itself: putting it to sleep would silently end that', () => {
    expect(sleepVerdict(tab, rules, facts)).toEqual({ sleep: true })
    expect(sleepVerdict({ ...tab, autoReload: { seconds: 30 } }, rules, facts)).toEqual({ sleep: false, reason: 'auto-reload' })
  })

  it('but the user can still put such a tab to sleep by hand', () => {
    expect(sleepVerdict({ ...tab, autoReload: { seconds: 30 } }, rules, facts, 'manual')).toEqual({ sleep: true })
  })
})

describe('the end of the countdowns in the runtime the interface is given', () => {
  const awake = { loading: false, audible: false, muted: false, awake: true }
  const runtime = { tabs: { a: awake, b: awake, c: awake }, canGoBack: false, canGoForward: false }
  const ends: Record<string, number> = { a: 5000, b: 6000, ghost: 7000 }

  it('goes on the tabs that have the setting and a countdown, and only on them', () => {
    const tabs = [{ id: 'a', autoReload: { seconds: 30 } }, { id: 'b' }, { id: 'c', autoReload: { seconds: 30 } }, { id: 'ghost', autoReload: { seconds: 30 } }]
    const given = withReloadAt(runtime, tabs, (id) => ends[id])
    // b has a countdown left behind but no setting; c has the setting but no countdown (asleep); ghost has no runtime entry.
    expect(given.tabs).toEqual({ a: { ...awake, reloadAt: 5000 }, b: awake, c: awake })
    expect(runtime.tabs.a).toEqual(awake)
  })

  it('leaves the runtime itself when no tab has one, so that nothing is copied for a profile that never uses it', () => {
    expect(withReloadAt(runtime, [{ id: 'a' }, { id: 'c', autoReload: { seconds: 30 } }], () => undefined)).toBe(runtime)
  })
})
