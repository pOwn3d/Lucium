import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import {
  FEATURES_MAX_CHARS,
  FEATURES_MAX_ENTRIES,
  MAX_POPUPS_PER_TAB,
  parseFeatures,
  parseWholeNumber,
  planOpen,
  POPUP_DEFAULT_SIZE,
  POPUP_FRAME_HEIGHT,
  POPUP_MIN_SIZE,
  POPUP_TITLE_MAX_CHARS,
  popupBounds,
  popupContentBounds,
  popupKey,
  PopupLimiter,
  popupSize,
  popupTitle
} from './popup'

const WORK = { x: 0, y: 25, width: 1680, height: 960 }
const PARENT = { x: 100, y: 80, width: 1200, height: 800 }

describe('parseFeatures', () => {
  it('reads names and values separated by commas, spaces and equal signs, names in lower case', () => {
    const { entries } = parseFeatures('Width=500, HEIGHT = 600 ,popup,left=10 top=20')
    expect([...entries]).toEqual([['width', '500'], ['height', '600'], ['popup', ''], ['left', '10'], ['top', '20']])
  })

  it('takes noopener and noreferrer out of the list: they say how to open, not what to open', () => {
    const parsed = parseFeatures('noopener,width=400')
    expect(parsed.noOpener).toBe(true)
    expect([...parsed.entries.keys()]).toEqual(['width'])
    expect(parseFeatures('noreferrer').noOpener).toBe(true)
    expect(parseFeatures('NoOpener=1').noOpener).toBe(true)
    expect(parseFeatures('width=400').noOpener).toBe(false)
  })

  it('lets the last value of a repeated name win', () => {
    expect(parseFeatures('width=300,width=500').entries.get('width')).toBe('500')
  })

  it('reads anything that is not text as an empty list', () => {
    for (const raw of [undefined, null, 42, {}, [], true, Symbol.iterator]) {
      const parsed = parseFeatures(raw)
      expect(parsed.entries.size, String(raw)).toBe(0)
      expect(parsed.noOpener).toBe(false)
    }
    expect(parseFeatures('').entries.size).toBe(0)
    expect(parseFeatures(' ,, = ,').entries.size).toBe(0)
  })

  it('ignores what comes after FEATURES_MAX_CHARS: it is attacker-controlled text', () => {
    expect(parseFeatures(`${' '.repeat(FEATURES_MAX_CHARS + 10)}width=500`).entries.size).toBe(0)
    expect(parseFeatures(`${'a'.repeat(FEATURES_MAX_CHARS - 1)} w=1`).entries.has('w')).toBe(false)
  })

  it('keeps at most FEATURES_MAX_ENTRIES entries', () => {
    const many = Array.from({ length: 1000 }, (_, i) => `f${i}=1`).join(',')
    expect(parseFeatures(many.slice(0, FEATURES_MAX_CHARS)).entries.size).toBe(FEATURES_MAX_ENTRIES)
  })

  it('does not let a name such as __proto__ or constructor reach anything but its own entry', () => {
    const parsed = parseFeatures('__proto__=polluted,constructor=1,toString=2')
    expect(parsed.entries.get('__proto__')).toBe('polluted')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(Object.keys(Object.prototype)).toEqual([])
  })
})

describe('parseWholeNumber', () => {
  it('reads the number at the start of the value, as the HTML rules for integers do', () => {
    expect(parseWholeNumber('500')).toBe(500)
    expect(parseWholeNumber('500px')).toBe(500)
    expect(parseWholeNumber(' +42')).toBe(42)
    expect(parseWholeNumber('-5')).toBe(-5)
    expect(parseWholeNumber('1e9')).toBe(1)
    expect(parseWholeNumber('0x10')).toBe(0)
    expect(parseWholeNumber('12.9')).toBe(12)
  })

  it('answers null when there is no number, and a large number rather than Infinity for a huge one', () => {
    for (const value of [undefined, '', 'abc', '-', '.5', 'px500']) expect(parseWholeNumber(value), String(value)).toBeNull()
    expect(parseWholeNumber('9'.repeat(400))).toBe(1_000_000_000)
    expect(parseWholeNumber(`-${'9'.repeat(400)}`)).toBe(-1_000_000_000)
  })
})

describe('planOpen', () => {
  it('makes a popup of a new window that comes with features, with the size that was asked for', () => {
    expect(planOpen({ disposition: 'new-window', features: 'width=500,height=600' })).toEqual({ kind: 'popup', opener: true, size: { width: 500, height: 600 } })
    expect(planOpen({ disposition: 'new-window', features: 'innerWidth=420,innerHeight=380,popup' })).toEqual({ kind: 'popup', opener: true, size: { width: 420, height: 380 } })
    expect(planOpen({ disposition: 'new-window', features: 'popup' })).toEqual({ kind: 'popup', opener: true, size: {} })
    expect(planOpen({ disposition: 'new-window', features: 'menubar=no' })).toEqual({ kind: 'popup', opener: true, size: {} })
  })

  it('keeps the opener out of a popup that asks for noopener or noreferrer', () => {
    expect(planOpen({ disposition: 'new-window', features: 'width=500,height=600,noopener' })).toMatchObject({ kind: 'popup', opener: false })
    expect(planOpen({ disposition: 'new-window', features: 'noreferrer,popup' })).toMatchObject({ kind: 'popup', opener: false })
  })

  it('leaves a Shift+click, which is a new window with no features at all, a Glance', () => {
    expect(planOpen({ disposition: 'new-window', features: '' })).toEqual({ kind: 'tab', mode: 'peek' })
    // noopener and noreferrer alone are not features of a window.
    expect(planOpen({ disposition: 'new-window', features: 'noopener' })).toEqual({ kind: 'tab', mode: 'peek' })
    expect(planOpen({ disposition: 'new-window', features: 'noopener,noreferrer' })).toEqual({ kind: 'tab', mode: 'peek' })
  })

  it('leaves links and plain window.open calls tabs, whatever features they carry', () => {
    expect(planOpen({ disposition: 'foreground-tab', features: '' })).toEqual({ kind: 'tab', mode: 'foreground' })
    expect(planOpen({ disposition: 'foreground-tab', features: 'noopener' })).toEqual({ kind: 'tab', mode: 'foreground' })
    expect(planOpen({ disposition: 'foreground-tab', features: 'width=500,height=600' })).toEqual({ kind: 'tab', mode: 'foreground' })
    expect(planOpen({ disposition: 'background-tab', features: '' })).toEqual({ kind: 'tab', mode: 'background' })
    expect(planOpen({ disposition: 'background-tab', features: 'width=500' })).toEqual({ kind: 'tab', mode: 'background' })
    for (const disposition of ['default', 'other', undefined, null, 7, {}]) expect(planOpen({ disposition, features: 'width=500' }), String(disposition)).toEqual({ kind: 'tab', mode: 'foreground' })
  })
})

describe('popupSize', () => {
  const area = { width: 1680, height: 960 }

  it('gives the default size to a popup that asks for none', () => {
    expect(popupSize({}, area)).toEqual(POPUP_DEFAULT_SIZE)
    expect(popupSize({ width: 0, height: -20 }, area)).toEqual(POPUP_DEFAULT_SIZE)
  })

  it('keeps what was asked for when it is reasonable', () => {
    expect(popupSize({ width: 500, height: 600 }, area)).toEqual({ width: 500, height: 600 })
  })

  it('does not let a popup be too small to see: a 1-pixel window is a way to hide one', () => {
    expect(popupSize({ width: 1, height: 1 }, area)).toEqual(POPUP_MIN_SIZE)
  })

  it('does not let a popup be bigger than the screen (the title bar included)', () => {
    expect(popupSize({ width: 99_999, height: 99_999 }, area)).toEqual({ width: area.width, height: area.height - POPUP_FRAME_HEIGHT })
    expect(popupSize({ width: 1_000_000_000, height: 1_000_000_000 }, { width: 300, height: 400 })).toEqual({ width: 300, height: 400 - POPUP_FRAME_HEIGHT })
  })
})

describe('popupBounds', () => {
  it('centres the popup on the window of the page that opened it', () => {
    const bounds = popupBounds({ width: 500, height: 600 }, PARENT, WORK)
    expect(bounds).toEqual({ x: 450, y: 80 + (800 - 640) / 2, width: 500, height: 600 })
  })

  it('keeps the whole popup on the screen when its opener is at an edge or larger than the screen', () => {
    const atCorner = popupBounds({ width: 500, height: 600 }, { x: -300, y: -200, width: 400, height: 300 }, WORK)
    expect(atCorner.x).toBeGreaterThanOrEqual(WORK.x)
    expect(atCorner.y).toBeGreaterThanOrEqual(WORK.y)
    const farAway = popupBounds({ width: 500, height: 600 }, { x: 5000, y: 4000, width: 400, height: 300 }, WORK)
    expect(farAway.x + farAway.width).toBeLessThanOrEqual(WORK.x + WORK.width)
    expect(farAway.y + farAway.height + POPUP_FRAME_HEIGHT).toBeLessThanOrEqual(WORK.y + WORK.height)
  })

  it('stays on the screen of a secondary display that does not start at zero', () => {
    const second = { x: 1680, y: -300, width: 1920, height: 1080 }
    const bounds = popupBounds({ width: 500, height: 600 }, { x: 1700, y: -280, width: 300, height: 300 }, second)
    expect(bounds.x).toBeGreaterThanOrEqual(second.x)
    expect(bounds.y).toBeGreaterThanOrEqual(second.y)
  })
})

describe('popupContentBounds', () => {
  it('lets a page resize and move its popup when what it asks is reasonable', () => {
    expect(popupContentBounds({ x: 300, y: 200, width: 500, height: 400 }, WORK)).toEqual({ x: 300, y: 200, width: 500, height: 400 })
  })

  it('does not let a page shrink its popup out of sight (resizeTo(1, 1)) or hide it off the screen (moveTo(-5000, -5000))', () => {
    const bounds = popupContentBounds({ x: -5000, y: -5000, width: 1, height: 1 }, WORK)
    expect(bounds.width).toBe(POPUP_MIN_SIZE.width)
    expect(bounds.height).toBe(POPUP_MIN_SIZE.height)
    expect(bounds.x).toBe(WORK.x)
    expect(bounds.y).toBe(WORK.y + POPUP_FRAME_HEIGHT)
  })

  it('does not let a page push its popup past the other edges, nor make it bigger than the screen', () => {
    const bounds = popupContentBounds({ x: 99_999, y: 99_999, width: 99_999, height: 99_999 }, WORK)
    expect(bounds.width).toBe(WORK.width)
    expect(bounds.height).toBe(WORK.height - POPUP_FRAME_HEIGHT)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(WORK.x + WORK.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(WORK.y + WORK.height)
    const moved = popupContentBounds({ x: 99_999, y: 99_999, width: 300, height: 200 }, WORK)
    expect(moved.x + moved.width).toBe(WORK.x + WORK.width)
    expect(moved.y + moved.height).toBe(WORK.y + WORK.height)
  })

  it('answers with whole numbers inside the screen, whatever the page sends', () => {
    for (const value of [NaN, Infinity, -Infinity, 0, -1, 1e12, 0.5]) {
      const bounds = popupContentBounds({ x: value, y: value, width: value, height: value }, WORK)
      expect(Object.values(bounds).every(Number.isInteger), String(value)).toBe(true)
      expect(bounds.x).toBeGreaterThanOrEqual(WORK.x)
      expect(bounds.y).toBeGreaterThanOrEqual(WORK.y + POPUP_FRAME_HEIGHT)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(WORK.x + WORK.width)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(WORK.y + WORK.height)
    }
  })

  it('stays on a secondary display that does not start at zero', () => {
    const second = { x: 1680, y: -300, width: 1920, height: 1080 }
    const bounds = popupContentBounds({ x: 0, y: -5000, width: 400, height: 300 }, second)
    expect(bounds.x).toBe(second.x)
    expect(bounds.y).toBe(second.y + POPUP_FRAME_HEIGHT)
  })
})

describe('popupTitle', () => {
  it('puts the host of the page first and the title of the page after it', () => {
    expect(popupTitle('https://accounts.google.com/o/oauth2/v2/auth?x=1', 'Connexion : comptes Google')).toBe('accounts.google.com — Connexion : comptes Google')
    expect(popupTitle('http://127.0.0.1:8080/login', 'Login')).toBe('127.0.0.1:8080 — Login')
  })

  it('shows the host alone for a page with no title, or whose title is the host', () => {
    expect(popupTitle('https://example.com/', '')).toBe('example.com')
    expect(popupTitle('https://example.com/', '   ')).toBe('example.com')
    expect(popupTitle('https://example.com/', 'example.com')).toBe('example.com')
    expect(popupTitle('about:blank', '')).toBe('about:blank')
  })

  it('shows the host as the network sees it, so that a look-alike name does not read as the real one', () => {
    expect(popupTitle('https://аррӏе.com/', '')).toBe(new URL('https://аррӏе.com/').host)
    expect(popupTitle('https://аррӏе.com/', '')).toMatch(/^xn--/)
  })

  it('says it in the language of the interface', () => {
    setLanguage('en')
    try {
      expect(popupTitle('not a url', 'Title')).toBe('unknown address — Title')
    } finally {
      setLanguage('fr')
    }
  })

  it('says it does not know the address of a page that is not on the web', () => {
    for (const url of ['', 'not a url', 'file:///etc/hosts', 'javascript:alert(1)', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html']) expect(popupTitle(url, 'Titre'), url).toBe('adresse inconnue — Titre')
  })

  it('does not let the title imitate another host in front of the real one, or hide words with control characters', () => {
    expect(popupTitle('https://evil.example/', 'accounts.google.com — Connexion')).toBe('evil.example — accounts.google.com — Connexion')
    expect(popupTitle('https://evil.example/', 'a‮b\u0000c​d\nlibre⁦x')).toBe('evil.example — a b c d libre x')
  })

  it('cuts a long title', () => {
    const title = popupTitle('https://example.com/', 'x'.repeat(5000))
    expect(title.length).toBe('example.com — '.length + POPUP_TITLE_MAX_CHARS)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('PopupLimiter', () => {
  it('lets a tab have a few popups, and no more', () => {
    const limiter = new PopupLimiter()
    const releases = Array.from({ length: MAX_POPUPS_PER_TAB }, () => limiter.acquire('tab-1'))
    expect(releases.every((release) => release !== null)).toBe(true)
    expect(limiter.canOpen('tab-1')).toBe(false)
    expect(limiter.acquire('tab-1')).toBeNull()
    expect(limiter.count('tab-1')).toBe(MAX_POPUPS_PER_TAB)
  })

  it('counts each tab apart', () => {
    const limiter = new PopupLimiter()
    for (let i = 0; i < MAX_POPUPS_PER_TAB; i++) limiter.acquire('tab-1')
    expect(limiter.canOpen('tab-2')).toBe(true)
    expect(limiter.acquire('tab-2')).not.toBeNull()
  })

  it('gives the place back when a popup closes, once however many times it is told', () => {
    const limiter = new PopupLimiter()
    const first = limiter.acquire('tab-1')!
    limiter.acquire('tab-1')
    limiter.acquire('tab-1')
    first()
    first()
    first()
    expect(limiter.count('tab-1')).toBe(MAX_POPUPS_PER_TAB - 1)
    expect(limiter.canOpen('tab-1')).toBe(true)
  })

  it('forgets a tab whose popups are all closed', () => {
    const limiter = new PopupLimiter()
    limiter.acquire('tab-1')!()
    expect(limiter.count('tab-1')).toBe(0)
  })
})

describe('popupKey', () => {
  const key = (name: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean; type: string }> = {}, platform = 'darwin') =>
    popupKey({ type: 'keyDown', key: name, meta: false, control: false, alt: false, shift: false, ...mods }, platform)

  it('closes the popup on ⌘W and reloads it on ⌘R, instead of acting on the tab behind it', () => {
    expect(key('w', { meta: true })).toBe('close')
    expect(key('W', { meta: true, shift: true })).toBe('close')
    expect(key('r', { meta: true })).toBe('reload')
  })

  it('keeps the other commands of the menu away from the popup: they belong to the tabs', () => {
    for (const name of ['t', 'l', 'n', 'f', 'p', 'd', 'g', '1', '9', ',', '-', '=', '0', '[', ']']) expect(key(name, { meta: true }), name).toBe('block')
    expect(key('r', { meta: true, shift: true })).toBe('block')
    expect(key('i', { meta: true, alt: true })).toBe('block')
    expect(key('Tab', { control: true })).toBe('block')
    expect(key('Tab', { control: true, shift: true })).toBe('block')
  })

  it('leaves editing and the commands of the system to the popup', () => {
    for (const name of ['c', 'v', 'x', 'a', 'z', 'q', 'h', 'm']) expect(key(name, { meta: true }), name).toBe('pass')
    expect(key('z', { meta: true, shift: true })).toBe('pass')
  })

  it('leaves every other key to the page', () => {
    expect(key('a')).toBe('pass')
    expect(key('Enter')).toBe('pass')
    expect(key('Escape')).toBe('pass')
    expect(key('a', { control: true })).toBe('pass')
    expect(key('w', { meta: true, type: 'keyUp' })).toBe('pass')
  })

  it('uses Ctrl rather than ⌘ away from macOS', () => {
    expect(key('w', { control: true }, 'win32')).toBe('close')
    expect(key('t', { control: true }, 'linux')).toBe('block')
    expect(key('w', { meta: true }, 'win32')).toBe('pass')
  })

  it('does not trust the shape of what it is given', () => {
    expect(popupKey({ type: 'keyDown', key: undefined as unknown as string, meta: true, control: false, alt: false, shift: false }, 'darwin')).toBe('block')
    expect(popupKey({ type: 'keyDown', key: 42 as unknown as string, meta: false, control: false, alt: false, shift: false }, 'darwin')).toBe('pass')
  })
})

/** A small deterministic generator: the same hostile strings on every run. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

describe('hostile feature lists', () => {
  const alphabet = ['=', ',', ';', ' ', '\t', '\n', '\0', 'width', 'height', 'innerWidth', 'popup', 'noopener', 'noreferrer', 'left', 'top', '0', '1', '9', '-', '+', '.', 'e', 'x', '%', '‮', '\u{1F600}', '__proto__', 'constructor', 'width=', 'height=', '99999999999999999999', 'NaN', 'Infinity']

  it('never throws, bounds what it keeps, and always gives a popup that fits the screen', () => {
    const random = generator(20_260_424)
    for (let i = 0; i < 3000; i++) {
      const length = Math.floor(random() * 60)
      const raw = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
      const parsed = parseFeatures(raw)
      expect(parsed.entries.size).toBeLessThanOrEqual(FEATURES_MAX_ENTRIES)
      for (const name of parsed.entries.keys()) expect(name, raw).toMatch(/^[^\s=,]+$/)
      for (const disposition of ['new-window', 'foreground-tab']) {
        const plan = planOpen({ disposition, features: raw })
        if (plan.kind !== 'popup') continue
        const bounds = popupBounds(plan.size, PARENT, WORK)
        expect(Number.isInteger(bounds.width) && Number.isInteger(bounds.height) && Number.isInteger(bounds.x) && Number.isInteger(bounds.y), raw).toBe(true)
        expect(bounds.width).toBeGreaterThanOrEqual(POPUP_MIN_SIZE.width)
        expect(bounds.height).toBeGreaterThanOrEqual(POPUP_MIN_SIZE.height)
        expect(bounds.x).toBeGreaterThanOrEqual(WORK.x)
        expect(bounds.y).toBeGreaterThanOrEqual(WORK.y)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(WORK.x + WORK.width)
        expect(bounds.y + bounds.height + POPUP_FRAME_HEIGHT).toBeLessThanOrEqual(WORK.y + WORK.height)
      }
    }
  })

  it('reads a very long list in bounded time', () => {
    const started = Date.now()
    parseFeatures('a='.repeat(2_000_000))
    parseFeatures(' '.repeat(2_000_000))
    parseFeatures(`${'9'.repeat(2_000_000)}`)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('does not take a title for more than text', () => {
    const random = generator(7)
    for (let i = 0; i < 500; i++) {
      const title = Array.from({ length: Math.floor(random() * 200) }, () => String.fromCodePoint(Math.floor(random() * 0x3000))).join('')
      const shown = popupTitle('https://example.com/', title)
      expect(shown.startsWith('example.com')).toBe(true)
      expect(shown.length).toBeLessThanOrEqual('example.com — '.length + POPUP_TITLE_MAX_CHARS)
      expect(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/.test(shown)).toBe(false)
    }
  })
})
