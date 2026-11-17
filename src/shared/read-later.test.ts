import { describe, expect, it } from 'vitest'
import { actionToDispatch, candidateHint, rankCandidates, type Candidate } from './command-bar'
import { COMMANDS, effectiveAccelerator, findConflicts } from './keybindings'
import { READ_LATER_FAVICON_MAX, READ_LATER_FAVICON_URL_MAX, READ_LATER_LIMIT, READ_LATER_TITLE_MAX, READ_LATER_URL_MAX, type ReadLaterItem, type SidebarState } from './model'
import { canOpenInPrivate, createPrivateState, privateAction, scrubPrivateState } from './private-window'
import { filterReadLater, readLaterAge, readLaterNotice, readLaterOffersList, readLaterOutcome } from './read-later'
import { createInitialState, normalize, parseSavedState, reduce, type Action, type Ctx } from './sidebar'
import { cleanReadLater, isReadLaterUrl } from './state-clean'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

// ---------- helpers ----------

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function makeCtx(now = 1_000_000): Ctx & { now: number } {
  let n = 0
  return { now, newId: () => `id${++n}` }
}

/** A state with the given tabs open in the first space (the last one selected), titles and icons set as the engine would. */
function stateWithTabs(tabs: Array<{ url: string; title?: string; faviconUrl?: string }>, ctx = makeCtx()): SidebarState {
  let state = createInitialState(ctx)
  for (const tab of tabs) state = reduce(state, { type: 'tab/open', url: tab.url }, ctx)
  return { ...state, tabs: state.tabs.map((t, i) => ({ ...t, title: tabs[i]!.title ?? t.title, ...(tabs[i]!.faviconUrl ? { faviconUrl: tabs[i]!.faviconUrl } : {}) })) }
}

const item = (n: number, over: Partial<ReadLaterItem> = {}): ReadLaterItem => ({ id: `rl${n}`, url: `https://site${n}.example/page`, title: `Page ${n}`, savedAt: n, ...over })
const list = (count: number): ReadLaterItem[] => Array.from({ length: count }, (_, i) => item(count - i))
const withList = (state: SidebarState, readLater: ReadLaterItem[]): SidebarState => ({ ...state, readLater })

// ---------- what a file may hold ----------

describe('the read-later list of a file', () => {
  it('keeps good entries as they are, newest first, with their icon', () => {
    const entries = [item(2, { faviconUrl: PNG }), item(1)]
    expect(cleanReadLater(entries)).toEqual(entries)
  })

  it('is empty when the file has no list or something else than a list', () => {
    for (const raw of [undefined, null, 'texte', 7, {}, true, [], [null, 3, 'x', []]]) expect(cleanReadLater(raw), String(raw)).toEqual([])
  })

  it('drops what is not a web page: the engine would not load it, and the list only opens pages', () => {
    const bad = ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'about:blank', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html', 'view-source:https://a.example/', 'ftp://a.example/', 'not a url', '', 'HTTP:/missing-slashes', 7, null, undefined]
    const good = item(9, { url: 'HTTPS://Majuscules.example/Chemin?x=1#ancre' })
    const out = cleanReadLater([...bad.map((url, i) => ({ id: `bad${i}`, url, title: 'x', savedAt: 1 })), good])
    expect(out.map((r) => r.id)).toEqual(['rl9'])
  })

  it('refuses an address too long to be kept whole, rather than cutting it (a cut address opens another page)', () => {
    const long = `https://long.example/${'a'.repeat(READ_LATER_URL_MAX)}`
    const exact = `https://long.example/${'a'.repeat(READ_LATER_URL_MAX - 'https://long.example/'.length)}`
    expect(exact).toHaveLength(READ_LATER_URL_MAX)
    expect(isReadLaterUrl(long)).toBe(false)
    expect(isReadLaterUrl(exact)).toBe(true)
    expect(cleanReadLater([item(1, { url: long }), item(2, { url: exact })]).map((r) => r.id)).toEqual(['rl2'])
  })

  it('keeps the first of several entries sharing an id or an address', () => {
    const out = cleanReadLater([item(1), item(2, { id: 'rl1' }), item(3, { url: item(1).url }), item(4)])
    expect(out.map((r) => r.id)).toEqual(['rl1', 'rl4'])
  })

  it('drops an entry with no usable id, and an id every object inherits', () => {
    const out = cleanReadLater([{ url: 'https://a.example/', title: 'a', savedAt: 1 }, { ...item(1), id: '' }, { ...item(2), id: 5 }, { ...item(3), id: '__proto__' }, { ...item(4), id: 'x'.repeat(300) }, item(5)])
    expect(out.map((r) => r.id)).toEqual(['rl5'])
  })

  it('stops at the limit and keeps the newest (the first ones of the file)', () => {
    const out = cleanReadLater(list(READ_LATER_LIMIT + 50))
    expect(out).toHaveLength(READ_LATER_LIMIT)
    expect(out[0]!.id).toBe(`rl${READ_LATER_LIMIT + 50}`)
  })

  it('makes the title a clean, bounded line, and falls back to the site when it says nothing', () => {
    const [long, controls, blank, missing, wrong] = cleanReadLater([
      item(1, { title: 'x'.repeat(READ_LATER_TITLE_MAX + 100) }),
      item(2, { title: '  Ligne 1\nLigne 2\u0000fin\u001b  ' }),
      item(3, { title: '   \n  ' }),
      { id: 'rl4', url: 'https://www.exemple.org/a', savedAt: 4 },
      { id: 'rl5', url: 'https://autre.example/a', title: { text: 'objet' }, savedAt: 5 }
    ])
    expect(long!.title).toHaveLength(READ_LATER_TITLE_MAX)
    expect(controls!.title).toBe('Ligne 1 Ligne 2 fin')
    expect(blank!.title).toBe('site3.example')
    expect(missing!.title).toBe('exemple.org')
    expect(wrong!.title).toBe('autre.example')
  })

  it('keeps an icon only when it is a small data: image or a web address (what a tab holds)', () => {
    const icons: Array<[string, unknown, boolean]> = [
      ['a png', PNG, true],
      ['an svg', 'data:image/svg+xml;base64,PHN2Zy8+', true],
      ['an https address', 'https://a.example/favicon.ico', true],
      ['an http address', 'http://127.0.0.1:4000/icon.png', true],
      ['an address just within the limit', `https://a.example/${'i'.repeat(READ_LATER_FAVICON_URL_MAX - 'https://a.example/'.length)}`, true],
      ['an address over the limit', `https://a.example/${'i'.repeat(READ_LATER_FAVICON_URL_MAX)}`, false],
      ['a local file', 'file:///etc/passwd', false],
      ['an extension page', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/icon.png', false],
      ['a script', 'data:text/html;base64,PGI+eDwvYj4=', false],
      ['a javascript: address', 'javascript:alert(1)', false],
      ['an image that is not base64', 'data:image/png,%89PNG', false],
      ['an image with something else after the data', `${PNG}"onerror="alert(1)`, false],
      ['text', 'png', false],
      ['a number', 7, false],
      ['empty', '', false],
      ['a data image just over the limit', `data:image/png;base64,${'A'.repeat(READ_LATER_FAVICON_MAX)}`, false],
      ['a data image just within the limit', `data:image/png;base64,${'A'.repeat(READ_LATER_FAVICON_MAX - 'data:image/png;base64,'.length)}`, true]
    ]
    for (const [name, faviconUrl, kept] of icons) {
      const [entry] = cleanReadLater([item(1, { faviconUrl: faviconUrl as string })])
      expect(entry, name).toBeDefined()
      expect(entry!.faviconUrl !== undefined, name).toBe(kept)
      // The entry itself is never lost for a bad icon.
      expect(entry!.url, name).toBe(item(1).url)
    }
  })

  it('repairs the date, and keeps nothing the model does not know', () => {
    const [a, b] = cleanReadLater([item(1, { savedAt: Number.NaN }), { ...item(2), savedAt: 'hier', extra: 'POLLUTED', constructor: { prototype: { polluted: 'POLLUTED' } } }])
    expect(a!.savedAt).toBe(0)
    expect(b!.savedAt).toBe(0)
    expect(Object.keys(b!).sort()).toEqual(['id', 'savedAt', 'title', 'url'])
  })

  it('does not let a key of the file reach the prototype', () => {
    cleanReadLater(JSON.parse('[{"id":"a","url":"https://a.example/","title":"a","savedAt":1,"__proto__":{"polluted":"POLLUTED"}}]'))
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('goes through normalize: an old file without the list gets an empty one, and a second pass changes nothing', () => {
    const old = JSON.stringify({ version: 1, spaces: [{ id: 's', name: 'Perso', emoji: '🏠' }], tabs: [] })
    expect(parseSavedState(old).readLater).toEqual([])
    const state = normalize({ ...createInitialState(makeCtx()), readLater: [item(2, { title: '  deux  ', faviconUrl: PNG }), item(1, { url: 'javascript:1' })] })
    expect(state.readLater).toEqual([item(2, { title: 'deux', faviconUrl: PNG })])
    expect(normalize(state)).toStrictEqual(state)
    expect(normalize(JSON.parse(JSON.stringify(state)) as SidebarState)).toStrictEqual(state)
  })

  it('is loaded fast even when the file holds a hundred thousand entries', () => {
    const junk = Array.from({ length: 100_000 }, (_, i) => (i % 3 === 0 ? null : i % 3 === 1 ? i : { id: `x${i}`, url: 'javascript:1' }))
    const started = performance.now()
    expect(cleanReadLater(junk)).toEqual([])
    expect(cleanReadLater(Array.from({ length: 100_000 }, (_, i) => item(i + 1)))).toHaveLength(READ_LATER_LIMIT)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

// ---------- the actions ----------

describe('readlater/add', () => {
  it('keeps the page of the tab (address, title, icon, date) at the top of the list and closes the tab', () => {
    const ctx = makeCtx(5_000)
    const state = stateWithTabs([{ url: 'https://a.example/un', title: 'Un' }, { url: 'https://b.example/deux', title: 'Deux', faviconUrl: PNG }], ctx)
    const tab = state.tabs[1]!
    const next = reduce(state, { type: 'readlater/add', tabId: tab.id }, ctx)
    expect(next.readLater).toHaveLength(1)
    expect(next.readLater[0]).toMatchObject({ url: 'https://b.example/deux', title: 'Deux', faviconUrl: PNG, savedAt: 5_000 })
    expect(next.readLater[0]!.id).not.toBe(tab.id)
    expect(next.tabs.map((t) => t.id)).toEqual([state.tabs[0]!.id])
    // The tab that was on screen is replaced by its neighbour.
    expect(next.activeTabBySpace[next.activeSpaceId]).toBe(state.tabs[0]!.id)
  })

  it('puts the newest page first', () => {
    const ctx = makeCtx()
    let state = stateWithTabs([{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B' }], ctx)
    state = reduce(state, { type: 'readlater/add', tabId: state.tabs[0]!.id }, { ...ctx, now: 10 })
    state = reduce(state, { type: 'readlater/add', tabId: state.tabs[0]!.id }, { ...ctx, now: 20 })
    expect(state.readLater.map((r) => r.title)).toEqual(['B', 'A'])
    expect(state.tabs).toEqual([])
  })

  it('names the page as the sidebar does: the name the user gave the tab, else the page title', () => {
    const ctx = makeCtx()
    let state = stateWithTabs([{ url: 'https://a.example/', title: 'Titre de la page' }], ctx)
    state = reduce(state, { type: 'tab/rename', id: state.tabs[0]!.id, title: 'Mon nom' }, ctx)
    expect(reduce(state, { type: 'readlater/add', tabId: state.tabs[0]!.id }, ctx).readLater[0]!.title).toBe('Mon nom')
  })

  it('does not add a page twice: the first entry stays as it was and the tab closes all the same', () => {
    const ctx = makeCtx(100)
    let state = stateWithTabs([{ url: 'https://a.example/lu', title: 'Premier titre' }, { url: 'https://autre.example/', title: 'Autre' }], ctx)
    state = reduce(state, { type: 'readlater/add', tabId: state.tabs[0]!.id }, ctx)
    const first = state.readLater[0]!
    state = reduce(state, { type: 'tab/open', url: 'https://a.example/lu' }, { ...ctx, now: 900 })
    state = { ...state, tabs: state.tabs.map((t) => (t.url === 'https://a.example/lu' ? { ...t, title: 'Second titre' } : t)) }
    const again = state.tabs.find((t) => t.url === 'https://a.example/lu')!
    const next = reduce(state, { type: 'readlater/add', tabId: again.id }, { ...ctx, now: 900 })
    expect(next.readLater).toEqual([first])
    expect(next.readLater[0]).toMatchObject({ title: 'Premier titre', savedAt: 100 })
    expect(next.tabs.some((t) => t.id === again.id)).toBe(false)
  })

  it('leaves everything alone for a page that is not on the web', () => {
    const ctx = makeCtx()
    const base = stateWithTabs([{ url: 'https://a.example/' }], ctx)
    for (const url of ['about:blank', 'file:///Users/moi/page.html', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', 'view-source:https://a.example/']) {
      const state = { ...base, tabs: base.tabs.map((t) => ({ ...t, url })) }
      const next = reduce(state, { type: 'readlater/add', tabId: state.tabs[0]!.id }, ctx)
      expect(next, url).toBe(state)
    }
  })

  it('refuses a page when the list is full: nothing saved is pushed out, and the tab stays open', () => {
    const ctx = makeCtx()
    const state = withList(stateWithTabs([{ url: 'https://nouvelle.example/' }], ctx), list(READ_LATER_LIMIT))
    const next = reduce(state, { type: 'readlater/add', tabId: state.tabs[0]!.id }, ctx)
    expect(next).toBe(state)
    expect(next.readLater).toHaveLength(READ_LATER_LIMIT)
    expect(next.tabs).toHaveLength(1)
  })

  it('accepts the page that fills the list, and still closes the tab of a page already in a full list', () => {
    const ctx = makeCtx()
    const almost = withList(stateWithTabs([{ url: 'https://derniere.example/' }], ctx), list(READ_LATER_LIMIT - 1))
    const full = reduce(almost, { type: 'readlater/add', tabId: almost.tabs[0]!.id }, ctx)
    expect(full.readLater).toHaveLength(READ_LATER_LIMIT)
    expect(full.readLater[0]!.url).toBe('https://derniere.example/')
    const known = withList(stateWithTabs([{ url: item(7).url }], ctx), list(READ_LATER_LIMIT))
    const next = reduce(known, { type: 'readlater/add', tabId: known.tabs[0]!.id }, ctx)
    expect(next.readLater).toEqual(known.readLater)
    expect(next.tabs).toEqual([])
  })

  it('ignores a tab that does not exist, whatever the id looks like', () => {
    const state = stateWithTabs([{ url: 'https://a.example/' }])
    for (const tabId of ['nope', '', '__proto__', 'constructor', 5, null, undefined, {}]) {
      expect(reduce(state, { type: 'readlater/add', tabId } as unknown as Action, makeCtx())).toBe(state)
    }
  })

  it('saves a pinned tab but leaves it as it is: closing it would only put it to sleep on its pinned address', () => {
    const ctx = makeCtx()
    let state = stateWithTabs([{ url: 'https://epingle.example/', title: 'Épinglé' }, { url: 'https://voisin.example/' }], ctx)
    state = reduce(state, { type: 'tab/pin', id: state.tabs[0]!.id }, ctx)
    // The pinned tab has gone on to another page of its site and is the one on screen.
    state = reduce(state, { type: 'tab/update', id: state.tabs[0]!.id, patch: { url: 'https://epingle.example/article' } }, ctx)
    state = reduce(state, { type: 'tab/select', id: state.tabs[0]!.id }, ctx)
    const next = reduce(state, { type: 'readlater/add', tabId: state.tabs[0]!.id }, ctx)
    expect(next.readLater.map((r) => r.url)).toEqual(['https://epingle.example/article'])
    expect(next.tabs).toEqual(state.tabs)
    expect(next.activeTabBySpace).toEqual(state.activeTabBySpace)
  })

  it('keeps the icon of the tab when it is a web address or a data image, drops any other, and does not change the tab it came from', () => {
    const ctx = makeCtx()
    const state = stateWithTabs([{ url: 'https://a.example/', faviconUrl: 'https://a.example/favicon.ico' }, { url: 'https://b.example/', faviconUrl: 'javascript:alert(1)' }, { url: 'https://c.example/', faviconUrl: PNG }], ctx)
    const frozen = JSON.stringify(state)
    const [a, b, c] = state.tabs
    const next = [a, b, c].reduce((s, tab) => reduce(s, { type: 'readlater/add', tabId: tab!.id }, ctx), state)
    const byUrl = (url: string) => next.readLater.find((r) => r.url === url)!
    expect(byUrl('https://a.example/').faviconUrl).toBe('https://a.example/favicon.ico')
    expect(byUrl('https://c.example/').faviconUrl).toBe(PNG)
    expect('faviconUrl' in byUrl('https://b.example/')).toBe(false)
    expect(JSON.stringify(state)).toBe(frozen)
  })

  it('keeps a tab of a split view working: the split is dissolved with the tab', () => {
    const ctx = makeCtx()
    let state = stateWithTabs([{ url: 'https://a.example/' }, { url: 'https://b.example/' }], ctx)
    state = reduce(state, { type: 'split/create', tabId: state.tabs[0]!.id, withTabId: state.tabs[1]!.id }, ctx)
    expect(state.splits).toHaveLength(1)
    const next = reduce(state, { type: 'readlater/add', tabId: state.tabs[1]!.id }, ctx)
    expect(next.splits).toEqual([])
    expect(next.tabs).toHaveLength(1)
  })
})

describe('readlater/open', () => {
  it('opens the page in a new tab of the space on screen, and keeps it in the list', () => {
    const ctx = makeCtx()
    let state = stateWithTabs([{ url: 'https://a.example/', title: 'A' }], ctx)
    state = reduce(state, { type: 'readlater/add', tabId: state.tabs[0]!.id }, ctx)
    const saved = state.readLater[0]!
    state = reduce(state, { type: 'space/create', name: 'Autre', emoji: '🎨', hue: 10 }, ctx)
    const next = reduce(state, { type: 'readlater/open', id: saved.id }, ctx)
    const opened = next.tabs.at(-1)!
    expect(opened).toMatchObject({ url: 'https://a.example/', spaceId: state.activeSpaceId, pinned: false })
    expect(next.activeTabBySpace[state.activeSpaceId]).toBe(opened.id)
    expect(next.readLater).toEqual(state.readLater)
  })

  it('does nothing for a page that is not in the list', () => {
    const state = withList(stateWithTabs([]), [item(1)])
    for (const id of ['nope', '', '__proto__', 7, null, undefined]) expect(reduce(state, { type: 'readlater/open', id } as unknown as Action, makeCtx())).toBe(state)
  })

  it('opens the page again each time it is asked to', () => {
    const state = withList(stateWithTabs([]), [item(1)])
    const twice = [1, 2].reduce((s) => reduce(s, { type: 'readlater/open', id: 'rl1' }, makeCtx()), state)
    expect(twice.tabs.filter((t) => t.url === item(1).url)).toHaveLength(2)
  })
})

describe('readlater/remove and readlater/clear', () => {
  const state = withList(stateWithTabs([]), [item(3), item(2), item(1)])

  it('removes one page and keeps the order of the others', () => {
    expect(reduce(state, { type: 'readlater/remove', id: 'rl2' }, makeCtx()).readLater.map((r) => r.id)).toEqual(['rl3', 'rl1'])
  })

  it('leaves the state as it is for a page that is not there', () => {
    for (const id of ['nope', '', 5, undefined]) expect(reduce(state, { type: 'readlater/remove', id } as unknown as Action, makeCtx())).toBe(state)
  })

  it('empties the list, and does nothing to an empty one', () => {
    const cleared = reduce(state, { type: 'readlater/clear' }, makeCtx())
    expect(cleared.readLater).toEqual([])
    expect(reduce(cleared, { type: 'readlater/clear' }, makeCtx())).toBe(cleared)
  })

  it('never touches the tabs or the archive', () => {
    const open = withList(stateWithTabs([{ url: 'https://a.example/' }]), [item(1)])
    const cleared = reduce(open, { type: 'readlater/clear' }, makeCtx())
    expect(cleared.tabs).toBe(open.tabs)
    expect(cleared.archive).toBe(open.archive)
  })
})

describe('restoring a state', () => {
  it('brings the list back with the rest', () => {
    const ctx = makeCtx()
    const saved = withList(stateWithTabs([]), [item(2), item(1)])
    const next = reduce(createInitialState(ctx), { type: 'state/restore', state: saved }, ctx)
    expect(next.readLater).toEqual(saved.readLater)
  })
})

// ---------- helpers ----------

describe('readLaterOutcome', () => {
  it('says what saving a page would do', () => {
    expect(readLaterOutcome([], { url: 'https://a.example/' })).toBe('saved')
    expect(readLaterOutcome([item(1)], { url: item(1).url })).toBe('already')
    expect(readLaterOutcome(list(READ_LATER_LIMIT), { url: 'https://nouvelle.example/' })).toBe('full')
    expect(readLaterOutcome(list(READ_LATER_LIMIT), { url: item(5).url })).toBe('already')
    for (const url of ['about:blank', 'file:///a', 'javascript:1', '', 'https://a.example/' + 'a'.repeat(READ_LATER_URL_MAX)]) expect(readLaterOutcome([], { url }), url).toBe('unsupported')
  })

  it('compares addresses exactly, as the Toolkit does: another fragment or query is another page', () => {
    expect(readLaterOutcome([item(1, { url: 'https://a.example/p' })], { url: 'https://a.example/p#haut' })).toBe('saved')
    expect(readLaterOutcome([item(1, { url: 'https://a.example/p' })], { url: 'https://a.example/p?x=1' })).toBe('saved')
  })
})

describe('readLaterNotice', () => {
  it('has a sentence for each outcome, and the full list says the limit', () => {
    expect(readLaterNotice('saved')).toBe('Enregistré dans Lire plus tard')
    expect(readLaterNotice('already')).toBe('Déjà dans Lire plus tard')
    expect(readLaterNotice('full')).toContain(String(READ_LATER_LIMIT))
    expect(readLaterNotice('unsupported')).toMatch(/pages web/)
  })
})

describe('readLaterAge', () => {
  const now = 1_700_000_000_000
  const ago = (ms: number) => readLaterAge(now - ms, now)
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it('reads like a sentence in French', () => {
    expect(ago(0)).toBe('à l’instant')
    expect(ago(59_999)).toBe('à l’instant')
    expect(ago(MIN)).toBe(frenchSpaces('il y a 1 min'))
    expect(ago(45 * MIN)).toBe(frenchSpaces('il y a 45 min'))
    expect(ago(HOUR)).toBe(frenchSpaces('il y a 1 h'))
    expect(ago(23 * HOUR + 59 * MIN)).toBe(frenchSpaces('il y a 23 h'))
    expect(ago(DAY)).toBe('hier')
    expect(ago(2 * DAY)).toBe('il y a 2 jours')
    expect(ago(3 * DAY)).toBe('il y a 3 jours')
    expect(ago(6 * DAY + HOUR)).toBe('il y a 6 jours')
    expect(ago(7 * DAY)).toBe('il y a 1 semaine')
    expect(ago(15 * DAY)).toBe('il y a 2 semaines')
    expect(ago(30 * DAY)).toBe('il y a 1 mois')
    expect(ago(200 * DAY)).toBe('il y a 6 mois')
    expect(ago(365 * DAY)).toBe('il y a 1 an')
    expect(ago(800 * DAY)).toBe('il y a 2 ans')
  })

  it('reads like a sentence in English too, with the singular of one week, one month, one year', () => {
    setLanguage('en')
    try {
      expect(ago(0)).toBe('just now')
      expect(ago(45 * MIN)).toBe('45 min ago')
      expect(ago(DAY)).toBe('yesterday')
      expect(ago(3 * DAY)).toBe('3 days ago')
      expect(ago(7 * DAY)).toBe('1 week ago')
      expect(ago(15 * DAY)).toBe('2 weeks ago')
      expect(ago(30 * DAY)).toBe('1 month ago')
      expect(ago(200 * DAY)).toBe('6 months ago')
      expect(ago(365 * DAY)).toBe('1 year ago')
      expect(ago(800 * DAY)).toBe('2 years ago')
    } finally {
      setLanguage('fr')
    }
  })

  it('does not break on a date in the future or one that is not a number', () => {
    expect(readLaterAge(now + DAY, now)).toBe('à l’instant')
    expect(readLaterAge(Number.NaN, now)).toBe('à l’instant')
    expect(readLaterAge(now, Number.NaN)).toBe('à l’instant')
  })
})

describe('filterReadLater', () => {
  const pages = [item(3, { title: 'Éléphants d’Afrique', url: 'https://nature.example/elephants' }), item(2, { title: 'Recette de crêpes', url: 'https://cuisine.example/crepes?id=42' }), item(1, { title: 'Autre' })]

  it('keeps everything for an empty filter, in order', () => {
    expect(filterReadLater(pages, '')).toEqual(pages)
    expect(filterReadLater(pages, '   ')).toEqual(pages)
  })

  it('looks in the title and the address, ignoring case and accents', () => {
    expect(filterReadLater(pages, 'elephant').map((r) => r.id)).toEqual(['rl3'])
    expect(filterReadLater(pages, 'CREPES').map((r) => r.id)).toEqual(['rl2'])
    expect(filterReadLater(pages, 'id=42').map((r) => r.id)).toEqual(['rl2'])
    expect(filterReadLater(pages, 'introuvable')).toEqual([])
  })
})

// ---------- the private window ----------

describe('the private window', () => {
  const actions: Action[] = [{ type: 'readlater/add', tabId: 't' }, { type: 'readlater/open', id: 'x' }, { type: 'readlater/remove', id: 'x' }, { type: 'readlater/clear' }]

  it('refuses every read-later action and the panel', () => {
    for (const action of actions) expect(privateAction(action), action.type).toBeNull()
    expect(canOpenInPrivate('readlater')).toBe(false)
  })

  it('keeps no list: it starts empty and the scrub empties what a path could still have put there', () => {
    const main = withList(createInitialState(makeCtx()), [item(1)])
    expect(createPrivateState(main, makeCtx()).readLater).toEqual([])
    const state = withList(createInitialState(makeCtx()), [item(1)])
    expect(scrubPrivateState(state).readLater).toEqual([])
    const empty = createInitialState(makeCtx())
    expect(scrubPrivateState(empty)).toBe(empty)
  })
})

// ---------- shortcuts ----------

describe('the shortcuts', () => {
  it('give both commands a place in the shortcut list, with no default key, and no clash', () => {
    for (const id of ['readLater', 'readLaterList']) {
      expect(COMMANDS.filter((c) => c.id === id)).toHaveLength(1)
      expect(effectiveAccelerator(id, {}), id).toBeUndefined()
      expect(effectiveAccelerator(id, { [id]: 'CmdOrCtrl+Alt+L' })).toBe('CmdOrCtrl+Alt+L')
    }
    expect(findConflicts({ readLater: 'CmdOrCtrl+Alt+L', readLaterList: 'CmdOrCtrl+Alt+L' })).toEqual({ 'CmdOrCtrl+Alt+L': ['readLater', 'readLaterList'] })
    expect(findConflicts({})).toEqual({})
  })
})

// ---------- the command bar ----------

describe('the command bar', () => {
  const ctx = makeCtx()
  const base = stateWithTabs([{ url: 'https://a.example/article', title: 'Un article' }], ctx)
  const labels = (candidates: Candidate[]) => candidates.map((c) => c.label)

  it('offers "Lire plus tard" and the list when the words are typed, never on an empty bar', () => {
    expect(labels(rankCandidates('lire plus', base))).toContain('Lire plus tard')
    expect(labels(rankCandidates('liste de lecture', base))).toContain('Ouvrir la liste de lecture')
    expect(labels(rankCandidates('lecture', base))).toContain('Ouvrir la liste de lecture')
    const empty = labels(rankCandidates('', base))
    expect(empty).not.toContain('Lire plus tard')
    expect(empty).not.toContain('Ouvrir la liste de lecture')
  })

  it('saves only a web page: without one on screen, only the list is offered', () => {
    const none = { ...base, activeTabBySpace: { [base.activeSpaceId]: null } }
    expect(labels(rankCandidates('lire plus tard', none))).not.toContain('Lire plus tard')
    const local = { ...base, tabs: base.tabs.map((t) => ({ ...t, url: 'file:///Users/moi/a.html' })) }
    expect(labels(rankCandidates('lire plus tard', local))).not.toContain('Lire plus tard')
    expect(labels(rankCandidates('liste', local))).toContain('Ouvrir la liste de lecture')
  })

  it('offers neither in a private window', () => {
    const found = labels(rankCandidates('lire plus tard liste de lecture', base, [], [], [], { private: true }))
    expect(found).not.toContain('Lire plus tard')
    expect(found).not.toContain('Ouvrir la liste de lecture')
    expect(labels(rankCandidates('lire plus tard', base, [], [], [], { private: false }))).toContain('Lire plus tard')
  })

  it('turns the action into the save of the page on screen, and the list into a panel the caller opens', () => {
    expect(actionToDispatch('read-later', base)).toEqual({ type: 'readlater/add', tabId: base.tabs[0]!.id })
    expect(actionToDispatch('read-later', { ...base, activeTabBySpace: { [base.activeSpaceId]: null } })).toBeNull()
    expect(actionToDispatch('read-later', { ...base, tabs: base.tabs.map((t) => ({ ...t, url: 'about:blank' })) })).toBeNull()
    expect(actionToDispatch('read-later-list', base)).toBeNull()
  })

  const saved = withList(base, [item(3, { title: 'Recette de crêpes', url: 'https://cuisine.example/crepes', faviconUrl: PNG }), item(2, { title: 'Crêpes bretonnes', url: 'https://bzh.example/p' }), item(1, { title: 'Autre sujet' })])

  it('lists the saved pages the query names, after the archive and before the web suggestions, with the site and the icon', () => {
    const withArchive: SidebarState = { ...saved, archive: [{ id: 'ar', spaceId: saved.activeSpaceId, url: 'https://old.example/crepes', title: 'Vieilles crêpes', archivedAt: 1 }] }
    const out = rankCandidates('crepes', withArchive, [], ['crepes recette'])
    const kinds = out.map((c) => c.kind)
    expect(kinds.indexOf('readlater')).toBeGreaterThan(kinds.indexOf('archived'))
    expect(kinds.indexOf('readlater')).toBeLessThan(kinds.indexOf('suggestion'))
    const later = out.filter((c): c is Extract<Candidate, { kind: 'readlater' }> => c.kind === 'readlater')
    // The title that starts with the query comes before the one that only has it inside.
    expect(later.map((c) => c.label)).toEqual(['Crêpes bretonnes', 'Recette de crêpes'])
    expect(later[1]).toMatchObject({ detail: 'Lire plus tard · cuisine.example', readLaterId: 'rl3', faviconUrl: PNG })
    expect('faviconUrl' in later[0]!).toBe(false)
    expect(candidateHint(later[0]!)).toBe('Ouvrir la page')
  })

  it('needs the query inside the title or the address: loose letters do not bring a saved page up', () => {
    expect(rankCandidates('cps', saved).some((c) => c.kind === 'readlater')).toBe(false)
    expect(rankCandidates('cuisine.example', saved).some((c) => c.kind === 'readlater')).toBe(true)
  })

  it('shows at most three, and none on an empty bar', () => {
    const many = withList(base, Array.from({ length: 10 }, (_, i) => item(i + 1, { title: `Crêpe numéro ${i + 1}` })))
    expect(rankCandidates('crepe', many).filter((c) => c.kind === 'readlater')).toHaveLength(3)
    expect(rankCandidates('', saved).some((c) => c.kind === 'readlater')).toBe(false)
  })
})

describe('readLaterOffersList', () => {
  it('offers the list in every notice but the one of a page that cannot be kept (there is no list to open for it)', () => {
    expect(readLaterOffersList('saved')).toBe(true)
    expect(readLaterOffersList('already')).toBe(true)
    expect(readLaterOffersList('full')).toBe(true)
    expect(readLaterOffersList('unsupported')).toBe(false)
  })
})
