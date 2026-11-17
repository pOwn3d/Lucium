import { describe, expect, it } from 'vitest'
import type { OverlayRequest } from './ipc'
import { defaultSettings } from './model'
import {
  AUTO_PERCENT_MAX,
  AUTO_PERCENT_MIN,
  PANEL_NEED,
  PANEL_PERCENT_MAX,
  PANEL_PERCENT_MIN,
  PANEL_PLACEMENT,
  PANEL_PRESETS,
  PANEL_SAMPLE,
  PANEL_SCREENS_MAX,
  SMALL_WIDTH,
  WIDE_WIDTH,
  autoPercent,
  centredIn,
  chosenPercent,
  cleanPanelSizes,
  committedPercent,
  fitLimit,
  knownScreens,
  panelFactor,
  panelIsScaled,
  previewOf,
  readScreen,
  rescaledContent,
  scaledWindow,
  screenKey,
  screenKind,
  screenNotice,
  screenOf,
  withNoticed,
  withPanelSize,
  type PanelSizes,
  type ScreenInfo,
  type ScreenView,
  type WindowSizes
} from './panel-scale'
import { createInitialState, normalize, parseSavedState, reduce } from './sidebar'

const display = (width: number, height: number, extra: { label?: string; internal?: boolean; scaleFactor?: number } = {}) => ({ label: extra.label ?? '', internal: extra.internal ?? false, scaleFactor: extra.scaleFactor ?? 1, size: { width, height } })
const screenAt = (width: number, height: number, extra: { label?: string; internal?: boolean; scaleFactor?: number } = {}): ScreenInfo => screenOf(display(width, height, extra))!

const ULTRAWIDE = screenAt(3440, 1440, { label: 'LG UltraWide' })
const LAPTOP = screenAt(1512, 982, { internal: true, label: 'Built-in Retina Display', scaleFactor: 2 })

describe('« Automatique »: the size of the panels worked out from the screen', () => {
  // The table of screens: what a person has on the desk, in points (the size a window is laid out in), and what Automatique gives the panels there.
  const TABLE: Array<[string, number, number, number]> = [
    ['an old 13-inch laptop', 1280, 800, 95],
    ['a 1366 × 768 laptop', 1366, 768, 95],
    ['a 13-inch at its larger default', 1440, 900, 95],
    ['a MacBook Air 13', 1470, 956, 100],
    ['a MacBook Pro 14 (the reference)', 1512, 982, 100],
    ['a MacBook Pro 16', 1728, 1117, 105],
    ['a 1080p monitor', 1920, 1080, 105],
    ['a 27-inch 1440p monitor', 2560, 1440, 120],
    ['the 34-inch ultra-wide of the mockup', 3440, 1440, 125],
    ['a 49-inch super ultra-wide', 5120, 1440, 130],
    ['a 4K monitor left at 100 %', 3840, 2160, 135]
  ]

  for (const [name, width, height, percent] of TABLE) {
    it(`gives ${percent} % to ${name} (${width} × ${height})`, () => {
      expect(autoPercent({ width, height })).toBe(percent)
    })
  }

  it('is larger as the screen is larger, by steps of 5, and never leaves its bounds, whatever the screen says', () => {
    let last = 0
    for (const width of [800, 1024, 1280, 1512, 1920, 2560, 3440, 5120, 7680]) {
      const percent = autoPercent({ width, height: Math.round(width * 0.5625) })
      expect(percent, String(width)).toBeGreaterThanOrEqual(last)
      expect(percent % 5, String(width)).toBe(0)
      expect(percent).toBeGreaterThanOrEqual(AUTO_PERCENT_MIN)
      expect(percent).toBeLessThanOrEqual(AUTO_PERCENT_MAX)
      last = percent
    }
    expect(autoPercent({ width: 100, height: 100 })).toBe(AUTO_PERCENT_MIN)
    expect(autoPercent({ width: 60000, height: 30000 })).toBe(AUTO_PERCENT_MAX)
    expect(autoPercent({ width: 0, height: 0 })).toBe(AUTO_PERCENT_MIN)
  })

  it('counts an ultra-wide screen for its width without making it a giant one: 3440 × 1440 gets less than a 4K at 100 %', () => {
    expect(autoPercent({ width: 3440, height: 1440 })).toBeLessThan(autoPercent({ width: 3840, height: 2160 }))
  })

  it('is what a screen with no choice gets, and a choice replaces it', () => {
    expect(chosenPercent({}, ULTRAWIDE)).toBe(125)
    const sizes = withPanelSize({}, ULTRAWIDE, 90, 1)
    expect(chosenPercent(sizes, ULTRAWIDE)).toBe(90)
    expect(chosenPercent(sizes, LAPTOP)).toBe(100)
  })
})

describe('the factor of the panels: never larger than the window', () => {
  const roomOf = (width: number, height: number) => ({ width, height })

  it('lets the window hold what it can: 100 % in a window that is not large enough for more, the choice in one that is', () => {
    // 1360 × 860, the size the main window opens at: it holds 1.65.
    expect(fitLimit(roomOf(1360, 860), PANEL_NEED)).toBe(1.65)
    expect(fitLimit(roomOf(2000, 1300), PANEL_NEED)).toBe(2.5)
    // The size of the panels is never made worse than it was: a window too small for 100 % keeps 100 %.
    expect(fitLimit(roomOf(720, 480), PANEL_NEED)).toBe(1)
    expect(fitLimit(roomOf(300, 200), PANEL_NEED)).toBe(1)
    expect(fitLimit(roomOf(Number.NaN, 800), PANEL_NEED)).toBe(1)
  })

  it('works to the nearest 5 % downwards, so that the size does not change at every pixel of a window being dragged', () => {
    expect(fitLimit(roomOf(1000, 900), PANEL_NEED)).toBe(1.4)
    expect(fitLimit(roomOf(1049, 900), PANEL_NEED)).toBe(1.45)
    expect(fitLimit(roomOf(1050, 900), PANEL_NEED)).toBe(1.5)
  })

  it('takes the zoom of the interface into account: the panels are drawn on top of it', () => {
    expect(fitLimit(roomOf(1360, 860), PANEL_NEED, 1.3)).toBe(1.25)
    expect(fitLimit(roomOf(1360, 860), PANEL_NEED, 2)).toBe(1)
  })

  it('brings the choice back to the window when it is above 100 %: Automatique on the ultra-wide in a window that cannot hold it', () => {
    const input = { sizes: {}, screen: ULTRAWIDE, need: PANEL_NEED }
    expect(panelFactor({ ...input, room: roomOf(1360, 860) })).toBe(1.25)
    // The window is smaller than 1.25 × the need: it holds 1.15.
    expect(panelFactor({ ...input, room: roomOf(810, 700) })).toBe(1.15)
    expect(panelFactor({ ...input, room: roomOf(720, 480) })).toBe(1)
  })

  it('does it for a choice made by hand too: Très grande (150 %) in a window of 1000 × 700 is what the window holds', () => {
    const sizes = withPanelSize({}, LAPTOP, 150, 1)
    expect(panelFactor({ sizes, screen: LAPTOP, room: roomOf(1000, 700), need: PANEL_NEED })).toBe(1.3)
    expect(panelFactor({ sizes, screen: LAPTOP, room: roomOf(2000, 1400), need: PANEL_NEED })).toBe(1.5)
  })

  it('leaves a size below 100 % alone: a small window is no reason to shrink them further, and a small screen is why they are small', () => {
    const sizes = withPanelSize({}, LAPTOP, 80, 1)
    expect(panelFactor({ sizes, screen: LAPTOP, room: roomOf(400, 300), need: PANEL_NEED })).toBe(0.8)
    expect(panelFactor({ sizes: {}, screen: screenAt(1280, 800), room: roomOf(400, 300), need: PANEL_NEED })).toBe(0.95)
  })
})

describe('the screens: what they are known by', () => {
  it('is the model, the size and the density, never the id the system gives: the same monitor plugged in again is the same screen', () => {
    const first = screenOf({ ...display(3440, 1440, { label: 'LG UltraWide' }), id: 2077 } as never)
    const again = screenOf({ ...display(3440, 1440, { label: 'LG UltraWide' }), id: 99118 } as never)
    expect(first!.key).toBe('LG UltraWide|3440x1440@1')
    expect(again!.key).toBe(first!.key)
  })

  it('names the built-in screen by what it is, not by the name the system gives it in its language', () => {
    const english = screenOf(display(1512, 982, { internal: true, label: 'Built-in Retina Display', scaleFactor: 2 }))!
    const french = screenOf(display(1512, 982, { internal: true, label: 'Écran Retina intégré', scaleFactor: 2 }))!
    expect(english.key).toBe('built-in|1512x982@2')
    expect(french.key).toBe(english.key)
    expect(english.label).toBe('')
  })

  it('tells another monitor of the same name apart by its size and its density, and counts two identical monitors as one (the same size, the same choice)', () => {
    expect(screenAt(2560, 1440, { label: 'DELL U2723QE' }).key).not.toBe(screenAt(3840, 2160, { label: 'DELL U2723QE' }).key)
    expect(screenAt(2560, 1440, { label: 'X', scaleFactor: 1 }).key).not.toBe(screenAt(2560, 1440, { label: 'X', scaleFactor: 2 }).key)
    expect(screenAt(2560, 1440, { label: 'X' }).key).toBe(screenAt(2560, 1440, { label: 'X' }).key)
  })

  it('keeps a label fit to be a key: no control character, a bounded length, and a display with no usable size is no screen', () => {
    expect(screenAt(1920, 1080, { label: '  A\u0000B\n C  ' }).label).toBe('A B C')
    expect(screenAt(1920, 1080, { label: 'x'.repeat(500) }).label).toHaveLength(80)
    expect(screenOf(display(0, 1080))).toBeNull()
    expect(screenOf(display(1920, Number.NaN))).toBeNull()
    expect(screenOf(display(99999, 1080))).toBeNull()
    expect(screenOf({ scaleFactor: 1 } as never)).toBeNull()
    expect(screenAt(1920, 1080, { scaleFactor: 1.5000001 }).scaleFactor).toBe(1.5)
    expect(screenAt(1920, 1080, { scaleFactor: Number.NaN }).scaleFactor).toBe(1)
  })

  it('is rebuilt from what the interface sends: a key that is not the one the fields give is not believed', () => {
    const sent = { key: 'whatever|1x1@1', label: 'LG UltraWide', internal: false, width: 3440, height: 1440, scaleFactor: 1 }
    expect(readScreen(sent)!.key).toBe('LG UltraWide|3440x1440@1')
    expect(readScreen({ ...sent, width: -4 })).toBeNull()
    expect(readScreen(null)).toBeNull()
    expect(readScreen([])).toBeNull()
    expect(readScreen('screen')).toBeNull()
  })
})

describe('the choices kept per screen', () => {
  it('keeps a choice for the screen it was made on, and another screen has its own', () => {
    let sizes = withPanelSize({}, ULTRAWIDE, 125, 10)
    sizes = withPanelSize(sizes, LAPTOP, 90, 20)
    expect(sizes[ULTRAWIDE.key]!.percent).toBe(125)
    expect(sizes[LAPTOP.key]!.percent).toBe(90)
    expect(sizes[ULTRAWIDE.key]).toMatchObject({ label: 'LG UltraWide', width: 3440, height: 1440, scaleFactor: 1, internal: false, noticed: false, used: 10 })
  })

  it('brings a size to the slider (80 to 160 %) and makes a whole of it', () => {
    expect(withPanelSize({}, ULTRAWIDE, 400, 1)[ULTRAWIDE.key]!.percent).toBe(PANEL_PERCENT_MAX)
    expect(withPanelSize({}, ULTRAWIDE, 10, 1)[ULTRAWIDE.key]!.percent).toBe(PANEL_PERCENT_MIN)
    expect(withPanelSize({}, ULTRAWIDE, 112.4, 1)[ULTRAWIDE.key]!.percent).toBe(112)
    expect(withPanelSize({}, ULTRAWIDE, Number.NaN, 1)).toEqual({})
  })

  it('puts a screen back to Automatique by removing its choice, and keeps nothing of a screen that says nothing', () => {
    const chosen = withPanelSize({}, ULTRAWIDE, 125, 1)
    expect(withPanelSize(chosen, ULTRAWIDE, null, 2)).toEqual({})
    // Nothing to remove: the same object comes back, so that nothing is saved for nothing.
    const none: PanelSizes = {}
    expect(withPanelSize(none, ULTRAWIDE, null, 2)).toBe(none)
    expect(withPanelSize(chosen, ULTRAWIDE, 125, 99)).toBe(chosen)
  })

  it('does not bring the notice back by removing the choice: the entry of a screen that was noticed stays, with no choice', () => {
    const noticed = withNoticed(withPanelSize({}, ULTRAWIDE, 125, 1), ULTRAWIDE, 2)
    const removed = withPanelSize(noticed, ULTRAWIDE, null, 3)
    expect(removed[ULTRAWIDE.key]).toMatchObject({ percent: null, noticed: true })
    expect(screenNotice(ULTRAWIDE, removed)).toBeNull()
  })

  it('keeps at most 12 screens, the most recent: a thirteenth takes the place of the one set longest ago', () => {
    let sizes: PanelSizes = {}
    for (let i = 0; i < PANEL_SCREENS_MAX + 3; i++) sizes = withPanelSize(sizes, screenAt(1000 + i, 800, { label: `Monitor ${i}` }), 100, i + 1)
    expect(Object.keys(sizes)).toHaveLength(PANEL_SCREENS_MAX)
    expect(sizes['Monitor 0|1000x800@1']).toBeUndefined()
    expect(sizes['Monitor 2|1002x800@1']).toBeUndefined()
    expect(sizes['Monitor 3|1003x800@1']).toBeDefined()
    expect(sizes['Monitor 14|1014x800@1']).toBeDefined()
  })
})

describe('the saved choices, cleaned when a file is read', () => {
  const entry = (screen: ScreenInfo, extra: Record<string, unknown> = {}) => ({ percent: 125, noticed: false, label: screen.label, internal: screen.internal, width: screen.width, height: screen.height, scaleFactor: screen.scaleFactor, used: 5, ...extra })

  it('keeps what a screen set by the application is, and gives it back unchanged', () => {
    const sizes = withNoticed(withPanelSize(withPanelSize({}, ULTRAWIDE, 125, 10), LAPTOP, 90, 20), screenAt(2560, 1080, { label: 'Ultra' }), 30)
    expect(cleanPanelSizes(sizes)).toEqual(sizes)
    expect(cleanPanelSizes(JSON.parse(JSON.stringify(sizes)))).toEqual(sizes)
  })

  it('gives nothing for what is not a record, and drops what is not an entry', () => {
    for (const bad of [null, undefined, 'x', 3, [], [entry(ULTRAWIDE)], true]) expect(cleanPanelSizes(bad)).toEqual({})
    expect(cleanPanelSizes({ [ULTRAWIDE.key]: null, other: 'x', n: 3, a: [] })).toEqual({})
  })

  it('drops an entry whose key is not the one its own fields give (a screen moved to another by hand, a damaged name)', () => {
    expect(cleanPanelSizes({ [ULTRAWIDE.key]: entry(ULTRAWIDE) })[ULTRAWIDE.key]).toBeDefined()
    expect(cleanPanelSizes({ 'Autre|3440x1440@1': entry(ULTRAWIDE) })).toEqual({})
    expect(cleanPanelSizes({ [ULTRAWIDE.key]: entry(ULTRAWIDE, { width: 3000 }) })).toEqual({})
    expect(cleanPanelSizes({ [ULTRAWIDE.key]: entry(ULTRAWIDE, { height: 0 }) })).toEqual({})
    expect(cleanPanelSizes({ ['x'.repeat(300)]: entry(ULTRAWIDE) })).toEqual({})
  })

  it('never lets a key that is the prototype through', () => {
    const hostile = JSON.parse(`{"__proto__": ${JSON.stringify(entry(ULTRAWIDE))}}`) as unknown
    const cleaned = cleanPanelSizes(hostile)
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype)
    expect(Object.keys(cleaned)).toEqual([])
  })

  it('brings a damaged choice to Automatique or to the slider, and drops an entry that says nothing', () => {
    const get = (extra: Record<string, unknown>) => cleanPanelSizes({ [ULTRAWIDE.key]: entry(ULTRAWIDE, extra) })[ULTRAWIDE.key]
    expect(get({ percent: 999 })!.percent).toBe(PANEL_PERCENT_MAX)
    expect(get({ percent: 1 })!.percent).toBe(PANEL_PERCENT_MIN)
    expect(get({ percent: 112.6 })!.percent).toBe(113)
    expect(get({ percent: 'grand', noticed: true })).toMatchObject({ percent: null, noticed: true })
    expect(get({ percent: 'grand', noticed: false })).toBeUndefined()
    expect(get({ percent: null, noticed: false })).toBeUndefined()
    expect(get({ noticed: 'yes' })!.noticed).toBe(false)
    expect(get({ used: -4 })!.used).toBe(0)
    expect(get({ used: 'hier' })!.used).toBe(0)
  })

  it('keeps the 12 most recent when a file holds more', () => {
    const entries = Object.fromEntries(Array.from({ length: 20 }, (_, i) => { const s = screenAt(1000 + i, 700, { label: `M${i}` }); return [s.key, entry(s, { used: i })] }))
    const kept = cleanPanelSizes(entries)
    expect(Object.keys(kept)).toHaveLength(PANEL_SCREENS_MAX)
    expect(kept['M19|1019x700@1']).toBeDefined()
    expect(kept['M7|1007x700@1']).toBeUndefined()
    expect(kept['M8|1008x700@1']).toBeDefined()
  })

  it('is part of the settings: nothing by default, cleaned by `normalize`, and a damaged file gives none rather than an error', () => {
    expect(defaultSettings().panelSizes).toEqual({})
    const state = createInitialState({ now: 0, newId: () => 'x' })
    const damaged = JSON.stringify({ ...state, settings: { ...state.settings, panelSizes: { 'LG|1x1@1': { percent: 'x' }, [ULTRAWIDE.key]: entry(ULTRAWIDE, { percent: 500 }) } } })
    const loaded = parseSavedState(damaged)
    expect(Object.keys(loaded.settings.panelSizes)).toEqual([ULTRAWIDE.key])
    expect(loaded.settings.panelSizes[ULTRAWIDE.key]!.percent).toBe(PANEL_PERCENT_MAX)
    const old = JSON.stringify({ ...state, settings: Object.fromEntries(Object.entries(state.settings).filter(([key]) => key !== 'panelSizes')) })
    expect(parseSavedState(old).settings.panelSizes).toEqual({})
    expect(normalize({ ...state, settings: { ...state.settings, panelSizes: 'x' as never } }).settings.panelSizes).toEqual({})
  })
})

describe('the actions that set the choice of a screen', () => {
  const ctx = { now: 1234, newId: () => 'id' }
  const state = createInitialState(ctx)

  it('sets, then removes, the choice of the screen the interface names, and dates it', () => {
    const set = reduce(state, { type: 'panel-size/set', screen: ULTRAWIDE, percent: 140 }, ctx)
    expect(set.settings.panelSizes[ULTRAWIDE.key]).toMatchObject({ percent: 140, used: 1234 })
    const removed = reduce(set, { type: 'panel-size/set', screen: ULTRAWIDE, percent: null }, ctx)
    expect(removed.settings.panelSizes).toEqual({})
  })

  it('refuses a screen that is not one, or a size that is not a number, and changes nothing (the same state comes back)', () => {
    for (const screen of [{ key: 'x', label: 'x', internal: false, width: 0, height: 0, scaleFactor: 1 }, null, 'screen', 7] as unknown as ScreenInfo[]) {
      expect(reduce(state, { type: 'panel-size/set', screen, percent: 100 }, ctx)).toBe(state)
      expect(reduce(state, { type: 'panel-size/noticed', screen }, ctx)).toBe(state)
    }
    expect(reduce(state, { type: 'panel-size/set', screen: ULTRAWIDE, percent: 'big' as unknown as number }, ctx)).toBe(state)
    expect(reduce(state, { type: 'panel-size/set', screen: ULTRAWIDE, percent: Number.NaN }, ctx)).toBe(state)
  })

  it('keeps the choice a screen has when a size that is not a number arrives for it: a bad value is not « Automatique »', () => {
    const chosen = reduce(state, { type: 'panel-size/set', screen: ULTRAWIDE, percent: 140 }, ctx)
    expect(reduce(chosen, { type: 'panel-size/set', screen: ULTRAWIDE, percent: 'big' as unknown as number }, ctx)).toBe(chosen)
    expect(reduce(chosen, { type: 'panel-size/set', screen: ULTRAWIDE, percent: Number.NaN }, ctx)).toBe(chosen)
    expect(chosen.settings.panelSizes[ULTRAWIDE.key]!.percent).toBe(140)
  })

  it('rebuilds the key from the fields: a screen sent with another key is not written under it', () => {
    const forged = { ...ULTRAWIDE, key: 'built-in|1512x982@2' }
    const next = reduce(state, { type: 'panel-size/set', screen: forged, percent: 150 }, ctx)
    expect(Object.keys(next.settings.panelSizes)).toEqual([ULTRAWIDE.key])
  })

  it('remembers the notice once, and is the same state the second time', () => {
    const noticed = reduce(state, { type: 'panel-size/noticed', screen: ULTRAWIDE }, ctx)
    expect(noticed.settings.panelSizes[ULTRAWIDE.key]).toMatchObject({ percent: null, noticed: true })
    expect(reduce(noticed, { type: 'panel-size/noticed', screen: ULTRAWIDE }, ctx)).toBe(noticed)
  })
})

describe('which panels are scaled', () => {
  it('says where every panel of the layer lives, so that a new one cannot be forgotten', () => {
    const panels = Object.keys(PANEL_PLACEMENT)
    expect(panels).toContain('notes')
    for (const placement of Object.values(PANEL_PLACEMENT)) expect(['centred', 'placed']).toContain(placement)
  })

  it('scales the sheets and lists in the middle of the window: Notes, Traduire, Nouveautés, the confirmation sheets', () => {
    const centred: OverlayRequest[] = [
      { panel: 'notes' },
      { panel: 'translate' },
      { panel: 'shortcuts' },
      { panel: 'passwords' },
      { panel: 'bookmarks' },
      { panel: 'whatsnew', sheet: {} as never },
      { panel: 'leave', request: {} as never },
      { panel: 'dialog', request: {} as never },
      { panel: 'auth', request: {} as never },
      { panel: 'extreview', request: {} as never },
      { panel: 'passphrase', request: {} as never },
      { panel: 'welcome' },
      { panel: 'sessions' }
    ]
    for (const request of centred) expect(panelIsScaled(request), request.panel).toBe(true)
  })

  it('keeps the zoom of the interface for what hangs from the sidebar or the toolbar, or that the main process places or sizes by its own setting', () => {
    const placed: OverlayRequest[] = [
      { panel: 'commandbar', mode: 'new', initial: '' },
      { panel: 'find' },
      { panel: 'findreplace' },
      { panel: 'site' },
      { panel: 'downloads' },
      { panel: 'plus', anchor: { x: 1, y: 2, width: 3, height: 4 } },
      { panel: 'permission', request: {} as never },
      { panel: 'tabcycle', cards: [], index: 0 },
      { panel: 'splitdrop', tabId: 'a', size: { width: 1, height: 1 }, snapshot: null, sidebarRight: false },
      { panel: 'theme', spaceId: 's' },
      { panel: 'boost', host: 'a.example' },
      { panel: 'capture' },
      { panel: 'peek', rect: { x: 0, y: 0, width: 1, height: 1 } }
    ]
    for (const request of placed) expect(panelIsScaled(request), request.panel).toBe(false)
  })

  it('scales a small editor that is centred, and not the same editor hung from the row that opened it', () => {
    const anchor = { x: 10, y: 20, width: 100, height: 30 }
    expect(panelIsScaled({ panel: 'tab', tabId: 't' })).toBe(true)
    expect(panelIsScaled({ panel: 'tab', tabId: 't', anchor })).toBe(false)
    expect(panelIsScaled({ panel: 'favorite', favoriteId: 'f' })).toBe(true)
    expect(panelIsScaled({ panel: 'favorite', favoriteId: 'f', anchor })).toBe(false)
    expect(panelIsScaled({ panel: 'autoreload', tabId: 't', anchor })).toBe(false)
    expect(panelIsScaled({ panel: 'windowname' })).toBe(true)
    expect(panelIsScaled({ panel: 'windowname', anchor })).toBe(false)
  })
})

describe('the windows of their own', () => {
  // Réglages, Extensions, the task manager, À propos: their size at 100 % and the least they can be made.
  const WINDOWS: Record<'settings' | 'extensions' | 'taskManager' | 'about', WindowSizes> = {
    settings: { width: 780, height: 760, minWidth: 684, minHeight: 520 },
    extensions: { width: 820, height: 640, minWidth: 560, minHeight: 420 },
    taskManager: { width: 720, height: 480, minWidth: 420, minHeight: 260 },
    about: { width: 340, height: 520 }
  }
  const AREAS = [
    ['a small laptop', { x: 0, y: 25, width: 1280, height: 775 }],
    ['the reference laptop', { x: 0, y: 38, width: 1512, height: 944 }],
    ['an ultra-wide', { x: 0, y: 25, width: 3440, height: 1415 }]
  ] as const

  it('multiplies the size of a window by the factor, and its minimum with it', () => {
    expect(scaledWindow(WINDOWS.settings, 1.25, { width: 3440, height: 1415 })).toEqual({ width: 975, height: 950, minWidth: 855, minHeight: 650 })
    expect(scaledWindow(WINDOWS.settings, 1, { width: 3440, height: 1415 })).toEqual({ width: 780, height: 760, minWidth: 684, minHeight: 520 })
    expect(scaledWindow(WINDOWS.about, 1.5, { width: 3440, height: 1415 })).toEqual({ width: 510, height: 780, minWidth: 510, minHeight: 780 })
    expect(scaledWindow(WINDOWS.settings, 0.8, { width: 1512, height: 944 })).toEqual({ width: 624, height: 608, minWidth: 547, minHeight: 416 })
  })

  it('never lets the minimum of a window go above its size, even when the window at 100 % was given a minimum larger than its size', () => {
    expect(scaledWindow({ width: 300, height: 200, minWidth: 500, minHeight: 400 }, 1.5, { width: 3440, height: 1415 })).toEqual({ width: 450, height: 300, minWidth: 450, minHeight: 300 })
  })

  it('is never larger than the work area it opens in, and its minimum never larger than its size, at every size of the slider, on every screen', () => {
    for (const [name, area] of AREAS) {
      for (const [windowName, base] of Object.entries(WINDOWS)) {
        for (let percent = PANEL_PERCENT_MIN; percent <= PANEL_PERCENT_MAX; percent += 5) {
          const sizes = scaledWindow(base, percent / 100, area)
          const where = `${windowName} at ${percent} % on ${name}`
          expect(sizes.width, where).toBeLessThanOrEqual(area.width)
          expect(sizes.height, where).toBeLessThanOrEqual(area.height)
          expect(sizes.minWidth, where).toBeLessThanOrEqual(sizes.width)
          expect(sizes.minHeight, where).toBeLessThanOrEqual(sizes.height)
          expect(sizes.minWidth, where).toBeGreaterThan(0)
        }
      }
    }
  })

  it('is given a factor that lets it be made as small as it is at 100 % (its minimum, in CSS pixels, fits the work area) at every choice, on every screen', () => {
    for (const [name, area] of AREAS) {
      for (const [windowName, base] of Object.entries(WINDOWS)) {
        for (let percent = PANEL_PERCENT_MIN; percent <= PANEL_PERCENT_MAX; percent += 5) {
          const sizes = withPanelSize({}, ULTRAWIDE, percent, 1)
          const factor = panelFactor({ sizes, screen: ULTRAWIDE, room: area, need: { width: base.minWidth ?? base.width, height: base.minHeight ?? base.height } })
          const where = `${windowName} at ${percent} % on ${name}`
          // The window at its smallest, laid out in CSS pixels, is at least its minimum at 100 %: nothing overflows.
          expect((base.minWidth ?? base.width) * factor, where).toBeLessThanOrEqual(Math.max(area.width, base.minWidth ?? base.width))
          expect((base.minHeight ?? base.height) * factor, where).toBeLessThanOrEqual(Math.max(area.height, base.minHeight ?? base.height))
          const scaled = scaledWindow(base, factor, area)
          expect(scaled.width / factor, where).toBeGreaterThanOrEqual(Math.min(base.minWidth ?? base.width, area.width / factor) - 1)
        }
      }
    }
  })

  it('centres a window in the work area', () => {
    expect(centredIn({ x: 100, y: 25, width: 1000, height: 800 }, { width: 400, height: 200 })).toEqual({ x: 400, y: 325 })
  })

  it('takes a window that is open to the size its new factor gives, its content as large in CSS pixels as it was, within its minimum and the work area', () => {
    const area = { width: 3440, height: 1415 }
    // Settings at 780 × 760 CSS pixels: from 100 % to 125 %.
    expect(rescaledContent({ width: 780, height: 760 }, 1, 1.25, WINDOWS.settings, area)).toEqual({ width: 975, height: 950 })
    // And back.
    expect(rescaledContent({ width: 975, height: 950 }, 1.25, 1, WINDOWS.settings, area)).toEqual({ width: 780, height: 760 })
    // One made larger by hand keeps its proportion.
    expect(rescaledContent({ width: 1000, height: 800 }, 1, 1.5, WINDOWS.settings, area)).toEqual({ width: 1500, height: 1200 })
    // Not below its minimum, not beyond the screen.
    expect(rescaledContent({ width: 700, height: 600 }, 1, 0.8, WINDOWS.settings, area)).toEqual({ width: 560, height: 480 })
    expect(rescaledContent({ width: 3000, height: 1300 }, 1, 1.5, WINDOWS.settings, area)).toEqual({ width: 3440, height: 1415 })
  })
})

describe('the notice « Les panneaux vous semblent trop petits ? »', () => {
  it('is for a screen at least 2560 points wide, or 2.2 times as wide as high: the panels look small on it', () => {
    expect(screenKind({ width: WIDE_WIDTH, height: 1440 })).toBe('wide')
    expect(screenKind({ width: WIDE_WIDTH - 1, height: 1440 })).toBeNull()
    expect(screenKind({ width: 3440, height: 1440 })).toBe('wide')
    expect(screenKind({ width: 5120, height: 1440 })).toBe('wide')
    // 2.2 exactly, then just under it.
    expect(screenKind({ width: 2200, height: 1000 })).toBe('wide')
    expect(screenKind({ width: 2199, height: 1000 })).toBeNull()
    expect(screenKind({ width: 1920, height: 1080 })).toBeNull()
  })

  it('is « trop grands » for a screen under 1366 points wide', () => {
    expect(screenKind({ width: SMALL_WIDTH - 1, height: 768 })).toBe('small')
    expect(screenKind({ width: SMALL_WIDTH, height: 768 })).toBeNull()
    expect(screenKind({ width: 1280, height: 800 })).toBe('small')
    expect(screenKind({ width: 1024, height: 768 })).toBe('small')
    // The reference laptop and the Air have no notice.
    expect(screenKind({ width: 1512, height: 982 })).toBeNull()
    expect(screenKind({ width: 1470, height: 956 })).toBeNull()
  })

  it('is owed once per screen: not again once it was shown, wherever the screen is used from', () => {
    expect(screenNotice(ULTRAWIDE, {})).toBe('wide')
    const shown = withNoticed({}, ULTRAWIDE, 1)
    expect(screenNotice(ULTRAWIDE, shown)).toBeNull()
    // Another screen has its own notice.
    expect(screenNotice(screenAt(1280, 800, { label: 'Old' }), shown)).toBe('small')
  })

  it('is not owed to a screen its owner has already chosen a size for: they found the setting', () => {
    expect(screenNotice(ULTRAWIDE, withPanelSize({}, ULTRAWIDE, 100, 1))).toBeNull()
    expect(screenNotice(ULTRAWIDE, withPanelSize({}, ULTRAWIDE, null, 1))).toBe('wide')
  })

  it('is not owed to an ordinary screen at all', () => {
    expect(screenNotice(LAPTOP, {})).toBeNull()
    expect(screenNotice(screenAt(1920, 1080, { label: 'Monitor' }), {})).toBeNull()
  })
})

describe('the list of the screens and the preview of the pane', () => {
  const view = (screen: ScreenInfo, extra: Partial<ScreenView> = {}): ScreenView => ({ ...screen, current: false, window: null, ...extra })

  it('lists the connected screens, the one the window is on first, then the screens that have a choice and are not connected, the most recent first', () => {
    let sizes = withPanelSize({}, ULTRAWIDE, 125, 10)
    const away = screenAt(2560, 1440, { label: 'Office' })
    const older = screenAt(1920, 1080, { label: 'Old' })
    sizes = withPanelSize(sizes, older, 110, 5)
    sizes = withPanelSize(sizes, away, 120, 50)
    const rows = knownScreens(sizes, [view(LAPTOP), view(ULTRAWIDE, { current: true })])
    expect(rows.map((row) => [row.screen.key, row.percent, row.connected, row.current])).toEqual([
      [ULTRAWIDE.key, 125, true, true],
      [LAPTOP.key, null, true, false],
      [away.key, 120, false, false],
      [older.key, 110, false, false]
    ])
  })

  it('lists two identical monitors once, and a screen that was only noticed not at all (it has no choice to show or remove)', () => {
    const noticed = withNoticed({}, screenAt(2560, 1440, { label: 'Hidden' }), 1)
    const rows = knownScreens(noticed, [view(ULTRAWIDE), view(ULTRAWIDE, { current: true })])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.current).toBe(true)
  })

  it('draws the Notes panel to the scale of the screen: a quarter of the way down the window, centred, larger as the slider goes up', () => {
    const window = { x: 1000, y: 200, width: 1360, height: 860 }
    const at = (percent: number) => previewOf({ screen: ULTRAWIDE, window, percent, stageWidth: 3440 })
    const hundred = at(100)
    expect(hundred.screen).toEqual({ width: 3440, height: 1440 })
    expect(hundred.panel.width).toBe(PANEL_SAMPLE.width)
    expect(hundred.panel.height).toBe(PANEL_SAMPLE.height)
    expect(hundred.panel.x + hundred.panel.width / 2).toBeCloseTo(window.x + window.width / 2, 0)
    expect(hundred.panel.y).toBeCloseTo(window.y + window.height * 0.12, 0)
    expect(at(125).panel.width).toBe(700)
    expect(at(125).panel.height).toBe(600)
    expect(at(80).panel.width).toBe(448)
    expect(at(125).factor).toBe(1.25)
  })

  it('keeps the panel inside its window and brings it back to what the window holds when the slider asks for more', () => {
    const window = { x: 0, y: 0, width: 800, height: 600 }
    const big = previewOf({ screen: { width: 2560, height: 1440 }, window, percent: 160, stageWidth: 2560 })
    expect(big.factor).toBe(1.1)
    expect(big.panel.x).toBeGreaterThanOrEqual(0)
    expect(big.panel.x + big.panel.width).toBeLessThanOrEqual(800)
    expect(big.panel.y + big.panel.height).toBeLessThanOrEqual(600)
  })

  it('draws a window of the usual size in the middle of the screen when none is known, and scales everything to the stage', () => {
    const preview = previewOf({ screen: { width: 1512, height: 982 }, window: null, percent: 100, stageWidth: 756 })
    expect(preview.screen).toEqual({ width: 756, height: 491 })
    expect(preview.window.width).toBeLessThanOrEqual(756)
    expect(preview.window.x).toBeCloseTo((756 - preview.window.width) / 2, 0)
    expect(preview.window.y).toBeCloseTo((491 - preview.window.height) / 2, 0)
  })

  it('has the slider choose only what it was dragged to, and nothing for a click that moved nothing', () => {
    expect(committedPercent(140, 125)).toBe(140)
    expect(committedPercent(125, 125)).toBeNull()
    expect(committedPercent(null, 125)).toBeNull()
    expect(committedPercent(Number.NaN, 125)).toBeNull()
    expect(committedPercent(9000, 125)).toBe(PANEL_PERCENT_MAX)
  })

  it('has a notch for each of the sizes of the control, each inside the slider', () => {
    expect(PANEL_PRESETS.map((preset) => preset.id)).toEqual(['compact', 'normal', 'large', 'xlarge'])
    for (const preset of PANEL_PRESETS) {
      expect(preset.percent).toBeGreaterThanOrEqual(PANEL_PERCENT_MIN)
      expect(preset.percent).toBeLessThanOrEqual(PANEL_PERCENT_MAX)
    }
    expect(PANEL_PRESETS.find((preset) => preset.id === 'normal')!.percent).toBe(100)
  })

  it('writes the key of a screen once: screenKey is what screenOf gives', () => {
    expect(screenKey(ULTRAWIDE)).toBe(ULTRAWIDE.key)
  })
})
