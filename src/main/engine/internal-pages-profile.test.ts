// The session of a profile, as `ensureProfile` makes it, answers the scheme of the Extensions page and carries its preload for that address alone. (The private
// contexts and the containers refuse it: private-permissions-wiring.test.ts. The files, the headers and the refusals themselves: internal-pages.test.ts.)

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveTabGrants } from '@shared/extension-access'
import { inertEngine, madeSessions } from '../profile-made.test-support'
import { INTERNAL_LOAD_HEADER } from '@shared/internal-serve'
import { INTERNAL_PRELOAD_ID, internalLoadHeaders, setInternalPagesHome } from './internal-pages'

vi.mock('electron', async () => (await import('../profile-made.test-support')).profileElectron())
vi.mock('electron-chrome-extensions', async () => ({ ElectronChromeExtensions: (await import('../profile-made.test-support')).realLibrary() }))
vi.mock('electron-chrome-web-store', () => ({}))
const { ElectronEngine } = await import('./electron-engine')
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

function profile(id: string) {
  madeSessions.clear()
  const engine = Object.assign(Object.create(ElectronEngine.prototype) as object, inertEngine({ activeTabs: new ActiveTabGrants() }))
  engineMethods['ensureProfile']!.call(engine, id)
  return [...madeSessions.values()][0]!
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  setInternalPagesHome({ rendererDir: '/app/out/renderer', projectRoot: '/Users/jane/lucium' }, () => ({
    readText: (file) => (file === 'extensions.html' ? '<script src="./assets/extensions-A.js"></script>' : null),
    has: (file) => file === 'assets/extensions-A.js',
    readBytes: (file) => new TextEncoder().encode(file === 'extensions.html' ? '<script src="./assets/extensions-A.js"></script>' : 'page'),
    fetchDev: () => Promise.reject(new Error('no development server'))
  }))
})

describe('the session of a profile', () => {
  it('serves the Extensions page: the document of a navigation is answered, a frame of another page is not', async () => {
    const ses = profile('work')
    expect([...ses.handled.keys()]).toEqual(['lucium-ui'])
    const serve = ses.handled.get('lucium-ui')!
    // The shell's own load carries the secret of the session (`loadURL` adds it: electron-page-navigation.ts); no other request for the document has it.
    const [name, value] = internalLoadHeaders(ses as never)!.split(': ')
    expect(name).toBe(INTERNAL_LOAD_HEADER)
    const document = await serve(new Request('lucium-ui://extensions/', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', [name!]: value! } }))
    expect(document.status).toBe(200)
    expect(document.headers.get('x-frame-options')).toBe('DENY')
    expect((await serve(new Request('lucium-ui://extensions/', { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' } }))).status).toBe(403)
    expect((await serve(new Request('lucium-ui://extensions/', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } }))).status).toBe(403)
  })

  it('carries the preload of the page for the address of the page alone, once', () => {
    const ses = profile('work')
    const ours = ses.scripts.filter((script) => script.id === INTERNAL_PRELOAD_ID)
    expect(ours).toHaveLength(1)
    expect(ours[0]).toMatchObject({ type: 'frame', matches: ['lucium-ui://extensions/*'] })
    expect(ours[0]?.filePath).toMatch(/preload[\\/]internal-extensions\.js$/)
    // Never a script of ours without a limit: a document of any other address does not run it.
    expect(ses.scripts.filter((script) => script.filePath.endsWith('internal-extensions.js') && script.matches === undefined)).toEqual([])
  })
})
