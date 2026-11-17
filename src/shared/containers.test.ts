// Tab containers: the rules (names, ids, rules of sites, remembered permissions), what the reducer does with them, what a file can say, and
// what a private window never gets.

import { describe, expect, it, vi } from 'vitest'
import {
  CONTAINERS_MAX,
  CONTAINER_COLORS,
  CONTAINER_RULES_MAX,
  cleanContainerRules,
  cleanContainers,
  containerForUrl,
  containerNameInvalid,
  containerNameTaken,
  containerOfTab,
  containerIdsOfStateText,
  containerRuleHost,
  containersKeptTooLong,
  containersNamedByCopies,
  containersToSweep,
  ORPHAN_CONTAINER_KEEP_MS,
  isContainerId,
  newContainerId,
  orphanContainerIds,
  pruneContainers,
  validateContainerName,
  withContainerPermission,
  withContainerRule,
  withoutContainerPages,
  type Container
} from './containers'
import { CONTAINER_DIR_PREFIX, containerIdOfDir, containerPartition, containerScopeKey } from './container-id'
import { interfaceMayDispatch } from './ipc-policy'
import { defaultSettings, type SidebarState } from './model'
import { createPrivateState, inheritedSettings, privateAction } from './private-window'
import { activeTab, createInitialState, normalize, persistableState, reduce, type Action, type Ctx } from './sidebar'
import { sessionTabsOf } from './sessions'
import { ARCHIVE_LIMIT, cleanTabs } from './state-clean'
import { candidateDispatches, rankCandidates, type Candidate } from './command-bar'
import { menuKey } from './menu-state'
import { sitesToClearOnClose } from './site-clear'
import { frenchSpaces } from './french-typography'

let counter = 0
const ctx: Ctx = { now: 1_000_000, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** A state with the function on and two containers, "Travail" and "Perso". */
function start(): SidebarState {
  counter = 0
  const base = run(createInitialState(ctx), { type: 'settings/update', patch: { tabContainers: true } })
  return run(base, { type: 'container/create', name: 'Travail', color: 'orange' }, { type: 'container/create', name: 'Perso', color: 'purple' })
}

const idOf = (state: SidebarState, name: string): string => state.settings.containers.find((c) => c.name === name)!.id

describe('container names and ids', () => {
  it('refuses a blank name, a long one, one with a control character and a non-text', () => {
    for (const name of ['', '   ', 'x'.repeat(31), 'a\nb', 'a\u0000b', 3, null, undefined]) expect(validateContainerName(name, []), String(name)).toBe(containerNameInvalid())
    expect(validateContainerName('x'.repeat(30), [])).toBeNull()
  })

  it('refuses a name another container has, whatever its case and spacing', () => {
    expect(validateContainerName('  travail ', ['Travail'])).toBe(containerNameTaken())
    expect(validateContainerName('TRAVAIL', ['Travail'])).toBe(containerNameTaken())
    expect(validateContainerName('Tra  vail', ['Tra vail'])).toBe(containerNameTaken())
    expect(validateContainerName('Perso', ['Travail'])).toBeNull()
  })

  it('makes a slug of the name, with the suffix, and a number when it is taken', () => {
    expect(newContainerId('Travail & Co', '3fa9c-zzz', [])).toBe('travail-co-3fa9c')
    expect(newContainerId('Été à Zürich', 'a1', [])).toBe('ete-a-zurich-a1')
    expect(newContainerId('日本語', 'b2', [])).toBe('conteneur-b2')
    expect(newContainerId('Travail', '3fa9c', ['travail-3fa9c'])).toBe('travail-3fa9c-2')
    expect(newContainerId('Travail', '', [])).toBe('travail')
  })

  it('always makes an id the engine accepts as a folder name', () => {
    for (const name of ['a'.repeat(40), '---', 'Mon super conteneur de travail', '__proto__', 'con/../tainer']) {
      const id = newContainerId(name, 'ABCDEFG', [])
      expect(isContainerId(id), `${name} -> ${id}`).toBe(true)
      expect(containerPartition(id)).toBe(`persist:container-${id}`)
    }
  })

  it('knows the folder of a container on disk, and nothing else', () => {
    expect(containerIdOfDir(`${CONTAINER_DIR_PREFIX}travail-3fa9c`)).toBe('travail-3fa9c')
    for (const dir of ['profile-default', 'container-', 'container-../x', 'container-A', 'container-a/b', 'x']) expect(containerIdOfDir(dir), dir).toBeNull()
    expect(containerScopeKey('travail-3fa9c')).toBe('container:travail-3fa9c')
  })
})

describe('what a file can say about containers', () => {
  it('keeps the good ones, repairs a colour, and drops duplicates and ids that are not slugs', () => {
    const clean = cleanContainers([
      { id: 'a-1', name: 'Un', color: 'red' },
      { id: 'a-1', name: 'Doublon d’id', color: 'red' },
      { id: 'b-2', name: 'un', color: 'red' },
      { id: 'c-3', name: 'Trois', color: 'not-a-colour' },
      { id: '../etc', name: 'Chemin', color: 'red' },
      { id: 'D-4', name: 'Majuscule', color: 'red' },
      { id: 'e-5', name: '   ', color: 'red' },
      { id: '__proto__', name: 'Proto', color: 'red' },
      'x',
      null
    ])
    expect(clean.map((c) => [c.id, c.name, c.color])).toEqual([['a-1', 'Un', 'red'], ['c-3', 'Trois', CONTAINER_COLORS[0].id]])
  })

  it('keeps at most CONTAINERS_MAX', () => {
    const many = Array.from({ length: CONTAINERS_MAX + 5 }, (_, i) => ({ id: `c-${i}`, name: `Conteneur ${i}`, color: 'blue' }))
    expect(cleanContainers(many)).toHaveLength(CONTAINERS_MAX)
  })

  it('keeps the remembered permissions of web origins only, with known decisions', () => {
    const [kept] = cleanContainers([
      { id: 'a-1', name: 'Un', color: 'red', permissions: { 'https://ok.example': { media: 'allow', camera: 'maybe' }, null: { media: 'allow' }, 'file://x': { media: 'allow' }, '__proto__': { media: 'allow' } } }
    ])
    expect(kept!.permissions).toEqual({ 'https://ok.example': { media: 'allow' } })
    expect(cleanContainers([{ id: 'a-1', name: 'Un', color: 'red', permissions: { null: { media: 'allow' } } }])[0]).not.toHaveProperty('permissions')
  })

  it('reads the host of a rule: a domain, an address, never a path, a port or a login', () => {
    expect(containerRuleHost('Example.COM')).toBe('example.com')
    expect(containerRuleHost('www.example.com')).toBe('example.com')
    expect(containerRuleHost('https://www.example.com/chemin?x=1')).toBe('example.com')
    expect(containerRuleHost('  mail.example.org  ')).toBe('mail.example.org')
    for (const bad of ['', 'exemple', 'example.com/chemin', 'example.com:8080', 'user@example.com', 'https://user:pw@example.com/', 'a b.com', '.example.com', 'example..com', 'javascript:alert(1)', 3, null]) expect(containerRuleHost(bad), String(bad)).toBeNull()
  })

  it('keeps the rules that name a host and a container that exists, each host once', () => {
    const containers = [{ id: 'a-1' }]
    const rules = cleanContainerRules(
      [
        { host: 'example.com', containerId: 'a-1' },
        { host: 'www.example.com', containerId: 'a-1' },
        { host: 'other.example', containerId: 'gone-9' },
        { host: 'bad host', containerId: 'a-1' },
        { host: 'ok.example', containerId: 'A-1' }
      ],
      containers
    )
    expect(rules).toEqual([{ host: 'example.com', containerId: 'a-1' }])
    expect(cleanContainerRules(Array.from({ length: CONTAINER_RULES_MAX + 10 }, (_, i) => ({ host: `site${i}.example`, containerId: 'a-1' })), containers)).toHaveLength(CONTAINER_RULES_MAX)
  })
})

describe('the rule of a site', () => {
  const settings = (over: Partial<ReturnType<typeof defaultSettings>> = {}) => ({
    ...defaultSettings(),
    tabContainers: true,
    containers: [{ id: 'work-1', name: 'Travail', color: 'blue' as const }, { id: 'pro-2', name: 'Pro', color: 'red' as const }],
    containerRules: [{ host: 'example.com', containerId: 'work-1' }, { host: 'app.example.com', containerId: 'pro-2' }],
    ...over
  })

  it('applies to the host and its subdomains, the most specific host first', () => {
    expect(containerForUrl(settings(), 'https://example.com/a')).toBe('work-1')
    expect(containerForUrl(settings(), 'https://www.example.com/a')).toBe('work-1')
    expect(containerForUrl(settings(), 'https://mail.example.com/')).toBe('work-1')
    expect(containerForUrl(settings(), 'https://app.example.com/')).toBe('pro-2')
    expect(containerForUrl(settings(), 'https://notexample.com/')).toBeUndefined()
    expect(containerForUrl(settings(), 'about:blank')).toBeUndefined()
  })

  it('is not applied while the function is off, nor for a container that is gone', () => {
    expect(containerForUrl(settings({ tabContainers: false }), 'https://example.com/')).toBeUndefined()
    expect(containerForUrl(settings({ containers: [] }), 'https://example.com/')).toBeUndefined()
  })

  it('is set and freed without disturbing the others, and refuses what it cannot keep', () => {
    const containers = [{ id: 'a-1' }, { id: 'b-2' }]
    const one = withContainerRule([], containers, 'Example.com', 'a-1')
    expect(one).toEqual([{ host: 'example.com', containerId: 'a-1' }])
    const two = withContainerRule(one, containers, 'other.example', 'b-2')
    expect(withContainerRule(two, containers, 'example.com', 'b-2')).toEqual([{ host: 'example.com', containerId: 'b-2' }, { host: 'other.example', containerId: 'b-2' }])
    expect(withContainerRule(two, containers, 'example.com', null)).toEqual([{ host: 'other.example', containerId: 'b-2' }])
    expect(withContainerRule(two, containers, 'example.com', 'gone-3')).toEqual(two)
    expect(withContainerRule(two, containers, 'not a host', 'a-1')).toEqual(two)
    const full = Array.from({ length: CONTAINER_RULES_MAX }, (_, i) => ({ host: `site${i}.example`, containerId: 'a-1' }))
    expect(withContainerRule(full, containers, 'one-more.example', 'a-1')).toHaveLength(CONTAINER_RULES_MAX)
    expect(withContainerRule(full, containers, 'site3.example', 'b-2')[3]).toEqual({ host: 'site3.example', containerId: 'b-2' })
  })
})

describe('permissions remembered in a container', () => {
  const container: Container = { id: 'a-1', name: 'Un', color: 'blue' }

  it('are kept per origin, replaced, forgotten, and never for an origin or a permission that is not kept', () => {
    const allowed = withContainerPermission(container, 'https://meet.example', 'media', 'allow')
    expect(allowed.permissions).toEqual({ 'https://meet.example': { media: 'allow' } })
    expect(withContainerPermission(allowed, 'https://meet.example', 'media', 'allow')).toBe(allowed)
    expect(withContainerPermission(allowed, 'https://meet.example', 'media', 'deny').permissions).toEqual({ 'https://meet.example': { media: 'deny' } })
    expect(withContainerPermission(allowed, 'https://meet.example', 'media', null)).toEqual(container)
    expect(withContainerPermission(container, 'https://meet.example', 'media', null)).toBe(container)
    expect(withContainerPermission(container, 'null', 'media', 'allow')).toBe(container)
    expect(withContainerPermission(container, 'file:///x', 'media', 'allow')).toBe(container)
    expect(withContainerPermission(container, 'https://a.example', 'openExternal', 'allow')).toBe(container)
    expect(withContainerPermission(container, 'https://a.example', '__proto__', 'allow')).toBe(container)
  })
})

describe('creating, renaming and recolouring a container', () => {
  it('needs the function on', () => {
    counter = 0
    const off = createInitialState(ctx)
    expect(run(off, { type: 'container/create', name: 'Travail' }).settings.containers).toEqual([])
    const on = run(off, { type: 'settings/update', patch: { tabContainers: true } }, { type: 'container/create', name: 'Travail', color: 'green' })
    expect(on.settings.containers).toMatchObject([{ name: 'Travail', color: 'green' }])
    expect(isContainerId(on.settings.containers[0]!.id)).toBe(true)
  })

  it('refuses a bad or taken name, keeps the colour it is given, and takes the next free one when none is', () => {
    const state = start()
    expect(run(state, { type: 'container/create', name: ' travail ' })).toBe(state)
    expect(run(state, { type: 'container/create', name: '' })).toBe(state)
    expect(run(state, { type: 'container/create', name: 'Neuf', color: 'chartreuse' }).settings.containers[2]!.color).toBe(CONTAINER_COLORS[2]!.id)
    expect(run(state, { type: 'container/create', name: 'Neuf', color: 'pink' }).settings.containers[2]!.color).toBe('pink')
  })

  it('stops at CONTAINERS_MAX', () => {
    let state = start()
    for (let i = state.settings.containers.length; i < CONTAINERS_MAX; i++) state = run(state, { type: 'container/create', name: `Conteneur ${i}` })
    expect(state.settings.containers).toHaveLength(CONTAINERS_MAX)
    expect(run(state, { type: 'container/create', name: 'Un de trop' })).toBe(state)
  })

  it('never gives two containers one id, even for one name used again after a deletion', () => {
    let state = start()
    const first = idOf(state, 'Travail')
    state = run(state, { type: 'container/delete', id: first }, { type: 'container/create', name: 'Travail' })
    expect(idOf(state, 'Travail')).not.toBe(first)
  })

  it('renames and recolours; a name another container has, a bad name or a bad colour changes nothing at all', () => {
    const state = start()
    const id = idOf(state, 'Travail')
    const renamed = run(state, { type: 'container/update', id, patch: { name: ' Boulot ', color: 'red' } })
    expect(renamed.settings.containers[0]).toMatchObject({ id, name: 'Boulot', color: 'red' })
    expect(run(state, { type: 'container/update', id, patch: { name: 'perso' } })).toBe(state)
    expect(run(state, { type: 'container/update', id, patch: { name: '' } })).toBe(state)
    expect(run(state, { type: 'container/update', id, patch: { name: 'Boulot', color: 'nope' } })).toBe(state)
    expect(run(state, { type: 'container/update', id: 'gone-1', patch: { name: 'X' } })).toBe(state)
    // The same name in another case is the container's own.
    expect(run(state, { type: 'container/update', id, patch: { name: 'TRAVAIL' } }).settings.containers[0]!.name).toBe('TRAVAIL')
    expect(run(state, { type: 'container/update', id, patch: { name: 'Travail' } })).toBe(state)
  })
})

describe('opening a tab in a container', () => {
  it('puts the tab in the container asked for, and selects it', () => {
    const state = start()
    const id = idOf(state, 'Travail')
    const next = run(state, { type: 'tab/open', url: 'https://a.example/', container: id })
    expect(activeTab(next)).toMatchObject({ url: 'https://a.example/', container: id })
  })

  it('is refused for a container that does not exist: the page would otherwise get the profile’s cookies', () => {
    const state = start()
    expect(run(state, { type: 'tab/open', url: 'https://a.example/', container: 'gone-1' })).toBe(state)
  })

  it('follows the rule of the site when no container is asked for, and not when asked for none', () => {
    const state = start()
    const id = idOf(state, 'Travail')
    const ruled = run(state, { type: 'container/rule', host: 'intranet.example.org', container: id })
    expect(activeTab(run(ruled, { type: 'tab/open', url: 'https://wiki.intranet.example.org/p' }))).toMatchObject({ container: id })
    expect(activeTab(run(ruled, { type: 'tab/open', url: 'https://other.example/' }))?.container).toBeUndefined()
    expect(activeTab(run(ruled, { type: 'tab/open', url: 'https://intranet.example.org/', container: null }))?.container).toBeUndefined()
    const other = idOf(state, 'Perso')
    expect(activeTab(run(ruled, { type: 'tab/open', url: 'https://intranet.example.org/', container: other }))?.container).toBe(other)
  })

  it('does not follow a rule once the function is off, but the tabs already in a container keep it', () => {
    const state = start()
    const id = idOf(state, 'Travail')
    const ruled = run(state, { type: 'container/rule', host: 'intranet.example.org', container: id }, { type: 'tab/open', url: 'https://intranet.example.org/a' })
    const off = run(ruled, { type: 'settings/update', patch: { tabContainers: false } })
    expect(activeTab(off)?.container).toBe(id)
    expect(activeTab(run(off, { type: 'tab/open', url: 'https://intranet.example.org/b' }))?.container).toBeUndefined()
    // ...and a copy of the tab stays in the container: the identity does not change because a switch was flipped.
    expect(activeTab(run(off, { type: 'tab/duplicate', id: activeTab(off)!.id }))?.container).toBe(id)
  })

  it('never puts a private tab, an extension’s page or a tab for an extension in a container', () => {
    const state = start()
    const id = idOf(state, 'Travail')
    const ruled = run(state, { type: 'container/rule', host: 'intranet.example.org', container: id })
    expect(activeTab(run(ruled, { type: 'tab/open', url: 'https://intranet.example.org/', private: true }))).toMatchObject({ private: true })
    expect(activeTab(run(ruled, { type: 'tab/open', url: 'https://intranet.example.org/', private: true }))?.container).toBeUndefined()
    const page = `chrome-extension://${'a'.repeat(32)}/options.html`
    expect(activeTab(run(ruled, { type: 'tab/open', url: page, allowExtensionPages: true, container: id }))?.container).toBeUndefined()
    expect(containerOfTab(ruled.settings, { container: id, private: true })).toBeUndefined()
  })

  it('a copy of a tab is in the same container, and a copy of a tab outside any is outside whatever the rules say', () => {
    const state = start()
    const id = idOf(state, 'Travail')
    const inside = run(state, { type: 'tab/open', url: 'https://a.example/', container: id })
    expect(activeTab(run(inside, { type: 'tab/duplicate', id: activeTab(inside)!.id }))?.container).toBe(id)
    const ruled = run(state, { type: 'tab/open', url: 'https://plain.example/', container: null }, { type: 'container/rule', host: 'plain.example', container: id })
    expect(activeTab(run(ruled, { type: 'tab/duplicate', id: activeTab(ruled)!.id }))?.container).toBeUndefined()
  })
})

describe('moving a tab into a container, and out', () => {
  it('sets and clears the container of a tab, keeping its place', () => {
    const state = run(start(), { type: 'tab/open', url: 'https://a.example/' }, { type: 'tab/open', url: 'https://b.example/' })
    const a = state.tabs[0]!.id
    const id = idOf(state, 'Travail')
    const inside = run(state, { type: 'tab/set-container', id: a, container: id })
    expect(inside.tabs.map((t) => [t.url, t.container])).toEqual([['https://a.example/', id], ['https://b.example/', undefined]])
    expect(run(inside, { type: 'tab/set-container', id: a, container: id })).toBe(inside)
    expect(run(inside, { type: 'tab/set-container', id: a, container: idOf(state, 'Perso') }).tabs[0]!.container).toBe(idOf(state, 'Perso'))
    const out = run(inside, { type: 'tab/set-container', id: a, container: null })
    expect(out.tabs[0]).not.toHaveProperty('container')
    expect(run(out, { type: 'tab/set-container', id: a, container: null })).toBe(out)
  })

  it('refuses a container that does not exist, a private tab, an extension’s page and a function that is off', () => {
    const state = run(start(), { type: 'tab/open', url: 'https://a.example/' }, { type: 'tab/open', url: 'https://secret.example/', private: true }, { type: 'tab/open', url: `chrome-extension://${'b'.repeat(32)}/p.html`, allowExtensionPages: true })
    const [a, secret, ext] = state.tabs.map((t) => t.id) as [string, string, string]
    const id = idOf(state, 'Travail')
    expect(run(state, { type: 'tab/set-container', id: a, container: 'gone-1' })).toBe(state)
    expect(run(state, { type: 'tab/set-container', id: secret, container: id })).toBe(state)
    expect(run(state, { type: 'tab/set-container', id: ext, container: id })).toBe(state)
    expect(run(state, { type: 'tab/set-container', id: 'nope', container: id })).toBe(state)
    expect(run(run(state, { type: 'settings/update', patch: { tabContainers: false } }), { type: 'tab/set-container', id: a, container: id }).tabs[0]!.container).toBeUndefined()
  })

  it('still lets a tab leave its container once the function is off', () => {
    const state = run(start(), { type: 'tab/open', url: 'https://a.example/', container: idOf(start(), 'Travail') })
    const off = run(state, { type: 'settings/update', patch: { tabContainers: false } })
    expect(run(off, { type: 'tab/set-container', id: off.tabs[0]!.id, container: null }).tabs[0]).not.toHaveProperty('container')
  })
})

describe('sites that always open in a container', () => {
  it('are set, replaced and freed; setting one needs the function, freeing one never does', () => {
    const state = start()
    const work = idOf(state, 'Travail')
    const ruled = run(state, { type: 'container/rule', host: 'https://www.Example.com/x', container: work })
    expect(ruled.settings.containerRules).toEqual([{ host: 'example.com', containerId: work }])
    expect(run(ruled, { type: 'container/rule', host: 'example.com', container: work })).toBe(ruled)
    const off = run(ruled, { type: 'settings/update', patch: { tabContainers: false } })
    expect(run(off, { type: 'container/rule', host: 'other.example', container: work })).toBe(off)
    expect(run(off, { type: 'container/rule', host: 'example.com', container: null }).settings.containerRules).toEqual([])
    expect(run(state, { type: 'container/rule', host: 'not a host', container: work })).toBe(state)
    expect(run(state, { type: 'container/rule', host: 'example.com', container: 'gone-1' })).toBe(state)
  })
})

describe('permissions remembered by the reducer', () => {
  it('go to the container and never to the profile’s list', () => {
    const state = start()
    const id = idOf(state, 'Travail')
    const next = run(state, { type: 'container/permission', id, origin: 'https://meet.example', permission: 'media', decision: 'allow' })
    expect(next.settings.containers[0]!.permissions).toEqual({ 'https://meet.example': { media: 'allow' } })
    expect(next.sitePermissions).toEqual({})
    expect(run(next, { type: 'container/permission', id, origin: 'https://meet.example', permission: 'media', decision: null }).settings.containers[0]).not.toHaveProperty('permissions')
    expect(run(state, { type: 'container/permission', id: 'gone-1', origin: 'https://meet.example', permission: 'media', decision: 'allow' })).toBe(state)
    expect(run(state, { type: 'container/permission', id, origin: 'null', permission: 'media', decision: 'allow' })).toBe(state)
  })
})

describe('deleting a container', () => {
  function withWork(): { state: SidebarState; work: string; perso: string } {
    let state = start()
    const work = idOf(state, 'Travail')
    const perso = idOf(state, 'Perso')
    state = run(
      state,
      { type: 'container/rule', host: 'intranet.example.org', container: work },
      { type: 'container/rule', host: 'perso.example', container: perso },
      { type: 'tab/open', url: 'https://plain.example/' },
      { type: 'tab/open', url: 'https://intranet.example.org/a', container: work },
      { type: 'tab/open', url: 'https://intranet.example.org/b', container: work },
      { type: 'tab/open', url: 'https://perso.example/', container: perso }
    )
    return { state, work, perso }
  }

  it('closes its tabs without a trace in the archive, and keeps the others', () => {
    const { state, work, perso } = withWork()
    const closed = run(state, { type: 'tab/archive', id: state.tabs[1]!.id })
    expect(closed.archive).toHaveLength(1)
    const next = run(closed, { type: 'container/delete', id: work })
    expect(next.tabs.map((t) => t.url)).toEqual(['https://plain.example/', 'https://perso.example/'])
    // The entry of the tab closed before, made in the container, goes with it.
    expect(next.archive).toEqual([])
    expect(JSON.stringify(next)).not.toContain('intranet.example.org/a')
    expect(next.settings.containers.map((c) => c.id)).toEqual([perso])
  })

  it('does not push older archive entries out to make room for the pages it closes (they are not archived at all)', () => {
    const { state, work } = withWork()
    const full = { ...state, archive: Array.from({ length: ARCHIVE_LIMIT }, (_, i) => ({ id: `old${i}`, spaceId: state.activeSpaceId, url: `https://old${i}.example/`, title: 'Vieux', archivedAt: i })) }
    const next = run(full, { type: 'container/delete', id: work })
    expect(next.archive).toHaveLength(ARCHIVE_LIMIT)
    expect(next.archive[0]!.id).toBe('old0')
  })

  it('removes the rules that named it and keeps the others', () => {
    const { state, work, perso } = withWork()
    const next = run(state, { type: 'container/delete', id: work })
    expect(next.settings.containerRules).toEqual([{ host: 'perso.example', containerId: perso }])
  })

  it('keeps the selection on a tab that exists', () => {
    const { state, work } = withWork()
    const next = run(state, { type: 'tab/select', id: state.tabs[1]!.id }, { type: 'container/delete', id: work })
    expect(next.tabs.some((t) => t.id === next.activeTabBySpace[next.activeSpaceId])).toBe(true)
  })

  it('removes the pages it holds from the saved sessions and the spaces put aside, and a session that held nothing else', () => {
    const { state, work } = withWork()
    const saved = run(state, { type: 'session/save', name: 'Tout' }, { type: 'tab/close', id: state.tabs[0]!.id }, { type: 'tab/close', id: state.tabs[3]!.id }, { type: 'session/save', name: 'Que le travail' })
    expect(saved.sessions).toHaveLength(2)
    expect(saved.sessions[1]!.tabs.some((t) => t.container === work)).toBe(true)
    const next = run(saved, { type: 'container/delete', id: work })
    expect(next.sessions.map((s) => s.name)).toEqual(['Tout'])
    expect(next.sessions[0]!.tabs.map((t) => t.url)).toEqual(['https://plain.example/', 'https://perso.example/'])
    expect(JSON.stringify(next)).not.toContain('intranet.example.org')
  })

  it('removes them from a space put aside, with the split views that held them', () => {
    const { state, work } = withWork()
    const second = run(state, { type: 'space/create', name: 'Autre', emoji: '🚀', hue: 10 }, { type: 'space/select', id: state.activeSpaceId })
    const aside = run(second, { type: 'split/create', tabId: state.tabs[1]!.id, withTabId: state.tabs[3]!.id }, { type: 'space/aside', id: state.activeSpaceId })
    const asideSession = aside.sessions.find((s) => s.space !== undefined)!
    expect(asideSession.space!.splits).toHaveLength(1)
    const next = run(aside, { type: 'container/delete', id: work })
    const left = next.sessions.find((s) => s.space !== undefined)!.space!
    expect(left.tabs.map((t) => t.url)).toEqual(['https://plain.example/', 'https://perso.example/'])
    expect(left.splits).toEqual([])
    expect(JSON.stringify(next)).not.toContain('intranet.example.org')
  })

  it('does nothing for a container that does not exist', () => {
    const { state } = withWork()
    expect(run(state, { type: 'container/delete', id: 'gone-1' })).toBe(state)
  })

  it('is possible with the function off: the data of a container is never held hostage by a switch', () => {
    const { state, work } = withWork()
    const off = run(state, { type: 'settings/update', patch: { tabContainers: false } })
    expect(run(off, { type: 'container/delete', id: work }).settings.containers.map((c) => c.name)).toEqual(['Perso'])
  })
})

describe('closing, reopening and saving tabs of a container', () => {
  it('the archive remembers the container, and reopening brings the tab back in it', () => {
    const state = start()
    const work = idOf(state, 'Travail')
    const opened = run(state, { type: 'tab/open', url: 'https://a.example/', container: work })
    const closed = run(opened, { type: 'tab/archive', id: opened.tabs[0]!.id })
    expect(closed.archive[0]!.container).toBe(work)
    expect(activeTab(run(closed, { type: 'archive/restore-last' }))?.container).toBe(work)
  })

  it('reopening in a container that was deleted since opens in the profile’s session', () => {
    const state = start()
    const work = idOf(state, 'Travail')
    const opened = run(state, { type: 'tab/open', url: 'https://a.example/', container: work })
    const closed = run(opened, { type: 'tab/archive', id: opened.tabs[0]!.id })
    // The entry is hand-edited back to name the deleted container, as an old file could.
    const gone = { ...closed, settings: { ...closed.settings, containers: closed.settings.containers.filter((c) => c.id !== work) } }
    expect(activeTab(run(gone, { type: 'archive/restore-last' }))?.container).toBeUndefined()
  })

  it('a saved session remembers the container of its tabs, and restores them in it while it exists', () => {
    const state = start()
    const work = idOf(state, 'Travail')
    const opened = run(state, { type: 'tab/open', url: 'https://a.example/', container: work }, { type: 'tab/open', url: 'https://b.example/' })
    const saved = run(opened, { type: 'session/save', name: 'S' })
    expect(sessionTabsOf(opened.tabs, []).map((t) => t.container)).toEqual([work, undefined])
    const restored = run(saved, { type: 'tab/close', id: opened.tabs[0]!.id }, { type: 'tab/close', id: opened.tabs[1]!.id }, { type: 'session/restore', id: saved.sessions[0]!.id, target: 'current' })
    expect(restored.tabs.map((t) => t.container)).toEqual([work, undefined])
    const without = run(saved, { type: 'tab/close', id: opened.tabs[0]!.id }, { type: 'tab/close', id: opened.tabs[1]!.id }, { type: 'settings/update', patch: { containers: [] } }, { type: 'session/restore', id: saved.sessions[0]!.id, target: 'current' })
    expect(without.tabs).toHaveLength(2)
    expect(without.tabs.every((t) => t.container === undefined)).toBe(true)
  })
})

describe('a state from a file', () => {
  it('drops the container of a tab, an archive entry or a session page whose container does not exist', () => {
    const state = start()
    const work = idOf(state, 'Travail')
    const opened = run(state, { type: 'tab/open', url: 'https://a.example/', container: work }, { type: 'tab/open', url: 'https://c.example/', container: work })
    const saved = run(run(opened, { type: 'tab/archive', id: opened.tabs[1]!.id }), { type: 'session/save', name: 'S' })
    expect(saved.archive[0]!.container).toBe(work)
    const broken = { ...saved, settings: { ...saved.settings, containers: [] } }
    const loaded = normalize(JSON.parse(JSON.stringify(broken)) as SidebarState)
    expect(loaded.tabs.every((t) => t.container === undefined)).toBe(true)
    expect(loaded.archive.every((a) => a.container === undefined)).toBe(true)
    expect(loaded.sessions.every((s) => s.tabs.every((t) => t.container === undefined))).toBe(true)
    expect(pruneContainers(loaded)).toBe(loaded)
  })

  it('keeps them, and the state as it is, when the container exists', () => {
    const state = start()
    const work = idOf(state, 'Travail')
    const opened = run(state, { type: 'tab/open', url: 'https://a.example/', container: work })
    const loaded = normalize(JSON.parse(JSON.stringify(opened)) as SidebarState)
    expect(loaded.tabs[0]!.container).toBe(work)
    expect(normalize(loaded)).toEqual(loaded)
  })

  it('a tab with a container id that is not a slug loses it', () => {
    const state = run(start(), { type: 'tab/open', url: 'https://a.example/' })
    const hostile = JSON.parse(JSON.stringify(state)) as { tabs: Array<{ container?: unknown }> }
    for (const bad of ['../x', '', 3, {}, '__proto__', 'A-B']) {
      hostile.tabs[0]!.container = bad
      expect(normalize(hostile as unknown as SidebarState).tabs[0]!.container, String(bad)).toBeUndefined()
    }
  })

  it('cleanTabs itself keeps the id of a container only when it is a slug', () => {
    const spaceIds = new Set(['sp'])
    const tab = (container: unknown) => ({ id: 't', spaceId: 'sp', url: 'https://a.example/', title: 'A', pinned: false, createdAt: 1, lastActiveAt: 1, container })
    expect(cleanTabs([tab('travail-3fa9c')], spaceIds, new Map())[0]!.container).toBe('travail-3fa9c')
    for (const bad of ['../x', 'A-B', '', 'a'.repeat(40), 3, {}, null]) expect(cleanTabs([tab(bad)], spaceIds, new Map())[0]!.container, String(bad)).toBeUndefined()
  })

  it('the settings patch of a container list is repaired like a file', () => {
    const state = start()
    const patched = run(state, { type: 'settings/update', patch: { containers: [{ id: 'x-1', name: 'Eux', color: 'bad' as never }, { id: '../y', name: 'Mauvais', color: 'red' }], containerRules: [{ host: 'example.com', containerId: 'x-1' }, { host: 'example.org', containerId: 'nope' }] } })
    expect(patched.settings.containers).toEqual([{ id: 'x-1', name: 'Eux', color: 'blue' }])
    expect(patched.settings.containerRules).toEqual([{ host: 'example.com', containerId: 'x-1' }])
  })
})

describe('what a container leaves on disk', () => {
  it('lists the stored containers the list no longer claims, and nothing that is not a container id', () => {
    const stored = ['travail-3fa9c', 'perso-aa111', 'vieux-00000', '../x', 'A']
    expect(orphanContainerIds(stored, [{ id: 'travail-3fa9c' }, { id: 'perso-aa111' }])).toEqual(['vieux-00000'])
    expect(orphanContainerIds(stored, [])).toEqual(['travail-3fa9c', 'perso-aa111', 'vieux-00000'])
    expect(orphanContainerIds([], [{ id: 'travail-3fa9c' }])).toEqual([])
  })

  it('erases nothing at launch when the state was not read, or a set-aside copy of it is kept: its containers would look deleted', () => {
    const stored = ['travail-3fa9c', 'vieux-00000']
    // A state replaced by a fresh one names no container: every folder would look orphaned.
    expect(containersToSweep(stored, [], false)).toEqual([])
    expect(containersToSweep(stored, [{ id: 'travail-3fa9c' }], false)).toEqual([])
    expect(containersToSweep(stored, [{ id: 'travail-3fa9c' }], true)).toEqual(['vieux-00000'])
  })

  it('leaves the folder of a container that a copy of the state made before a restoration still names: that copy can be put back', () => {
    const stored = ['travail-3fa9c', 'apres-export-11111', 'vieux-00000']
    // The restored state names only the container of the export; the copy made before the restoration names the one created since.
    const copy = JSON.stringify({ version: 1, settings: { containers: [{ id: 'travail-3fa9c', name: 'Travail' }, { id: 'apres-export-11111', name: 'Après' }] } })
    expect(containersToSweep(stored, [{ id: 'travail-3fa9c' }], true, () => containersNamedByCopies([copy]))).toEqual(['vieux-00000'])
    // Without the copy, the folder would go with the cookies and the storage of the container.
    expect(containersToSweep(stored, [{ id: 'travail-3fa9c' }], true, () => containersNamedByCopies([]))).toEqual(['apres-export-11111', 'vieux-00000'])
  })

  it('erases nothing when a copy made before a restoration cannot be read, or is not a state: what it names is unknown', () => {
    const stored = ['vieux-00000']
    expect(containersToSweep(stored, [], true, () => containersNamedByCopies([null]))).toEqual([])
    expect(containersToSweep(stored, [], true, () => containersNamedByCopies(['{ not json']))).toEqual([])
    expect(containersToSweep(stored, [], true, () => containersNamedByCopies(['[]']))).toEqual([])
    expect(containersToSweep(stored, [], true, () => containersNamedByCopies([JSON.stringify({ settings: { containers: 'x' } })]))).toEqual([])
  })

  describe('the folder a copy of the state protects, past thirty days without a write', () => {
    const day = 24 * 3_600_000
    const stored = ['travail-3fa9c', 'apres-export-11111', 'recent-22222', 'vieux-00000']
    const listed = [{ id: 'travail-3fa9c' }]
    const idle: Record<string, number> = { 'travail-3fa9c': 400 * day, 'apres-export-11111': 31 * day + 5, 'recent-22222': 29 * day, 'vieux-00000': 90 * day }
    const idleMs = (id: string): number | null => idle[id] ?? null

    it('goes too, with the days it stayed unused; a younger one stays, and so does a container the list names however old', () => {
      expect(ORPHAN_CONTAINER_KEEP_MS).toBe(30 * day)
      // The sweep already removes `vieux-00000`; the two others are named by a copy.
      expect(containersKeptTooLong(stored, listed, true, ['vieux-00000'], idleMs)).toEqual([{ id: 'apres-export-11111', days: 31 }])
    })

    it('goes on the very day the limit is reached, not the day before', () => {
      expect(containersKeptTooLong(['a-11111'], [], true, [], () => 30 * day)).toEqual([{ id: 'a-11111', days: 30 }])
      expect(containersKeptTooLong(['a-11111'], [], true, [], () => 30 * day - 1)).toEqual([])
    })

    it('stays when its age is unknown, and nothing goes while the state is not the one the user had', () => {
      expect(containersKeptTooLong(['a-11111'], [], true, [], () => null)).toEqual([])
      expect(containersKeptTooLong(['a-11111'], [], true, [], () => Number.NaN)).toEqual([])
      expect(containersKeptTooLong(stored, [], false, [], idleMs)).toEqual([])
    })

    it('never names what is not a container id', () => {
      expect(containersKeptTooLong(['../x', 'A'], [], true, [], () => 400 * day)).toEqual([])
    })
  })

  it('does not read the copies when no folder is about to go (the usual launch)', () => {
    const read = vi.fn(() => new Set<string>())
    expect(containersToSweep(['travail-3fa9c'], [{ id: 'travail-3fa9c' }], true, read)).toEqual([])
    expect(containersToSweep(['vieux-00000'], [], false, read)).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('reads the containers a copy of the state names, and only ids that can name a folder', () => {
    expect(containerIdsOfStateText(JSON.stringify({ settings: { containers: [{ id: 'a-1' }, { id: '../evil' }, { id: 7 }, null, { id: 'b-2' }] } }))).toEqual(['a-1', 'b-2'])
    // A state from before the function, or without settings, names none.
    expect(containerIdsOfStateText(JSON.stringify({ version: 1, settings: {} }))).toEqual([])
    expect(containerIdsOfStateText(JSON.stringify({ version: 1 }))).toEqual([])
    expect(containerIdsOfStateText('null')).toBeNull()
    expect(containerIdsOfStateText(JSON.stringify({ settings: 3 }))).toBeNull()
  })

  it('withoutContainerPages leaves the state alone when nothing is in the container', () => {
    const state = start()
    const next = withoutContainerPages(state, idOf(state, 'Travail'))
    expect(next.archive).toEqual([])
    expect(next.sessions).toEqual([])
  })
})

describe('a private window', () => {
  it('has no container: its state starts without any, and it never inherits the list', () => {
    const main = start()
    const priv = createPrivateState(main, ctx)
    expect(priv.settings).toMatchObject({ tabContainers: false, containers: [], containerRules: [] })
    const inherited = inheritedSettings(main.settings)
    for (const key of ['tabContainers', 'containers', 'containerRules']) expect(inherited, key).not.toHaveProperty(key)
  })

  it('refuses every action that would create, change or use a container', () => {
    const main = start()
    const work = idOf(main, 'Travail')
    const actions: Action[] = [
      { type: 'container/create', name: 'Neuf' },
      { type: 'container/update', id: work, patch: { name: 'Autre' } },
      { type: 'container/delete', id: work },
      { type: 'container/rule', host: 'example.com', container: work },
      { type: 'container/permission', id: work, origin: 'https://a.example', permission: 'media', decision: 'allow' },
      { type: 'tab/set-container', id: 'x', container: work },
      { type: 'settings/update', patch: { tabContainers: true, containers: main.settings.containers, containerRules: [] } }
    ]
    for (const action of actions) expect(privateAction(action), action.type).toBeNull()
  })

  it('strips the container of a tab to open even when the action is not marked private', () => {
    expect(privateAction({ type: 'tab/open', url: 'https://a.example/', container: 'travail-3fa9c' })).toEqual({ type: 'tab/open', url: 'https://a.example/' })
    expect(privateAction({ type: 'tab/open', url: 'https://a.example/', container: null })).toEqual({ type: 'tab/open', url: 'https://a.example/' })
  })

  it('opens a tab without the container it was asked to open in', () => {
    const action = privateAction({ type: 'tab/open', url: 'https://a.example/', container: 'travail-3fa9c', private: true })
    expect(action).toEqual({ type: 'tab/open', url: 'https://a.example/' })
    expect(privateAction({ type: 'tab/open', url: 'https://a.example/' })).toEqual({ type: 'tab/open', url: 'https://a.example/' })
  })

  it('a container tab is saved with the state (unlike a private tab)', () => {
    const state = start()
    const work = idOf(state, 'Travail')
    const opened = run(state, { type: 'tab/open', url: 'https://a.example/', container: work })
    expect(persistableState(opened).tabs[0]).toMatchObject({ container: work })
  })
})

describe('what the interface may ask', () => {
  it('may not patch the list of containers or their rules, which would skip the erasure and the checks', () => {
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { containers: [] } }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { containerRules: [] } }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { tabContainers: true } }, [])).toBe(true)
    expect(interfaceMayDispatch({ type: 'container/delete', id: 'x' }, [])).toBe(true)
  })
})

describe('the command bar', () => {
  const containerRows = (state: SidebarState, query: string, options: { private?: boolean } = {}): Extract<Candidate, { kind: 'container' }>[] =>
    rankCandidates(query, state, [], [], [], options).filter((c): c is Extract<Candidate, { kind: 'container' }> => c.kind === 'container')

  it('offers a new tab in each container, and the page on screen in the others, when the query asks for them', () => {
    const state = run(start(), { type: 'tab/open', url: 'https://a.example/' })
    const rows = containerRows(state, 'conteneur')
    expect(rows.map((r) => [r.mode, r.label])).toEqual([
      ['new', frenchSpaces('Nouvel onglet dans le conteneur « Travail »')],
      ['reopen', frenchSpaces('Ouvrir cette page dans le conteneur « Travail »')],
      ['new', frenchSpaces('Nouvel onglet dans le conteneur « Perso »')],
      ['reopen', frenchSpaces('Ouvrir cette page dans le conteneur « Perso »')]
    ])
    expect(containerRows(state, 'perso').every((r) => r.containerId === idOf(state, 'Perso'))).toBe(true)
    expect(containerRows(state, 'zzzz')).toEqual([])
  })

  it('does not offer to move a page into the container it is in, nor a page that is not a web page', () => {
    const work = idOf(start(), 'Travail')
    const inside = run(start(), { type: 'tab/open', url: 'https://a.example/', container: work })
    expect(containerRows(inside, 'travail').map((r) => r.mode)).toEqual(['new'])
    const blank = run(start(), { type: 'tab/open', url: 'about:blank' })
    expect(containerRows(blank, 'conteneur').every((r) => r.mode === 'new')).toBe(true)
  })

  it('offers nothing while the function is off, without a container, or in a private window', () => {
    const state = run(start(), { type: 'tab/open', url: 'https://a.example/' })
    expect(containerRows(run(state, { type: 'settings/update', patch: { tabContainers: false } }), 'conteneur')).toEqual([])
    expect(containerRows(createInitialState(ctx), 'conteneur')).toEqual([])
    expect(containerRows(state, 'conteneur', { private: true })).toEqual([])
  })

  it('turns a choice into the reducer actions', () => {
    const state = run(start(), { type: 'tab/open', url: 'https://a.example/' })
    const [fresh, reopen] = containerRows(state, 'travail')
    expect(candidateDispatches(fresh!)).toEqual([{ type: 'tab/open', url: 'about:blank', container: idOf(state, 'Travail') }])
    expect(candidateDispatches(reopen!)).toEqual([{ type: 'tab/set-container', id: state.tabs[0]!.id, container: idOf(state, 'Travail') }])
    expect(candidateDispatches({ ...reopen!, tabId: undefined })).toEqual([])
  })
})

describe('the application menu', () => {
  it('is rebuilt when a container is created or renamed, but only while the function is on', () => {
    const state = start()
    const renamed = run(state, { type: 'container/update', id: idOf(state, 'Travail'), patch: { name: 'Boulot' } })
    expect(menuKey(renamed, [])).not.toBe(menuKey(state, []))
    const off = (s: SidebarState) => run(s, { type: 'settings/update', patch: { tabContainers: false } })
    expect(menuKey(off(renamed), [])).toBe(menuKey(off(state), []))
    // Off, the containers are not in the key at all: a browser that never used the function has the key it always had.
    const bare = off(state)
    expect(menuKey(bare, [])).toBe(menuKey({ ...bare, settings: { ...bare.settings, containers: [] } }, []))
  })
})

describe('erasing the data of a site when its last tab closes', () => {
  it('ignores the tabs in a container: they have a jar of their own, which this feature does not reach', () => {
    const base = run(start(), { type: 'settings/update', patch: { siteDataClearOnCloseEnabled: true, siteDataClearOnClose: ['bank.example'] } })
    const work = idOf(base, 'Travail')
    // The profile has a tab on the site and so has the container: closing the container's tab erases nothing of the profile's.
    const both = run(base, { type: 'tab/open', url: 'https://bank.example/' }, { type: 'tab/open', url: 'https://bank.example/in-container', container: work })
    const containerTab = both.tabs.find((t) => t.container === work)!
    expect(sitesToClearOnClose(both, run(both, { type: 'tab/close', id: containerTab.id }), { private: false })).toEqual([])
    // Closing the profile's tab while the container's stays still erases the profile's data: the container's tab does not keep the site "open".
    const profileTab = both.tabs.find((t) => t.container === undefined)!
    expect(sitesToClearOnClose(both, run(both, { type: 'tab/close', id: profileTab.id }), { private: false })).toHaveLength(1)
    // A container's tab alone on the site: closing it erases nothing of the profile (which never held anything of that tab).
    const onlyContainer = run(base, { type: 'tab/open', url: 'https://bank.example/', container: work })
    expect(sitesToClearOnClose(onlyContainer, run(onlyContainer, { type: 'tab/close', id: onlyContainer.tabs[0]!.id }), { private: false })).toEqual([])
    // ...and the usual case is unchanged.
    const alone = run(base, { type: 'tab/open', url: 'https://bank.example/' })
    expect(sitesToClearOnClose(alone, run(alone, { type: 'tab/close', id: alone.tabs[0]!.id }), { private: false })).toHaveLength(1)
  })
})
