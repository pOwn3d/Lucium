// "Ranger les onglets…" (tab-grouping.ts): which tabs can be put in order, the folders proposed for them, what the person's edits make of the proposal, and how
// the result is taken back. All of it is local and deterministic, which is measured here: the same tabs give the same proposal, in the order of their first tab.

import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import type { Folder, SidebarState, TabItem } from './model'
import { siteOf } from './party'
import { createInitialState, reduce, type Action } from './sidebar'
import {
  NO_TIDY_CHOICES,
  PRIVATE_SUFFIXES,
  TIDY_GROUPS_MAX,
  TIDY_NAME_MAX,
  TIDY_TABS_MAX,
  existingFolderFor,
  nameKey,
  proposeTidy,
  registrableDomain,
  siteOfAddress,
  tidyCandidates,
  tidyActions,
  tidyFolderName,
  tidyNotice,
  tidyOutcome,
  tidyPlan,
  tidyTargets
} from './tab-grouping'

let n = 0
const ctx = { now: 1_700_000_000_000, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** A state whose Today holds these addresses, in this order. */
function today(...urls: string[]): SidebarState {
  return run(createInitialState(ctx), ...urls.map((url): Action => ({ type: 'tab/open', url, background: true })))
}
const space = (s: SidebarState): string => s.activeSpaceId
const tabId = (s: SidebarState, url: string): string => s.tabs.find((t) => t.url === url)!.id
const urlsOf = (s: SidebarState, ids: readonly string[]): string[] => ids.map((id) => s.tabs.find((t) => t.id === id)!.url)
const namesOf = (s: SidebarState) => proposeTidy(s, space(s)).groups.map((g) => g.name)

describe('the site of an address', () => {
  it('is the registrable domain: a subdomain belongs to its domain, "www." and the port are not part of it', () => {
    for (const address of ['https://docs.google.com/a', 'https://sheets.google.com/b', 'https://drive.google.com:8443/c', 'https://www.google.com/']) expect(siteOfAddress(address)?.key, address).toBe('google')
    expect(siteOfAddress('https://a.b.example.org/x')).toEqual({ key: 'example.org', name: 'Example' })
    expect(siteOfAddress('http://example.org:3000/')?.key).toBe('example.org')
  })

  it('keeps the two labels of a country suffix with the name: bbc.co.uk, example.com.au, impots.gouv.fr', () => {
    expect(siteOfAddress('https://www.bbc.co.uk/news')).toEqual({ key: 'bbc.co.uk', name: 'BBC' })
    expect(siteOfAddress('https://shop.example.com.au/')?.key).toBe('example.com.au')
    expect(siteOfAddress('https://www.impots.gouv.fr/')?.key).toBe('impots.gouv.fr')
    expect(siteOfAddress('https://www.service-public.fr/')).toEqual({ key: 'service-public.fr', name: 'Service Public' })
  })

  it('tells the sites apart on a platform that rents out subdomains: alice.github.io is not bob.github.io', () => {
    expect(siteOfAddress('https://alice.github.io/blog')).toEqual({ key: 'alice.github.io', name: 'alice.github.io' })
    expect(siteOfAddress('https://bob.github.io/')?.key).toBe('bob.github.io')
    expect(siteOfAddress('https://x.y.alice.github.io/')?.key).toBe('alice.github.io')
    expect(siteOfAddress('https://mon-app.vercel.app/')?.key).toBe('mon-app.vercel.app')
  })

  it('is one site for a family of domains, and for a brand with a site in every country', () => {
    expect(siteOfAddress('https://outlook.office.com/mail')?.key).toBe('microsoft')
    expect(siteOfAddress('https://login.microsoftonline.com/')?.key).toBe('microsoft')
    expect(siteOfAddress('https://x.sharepoint.com/')).toEqual({ key: 'microsoft', name: 'Microsoft' })
    expect(siteOfAddress('https://raw.githubusercontent.com/o/r/main/f')).toEqual({ key: 'github', name: 'GitHub' })
    expect(siteOfAddress('https://www.google.fr/')).toEqual({ key: 'google', name: 'Google' })
    expect(siteOfAddress('https://www.google.co.uk/')?.key).toBe('google')
    expect(siteOfAddress('https://www.amazon.de/')?.key).toBe('amazon')
    // A look-alike under another suffix is not the brand.
    expect(siteOfAddress('https://google.xyz/')?.key).toBe('google.xyz')
  })

  it('has no site for an address that is not a web page: about:, file:, the application’s own pages, a script', () => {
    for (const address of ['about:blank', 'file:///Users/me/notes.html', 'chrome-extension://' + 'a'.repeat(32) + '/page.html', 'javascript:alert(1)', 'data:text/html,hi', 'not an address', '', 'https://', 'http://./']) {
      expect(siteOfAddress(address), address).toBeNull()
    }
  })

  it('is the address itself for a host that is no domain: localhost, an IP address, a name of the local network', () => {
    expect(siteOfAddress('http://localhost:5173/app')).toEqual({ key: 'localhost', name: 'localhost' })
    expect(siteOfAddress('http://192.168.1.20:8080/')?.key).toBe('192.168.1.20')
    expect(siteOfAddress('http://[::1]:3000/')?.key).toBe('[::1]')
    expect(siteOfAddress('http://nas/')?.key).toBe('nas')
  })

  it('keeps an internationalised domain as the network sees it (punycode), so that a look-alike stays visible as one', () => {
    const site = siteOfAddress('https://www.café.fr/menu')!
    expect(site.key).toBe('xn--caf-dma.fr')
    expect(site.name).toBe('xn--caf-dma')
    expect(siteOfAddress('https://аррӏе.com/')!.name.startsWith('xn--')).toBe(true)
  })

  it('names a site from its domain: capitals, hyphens, brands whose capitals are not the first one’s, never empty, never long', () => {
    expect(siteOfAddress('https://www.youtube.com/watch')?.name).toBe('YouTube')
    expect(siteOfAddress('https://stackoverflow.com/q/1')?.name).toBe('Stack Overflow')
    expect(siteOfAddress('https://news.ycombinator.com/')?.name).toBe('Y Combinator')
    expect(siteOfAddress('https://en.wikipedia.org/wiki/X')?.name).toBe('Wikipedia')
    expect(siteOfAddress('https://mon-petit-site.fr/')?.name).toBe('Mon Petit Site')
    const long = siteOfAddress(`https://${'a'.repeat(60)}.com/`)!
    expect(long.name.length).toBeLessThanOrEqual(TIDY_NAME_MAX)
    expect(long.name.length).toBeGreaterThan(0)
    // A host the parser lets through with an empty label still gets a name.
    expect(siteOfAddress('http://a..b/')?.name.length).toBeGreaterThan(0)
  })

  // The public suffix list is what the main process reads (party.ts); the panel cannot carry it. The short rules must say what the list says on the hosts people open.
  // (One difference is wanted: the list makes every subdomain of githubusercontent.com a site of its own, and the family of GitHub takes them all.)
  it('agrees with the public suffix list on a table of hosts', () => {
    const hosts = [
      'google.com', 'docs.google.com', 'www.example.org', 'a.b.c.example.net', 'bbc.co.uk', 'www.bbc.co.uk', 'foo.example.com.au', 'shop.example.co.nz', 'www.example.co.jp', 'sub.example.ne.jp',
      'impots.gouv.fr', 'www.service-public.fr', 'asso.example.asso.fr', 'example.fr', 'example.de', 'example.me', 'example.io', 'example.dev', 'example.app', 'example.xyz',
      'alice.github.io', 'x.alice.github.io', 'bob.gitlab.io', 'my-site.netlify.app', 'my-app.vercel.app', 'proj.pages.dev', 'x.workers.dev', 'app.herokuapp.com', 'blog.blogspot.com',
      'site.wordpress.com', 'app.web.app', 'proj.firebaseapp.com', 'srv.onrender.com', 'app.fly.dev', 'x.repl.co', 'x.azurewebsites.net', 'x.appspot.com', 'd111.cloudfront.net',
      'github.com', 'en.wikipedia.org', 'stackoverflow.com', 'news.ycombinator.com', 'mail.proton.me', 'cdn.jsdelivr.net', 'www.amazon.co.uk', 'www.amazon.com'
    ]
    for (const host of hosts) expect(registrableDomain(host), host).toBe(siteOf(`https://${host}/`))
    // Every suffix the short list holds is one the public suffix list holds too: the list cannot drift into calling a plain domain a platform.
    for (const suffix of PRIVATE_SUFFIXES) expect(registrableDomain(`x.y.${suffix}`), suffix).toBe(siteOf(`https://x.y.${suffix}/`))
  })
})

describe('the tabs that can be put in order', () => {
  it('are the Today tabs of the space, in the order of Today', () => {
    const s = today('https://a.example/', 'https://b.example/', 'https://c.example/')
    expect(urlsOf(s, tidyCandidates(s, space(s)).map((t) => t.id))).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/'])
  })

  it('leave out a pinned tab, a tab already in a folder, and the tabs of another space', () => {
    let s = today('https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/')
    const home = space(s)
    s = run(s, { type: 'tab/pin', id: tabId(s, 'https://a.example/') }, { type: 'folder/create-with', tabIds: [tabId(s, 'https://b.example/')], name: 'Dossier' }, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 })
    s = run(s, { type: 'tab/open', url: 'https://e.example/', background: true })
    expect(urlsOf(s, tidyCandidates(s, home).map((t) => t.id))).toEqual(['https://c.example/', 'https://d.example/'])
    expect(urlsOf(s, tidyCandidates(s, s.activeSpaceId).map((t) => t.id))).toEqual(['https://e.example/'])
  })

  it('leave out the page of a favourite (its tile stands for it)', () => {
    let s = today('https://a.example/', 'https://b.example/')
    s = run(s, { type: 'favorite/add', url: 'https://fav.example/', title: 'Fav' })
    s = run(s, { type: 'favorite/open', id: s.favorites[0]!.id })
    expect(s.tabs.some((t) => t.favoriteId !== undefined)).toBe(true)
    expect(urlsOf(s, tidyCandidates(s, space(s)).map((t) => t.id))).toEqual(['https://a.example/', 'https://b.example/'])
  })

  it('leave out a private tab (the pinned list is saved, a private tab never is)', () => {
    let s = run(createInitialState(ctx), { type: 'settings/update', patch: { privateTabs: true } })
    s = run(s, { type: 'tab/open', url: 'https://a.example/', background: true }, { type: 'tab/open', url: 'https://b.example/', background: true, private: true })
    expect(s.tabs.some((t) => t.private === true)).toBe(true)
    expect(urlsOf(s, tidyCandidates(s, space(s)).map((t) => t.id))).toEqual(['https://a.example/'])
  })

  it('leave out the panes of a split view (a folder would tear it)', () => {
    let s = today('https://a.example/', 'https://b.example/', 'https://c.example/')
    s = run(s, { type: 'split/create', tabId: tabId(s, 'https://a.example/'), withTabId: tabId(s, 'https://b.example/') })
    expect(s.splits).toHaveLength(1)
    expect(urlsOf(s, tidyCandidates(s, space(s)).map((t) => t.id))).toEqual(['https://c.example/'])
  })

  it('leave out the tabs of a branch of the tab tree, and only while the tree is on', () => {
    let s = run(createInitialState(ctx), { type: 'settings/update', patch: { tabTree: true } })
    s = run(s, { type: 'tab/open', url: 'https://a.example/', background: true })
    const parent = tabId(s, 'https://a.example/')
    s = run(s, { type: 'tab/open', url: 'https://b.example/', background: true, parentId: parent }, { type: 'tab/open', url: 'https://c.example/', background: true })
    expect(s.tabs.find((t) => t.url === 'https://b.example/')?.parentId).toBe(parent)
    expect(urlsOf(s, tidyCandidates(s, space(s)).map((t) => t.id))).toEqual(['https://c.example/'])
    const flat = run(s, { type: 'settings/update', patch: { tabTree: false } })
    expect(urlsOf(flat, tidyCandidates(flat, space(flat)).map((t) => t.id))).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/'])
  })
})

describe('the proposal', () => {
  it('is empty with no tab, with a single tab, and when every site has one tab', () => {
    expect(proposeTidy(today(), 'x')).toEqual({ candidates: 0, groups: [] })
    const one = today('https://a.example/')
    expect(proposeTidy(one, space(one))).toEqual({ candidates: 1, groups: [] })
    const apart = today('https://a.example/', 'https://b.example/', 'https://c.example/')
    expect(proposeTidy(apart, space(apart))).toEqual({ candidates: 3, groups: [] })
  })

  it('makes a folder of two tabs of one site, named after it, and leaves the tab alone where it is', () => {
    const s = today('https://github.com/a', 'https://news.example/', 'https://github.com/b', 'https://lone.example/')
    const { groups, candidates } = proposeTidy(s, space(s))
    expect(candidates).toBe(4)
    expect(groups).toEqual([{ key: 'github', name: 'GitHub', tabIds: [tabId(s, 'https://github.com/a'), tabId(s, 'https://github.com/b')] }])
  })

  it('groups the subdomains of a site together, whatever the port or the "www"', () => {
    const s = today('https://docs.google.com/d/1', 'https://sheets.google.com/s/1', 'https://www.google.com/search?q=x', 'http://google.com:80/')
    const groups = proposeTidy(s, space(s)).groups
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 'google', name: 'Google' })
    expect(groups[0]!.tabIds).toHaveLength(4)
  })

  it('puts the addresses with no site aside: two about:blank or two local files make no folder', () => {
    const s = today('about:blank', 'about:blank', 'file:///a.html', 'file:///b.html', 'https://a.example/')
    expect(proposeTidy(s, space(s))).toMatchObject({ candidates: 5, groups: [] })
  })

  it('groups two tabs of one machine of the network, one IP address or localhost, whatever the port', () => {
    const s = today('http://localhost:3000/', 'http://localhost:5173/', 'http://192.168.1.20:8080/a', 'http://192.168.1.20:9090/b', 'http://192.168.1.21/')
    expect(namesOf(s)).toEqual(['localhost', '192.168.1.20'])
  })

  it('tells two sites with the same name apart by their domain instead of putting them in one folder', () => {
    const s = today('https://example.com/1', 'https://example.org/1', 'https://example.com/2', 'https://example.org/2')
    expect(namesOf(s)).toEqual(['example.com', 'example.org'])
    // Alone, the name stays the readable one.
    const alone = today('https://example.com/1', 'https://example.com/2', 'https://example.org/1')
    expect(namesOf(alone)).toEqual(['Example'])
  })

  it('does not merge two people’s sites on a platform: each needs two tabs of its own', () => {
    const s = today('https://alice.github.io/a', 'https://bob.github.io/a', 'https://alice.github.io/b')
    const groups = proposeTidy(s, space(s)).groups
    expect(groups.map((g) => g.key)).toEqual(['alice.github.io'])
  })

  it('merges the domains of one family, and a brand’s country sites', () => {
    const s = today('https://outlook.office.com/', 'https://www.google.fr/', 'https://teams.microsoft.com/', 'https://www.google.com/', 'https://x.sharepoint.com/')
    expect(namesOf(s)).toEqual(['Microsoft', 'Google'])
    expect(proposeTidy(s, space(s)).groups.map((g) => g.tabIds.length)).toEqual([3, 2])
  })

  it('lists the folders in the order of the first tab of each, and the tabs in the order of Today', () => {
    const s = today('https://b.example/1', 'https://a.example/1', 'https://b.example/2', 'https://c.example/1', 'https://a.example/2', 'https://c.example/2', 'https://a.example/3')
    const groups = proposeTidy(s, space(s)).groups
    expect(groups.map((g) => g.name)).toEqual(['B', 'A', 'C'])
    expect(groups.map((g) => urlsOf(s, g.tabIds))).toEqual([
      ['https://b.example/1', 'https://b.example/2'],
      ['https://a.example/1', 'https://a.example/2', 'https://a.example/3'],
      ['https://c.example/1', 'https://c.example/2']
    ])
  })

  it('is the same every time for the same tabs, and follows the order of the tabs when that changes', () => {
    const urls = ['https://b.example/1', 'https://a.example/1', 'https://b.example/2', 'https://a.example/2']
    const first = today(...urls)
    expect(proposeTidy(first, space(first))).toEqual(proposeTidy(first, space(first)))
    const reversed = today(...[...urls].reverse())
    expect(namesOf(first)).toEqual(['B', 'A'])
    expect(namesOf(reversed)).toEqual(['A', 'B'])
  })

  it('names every folder with text and within the limit, whatever the host', () => {
    const urls = ['https://' + 'x'.repeat(63) + '.' + 'y'.repeat(63) + '.example.com/', 'https://ünï.example/', 'http://[2001:db8::1]/a', 'http://0x7f.1/', 'https://a-.-b.fr/', 'http://a..b/', 'http://.../']
    const s = today(...urls, ...urls)
    for (const group of proposeTidy(s, space(s)).groups) {
      expect(group.name.trim().length, group.key).toBeGreaterThan(0)
      expect(group.name.length, group.key).toBeLessThanOrEqual(TIDY_NAME_MAX)
      expect(group.name, group.key).not.toMatch(/\p{Cc}/u)
    }
  })

  it('takes a few milliseconds for 500 tabs, and groups them right', () => {
    const hosts = Array.from({ length: 40 }, (_, i) => `www.site${i}.example`)
    const urls = Array.from({ length: 500 }, (_, i) => `https://${hosts[i % hosts.length]}/page/${i}`)
    let s = createInitialState(ctx)
    s = { ...s, tabs: urls.map((url, i): TabItem => ({ id: `t${i}`, spaceId: s.activeSpaceId, url, title: url, pinned: false, createdAt: 1, lastActiveAt: 1 })) }
    const started = performance.now()
    const proposal = proposeTidy(s, space(s))
    const took = performance.now() - started
    expect(proposal.candidates).toBe(500)
    expect(proposal.groups).toHaveLength(40)
    expect(proposal.groups.every((g) => g.tabIds.length === 12 || g.tabIds.length === 13)).toBe(true)
    expect(proposal.groups.reduce((sum, g) => sum + g.tabIds.length, 0)).toBe(500)
    expect(took).toBeLessThan(500)
  })

  it('leaves out of the proposal what cannot be moved (a pinned tab of the same site is not pulled into the folder)', () => {
    let s = today('https://github.com/a', 'https://github.com/b', 'https://github.com/c')
    s = run(s, { type: 'tab/pin', id: tabId(s, 'https://github.com/a') })
    expect(urlsOf(s, proposeTidy(s, space(s)).groups[0]!.tabIds)).toEqual(['https://github.com/b', 'https://github.com/c'])
  })
})

describe('folder names', () => {
  it('are compared without the case, the spaces around or inside, nor the form of an accent', () => {
    expect(nameKey('  Mon   Dossier ')).toBe(nameKey('mon dossier'))
    expect(nameKey('É')).toBe(nameKey('É'))
    expect(nameKey('A')).not.toBe(nameKey('B'))
  })

  it('are never empty: a blank or a name that is no text gives the name of a new folder, and a name has no line break', () => {
    setLanguage('fr')
    expect(tidyFolderName('   ')).toBe('Nouveau dossier')
    expect(tidyFolderName(undefined)).toBe('Nouveau dossier')
    expect(tidyFolderName(42)).toBe('Nouveau dossier')
    expect(tidyFolderName(' Docs\nSuite ')).toBe('Docs Suite')
    expect(tidyFolderName('x'.repeat(500)).length).toBe(200)
  })

  it('find the folder of the space that has the name: a root one first, never a live one, never another space’s', () => {
    const folders: Folder[] = [
      { id: 'other-space', spaceId: 'b', name: 'GitHub', collapsed: false },
      { id: 'live', spaceId: 'a', name: 'GitHub', collapsed: false, live: { source: { kind: 'feed', url: 'https://x.example/rss' }, items: [] } },
      { id: 'nested', spaceId: 'a', name: 'github', collapsed: false, parentId: 'root' },
      { id: 'root', spaceId: 'a', name: ' GITHUB ', collapsed: false }
    ]
    expect(existingFolderFor(folders, 'a', 'GitHub')?.id).toBe('root')
    expect(existingFolderFor(folders.filter((f) => f.id !== 'root'), 'a', 'GitHub')?.id).toBe('nested')
    expect(existingFolderFor(folders.filter((f) => f.id === 'live' || f.id === 'other-space'), 'a', 'GitHub')).toBeUndefined()
    expect(existingFolderFor(folders, 'a', 'Docs')).toBeUndefined()
    expect(existingFolderFor(folders, 'a', '   ')).toBeUndefined()
  })
})

describe('where groups of tabs go', () => {
  const folders: Folder[] = [{ id: 'gh', spaceId: 'a', name: 'GitHub', collapsed: false }]

  it('is the folder that has the name when there is one, else a new folder', () => {
    expect(tidyTargets(folders, 'a', [{ name: 'github', tabIds: ['t1', 't2'] }, { name: 'Google', tabIds: ['t3', 't4'] }])).toEqual([
      { name: 'github', tabIds: ['t1', 't2'], folderId: 'gh' },
      { name: 'Google', tabIds: ['t3', 't4'] }
    ])
  })

  it('sends groups of one name to one folder, in the order they come', () => {
    expect(tidyTargets([], 'a', [{ name: 'Docs', tabIds: ['t1'] }, { name: ' docs ', tabIds: ['t2', 't3'] }])).toEqual([{ name: 'Docs', tabIds: ['t1', 't2', 't3'] }])
  })

  it('puts a tab named twice with the first group that names it, and makes no folder for a group left with nothing', () => {
    expect(tidyTargets([], 'a', [{ name: 'A', tabIds: ['t1', 't2'] }, { name: 'B', tabIds: ['t2', 't1'] }, { name: 'C', tabIds: [] }])).toEqual([{ name: 'A', tabIds: ['t1', 't2'] }])
  })
})

describe('the proposal as the person edits it', () => {
  const urls = ['https://github.com/a', 'https://github.com/b', 'https://github.com/c', 'https://google.com/1', 'https://google.com/2', 'https://lone.example/']
  const setup = () => {
    const s = today(...urls)
    return { s, proposal: proposeTidy(s, space(s)) }
  }

  it('takes every group as it is proposed when nothing is changed', () => {
    const { s, proposal } = setup()
    const plan = tidyPlan(s, space(s), proposal)
    expect(plan.rows.map((r) => [r.name, r.kept.length, r.on, r.applies])).toEqual([['GitHub', 3, true, true], ['Google', 2, true, true]])
    expect(plan).toMatchObject({ created: 2, extended: 0, moved: 5 })
    expect(plan.apply.map((g) => g.name)).toEqual(['GitHub', 'Google'])
  })

  it('leaves a group out when it is unticked, and a tab when it is', () => {
    const { s, proposal } = setup()
    const off = tidyPlan(s, space(s), proposal, { ...NO_TIDY_CHOICES, offGroups: new Set(['github']) })
    expect(off.apply.map((g) => g.name)).toEqual(['Google'])
    expect(off).toMatchObject({ created: 1, moved: 2 })
    expect(off.rows[0]).toMatchObject({ on: false, applies: false, few: false })
    const oneTab = tidyPlan(s, space(s), proposal, { ...NO_TIDY_CHOICES, offTabs: new Set([tabId(s, 'https://github.com/b')]) })
    expect(urlsOf(s, oneTab.apply[0]!.tabIds)).toEqual(['https://github.com/a', 'https://github.com/c'])
    expect(oneTab.moved).toBe(4)
  })

  it('does not make a folder of a single tab: a group left with one is flagged and does not apply', () => {
    const { s, proposal } = setup()
    const plan = tidyPlan(s, space(s), proposal, { ...NO_TIDY_CHOICES, offTabs: new Set([tabId(s, 'https://google.com/1')]) })
    expect(plan.rows[1]).toMatchObject({ on: true, few: true, applies: false })
    expect(plan.apply.map((g) => g.name)).toEqual(['GitHub'])
  })

  it('uses the name typed, and a name that is a folder that exists sends the tabs there (one tab is enough then)', () => {
    let { s, proposal } = setup()
    s = run(s, { type: 'folder/create', name: 'Code' })
    const renamed = tidyPlan(s, space(s), proposal, { ...NO_TIDY_CHOICES, names: new Map([['github', ' code ']]), offTabs: new Set([tabId(s, 'https://github.com/a'), tabId(s, 'https://github.com/b')]) })
    expect(renamed.rows[0]).toMatchObject({ name: ' code ', kept: [tabId(s, 'https://github.com/c')], few: false, applies: true })
    expect(renamed.rows[0]!.into?.name).toBe('Code')
    expect(renamed).toMatchObject({ created: 1, extended: 1, moved: 3 })
  })

  it('counts two rows of one name as one folder', () => {
    const { s, proposal } = setup()
    const plan = tidyPlan(s, space(s), proposal, { ...NO_TIDY_CHOICES, names: new Map([['google', 'github']]) })
    expect(plan).toMatchObject({ created: 1, extended: 0, moved: 5 })
    expect(plan.apply.map((g) => g.name)).toEqual(['GitHub', 'github'])
  })

  it('says a group joins a folder that exists when the proposed name already is one', () => {
    let { s, proposal } = setup()
    s = run(s, { type: 'folder/create', name: 'github' })
    const plan = tidyPlan(s, space(s), proposal)
    expect(plan.rows[0]!.into?.name).toBe('github')
    expect(plan.rows[1]!.into).toBeUndefined()
    expect(plan).toMatchObject({ created: 1, extended: 1 })
  })

  it('forgets a tab that is no longer one that can move (closed, or pinned since the proposal was made)', () => {
    let { s, proposal } = setup()
    s = run(s, { type: 'tab/close', id: tabId(s, 'https://github.com/a') }, { type: 'tab/pin', id: tabId(s, 'https://github.com/b') })
    const plan = tidyPlan(s, space(s), proposal)
    expect(plan.rows[0]!.tabIds).toEqual([tabId(s, 'https://github.com/c')])
    expect(plan.rows[0]).toMatchObject({ few: true, applies: false })
  })
})

describe('what "Ranger" sends', () => {
  const plan = { apply: [{ name: 'GitHub', tabIds: ['a', 'b'] }] }

  it('is the groups, on top by default and with `atBottom` for the side under the tabs, for the space named', () => {
    expect(tidyActions(plan, 'sp', 'top', 'top')).toEqual([{ type: 'tabs/tidy', groups: plan.apply, spaceId: 'sp' }])
    expect(tidyActions(plan, 'sp', 'bottom', 'bottom')).toEqual([{ type: 'tabs/tidy', groups: plan.apply, spaceId: 'sp', atBottom: true }])
  })

  it('remembers the side first when the person chose another than the remembered one, and not otherwise', () => {
    expect(tidyActions(plan, 'sp', 'bottom', 'top')).toEqual([
      { type: 'settings/update', patch: { tidyFoldersPosition: 'bottom' } },
      { type: 'tabs/tidy', groups: plan.apply, spaceId: 'sp', atBottom: true }
    ])
    expect(tidyActions(plan, 'sp', 'top', 'bottom')[0]).toEqual({ type: 'settings/update', patch: { tidyFoldersPosition: 'top' } })
    expect(tidyActions(plan, 'sp', 'top', 'top').some((action) => action.type === 'settings/update')).toBe(false)
  })

  it('is nothing when no group takes part: not even the side is remembered', () => {
    expect(tidyActions({ apply: [] }, 'sp', 'bottom', 'top')).toEqual([])
  })
})

describe('what the reducer does with a validated proposal', () => {
  const urls = ['https://github.com/a', 'https://github.com/b', 'https://news.example/', 'https://google.com/1', 'https://google.com/2']
  const groupsOf = (s: SidebarState) => proposeTidy(s, space(s)).groups.map((g) => ({ name: g.name, tabIds: g.tabIds }))
  const folderOf = (s: SidebarState, name: string): Folder | undefined => s.folders.find((f) => f.name === name)
  const inFolder = (s: SidebarState, name: string): string[] => s.tabs.filter((t) => t.folderId === folderOf(s, name)?.id).map((t) => t.url)

  it('makes a folder per group, pins its tabs in it, and leaves the other tabs alone', () => {
    const s = today(...urls)
    const out = run(s, { type: 'tabs/tidy', groups: groupsOf(s) })
    expect(out.folders.map((f) => f.name)).toEqual(['GitHub', 'Google'])
    expect(inFolder(out, 'GitHub')).toEqual(['https://github.com/a', 'https://github.com/b'])
    expect(inFolder(out, 'Google')).toEqual(['https://google.com/1', 'https://google.com/2'])
    expect(out.tabs.filter((t) => t.folderId).every((t) => t.pinned && t.anchorUrl === t.url)).toBe(true)
    const alone = out.tabs.find((t) => t.url === 'https://news.example/')!
    expect(alone.pinned).toBe(false)
    expect(alone.folderId).toBeUndefined()
  })

  it('makes folders on top by default and under the Today tabs with `atBottom`, the folders that exist keeping their own side', () => {
    let s = today(...urls)
    s = run(s, { type: 'folder/create', name: 'Google' }, { type: 'folder/bottom', id: s.folders[0]?.id ?? 'none', bottom: true })
    const out = run(s, { type: 'tabs/tidy', groups: groupsOf(s) })
    expect(folderOf(out, 'GitHub')?.atBottom).toBeUndefined()
    const down = run(s, { type: 'tabs/tidy', groups: groupsOf(s), atBottom: true })
    expect(folderOf(down, 'GitHub')?.atBottom).toBe(true)
    // The Google folder was there already, on top: it stays where it is, with the two tabs added.
    expect(folderOf(down, 'Google')?.atBottom).toBeUndefined()
    expect(down.folders.filter((f) => f.name === 'Google')).toHaveLength(1)
    expect(inFolder(down, 'Google')).toEqual(['https://google.com/1', 'https://google.com/2'])
  })

  it('pours into the folder of that name, however it is written, rather than making a second', () => {
    let s = today(...urls)
    s = run(s, { type: 'folder/create', name: 'GITHUB' })
    const before = s.folders[0]!.id
    const out = run(s, { type: 'tabs/tidy', groups: groupsOf(s) })
    expect(out.folders.map((f) => f.name)).toEqual(['GITHUB', 'Google'])
    expect(out.tabs.filter((t) => t.folderId === before).map((t) => t.url)).toEqual(['https://github.com/a', 'https://github.com/b'])
  })

  it('makes one folder for groups that have one name', () => {
    const s = today(...urls)
    const [github, google] = groupsOf(s)
    const out = run(s, { type: 'tabs/tidy', groups: [github!, { name: 'github', tabIds: google!.tabIds }] })
    expect(out.folders).toHaveLength(1)
    expect(out.tabs.filter((t) => t.folderId === out.folders[0]!.id)).toHaveLength(4)
  })

  it('puts the tabs of a folder in the order the sidebar shows them, whatever the order of the groups', () => {
    const s = today('https://a.example/1', 'https://b.example/1', 'https://a.example/2')
    const [first] = groupsOf(s)
    const out = run(s, { type: 'tabs/tidy', groups: [{ name: 'A', tabIds: [...first!.tabIds].reverse() }] })
    expect(inFolder(out, 'A')).toEqual(['https://a.example/1', 'https://a.example/2'])
  })

  it('moves nothing it was not offered: a pinned tab, a tab in a folder, a tab of another space, a private tab, a tab that does not exist', () => {
    let s = today('https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4')
    const home = space(s)
    s = run(s, { type: 'tab/pin', id: tabId(s, 'https://a.example/1') }, { type: 'folder/create-with', tabIds: [tabId(s, 'https://a.example/2')], name: 'Ailleurs' })
    s = run(s, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 })
    s = run(s, { type: 'tab/open', url: 'https://a.example/5', background: true }, { type: 'space/select', id: home })
    const all = ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4', 'https://a.example/5'].map((u) => tabId(s, u))
    const out = run(s, { type: 'tabs/tidy', groups: [{ name: 'A', tabIds: [...all, 'nope'] }] })
    expect(inFolder(out, 'A')).toEqual(['https://a.example/3', 'https://a.example/4'])
    expect(out.tabs.find((t) => t.url === 'https://a.example/1')?.folderId).toBeUndefined()
    expect(out.tabs.find((t) => t.url === 'https://a.example/2')?.folderId).toBe(folderOf(out, 'Ailleurs')!.id)
    const elsewhere = out.tabs.find((t) => t.url === 'https://a.example/5')!
    expect(elsewhere.pinned).toBe(false)
    expect(elsewhere.folderId).toBeUndefined()
  })

  it('works on the space named, the one on screen without it, and the one on screen when the name is no space', () => {
    let s = run(createInitialState(ctx), { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 })
    const [home, other] = s.spaces.map((sp) => sp.id) as [string, string]
    s = run(s, { type: 'tab/open', url: 'https://a.example/1', background: true, spaceId: home }, { type: 'tab/open', url: 'https://a.example/2', background: true, spaceId: home })
    s = run(s, { type: 'tab/open', url: 'https://b.example/1', background: true, spaceId: other }, { type: 'tab/open', url: 'https://b.example/2', background: true, spaceId: other })
    const groups = (spaceId: string) => proposeTidy(s, spaceId).groups.map((g) => ({ name: g.name, tabIds: g.tabIds }))
    expect(s.activeSpaceId).toBe(other)
    expect(run(s, { type: 'tabs/tidy', groups: groups(home), spaceId: home }).folders.map((f) => [f.name, f.spaceId])).toEqual([['A', home]])
    // Without a space the tabs of the other one are not candidates: nothing moves.
    expect(run(s, { type: 'tabs/tidy', groups: groups(home) })).toBe(s)
    expect(run(s, { type: 'tabs/tidy', groups: groups(home), spaceId: 'gone' })).toBe(s)
    expect(run(s, { type: 'tabs/tidy', groups: groups(other) }).folders.map((f) => [f.name, f.spaceId])).toEqual([['B', other]])
  })

  it('is the same state when there is nothing to do: no group, an empty one, tabs that cannot move, a payload that is no list', () => {
    const s = today(...urls)
    expect(run(s, { type: 'tabs/tidy', groups: [] })).toBe(s)
    expect(run(s, { type: 'tabs/tidy', groups: [{ name: 'X', tabIds: [] }, { name: 'Y', tabIds: ['nope'] }] })).toBe(s)
    for (const groups of [null, 'groups', 7, {}, [null, 4, 'x', { name: 'Z', tabIds: 'abc' }, { name: 'Z', tabIds: [1, null, {}] }]]) expect(run(s, { type: 'tabs/tidy', groups } as never)).toBe(s)
  })

  it('reads no more than the bound of tabs, however many a group names', () => {
    let s = createInitialState(ctx)
    const count = TIDY_TABS_MAX + 100
    s = { ...s, tabs: Array.from({ length: count }, (_, i): TabItem => ({ id: `t${i}`, spaceId: s.activeSpaceId, url: `https://a.example/${i}`, title: 'A', pinned: false, createdAt: 1, lastActiveAt: 1 })) }
    const out = run(s, { type: 'tabs/tidy', groups: [{ name: 'A', tabIds: s.tabs.map((t) => t.id) }] })
    expect(out.tabs.filter((t) => t.folderId !== undefined)).toHaveLength(TIDY_TABS_MAX)
    expect(out.tabs.filter((t) => t.pinned === false)).toHaveLength(100)
  })

  it('reads a payload from the interface as far as it can be: a name that is no text gives "Nouveau dossier", a group past the bound is dropped', () => {
    setLanguage('fr')
    const s = today(...urls)
    const [github] = groupsOf(s)
    const out = run(s, { type: 'tabs/tidy', groups: [{ name: 42, tabIds: github!.tabIds }] as never })
    expect(out.folders.map((f) => f.name)).toEqual(['Nouveau dossier'])
    expect(github).toBeTruthy()
  })

  it('reads no more than the bound of groups', () => {
    let s = createInitialState(ctx)
    s = { ...s, tabs: Array.from({ length: TIDY_GROUPS_MAX + 100 }, (_, i): TabItem => ({ id: `t${i}`, spaceId: s.activeSpaceId, url: `https://a${i}.example/`, title: 'A', pinned: false, createdAt: 1, lastActiveAt: 1 })) }
    const out = run(s, { type: 'tabs/tidy', groups: s.tabs.map((t, i) => ({ name: `G${i}`, tabIds: [t.id] })) })
    expect(out.folders).toHaveLength(TIDY_GROUPS_MAX)
    expect(out.tabs.filter((t) => !t.pinned)).toHaveLength(100)
  })

  it('keeps the tab on screen on screen', () => {
    let s = today(...urls)
    s = run(s, { type: 'tab/select', id: tabId(s, 'https://github.com/a') })
    const out = run(s, { type: 'tabs/tidy', groups: groupsOf(s) })
    expect(out.activeTabBySpace[space(out)]).toBe(tabId(s, 'https://github.com/a'))
  })
})

describe('taking a tidy back', () => {
  const urls = ['https://github.com/a', 'https://news.example/', 'https://github.com/b', 'https://google.com/1', 'https://lone.example/', 'https://google.com/2']
  const groupsOf = (s: SidebarState) => proposeTidy(s, space(s)).groups.map((g) => ({ name: g.name, tabIds: g.tabIds }))
  const shape = (s: SidebarState) => JSON.stringify({ tabs: s.tabs.map((t) => [t.id, t.pinned, t.folderId ?? null, t.anchorUrl ?? null, t.openerId ?? null]), folders: s.folders })

  it('is nothing when no tab moved', () => {
    const s = today(...urls)
    expect(tidyOutcome(s, s)).toBeNull()
    expect(tidyOutcome(s, run(s, { type: 'tab/pin', id: s.tabs[0]!.id }))).toBeNull()
  })

  it('counts the folders made and the folders that took tabs, and the tabs moved', () => {
    let s = today(...urls)
    s = run(s, { type: 'folder/create', name: 'GitHub' })
    const out = run(s, { type: 'tabs/tidy', groups: groupsOf(s) })
    expect(tidyOutcome(s, out)).toMatchObject({ created: 1, extended: 1, moved: 4 })
  })

  it('puts back exactly what was there in one step: the same tabs at the same places, the folders made gone', () => {
    const s = today(...urls)
    const out = run(s, { type: 'tabs/tidy', groups: groupsOf(s) })
    expect(shape(out)).not.toBe(shape(s))
    const outcome = tidyOutcome(s, out)!
    expect(outcome.undo.type).toBe('tabs/untidy')
    expect(shape(run(out, outcome.undo))).toBe(shape(s))
  })

  it('gives a tab opened from a link its origin back (a pin forgets it, and Back on its first page closes it again)', () => {
    let s = today('https://github.com/a')
    s = run(s, { type: 'tab/open', url: 'https://github.com/b', background: true, openerId: tabId(s, 'https://github.com/a') })
    expect(s.tabs[1]!.openerId).toBe(s.tabs[0]!.id)
    const out = run(s, { type: 'tabs/tidy', groups: groupsOf(s) })
    expect(out.tabs.every((t) => t.openerId === undefined)).toBe(true)
    const back = run(out, tidyOutcome(s, out)!.undo)
    expect(back.tabs[1]!.openerId).toBe(back.tabs[0]!.id)
  })

  it('leaves the folder that was there before, with what it held, and takes out only what the tidy put in', () => {
    let s = today(...urls)
    s = run(s, { type: 'folder/create-with', tabIds: [tabId(s, 'https://lone.example/')], name: 'GitHub' })
    const out = run(s, { type: 'tabs/tidy', groups: groupsOf(s) })
    const outcome = tidyOutcome(s, out)!
    // The tab that was in the folder already did not move: it is not counted, and the undo does not name it.
    expect(outcome).toMatchObject({ created: 1, extended: 1, moved: 4 })
    expect(JSON.stringify(outcome.undo)).not.toContain(tabId(s, 'https://lone.example/'))
    const back = run(out, outcome.undo)
    expect(back.folders.map((f) => f.name)).toEqual(['GitHub'])
    expect(back.tabs.filter((t) => t.folderId === back.folders[0]!.id).map((t) => t.url)).toEqual(['https://lone.example/'])
    expect(back.tabs.filter((t) => !t.pinned).map((t) => t.url)).toEqual(['https://github.com/a', 'https://news.example/', 'https://github.com/b', 'https://google.com/1', 'https://google.com/2'])
  })

  it('keeps a folder somebody has put something in since, and leaves alone a tab that is no longer where the tidy put it', () => {
    const s = today(...urls)
    const out = run(s, { type: 'tabs/tidy', groups: groupsOf(s) })
    const undo = tidyOutcome(s, out)!.undo
    const github = out.folders.find((f) => f.name === 'GitHub')!
    const google = out.folders.find((f) => f.name === 'Google')!
    // The person added a tab to GitHub, a folder to it, and moved a Google tab to GitHub.
    let later = run(out, { type: 'tab/move', id: tabId(out, 'https://news.example/'), toIndex: 0, pinned: true, folderId: github.id })
    later = run(later, { type: 'tab/move', id: tabId(out, 'https://google.com/1'), toIndex: 0, pinned: true, folderId: github.id })
    const back = run(later, undo)
    expect(back.folders.map((f) => f.name)).toEqual(['GitHub'])
    expect(back.tabs.find((t) => t.url === 'https://google.com/1')).toMatchObject({ pinned: true, folderId: github.id })
    expect(back.tabs.find((t) => t.url === 'https://google.com/2')).toMatchObject({ pinned: false })
    expect(google.id).not.toBe(github.id)
    // A folder inside the one that was made keeps it too.
    const nested = run(out, { type: 'folder/create', name: 'Dedans', parentId: google.id })
    expect(run(nested, undo).folders.map((f) => f.name).sort()).toEqual(['Dedans', 'Google'])
  })

  it('ignores a tab that was closed or archived since, and a payload that is no list', () => {
    const s = today(...urls)
    const out = run(s, { type: 'tabs/tidy', groups: groupsOf(s) })
    const undo = tidyOutcome(s, out)!.undo
    const closed = run(out, { type: 'tab/remove-pinned', id: tabId(out, 'https://github.com/a') })
    expect(closed.archive).toHaveLength(1)
    const back = run(closed, undo)
    expect(back.tabs.some((t) => t.url === 'https://github.com/a')).toBe(false)
    expect(back.tabs.filter((t) => t.pinned)).toHaveLength(0)
    for (const bad of [{ type: 'tabs/untidy', tabs: null, folderIds: 'x' }, { type: 'tabs/untidy', tabs: [null, 3, { id: 1 }, { id: 'a', folderId: 'b', index: 'c' }], folderIds: [4, null] }]) {
      expect(run(out, bad as never)).toBe(out)
    }
  })

  // The property: from states made at random (the same sites, pinned tabs, folders of the same names, split views), tidying and taking back is the identity.
  it('is the identity on random states: tidy, then take back', () => {
    let seed = 12345
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const hosts = ['github.com', 'docs.google.com', 'www.google.fr', 'example.org', 'a.example.org', 'localhost:3000', 'alice.github.io', 'news.ycombinator.com']
    let tidied = 0
    for (let round = 0; round < 60; round++) {
      let s = createInitialState(ctx)
      const count = 2 + Math.floor(rand() * 14)
      for (let i = 0; i < count; i++) s = run(s, { type: 'tab/open', url: `https://${hosts[Math.floor(rand() * hosts.length)]}/p${i}`, background: true, ...(i > 0 && rand() < 0.3 ? { openerId: s.tabs[Math.floor(rand() * s.tabs.length)]!.id } : {}) })
      if (rand() < 0.5) s = run(s, { type: 'tab/pin', id: s.tabs[Math.floor(rand() * s.tabs.length)]!.id })
      if (rand() < 0.5) s = run(s, { type: 'folder/create', name: rand() < 0.5 ? 'GitHub' : 'Google' })
      if (rand() < 0.3) s = run(s, { type: 'split/create', tabId: s.tabs[0]!.id, withTabId: s.tabs[1]!.id })
      const proposal = proposeTidy(s, space(s))
      const out = run(s, { type: 'tabs/tidy', groups: proposal.groups.map((g) => ({ name: g.name, tabIds: g.tabIds })), ...(rand() < 0.5 ? { atBottom: true } : {}) })
      const outcome = tidyOutcome(s, out)
      if (!outcome) {
        expect(out).toBe(s)
        continue
      }
      tidied++
      expect(shape(run(out, outcome.undo)), `round ${round}`).toBe(shape(s))
    }
    expect(tidied).toBeGreaterThan(20)
  })
})

describe('the notice that follows', () => {
  it('says "3 dossiers créés", singular for one, and the folders that took tabs when there were some', () => {
    setLanguage('fr')
    expect(tidyNotice({ created: 3, extended: 0 })).toBe('3 dossiers créés')
    expect(tidyNotice({ created: 1, extended: 0 })).toBe('1 dossier créé')
    expect(tidyNotice({ created: 0, extended: 1 })).toBe('1 dossier existant complété')
    expect(tidyNotice({ created: 2, extended: 3 })).toBe('2 dossiers créés, 3 dossiers existants complétés')
  })

  it('reads in English when the interface does', () => {
    setLanguage('en')
    try {
      expect(tidyNotice({ created: 3, extended: 0 })).toBe('3 folders created')
      expect(tidyNotice({ created: 1, extended: 1 })).toBe('1 folder created, 1 existing folder filled')
    } finally {
      setLanguage('fr')
    }
  })
})
