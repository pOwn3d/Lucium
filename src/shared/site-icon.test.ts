// The interface loaded the icon of every tab from the site itself, in its own session: outside the profile of the tab, its cookies and its
// blocker. It now draws the copy the main process downloaded in that profile (site-icon.ts): what it is given as an address, which icon a
// request names, and which profile an icon of the state is downloaded for.

import { describe, expect, it } from 'vitest'
import type { SidebarState } from './model'
import { createInitialState, type Ctx } from './sidebar'
import { ICON_PRIVILEGES, ICON_SCHEME, iconAddressOf, iconSource, servedIconType, siteIconOwner } from './site-icon'

const ICON = 'https://exemple.fr/icones/favicon-32.png?v=2&x=é#frag'

describe('what an <img> of the interface is given for an icon', () => {
  it('is the address of the copy of the main process, never the address of the site', () => {
    const source = iconSource(ICON) as string
    expect(source.startsWith(`${ICON_SCHEME}://site/?u=`)).toBe(true)
    expect(source).not.toContain('https://')
    expect(new URL(source).searchParams.get('u')).toBe(ICON)
    expect(iconSource('http://intranet.local/favicon.ico')).toBe(`${ICON_SCHEME}://site/?u=${encodeURIComponent('http://intranet.local/favicon.ico')}`)
  })

  it('is the picture itself when the state holds it as data (a private tab, a tab of a container)', () => {
    expect(iconSource('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
  })

  it('is nothing for what is neither: no address the interface would then ask for', () => {
    for (const value of [undefined, null, '', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<p>', 'ftp://exemple.fr/a.png', '//exemple.fr/a.png', `https://exemple.fr/${'a'.repeat(3000)}`]) {
      expect(iconSource(value), String(value).slice(0, 40)).toBeUndefined()
    }
  })

  it('is served under a scheme that is read like a web address and that a page of the interface may always draw', () => {
    expect(ICON_PRIVILEGES).toEqual({ standard: true, secure: true })
  })
})

describe('the icon a request of the interface names', () => {
  it('is the address the state holds, whatever it contains', () => {
    for (const icon of [ICON, 'http://192.168.1.10:8123/static/icons/favicon.ico', 'https://cdn.exemple.fr/a%20b.png?u=https://autre.example/']) {
      expect(iconAddressOf(iconSource(icon) as string), icon).toBe(icon)
    }
  })

  it('is none for a request that `iconSource` did not make', () => {
    const encoded = encodeURIComponent(ICON)
    for (const request of [
      '',
      'not an address',
      `https://site/?u=${encoded}`,
      `${ICON_SCHEME}://autre/?u=${encoded}`,
      `${ICON_SCHEME}://site/chemin?u=${encoded}`,
      `${ICON_SCHEME}://site/`,
      `${ICON_SCHEME}://site/?u=`,
      `${ICON_SCHEME}://site/?u=${encodeURIComponent('file:///etc/passwd')}`,
      `${ICON_SCHEME}://site/?u=${encodeURIComponent('ftp://exemple.fr/a.png')}`,
      `${ICON_SCHEME}://site/?u=${encodeURIComponent('data:image/png;base64,AAAA')}`,
      `${ICON_SCHEME}://site/?u=${encodeURIComponent('https://user:secret@exemple.fr/a.png')}`,
      `${ICON_SCHEME}://site/?u=${encodeURIComponent(`https://exemple.fr/${'a'.repeat(3000)}`)}`
    ]) {
      expect(iconAddressOf(request), request.slice(0, 80)).toBeNull()
    }
  })
})

describe('the type a copy is served with', () => {
  const bytes = (...values: number[]): Uint8Array => Uint8Array.from([...values, ...new Array<number>(24).fill(0)])

  it('is what the bytes are', () => {
    expect(servedIconType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(servedIconType(bytes(0, 0, 1, 0, 1, 0))).toBe('image/x-icon')
    expect(servedIconType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
  })

  it('is none for bytes that are no picture (the error page of a site)', () => {
    expect(servedIconType(new TextEncoder().encode('<!doctype html><html><body>Not found</body></html>'))).toBeNull()
  })
})

describe('who an icon of the state is downloaded for', () => {
  const ctx = (): Ctx => {
    let n = 0
    return { now: 1_000_000, newId: () => `id${++n}` }
  }

  /** A state with a second space on the profile "travail"; the first space (profile "default") is the one shown. */
  function world(): { state: SidebarState; home: string; work: string } {
    const state = createInitialState(ctx())
    const home = state.activeSpaceId
    const first = state.spaces.find((space) => space.id === home)!
    const work = 'space-travail'
    return { state: { ...state, spaces: [{ ...first, profileId: 'default' }, { ...first, id: work, name: 'Travail', profileId: 'travail' }] }, home, work }
  }

  const tab = (id: string, spaceId: string, url: string, faviconUrl: string, more: Record<string, unknown> = {}) => ({ id, spaceId, url, title: id, pinned: false, createdAt: 1, lastActiveAt: 1, faviconUrl, ...more }) as SidebarState['tabs'][number]

  it('is the profile of the space of the tab that carries it, with the page of that tab', () => {
    const { state, home, work } = world()
    const tabs = [tab('a', home, 'https://exemple.fr/', ICON), tab('b', work, 'https://bureau.example/app', 'https://bureau.example/favicon.ico')]
    expect(siteIconOwner(ICON, [{ ...state, tabs }])).toEqual({ profileId: 'default', pageUrl: 'https://exemple.fr/' })
    expect(siteIconOwner('https://bureau.example/favicon.ico', [{ ...state, tabs }])).toEqual({ profileId: 'travail', pageUrl: 'https://bureau.example/app' })
  })

  it('is nobody for an icon nothing of the state shows', () => {
    const { state, home } = world()
    expect(siteIconOwner('https://ailleurs.example/favicon.ico', [{ ...state, tabs: [tab('a', home, 'https://exemple.fr/', ICON)] }])).toBeNull()
    expect(siteIconOwner(ICON, [])).toBeNull()
  })

  it('is never a private tab: nothing of it is asked outside its own session', () => {
    const { state, home, work } = world()
    const hidden = tab('p', home, 'https://exemple.fr/', ICON, { private: true })
    expect(siteIconOwner(ICON, [{ ...state, tabs: [hidden] }])).toBeNull()
    // The same icon on an ordinary tab is downloaded for that tab, in its profile.
    expect(siteIconOwner(ICON, [{ ...state, tabs: [hidden, tab('b', work, 'https://exemple.fr/page', ICON)] }])).toEqual({ profileId: 'travail', pageUrl: 'https://exemple.fr/page' })
  })

  it('is never a tab in a container: its icon is not asked with the cookies of the profile', () => {
    const { state, home, work } = world()
    const contained = tab('c', home, 'https://exemple.fr/', ICON, { container: 'banque' })
    expect(siteIconOwner(ICON, [{ ...state, tabs: [contained] }])).toBeNull()
    expect(siteIconOwner(ICON, [{ ...state, tabs: [contained, tab('b', work, 'https://exemple.fr/page', ICON)] }])).toEqual({ profileId: 'travail', pageUrl: 'https://exemple.fr/page' })
  })

  it('is the profile of a favourite for its icon, the default one for a favourite from before the profiles', () => {
    const { state } = world()
    const favorites = [
      { id: 'f1', url: 'https://bureau.example/', title: 'Bureau', faviconUrl: 'https://bureau.example/favicon.ico', profileId: 'travail' },
      { id: 'f2', url: 'https://exemple.fr/', title: 'Exemple', faviconUrl: ICON }
    ]
    expect(siteIconOwner('https://bureau.example/favicon.ico', [{ ...state, favorites }])).toEqual({ profileId: 'travail', pageUrl: 'https://bureau.example/' })
    expect(siteIconOwner(ICON, [{ ...state, favorites }])).toEqual({ profileId: 'default', pageUrl: 'https://exemple.fr/' })
  })

  it('is the profile of the space the window shows for a page read later or a bookmark, which belong to no profile', () => {
    const { state, work } = world()
    const readLater = [{ id: 'r1', url: 'https://exemple.fr/article', title: 'Article', faviconUrl: ICON, savedAt: 1 }]
    const bookmarks = [{ id: 'b1', url: 'https://bureau.example/doc', title: 'Doc', tags: [], faviconUrl: 'https://bureau.example/favicon.ico', addedAt: 1 }]
    expect(siteIconOwner(ICON, [{ ...state, readLater, bookmarks }])).toEqual({ profileId: 'default', pageUrl: 'https://exemple.fr/article' })
    expect(siteIconOwner('https://bureau.example/favicon.ico', [{ ...state, activeSpaceId: work, readLater, bookmarks }])).toEqual({ profileId: 'travail', pageUrl: 'https://bureau.example/doc' })
  })

  it('looks at the tabs of every window, and at the first window for the rest', () => {
    const { state, home, work } = world()
    const second = { ...state, tabs: [tab('z', work, 'https://bureau.example/', 'https://bureau.example/favicon.ico')] }
    expect(siteIconOwner('https://bureau.example/favicon.ico', [{ ...state, tabs: [tab('a', home, 'https://exemple.fr/', ICON)] }, second])).toEqual({ profileId: 'travail', pageUrl: 'https://bureau.example/' })
  })

  // A state file restored from elsewhere could name any address as the icon of a tab, and the download goes with the cookies of the profile.
  it('is nobody for an icon on this machine or the local network, unless the page that carries it is on that very host', () => {
    const { state, home } = world()
    const router = 'http://192.168.1.1/cgi-bin/reboot'
    expect(siteIconOwner(router, [{ ...state, tabs: [tab('a', home, 'http://exemple.fr/', router)] }])).toBeNull()
    expect(siteIconOwner('http://localhost:8080/admin', [{ ...state, tabs: [tab('a', home, 'http://exemple.fr/', 'http://localhost:8080/admin')] }])).toBeNull()
    const own = 'http://192.168.1.10:8123/static/favicon.ico'
    expect(siteIconOwner(own, [{ ...state, tabs: [tab('a', home, 'http://192.168.1.10:8123/lovelace', own)] }])).toEqual({ profileId: 'default', pageUrl: 'http://192.168.1.10:8123/lovelace' })
    // Another port of the same machine is another server.
    expect(siteIconOwner('http://192.168.1.10:9000/x.ico', [{ ...state, tabs: [tab('a', home, 'http://192.168.1.10:8123/lovelace', 'http://192.168.1.10:9000/x.ico')] }])).toBeNull()
  })

  it('is nobody for an http icon of an https page, and for a profile whose name could not be one', () => {
    const { state, home } = world()
    expect(siteIconOwner('http://exemple.fr/favicon.ico', [{ ...state, tabs: [tab('a', home, 'https://exemple.fr/', 'http://exemple.fr/favicon.ico')] }])).toBeNull()
    const odd = { ...state, spaces: state.spaces.map((space) => (space.id === home ? { ...space, profileId: '../../etc' } : space)) }
    expect(siteIconOwner(ICON, [{ ...odd, tabs: [tab('a', home, 'https://exemple.fr/', ICON)] }])).toBeNull()
  })
})
