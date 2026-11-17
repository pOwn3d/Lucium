// What an erasure asks of the session of the interface (the default session, which belongs to no profile): emptying a cache takes the icons the
// sidebar drew; erasing or deleting a profile takes its cookie jar too. The sessions are recorders.

import { describe, expect, it, vi } from 'vitest'

const asked: Array<{ session: string; call: string; options?: unknown }> = []
const recorder = (name: string) => ({
  clearCache: async () => void asked.push({ session: name, call: 'clearCache' }),
  clearData: async (options?: unknown) => void asked.push({ session: name, call: 'clearData', options }),
  clearAuthCache: async () => void asked.push({ session: name, call: 'clearAuthCache' }),
  getStoragePath: () => null
})

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ session: { defaultSession: recorder('interface'), fromPartition: (partition: string) => recorder(partition) }, app: { getPath: () => '/nowhere' } }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => Promise<void>>
const iconCopies = { clear: vi.fn() }
const engine = () => ({ loaded: new Map(), resume: { forgetProfile: vi.fn() }, storeExtensionsOf: () => [], siteIcons: iconCopies })
const ofInterface = () => asked.filter((entry) => entry.session === 'interface').map(({ call, options }) => ({ call, options }))

describe('the session of the interface', () => {
  it('loses its cache only when the cache of a profile is emptied', async () => {
    asked.length = 0
    await methods['clearCache']!.call(engine(), 'travail')
    expect(ofInterface()).toEqual([{ call: 'clearData', options: { dataTypes: ['cache'] } }])
  })

  it('loses its cache and its cookies when the data of a profile are erased, after the profile itself', async () => {
    asked.length = 0
    await methods['clearProfileData']!.call(engine(), 'travail')
    expect(ofInterface()).toEqual([{ call: 'clearData', options: { dataTypes: ['cache', 'cookies'] } }])
    expect(asked.at(-1)!.session).toBe('interface')
    expect(asked.filter((entry) => entry.session !== 'interface').map((entry) => entry.call)).toEqual(['clearData', 'clearAuthCache'])
  })

  it('loses them when a profile is deleted too', async () => {
    asked.length = 0
    await methods['deleteProfileData']!.call(engine(), 'travail')
    expect(ofInterface()).toEqual([{ call: 'clearData', options: { dataTypes: ['cache', 'cookies'] } }])
  })
})

// The copies the engine keeps of the icons of sites (site-icons.ts) were downloaded through the cache and with the cookies of a profile.
describe('the copies of the icons of sites', () => {
  for (const erasure of ['clearCache', 'clearProfileData', 'deleteProfileData'] as const) {
    it(`are forgotten by ${erasure}`, async () => {
      iconCopies.clear.mockClear()
      await methods[erasure]!.call(engine(), 'travail')
      expect(iconCopies.clear).toHaveBeenCalledTimes(1)
    })
  }

  it('are forgotten when the data of a site are erased', async () => {
    iconCopies.clear.mockClear()
    const ses = recorder('persist:profile-travail')
    const results = await (methods['clearSiteData'] as unknown as (this: unknown, profileId: string, request: unknown) => Promise<unknown[]>).call({ ...engine(), ensureProfile: () => ({ session: ses }) }, 'travail', { origins: ['https://exemple.fr'], host: 'exemple.fr', subdomains: false, types: [] })
    expect(results).toEqual([])
    expect(iconCopies.clear).toHaveBeenCalledTimes(1)
  })
})

