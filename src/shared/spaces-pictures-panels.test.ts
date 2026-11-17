// The state side of three functions: a picture for a space, web panels, and the sidebar at the right. Web panels and the sidebar at the right are off by default and do
// nothing (change no state, show no entry) until their setting is on. The picture of a space is offered by the icon picker whatever the setting says.

import { describe, expect, it } from 'vitest'
import { actionToDispatch, rankCandidates } from './command-bar'
import { interfaceMayDispatch, MAIN_ONLY_ACTIONS } from './ipc-policy'
import { menuKey } from './menu-state'
import { defaultSettings, type SidebarState } from './model'
import { privateAction } from './private-window'
import { createInitialState, normalize, reduce, type Action } from './sidebar'
import { WEB_PANELS_MAX } from './web-panels'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const start = (settings: Partial<SidebarState['settings']> = {}): SidebarState => {
  const state = createInitialState(ctx)
  return { ...state, settings: { ...state.settings, ...settings } }
}
const spaceOf = (state: SidebarState, id = state.spaces[0]!.id) => state.spaces.find((s) => s.id === id)!
const NAME = '0123456789abcdef01234567.png'
const OTHER = 'fedcba9876543210fedcba98.png'

describe('the defaults', () => {
  it('leave all three functions off', () => {
    const settings = defaultSettings()
    expect([settings.sidebarRight, settings.spaceImages, settings.webPanels]).toEqual([false, false, false])
  })

  it('give a new space neither a picture nor a panel', () => {
    const space = spaceOf(start())
    expect('image' in space).toBe(false)
    expect('webPanels' in space).toBe(false)
  })
})

describe('space/image', () => {
  it('gives a space a picture whatever the old setting says, and makes it the icon of the space', () => {
    for (const spaceImages of [false, true]) {
      const state = start({ spaceImages })
      const set = reduce(state, { type: 'space/image', id: state.spaces[0]!.id, image: NAME }, ctx)
      expect(spaceOf(set).image, String(spaceImages)).toBe(NAME)
      expect(spaceOf(set).iconKind, String(spaceImages)).toBe('image')
    }
  })

  it('gives the emoji back when the picture goes, but keeps a letter icon the space had chosen instead', () => {
    const base = start()
    const id = base.spaces[0]!.id
    const withPicture = reduce(base, { type: 'space/image', id, image: NAME }, ctx)
    const cleared = reduce(withPicture, { type: 'space/image', id, image: null }, ctx)
    expect(spaceOf(cleared).iconKind).toBe('emoji')
    // A letter chosen after the picture: removing the picture (a file nobody shows any more) changes nothing about what shows.
    const lettered = reduce(withPicture, { type: 'space/update', id, patch: { iconLetter: 'ab', iconKind: 'letter' } }, ctx)
    expect(spaceOf(lettered)).toMatchObject({ iconKind: 'letter', iconLetter: 'AB', image: NAME })
    expect(spaceOf(reduce(lettered, { type: 'space/image', id, image: null }, ctx)).iconKind).toBe('letter')
  })

  it('takes a picture away whatever the setting says: switching the function off never traps a picture', () => {
    const base = start({ spaceImages: false })
    const withPicture: SidebarState = { ...base, spaces: [{ ...base.spaces[0]!, image: NAME }] }
    const cleared = reduce(withPicture, { type: 'space/image', id: base.spaces[0]!.id, image: null }, ctx)
    expect('image' in spaceOf(cleared)).toBe(false)
  })

  it('refuses a name that is not one of our files, a space that does not exist, and a change that changes nothing', () => {
    const on = start({ spaceImages: true })
    const id = on.spaces[0]!.id
    for (const image of ['../../etc/passwd', '/tmp/photo.png', 'photo.png', 'https://evil.example/x.png', `${NAME}/..`, '']) {
      expect(reduce(on, { type: 'space/image', id, image }, ctx), image).toBe(on)
    }
    expect(reduce(on, { type: 'space/image', id: 'unknown', image: NAME }, ctx)).toBe(on)
    expect(reduce(on, { type: 'space/image', id, image: null }, ctx)).toBe(on)
    const set = reduce(on, { type: 'space/image', id, image: NAME }, ctx)
    expect(reduce(set, { type: 'space/image', id, image: NAME }, ctx)).toBe(set)
  })

  it('goes with the space: a space put aside keeps its picture, and reopening gives it back', () => {
    let state = start({ spaceImages: true })
    state = reduce(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
    const work = state.spaces[1]!.id
    state = reduce(state, { type: 'space/image', id: work, image: OTHER }, ctx)
    state = reduce(state, { type: 'space/aside', id: work }, ctx)
    expect(state.spaces.some((s) => s.id === work)).toBe(false)
    const session = state.sessions.find((s) => s.space?.space.id === work)!
    expect(session.space!.space.image).toBe(OTHER)
    state = reduce(state, { type: 'space/reopen', id: session.id }, ctx)
    expect(spaceOf(state, work).image).toBe(OTHER)
  })

  it('goes with the space: a deleted space keeps nothing', () => {
    let state = start({ spaceImages: true })
    state = reduce(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
    const work = state.spaces[1]!.id
    state = reduce(state, { type: 'space/image', id: work, image: OTHER }, ctx)
    state = reduce(state, { type: 'space/delete', id: work }, ctx)
    expect(JSON.stringify(state)).not.toContain(OTHER)
  })

  it('survives a trip through the file, and a file that carries a picture into a build that has the function off keeps the name', () => {
    const state = reduce(start({ spaceImages: true }), { type: 'space/image', id: start().spaces[0]!.id, image: NAME }, ctx)
    const withId = { ...state, spaces: [{ ...state.spaces[0]!, image: NAME }] }
    expect(normalize(JSON.parse(JSON.stringify(withId)) as SidebarState).spaces[0]!.image).toBe(NAME)
    const off = { ...withId, settings: { ...withId.settings, spaceImages: false } }
    expect(normalize(off).spaces[0]!.image).toBe(NAME)
    // …and shows it: a file written before the icon kind existed has none, and the picture is what that space wore.
    expect(normalize(off).spaces[0]!.iconKind).toBeUndefined()
  })

  it('is not something the interface may dispatch: it names a file, and only the code that has just made the file says so', () => {
    expect(MAIN_ONLY_ACTIONS.has('space/image')).toBe(true)
    expect(interfaceMayDispatch({ type: 'space/image', id: 'sp', image: NAME }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'space/image', id: 'sp', image: null }, [])).toBe(false)
  })
})

describe('space/panel-add and space/panel-remove', () => {
  const add = (state: SidebarState, url: string, panelId = 'p1', title?: string): SidebarState =>
    reduce(state, { type: 'space/panel-add', id: state.spaces[0]!.id, panelId, url, ...(title ? { title } : {}) }, ctx)

  it('adds a site only while the function is on', () => {
    const off = start()
    expect(add(off, 'https://web.whatsapp.com/')).toBe(off)
    const on = add(start({ webPanels: true }), 'https://web.whatsapp.com/', 'p1', 'WhatsApp')
    expect(spaceOf(on).webPanels).toEqual([{ id: 'p1', url: 'https://web.whatsapp.com/', title: 'WhatsApp' }])
  })

  it('takes web pages only, each once, and not more than the limit', () => {
    let state = start({ webPanels: true })
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', 'https://u:p@example.org/', '', 'example.org']) {
      expect(add(state, url), url).toBe(state)
    }
    state = add(state, 'https://a.example/', 'p1')
    expect(add(state, 'https://a.example/', 'p2')).toBe(state)
    for (let i = 0; i < WEB_PANELS_MAX; i++) state = add(state, `https://site${i}.example/`, `q${i}`)
    expect(spaceOf(state).webPanels).toHaveLength(WEB_PANELS_MAX)
    expect(add(state, 'https://one-too-many.example/', 'late')).toBe(state)
  })

  it('refuses a space that does not exist and a panel id that is not a usable key', () => {
    const on = start({ webPanels: true })
    expect(reduce(on, { type: 'space/panel-add', id: 'unknown', panelId: 'p1', url: 'https://a.example/' }, ctx)).toBe(on)
    expect(add(on, 'https://a.example/', '')).toBe(on)
    expect(add(on, 'https://a.example/', 'x'.repeat(300))).toBe(on)
    expect(reduce(on, { type: 'space/panel-add', id: on.spaces[0]!.id, panelId: 7 as unknown as string, url: 'https://a.example/' }, ctx)).toBe(on)
  })

  it('removes a site, even with the function off, and leaves a space as it was before when the last one goes', () => {
    let state = add(add(start({ webPanels: true }), 'https://a.example/', 'p1'), 'https://b.example/', 'p2')
    const off: SidebarState = { ...state, settings: { ...state.settings, webPanels: false } }
    state = reduce(off, { type: 'space/panel-remove', id: off.spaces[0]!.id, panelId: 'p1' }, ctx)
    expect(spaceOf(state).webPanels).toEqual([{ id: 'p2', url: 'https://b.example/', title: 'b.example' }])
    state = reduce(state, { type: 'space/panel-remove', id: state.spaces[0]!.id, panelId: 'p2' }, ctx)
    expect('webPanels' in spaceOf(state)).toBe(false)
    expect(reduce(state, { type: 'space/panel-remove', id: state.spaces[0]!.id, panelId: 'p2' }, ctx)).toBe(state)
  })

  it('is kept with a space put aside and given back with it', () => {
    let state = start({ webPanels: true })
    state = reduce(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
    const work = state.spaces[1]!.id
    state = reduce(state, { type: 'space/panel-add', id: work, panelId: 'w1', url: 'https://chat.example/' }, ctx)
    state = reduce(state, { type: 'space/aside', id: work }, ctx)
    const session = state.sessions.find((s) => s.space?.space.id === work)!
    state = reduce(state, { type: 'space/reopen', id: session.id }, ctx)
    expect(spaceOf(state, work).webPanels).toEqual([{ id: 'w1', url: 'https://chat.example/', title: 'chat.example' }])
  })
})

describe('the private window', () => {
  const actions: Action[] = [
    { type: 'space/image', id: 'sp', image: NAME },
    { type: 'space/image', id: 'sp', image: null },
    { type: 'space/panel-add', id: 'sp', panelId: 'p', url: 'https://a.example/' },
    { type: 'space/panel-remove', id: 'sp', panelId: 'p' }
  ]

  it('refuses every action of these functions: it keeps no picture and no panel list', () => {
    for (const action of actions) expect(privateAction(action), action.type).toBeNull()
  })

  it('follows the main window\'s side of the sidebar but not a layout of its own: the side is not a per-window setting', () => {
    expect(privateAction({ type: 'settings/update', patch: { sidebarRight: true } })).toBeNull()
  })
})

describe('the command bar', () => {
  const withPanels = (settings: Partial<SidebarState['settings']> = { webPanels: true }, page = 'https://news.example/article'): SidebarState => {
    let state = start(settings)
    const spaceId = state.spaces[0]!.id
    state = reduce(state, { type: 'tab/open', url: page }, ctx)
    state = { ...state, spaces: state.spaces.map((s) => ({ ...s, webPanels: [{ id: 'wa', url: 'https://web.whatsapp.com/', title: 'WhatsApp' }, { id: 'ag', url: 'https://calendar.example/', title: 'Agenda' }] })) }
    expect(spaceId).toBe(state.activeSpaceId)
    return state
  }
  const labels = (state: SidebarState, query: string, options: { private?: boolean } = {}) => rankCandidates(query, state, [], [], [], options).filter((c) => c.kind === 'webpanel' || c.id.startsWith('action:web-panel')).map((c) => c.label)

  it('offers "Ouvrir <site> en volet" for the sites of the space, by name', () => {
    const state = withPanels()
    expect(labels(state, 'whatsapp')).toEqual(['Ouvrir WhatsApp en volet'])
    expect(labels(state, 'agenda')).toEqual(['Ouvrir Agenda en volet'])
    expect(labels(state, 'ouvrir')).toEqual(['Ouvrir WhatsApp en volet', 'Ouvrir Agenda en volet'])
    const [candidate] = rankCandidates('whatsapp', state).filter((c) => c.kind === 'webpanel')
    expect(candidate).toMatchObject({ kind: 'webpanel', panelId: 'wa' })
  })

  it('offers to add the page on screen, unless it already is a panel or cannot be one, and to put the panel away', () => {
    // The names of the sites match a word of the query ("volet") as any name does; what matters here is which commands are among them.
    expect(labels(withPanels(), 'ajouter la page en volet')).toContain('Ajouter la page en volet web')
    expect(labels(withPanels(), 'fermer le volet')).toContain('Fermer le volet web')
    expect(labels(withPanels({ webPanels: true }, 'https://web.whatsapp.com/'), 'ajouter la page en volet')).not.toContain('Ajouter la page en volet web')
    expect(labels(withPanels({ webPanels: true }, 'file:///Users/me/notes.html'), 'ajouter la page en volet')).not.toContain('Ajouter la page en volet web')
    expect(actionToDispatch('web-panel-add', withPanels())).toBeNull()
    expect(actionToDispatch('web-panel-close', withPanels())).toBeNull()
  })

  it('offers none of it while the function is off, nor in a private window, nor on an empty bar', () => {
    for (const query of ['whatsapp', 'ouvrir', 'ajouter la page en volet', 'fermer le volet', 'volet']) {
      expect(labels(withPanels({ webPanels: false }), query), query).toEqual([])
      expect(labels(withPanels(), query, { private: true }), query).toEqual([])
    }
    expect(labels(withPanels(), '')).toEqual([])
  })
})

describe('the application menu', () => {
  it('is rebuilt when the sites of the space change, but its key does not move at all while the function is off', () => {
    const off = start()
    const withSite = reduce({ ...off, settings: { ...off.settings, webPanels: true } }, { type: 'space/panel-add', id: off.spaces[0]!.id, panelId: 'p', url: 'https://a.example/' }, ctx)
    const on = { ...off, settings: { ...off.settings, webPanels: true } }
    expect(menuKey(on, [])).not.toBe(menuKey(withSite, []))
    // The same list, the function off: nothing of it is in the key.
    const hidden = { ...withSite, settings: { ...withSite.settings, webPanels: false } }
    expect(menuKey(hidden, [])).toBe(menuKey(off, []))
    expect(menuKey(off, [])).not.toContain('webPanels')
  })
})
