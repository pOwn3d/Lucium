// The engine downloads the icon of a site for the profile that shows it (engine/site-icons.ts). For an icon no page of this run declared, it
// asks the shell: the main window answers from its state and from the states of the other windows of its group, and no private or second
// window ever answers. And the lookup of an icon hands the engine the bytes it read. `Browser.start` runs on a stand-in
// (browser-fake.test-support.ts): the engine is a recorder, the gates are kept so that the one of the lookup can be started.

import { describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import type { SiteIconOwner } from '@shared/site-icon'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

const lookups: Array<Record<string, (...args: unknown[]) => unknown>> = []
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('../blocking', () => ({ blockingService: () => ({ subscribe: () => () => {}, filter: () => false }) }))
vi.mock('./extension-shims', () => ({ ExtensionShims: class {} }))
vi.mock('./favicon-service', () => ({
  requestFetch: () => () => undefined,
  // The lookup itself is favicon-service.ts and favicon-resolver.ts: here only what the window gives it is read.
  FaviconService: class {
    constructor(deps: Record<string, (...args: unknown[]) => unknown>) {
      lookups.push(deps)
    }
    start(): void {}
    stop(): void {}
  }
}))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

type Kind = 'main' | 'private' | 'secondary'

const ICON = 'https://journal.example/favicon.png'

const stateWith = (url: string, faviconUrl: string): SidebarState => {
  const state = createInitialState({ now: 0, newId: () => 'x' })
  return { ...state, tabs: [{ id: 't', spaceId: state.activeSpaceId, url, title: 't', pinned: false, createdAt: 1, lastActiveAt: 1, faviconUrl } as SidebarState['tabs'][number]] }
}

function start(kind: Kind, state: SidebarState, others: SidebarState[] = []) {
  const gates = new Map<string, { start(): unknown }>()
  const fake = fakeBrowser({
    isPrivate: () => kind === 'private',
    isSecondary: () => kind === 'secondary',
    gates: { gate: (id: string, gate: { start(): unknown }) => void gates.set(id, gate) },
    store: { get: () => state, subscribe: () => () => {} },
    group: new Set<unknown>()
  })
  const group = fake.self['group'] as Set<unknown>
  // The group is every window over the same tabs, this one included, in the order they were opened: this one is not always the first.
  for (const other of others) group.add({ store: { get: () => other } })
  group.add(fake.self)
  // The helper of the class is the one under test: the stand-in gets the real one.
  fake.self['viewsFromThisWindow'] = () => shell['viewsFromThisWindow']!.call(fake.self)
  shell['start']!.call(fake.self)
  const asked = fake.calls.filter((call) => call.name === 'engine.setSiteIconOwners')
  return { fake, gates, asked, owner: asked[0]?.args[0] as ((iconUrl: string) => SiteIconOwner | null) | undefined }
}

describe('who shows an icon, as the engine is told', () => {
  it('is answered by the main window, from its state', () => {
    const { asked, owner } = start('main', stateWith('https://journal.example/article', ICON))
    expect(asked).toHaveLength(1)
    expect(owner?.(ICON)).toEqual({ profileId: 'default', pageUrl: 'https://journal.example/article' })
    expect(owner?.('https://ailleurs.example/a.png')).toBeNull()
  })

  it('is never answered by a private window, nor by a second window over the same tabs', () => {
    expect(start('private', stateWith('https://journal.example/article', ICON)).asked).toEqual([])
    expect(start('secondary', stateWith('https://journal.example/article', ICON)).asked).toEqual([])
  })

  it('reads the tabs of the other windows of the group too, and this window first', () => {
    const mine = stateWith('https://journal.example/chez-moi', ICON)
    const theirs = stateWith('https://journal.example/chez-eux', ICON)
    const elsewhere = stateWith('https://bureau.example/app', 'https://bureau.example/favicon.ico')
    const { owner } = start('main', mine, [theirs, elsewhere])
    expect(owner?.(ICON)).toEqual({ profileId: 'default', pageUrl: 'https://journal.example/chez-moi' })
    expect(owner?.('https://bureau.example/favicon.ico')).toEqual({ profileId: 'default', pageUrl: 'https://bureau.example/app' })
  })
})

describe('the bytes the lookup of an icon read', () => {
  it('are handed to the engine, which keeps them as the copy the interface draws', () => {
    lookups.length = 0
    const { fake, gates } = start('main', stateWith('https://journal.example/article', ICON))
    gates.get('favicons')!.start()
    expect(lookups).toHaveLength(1)
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    lookups[0]!['keepIcon']!(ICON, bytes, 'image/png')
    expect(fake.calls.filter((call) => call.name === 'engine.keepSiteIcon').map((call) => call.args)).toEqual([[ICON, bytes, 'image/png']])
  })
})
