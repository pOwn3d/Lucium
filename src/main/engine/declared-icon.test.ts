// The icon a page declares, judged before the interface loads it: the blocker of the page's context and the rule of what an icon may be.

import { describe, expect, it, vi } from 'vitest'
import { declaredIcon, withDeclaredIcon, withJudgedIcon } from './declared-icon'
import { engineForPages } from './electron-page.test-support'
import type { PageEvents, PageUpdate, RequestBlocker } from './types'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const PAGE = 'https://journal.example/article'
const ICON = 'https://journal.example/favicon.ico'
const PIXEL = 'https://traqueur.example/p.gif?id=abc123'

/** A blocker that refuses the hosts it is given, as the lists would. */
const blocking = (...hosts: string[]): RequestBlocker & { mock: { calls: unknown[][] } } => vi.fn((request: { url: string }) => hosts.includes(new URL(request.url).hostname)) as never

describe('the icon a page declares', () => {
  it('is kept when the blocker lets it through, judged as a picture the page would load', () => {
    const blocker = blocking('traqueur.example')
    expect(declaredIcon(ICON, PAGE, 'tab-1', blocker)).toBe(ICON)
    expect(blocker.mock.calls).toEqual([[{ url: ICON, resourceType: 'image', pageUrl: PAGE, pageId: 'tab-1', documentUrl: PAGE, method: 'GET' }]])
  })

  it('is refused when the blocker would have refused it in the page: a third party is not contacted by being named as the icon', () => {
    expect(declaredIcon(PIXEL, PAGE, 'tab-1', blocking('traqueur.example'))).toBe('')
  })

  it('is refused when the blocker would have sent it to a stand-in', () => {
    expect(declaredIcon(PIXEL, PAGE, 'tab-1', () => ({ redirect: 'lucium-stand-in://x/1x1.gif' }))).toBe('')
  })

  it('is kept while no blocker is set', () => {
    expect(declaredIcon(PIXEL, PAGE, 'tab-1', null)).toBe(PIXEL)
  })

  it.each([
    ['an http icon for an https page', 'http://journal.example/favicon.ico'],
    ['an address with a login', 'https://moi:secret@journal.example/favicon.ico'],
    ['a local file', 'file:///Users/moi/icone.png'],
    ['a script', 'javascript:alert(1)'],
    ['an address that is not one', 'favicon.ico']
  ])('is refused whatever the blocker says when it is %s', (_what, icon) => {
    const blocker = blocking()
    expect(declaredIcon(icon, PAGE, 'tab-1', blocker)).toBe('')
    expect(blocker).not.toHaveBeenCalled()
  })

  it('is kept untouched when it is already an inlined image: nothing is requested for it', () => {
    const blocker = blocking()
    expect(declaredIcon('data:image/png;base64,AAAA', PAGE, 'tab-1', blocker)).toBe('data:image/png;base64,AAAA')
    expect(blocker).not.toHaveBeenCalled()
  })

  it('is refused, with a line in the log, when the blocker fails', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(declaredIcon(ICON, PAGE, 'tab-1', () => {
      throw new Error('lists not loaded')
    })).toBe('')
    expect(logged).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('the icon of a page'), 'lists not loaded')
    logged.mockRestore()
  })
})

describe('the events of a page', () => {
  function page(blocker: RequestBlocker | null, url = PAGE) {
    const updates: PageUpdate[] = []
    const events = withJudgedIcon({ update: (patch: PageUpdate) => void updates.push(patch) } as unknown as PageEvents, 'tab-1', () => url, () => blocker)
    return { events, updates }
  }

  it('carry the icon the blocker lets through, and an empty one for the icon it refuses', () => {
    const { events, updates } = page(blocking('traqueur.example'))
    events.update({ faviconUrl: ICON })
    events.update({ title: 'Article', faviconUrl: PIXEL })
    expect(updates).toEqual([{ faviconUrl: ICON }, { title: 'Article', faviconUrl: '' }])
  })

  it('pass on untouched what says nothing of an icon', () => {
    const blocker = blocking()
    const { events, updates } = page(blocker)
    const patch = { title: 'Article', loading: false }
    events.update(patch)
    expect(updates[0]).toBe(patch)
    expect(blocker).not.toHaveBeenCalled()
  })

  it('read the address of the page and the blocker when the icon arrives', () => {
    let blocker: RequestBlocker | null = null
    const updates: PageUpdate[] = []
    const events = withJudgedIcon({ update: (patch: PageUpdate) => void updates.push(patch) } as unknown as PageEvents, 'tab-1', () => PAGE, () => blocker)
    events.update({ faviconUrl: PIXEL })
    blocker = blocking('traqueur.example')
    events.update({ faviconUrl: PIXEL })
    expect(updates).toEqual([{ faviconUrl: PIXEL }, { faviconUrl: '' }])
  })
})

// `createPage` of the engine runs over fake web contents (electron-page.test-support.ts): the page tells the icon it found, the shell hears the judged one.
describe('the engine', () => {
  /** An icon found by the page of the tab `id` (the shell's own events are what `create` gave the engine). */
  const found = (icon: string, view: { webContents: { emit(event: string, ...args: unknown[]): boolean } }): void => void view.webContents.emit('page-favicon-updated', {}, [icon])
  const faviconsHeard = (events: { update: { mock: { calls: unknown[][] } } }): unknown[] => events.update.mock.calls.map(([patch]) => (patch as PageUpdate).faviconUrl).filter((icon) => icon !== undefined)

  it('gives every page it makes the judged events, with the blocker of the page\'s own context', async () => {
    const world = await engineForPages({ ready: null })
    // The blocker of the profile refuses the tracker; a page of a private context has a blocker of its own, which the engine\'s does not stand for.
    Object.assign(world.engine, { requestBlocker: blocking('traqueur.example'), siteIcons: { declare: vi.fn() } })
    const { view, events } = world.create('t1')
    found(PIXEL, view)
    found(ICON, view)
    expect(faviconsHeard(events)).toEqual(['', ICON])

    const hidden = await engineForPages()
    const scope = hidden.engine.scopes.get('private') as unknown as { prefix: string; blocker: RequestBlocker | null }
    Object.assign(hidden.engine, { requestBlocker: blocking('journal.example'), siteIcons: { declare: vi.fn() } })
    Object.assign(scope, { prefix: 'ephemeral:1/', blocker: blocking('traqueur.example') })
    const inScope = hidden.create('ephemeral:1/t1')
    found(PIXEL, inScope.view)
    found(ICON, inScope.view)
    // The icon of the page's own site went through: the blocker of the engine (which would have refused it) was not the one asked. The tracker is refused by the scope's.
    expect(faviconsHeard(inScope.events)).toEqual(['', ICON])
    // That blocker knows the page by the id the shell gave it, without the prefix of the context.
    expect((scope.blocker as unknown as { mock: { calls: Array<[{ pageId: string }]> } }).mock.calls.map(([request]) => request.pageId)).toEqual(['t1', 't1'])
  })
})

// The interface draws the copy the engine keeps of an icon: the engine must know which page shows an icon before the interface asks for it.
describe('the icon the interface will ask the copy of', () => {
  const recorded = (): { events: PageEvents; updates: PageUpdate[] } => {
    const updates: PageUpdate[] = []
    return { events: { update: (patch: PageUpdate) => void updates.push(patch) } as unknown as PageEvents, updates }
  }

  it('is noted before the page event goes on, for a web address only', () => {
    const { events, updates } = recorded()
    const order: string[] = []
    const noted = withDeclaredIcon({ ...events, update: (patch) => (order.push('update'), events.update(patch)) }, (iconUrl) => void order.push(`note ${iconUrl}`))
    noted.update({ faviconUrl: ICON })
    noted.update({ faviconUrl: 'data:image/png;base64,AAAA' })
    noted.update({ faviconUrl: '' })
    noted.update({ title: 'Journal' })
    expect(order).toEqual([`note ${ICON}`, 'update', 'update', 'update', 'update'])
    expect(updates).toHaveLength(4)
  })

  it('is never one the blocker refused: the note comes after the judgement', () => {
    const { events } = recorded()
    const notes: string[] = []
    const judged = withJudgedIcon(withDeclaredIcon(events, (iconUrl) => void notes.push(iconUrl)), 'tab-1', () => PAGE, () => blocking('traqueur.example'))
    judged.update({ faviconUrl: PIXEL })
    judged.update({ faviconUrl: ICON })
    expect(notes).toEqual([ICON])
  })

  it('is noted by the engine for a page of a profile, with the profile and the page, and never for a private context or a container', async () => {
    const world = await engineForPages({ ready: null })
    const declare = vi.fn()
    Object.assign(world.engine, { requestBlocker: blocking('traqueur.example'), siteIcons: { declare } })
    const { view } = world.create('t1')
    view.webContents.url = PAGE
    view.webContents.emit('page-favicon-updated', {}, [PIXEL])
    expect(declare).not.toHaveBeenCalled()
    view.webContents.emit('page-favicon-updated', {}, [ICON])
    expect(declare).toHaveBeenCalledExactlyOnceWith(ICON, { profileId: 'default', pageUrl: PAGE })

    const hidden = await engineForPages()
    const declaredInContext = vi.fn()
    Object.assign(hidden.engine, { siteIcons: { declare: declaredInContext } })
    Object.assign(hidden.engine.scopes.get('private') as object, { prefix: 'ephemeral:1/', blocker: null })
    const inContext = hidden.create('ephemeral:1/t1')
    inContext.view.webContents.emit('page-favicon-updated', {}, [ICON])
    expect(declaredInContext).not.toHaveBeenCalled()
  })
})

