// The copies of the icons of sites, in the engine: which session an icon is asked with and what goes with the request, what the blocker of the
// pages says of it, what the copies are given, and the session that serves them. The methods run on stand-ins of the engine. The rules of the
// copies themselves: site-icons.test.ts. The same in a real Electron: `smokeFavicons`.

import { describe, expect, it, vi } from 'vitest'
import { ICON_SCHEME, iconSource, type SiteIconOwner } from '@shared/site-icon'
import { standIn } from '../stand-in.test-support'

const handled: Array<{ scheme: string; handler: (request: { url: string }) => unknown }> = []
vi.mock('electron', async () =>
  (await import('./electron-page.test-support')).electronStub({
    session: { defaultSession: { protocol: { handle: (scheme: string, handler: (request: { url: string }) => unknown) => void handled.push({ scheme, handler }) } } },
    app: { getPath: () => '/nowhere' }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { EphemeralScope } = await import('./ephemeral-scope')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>
const scopeMethods = EphemeralScope.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const ICON = 'https://journal.example/favicon.png'
const PAGE = 'https://journal.example/article'

describe('the request of an icon', () => {
  function profiles() {
    const asked: Array<{ profileId: string; url: string; init: Record<string, unknown> }> = []
    const made: string[] = []
    const engine = standIn('engine', {
      ensureProfile: (profileId: string) => {
        made.push(profileId)
        return { session: { fetch: async (url: string, init: Record<string, unknown>) => (asked.push({ profileId, url, init }), new Response(null, { status: 204 })) } }
      }
    })
    return { engine, asked, made }
  }

  it('goes through the session of the profile that shows the icon, with its cookies and without a Referer', async () => {
    const { engine, asked } = profiles()
    const signal = AbortSignal.timeout(1000)
    await methods['fetchSiteIcon']!.call(engine, 'travail', ICON, signal)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ profileId: 'travail', url: ICON })
    expect(asked[0]!.init).toMatchObject({ credentials: 'include', referrerPolicy: 'no-referrer', signal })
  })

  it('is refused for a profile whose name could not be one: no session is made for it', async () => {
    const { engine, asked, made } = profiles()
    for (const odd of ['../../Library', 'persist:autre', '', 'a'.repeat(33)]) {
      await expect(methods['fetchSiteIcon']!.call(engine, odd, ICON, AbortSignal.timeout(1000)), odd).rejects.toThrow('unknown profile')
    }
    expect(made).toEqual([])
    expect(asked).toEqual([])
  })
})

describe('the blocker of the pages, asked about an icon', () => {
  const blocked = (requestBlocker: unknown): boolean => methods['siteIconBlocked']!.call(standIn('engine', { requestBlocker }), ICON, PAGE) as boolean

  it('judges it as a picture the page that shows it would load', () => {
    const blocker = vi.fn(() => false)
    expect(blocked(blocker)).toBe(false)
    expect(blocker.mock.calls).toEqual([[{ url: ICON, resourceType: 'image', pageUrl: PAGE, pageId: null, documentUrl: PAGE, method: 'GET' }]])
  })

  it('stops it when the blocker cancels it, and when it would send it to a stand-in', () => {
    expect(blocked(() => true)).toBe(true)
    expect(blocked(() => ({ redirect: 'lucium-stand-in://x/1x1.gif' }))).toBe(true)
  })

  it('lets it through while no blocker is set', () => {
    expect(blocked(null)).toBe(false)
  })
})

describe('what the copies are given of the engine', () => {
  type Deps = { fetch(profileId: string, url: string, signal: AbortSignal): unknown; blocked(iconUrl: string, pageUrl: string): boolean; owner(iconUrl: string): SiteIconOwner | null }

  it('is the session of the profile, the blocker of the pages, and what the shell says of the state', () => {
    const calls: unknown[][] = []
    const engine = standIn('engine', {
      fetchSiteIcon: (...args: unknown[]) => (calls.push(['fetch', ...args]), 'answer'),
      siteIconBlocked: (...args: unknown[]) => (calls.push(['blocked', ...args]), true),
      siteIconOwners: null as ((iconUrl: string) => SiteIconOwner | null) | null
    })
    const deps = methods['siteIconDeps']!.call(engine) as Deps
    const signal = AbortSignal.timeout(1000)
    expect(deps.fetch('travail', ICON, signal)).toBe('answer')
    expect(deps.blocked(ICON, PAGE)).toBe(true)
    expect(calls).toEqual([
      ['fetch', 'travail', ICON, signal],
      ['blocked', ICON, PAGE]
    ])
    // Until the shell says who shows an icon, nobody does.
    expect(deps.owner(ICON)).toBeNull()
    methods['setSiteIconOwners']!.call(engine, (iconUrl: string) => (iconUrl === ICON ? { profileId: 'travail', pageUrl: PAGE } : null))
    expect(deps.owner(ICON)).toEqual({ profileId: 'travail', pageUrl: PAGE })
    expect(deps.owner('https://ailleurs.example/a.png')).toBeNull()
    methods['setSiteIconOwners']!.call(engine, null)
    expect(deps.owner(ICON)).toBeNull()
  })

  it('takes the bytes a lookup already read as the copy of the icon', () => {
    const kept: unknown[][] = []
    const engine = standIn('engine', { siteIcons: { keep: (...args: unknown[]) => (kept.push(args), true) } })
    const bytes = Uint8Array.from([1, 2, 3])
    expect(methods['keepSiteIcon']!.call(engine, ICON, bytes, 'image/png')).toBe(true)
    expect(kept).toEqual([[ICON, bytes, 'image/png']])
  })
})

describe('the scheme of the copies', () => {
  it('is served in the session of the interface, from the copies of the engine, by the address of the request', async () => {
    handled.length = 0
    const served: string[] = []
    const engine = standIn('engine', { siteIcons: { serve: async (request: string) => (served.push(request), new Response(null, { status: 404 })) } })
    methods['serveSiteIcons']!.call(engine)
    expect(handled.map((entry) => entry.scheme)).toEqual([ICON_SCHEME])
    const request = iconSource(ICON) as string
    const answer = (await handled[0]!.handler({ url: request })) as Response
    expect(served).toEqual([request])
    expect(answer.status).toBe(404)
  })
})

describe('a private context', () => {
  // A stand-in with nothing in it: whatever the methods touched of the scope or of the engine behind it would throw.
  it('says who shows no icon, and keeps no bytes: nothing of it reaches the copies of the engine', () => {
    const scope = standIn('scope', {})
    expect(scopeMethods['setSiteIconOwners']!.call(scope, () => ({ profileId: 'default', pageUrl: PAGE }))).toBeUndefined()
    expect(scopeMethods['keepSiteIcon']!.call(scope, ICON, Uint8Array.from([1]), 'image/png')).toBe(false)
  })
})
