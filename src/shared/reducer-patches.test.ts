// What the reducer copies from a patch (`tab/update`, `space/update`) and what it takes from a private tab. These patches are sent by the engine
// (a page's title, address and icon) or by the interface; the interface is not trusted with fields it has no reason to set, so each field has its
// rule and the rest of the patch is ignored.

import { describe, expect, it } from 'vitest'
import type { SidebarState, TabItem } from './model'
import { cleanFaviconUrl } from './state-clean'
import { createInitialState, normalize, reduce, type Action, type Ctx } from './sidebar'

function makeCtx(): Ctx {
  let n = 0
  return { now: 1_000_000, newId: () => `id${++n}` }
}
const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const patchOf = (patch: unknown): never => patch as never

function oneTab(url = 'https://a.example/') {
  const ctx = makeCtx()
  const state = run(ctx, createInitialState(ctx), { type: 'tab/open', url })
  return { ctx, state, tab: state.tabs[0]!, space: state.spaces[0]! }
}
const tabOf = (state: SidebarState, id: string): TabItem => state.tabs.find((t) => t.id === id)!

describe('tab/update takes an address, a title and an icon, and nothing else', () => {
  it('ignores every other field of a tab (this fails if the patch is spread whole)', () => {
    const { ctx, state, tab } = oneTab()
    const second = run(ctx, state, { type: 'space/create', name: 'Autre', emoji: 'a', hue: 3 })
    const forged = { title: 'Titre', spaceId: second.spaces[1]!.id, private: true, container: 'nope', id: 'forged', anchorUrl: 'javascript:1', pinned: true, customTitle: 'x', openerId: 'o', parentId: 'p', windowKey: 'w', keepAwake: true, autoReload: { seconds: 5 } }
    const next = run(ctx, second, { type: 'tab/update', id: tab.id, patch: patchOf(forged) })
    expect(tabOf(next, tab.id)).toEqual({ ...tab, title: 'Titre' })
    expect(next.tabs).toHaveLength(1)
  })

  it('takes an address only when it is a web page, a page that cannot be forged into a script, or another page of the extension the tab is on', () => {
    const { ctx, state, tab } = oneTab()
    const urlAfter = (url: unknown, from = state) => tabOf(run(ctx, from, { type: 'tab/update', id: tab.id, patch: patchOf({ url }) }), tab.id).url
    expect(urlAfter('https://b.example/deep?x=1#y')).toBe('https://b.example/deep?x=1#y')
    expect(urlAfter('about:blank')).toBe('about:blank')
    expect(urlAfter('file:///Users/me/doc.html')).toBe('file:///Users/me/doc.html')
    expect(urlAfter('view-source:https://b.example/')).toBe('view-source:https://b.example/')
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'chrome://gpu', 'devtools://devtools/x', 'blob:https://b.example/x', 'ftp://b.example/', 'not an address', '', 5, null, {}, ['https://b.example/']]) expect(urlAfter(bad), String(bad)).toBe('https://a.example/')
    // An extension's page only from a tab that already is on a page of that extension.
    const ext = (letter: string, path = 'p.html') => `chrome-extension://${letter.repeat(32)}/${path}`
    expect(urlAfter(ext('a'))).toBe('https://a.example/')
    const onExtension = run(ctx, state, { type: 'tab/open', url: ext('a'), allowExtensionPages: true })
    const extTab = onExtension.tabs[1]!
    const extAfter = (url: string) => tabOf(run(ctx, onExtension, { type: 'tab/update', id: extTab.id, patch: { url } }), extTab.id).url
    expect(extAfter(ext('a', 'options.html#/list'))).toBe(ext('a', 'options.html#/list'))
    expect(extAfter(ext('b'))).toBe(ext('a'))
    expect(extAfter('https://b.example/')).toBe('https://b.example/')
  })

  it('bounds the title and takes the control characters out of it', () => {
    const { ctx, state, tab } = oneTab()
    const titled = (title: unknown) => tabOf(run(ctx, state, { type: 'tab/update', id: tab.id, patch: patchOf({ title }) }), tab.id).title
    expect(titled('Une page')).toBe('Une page')
    expect(titled('')).toBe('')
    expect(titled('a\nb\u0000c\u001b[31m')).toBe('a b c [31m')
    expect(titled('x'.repeat(5_000_000))).toHaveLength(1000)
    for (const bad of [5, null, {}, ['x']]) expect(titled(bad), String(bad)).toBe(tab.title)
  })

  it('takes an icon that is a web address or a small image, and nothing else (this fails if the icon is not filtered when it is written)', () => {
    const { ctx, state, tab } = oneTab()
    const iconAfter = (faviconUrl: unknown, from = state) => tabOf(run(ctx, from, { type: 'tab/update', id: tab.id, patch: patchOf({ faviconUrl }) }), tab.id).faviconUrl
    expect(iconAfter('https://a.example/favicon.ico')).toBe('https://a.example/favicon.ico')
    expect(iconAfter('http://a.example/favicon.ico')).toBe('http://a.example/favicon.ico')
    expect(iconAfter('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=')
    const big = `data:image/png;base64,${'A'.repeat(65_536 - 'data:image/png;base64,'.length)}`
    expect(big).toHaveLength(65_536)
    expect(iconAfter(big)).toBe(big)
    expect(iconAfter(`${big}A`)).toBeUndefined()
    expect(iconAfter(`data:image/png;base64,${'A'.repeat(2_000_000)}`)).toBeUndefined()
    for (const bad of ['file:///Users/me/secret.png', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/i.png', 'blob:https://a.example/x', '//a.example/i.png', 'a.example/i.png', '', 5, null]) expect(iconAfter(bad), String(bad)).toBeUndefined()
    // A refused icon leaves the one the tab had.
    const withIcon = run(ctx, state, { type: 'tab/update', id: tab.id, patch: { faviconUrl: 'https://a.example/old.ico' } })
    expect(iconAfter('file:///x.png', withIcon)).toBe('https://a.example/old.ico')
  })

  it('leaves the state as it was when nothing in the patch is taken, and for a tab that does not exist', () => {
    const { ctx, state, tab } = oneTab()
    expect(reduce(state, { type: 'tab/update', id: tab.id, patch: patchOf({ spaceId: 'x', private: true }) }, ctx)).toBe(state)
    expect(reduce(state, { type: 'tab/update', id: tab.id, patch: patchOf(null) }, ctx)).toBe(state)
    expect(reduce(state, { type: 'tab/update', id: tab.id, patch: patchOf('title') }, ctx)).toBe(state)
    expect(reduce(state, { type: 'tab/update', id: tab.id, patch: {} }, ctx)).toBe(state)
    expect(reduce(state, { type: 'tab/update', id: 'ghost', patch: { title: 'x' } }, ctx)).toBe(state)
  })

  it('tidies the title of a pinned tab as before', () => {
    const { ctx, state, tab } = oneTab('https://github.com/org/repo')
    const pinned = run(ctx, state, { type: 'tab/pin', id: tab.id })
    const next = run(ctx, { ...pinned, settings: { ...pinned.settings, tidyPinnedTitles: true } }, { type: 'tab/update', id: tab.id, patch: { title: 'Pull requests · org/repo · GitHub' } })
    expect(tabOf(next, tab.id).title).toBe('GitHub')
  })
})

describe('space/update takes a name, an icon, a profile and a theme, and nothing else', () => {
  it('ignores every other field of a space (this fails if the patch is spread whole)', () => {
    const { ctx, state, space } = oneTab()
    const forged = { name: 'Neuf', id: 'forged', image: 'x.png', webPanels: [{ id: 'p', url: 'file:///etc/passwd', title: 'x' }], hideHeader: true, extra: 1 }
    const next = run(ctx, state, { type: 'space/update', id: space.id, patch: patchOf(forged) })
    expect(next.spaces[0]).toEqual({ ...space, name: 'Neuf' })
  })

  it('refuses the whole patch when its profile is not a plain id: it names a folder of the data directory, or the session of another context (this fails if the id is not checked)', () => {
    const { ctx, state, space } = oneTab()
    for (const bad of ['persist:profile-x/../../y', 'x/../../y', '../y', 'ephemeral:1', 'container:abc', 'a b', '', '__proto__', 'x'.repeat(33), 5, null, {}, ['a']]) {
      expect(reduce(state, { type: 'space/update', id: space.id, patch: patchOf({ name: 'Autre nom', profileId: bad }) }, ctx), String(bad)).toBe(state)
    }
    const next = run(ctx, state, { type: 'space/update', id: space.id, patch: { name: 'Autre nom', profileId: 'travail-2_b' } })
    expect(next.spaces[0]).toMatchObject({ name: 'Autre nom', profileId: 'travail-2_b' })
    expect(run(ctx, state, { type: 'space/update', id: space.id, patch: { profileId: undefined, emoji: '💼' } }).spaces[0]).toMatchObject({ profileId: 'default', emoji: '💼' })
  })

  it('bounds the name and the icon, and ignores one that is blank or not text', () => {
    const { ctx, state, space } = oneTab()
    const after = (patch: unknown) => run(ctx, state, { type: 'space/update', id: space.id, patch: patchOf(patch) }).spaces[0]!
    expect(after({ name: '  Boulot  ' }).name).toBe('  Boulot  ')
    expect(after({ name: 'a\nb' }).name).toBe('a b')
    expect(after({ name: 'x'.repeat(100_000) }).name).toHaveLength(200)
    for (const bad of [{ name: '   ' }, { name: 5 }, { name: null }, { emoji: '  ' }, { emoji: {} }]) expect(after(bad), JSON.stringify(bad)).toEqual(space)
  })

  it('takes one emoji, one letter or one digit as the icon, and keeps the one the space has for anything else (a word, two emoji, two letters)', () => {
    const { ctx, state, space } = oneTab()
    const after = (patch: unknown) => run(ctx, state, { type: 'space/update', id: space.id, patch: patchOf(patch) }).spaces[0]!
    for (const emoji of ['💼', '👩‍💻', '🇫🇷', '🛠️', 'a', 'É', '7']) expect(after({ emoji }).emoji, emoji).toBe(emoji)
    // A letter written with its accent apart is kept as the one letter it draws.
    expect(after({ emoji: 'e\u0301' }).emoji).toBe('\u00E9')
    for (const bad of ['e'.repeat(1000), 'Travail', 'ab', '42', 'a ', '-', '💼💼', '💼 ', '<b>']) expect(after({ emoji: bad }), bad).toEqual(space)
  })

  it('gives a new space the emoji, the letter or the digit it is created with when it is one, and ✨ otherwise', () => {
    const { ctx, state } = oneTab()
    const created = (emoji: unknown) => run(ctx, state, { type: 'space/create', name: 'Autre', emoji: emoji as string, hue: 3 }).spaces.at(-1)!.emoji
    for (const good of ['🚀', 'a', 'Z', '3']) expect(created(good), good).toBe(good)
    for (const bad of ['Travail', 'ab', '12', '?', '🚀🚀', '', 7]) expect(created(bad), String(bad)).toBe('✨')
  })

  it('keeps repairing the theme, and ignores one that is not a record', () => {
    const { ctx, state, space } = oneTab()
    const themed = run(ctx, state, { type: 'space/update', id: space.id, patch: { theme: { intensity: 0.4, angle: 999 } } })
    expect(themed.spaces[0]!.theme).toMatchObject({ intensity: 0.4, angle: 360 })
    for (const bad of ['dark', 5, null, ['x']]) expect(run(ctx, state, { type: 'space/update', id: space.id, patch: patchOf({ theme: bad }) }).spaces[0]!.theme, String(bad)).toEqual(space.theme)
  })

  it('takes a valid background media patch, rejects invalid media names, and clears it when asked', () => {
    const { ctx, state, space } = oneTab()
    const withVideo = run(ctx, state, { type: 'space/update', id: space.id, patch: { background: { type: 'video', value: '1234-aaaa.mp4', muted: true, loop: true } } })
    expect(withVideo.spaces[0]!.background).toEqual({ type: 'video', value: '1234-aaaa.mp4', muted: true, loop: true })

    const refused = run(ctx, withVideo, { type: 'space/update', id: space.id, patch: patchOf({ background: { type: 'video', value: '../escape.mp4' } }) })
    expect(refused.spaces[0]!.background).toEqual(withVideo.spaces[0]!.background)

    const cleared = run(ctx, withVideo, { type: 'space/update', id: space.id, patch: { background: undefined } })
    expect(cleared.spaces[0]!.background).toBeUndefined()
  })
})

describe('a choice about a site made from a private tab is not written to the settings', () => {
  function withPrivateTab() {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const state = run(ctx, { ...base, settings: { ...base.settings, privateTabs: true } }, { type: 'tab/open', url: 'https://ordinaire.example/' }, { type: 'tab/open', url: 'https://prive.example/', private: true })
    return { ctx, state, normal: state.tabs[0]!, secret: state.tabs[1]! }
  }
  const choices = (site: string, tabId?: string): Action[] => [
    { type: 'blocking/exempt-site', site, exempt: true, ...(tabId ? { tabId } : {}) },
    { type: 'autoplay/site', site, mode: 'allow', ...(tabId ? { tabId } : {}) },
    { type: 'siteclear/site', site, on: true, ...(tabId ? { tabId } : {}) }
  ]

  it('changes nothing for a private tab, whichever of the three choices it is (this fails if the tab is not looked at)', () => {
    const { ctx, state, secret } = withPrivateTab()
    for (const action of choices('https://prive.example/', secret.id)) expect(reduce(state, action, ctx), action.type).toBe(state)
    expect(JSON.stringify(state.settings)).not.toContain('prive.example')
  })

  it('still writes it for an ordinary tab, for a choice made in the settings (no tab), and for a tab that does not exist', () => {
    const { ctx, state, normal } = withPrivateTab()
    const cases: [site: string, tabId: string | undefined, host: string][] = [
      ['https://ordinaire.example/', normal.id, 'ordinaire.example'],
      ['prive.example', undefined, 'prive.example'],
      ['ordinaire.example', 'ghost', 'ordinaire.example']
    ]
    for (const [site, tabId, host] of cases) {
      // Each choice lands in its own setting, under the site's host, with the value asked for.
      const after = run(ctx, state, ...choices(site, tabId))
      expect(after.settings.blockExceptions, `${site} ${tabId}`).toEqual([...state.settings.blockExceptions, host])
      expect(after.settings.siteAutoplay, `${site} ${tabId}`).toEqual({ ...state.settings.siteAutoplay, [host]: 'allow' })
      expect(after.settings.siteDataClearOnClose, `${site} ${tabId}`).toEqual([...state.settings.siteDataClearOnClose, host])
    }
  })
})

describe('cleanFaviconUrl', () => {
  it('is the rule of the icon of a saved tab too: a state file with a file: icon loses it', () => {
    expect(cleanFaviconUrl('https://a.example/i.png')).toBe('https://a.example/i.png')
    expect(cleanFaviconUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe('data:image/svg+xml;base64,PHN2Zz4=')
    expect(cleanFaviconUrl('file:///x.png')).toBeUndefined()
    expect(cleanFaviconUrl(undefined)).toBeUndefined()
    const { state, tab } = oneTab()
    const loaded = normalize({ ...state, tabs: [{ ...tab, faviconUrl: 'file:///Users/me/secret.png' }], favorites: [{ id: 'f', url: 'https://a.example/', title: 'A', faviconUrl: 'javascript:1' }] })
    expect(loaded.tabs[0]!.faviconUrl).toBeUndefined()
    expect(loaded.favorites[0]!.faviconUrl).toBeUndefined()
  })
})
