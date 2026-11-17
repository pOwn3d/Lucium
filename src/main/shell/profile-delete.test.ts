// "Supprimer le profil et ses données": everything the profile holds goes, its Chrome Web Store extensions and the storage of every
// extension included; its id is retired, and the next launch removes its folders. Run on stand-ins of the engine, the session and the window; the
// rules on the state are in src/shared/profile-retire.test.ts.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'

const holder = vi.hoisted(() => ({ userData: '', sessions: new Map<string, { clearData: ReturnType<typeof vi.fn>; clearAuthCache: ReturnType<typeof vi.fn>; getStoragePath: () => string | null }>() }))
vi.mock('electron', async () =>
  (await import('../engine/electron-page.test-support')).electronStub({
    app: { getPath: (name: string) => (name === 'userData' ? holder.userData : `/tmp/lucium-test-${name}`) },
    session: {
      defaultSession: { clearData: vi.fn(async () => undefined), clearCache: vi.fn(async () => undefined) },
      fromPartition: (name: string) => {
        if (!holder.sessions.has(name)) holder.sessions.set(name, { clearData: vi.fn(async () => undefined), clearAuthCache: vi.fn(async () => undefined), getStoragePath: () => null })
        return holder.sessions.get(name)
      }
    }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('../engine/electron-engine')
const { Browser } = await import('./browser')
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>
const browserMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const STORE_ID = 'a'.repeat(32)
const FOLDER_ID = 'b'.repeat(32)

function dataFolder(): string {
  holder.userData = mkdtempSync(join(tmpdir(), 'lucium-profile-delete-'))
  return holder.userData
}
afterEach(() => {
  if (holder.userData) rmSync(holder.userData, { recursive: true, force: true })
  holder.sessions.clear()
})

/** An engine with one extension of the Chrome Web Store and one folder loaded by hand in « travail », and one of the Store in another profile. */
function engine() {
  const known = new Map([
    [`travail:${STORE_ID}`, { info: { id: STORE_ID, source: 'store' } }],
    [`travail:${FOLDER_ID}`, { info: { id: FOLDER_ID, source: 'folder' } }],
    [`autre:${STORE_ID}`, { info: { id: STORE_ID, source: 'store' } }]
  ])
  const fake = Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    known,
    loaded: new Map([[`travail:${FOLDER_ID}`, { id: FOLDER_ID }]]),
    profiles: new Map<string, unknown>(),
    webStore: { uninstall: vi.fn(async () => undefined) },
    resume: { forgetProfile: vi.fn() },
    siteIcons: { clear: vi.fn() }
  })
  return fake as typeof fake & { webStore: { uninstall: ReturnType<typeof vi.fn> }; resume: { forgetProfile: ReturnType<typeof vi.fn> }; profiles: Map<string, unknown> }
}

describe('the engine, for a deleted profile', () => {
  it('erases all the session holds, the storage of the extensions included, and uninstalls its Chrome Web Store extensions', async () => {
    const root = dataFolder()
    const manifest = join(root, 'WebStoreExtensions', 'travail', STORE_ID, '1.0.0_0')
    mkdirSync(manifest, { recursive: true })
    writeFileSync(join(manifest, 'manifest.json'), '{}')
    const fake = engine()
    await engineMethods['deleteProfileData']!.call(fake, 'travail')
    const ses = holder.sessions.get('persist:profile-travail')!
    // No `excludeOrigins`: "Effacer les données de navigation" keeps the extensions' storage (clearProfileData), a deletion does not.
    expect(ses.clearData).toHaveBeenCalledExactlyOnceWith()
    expect(ses.clearAuthCache).toHaveBeenCalledOnce()
    expect(fake.webStore.uninstall).toHaveBeenCalledExactlyOnceWith('travail', STORE_ID)
    expect(existsSync(join(root, 'WebStoreExtensions', 'travail'))).toBe(false)
    expect(fake.resume.forgetProfile).toHaveBeenCalledWith('travail')
  })

  it('removes at launch the folders of the retired profiles, never those of a profile whose session is open', () => {
    const root = dataFolder()
    for (const dir of ['Partitions/profile-gone', 'WebStoreExtensions/gone', 'Partitions/profile-open']) mkdirSync(join(root, dir), { recursive: true })
    const fake = engine()
    fake.profiles.set('open', {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(engineMethods['removeRetiredProfiles']!.call(fake, ['gone', 'open', 'default', '../x'])).toEqual(['open', 'default', '../x'])
    expect(existsSync(join(root, 'Partitions/profile-gone'))).toBe(false)
    expect(existsSync(join(root, 'WebStoreExtensions/gone'))).toBe(false)
    expect(existsSync(join(root, 'Partitions/profile-open'))).toBe(true)
    expect(error).toHaveBeenCalledTimes(3)
    error.mockRestore()
  })
})

/** A window over the real reducer, with a profile « Travail » no space uses, and stand-ins for the engine and the history. */
function windowWithWork(eraseFails = false) {
  const ctx = { now: 1, newId: (() => { let next = 0; return () => `n${++next}` })() }
  let state: SidebarState = createInitialState(ctx)
  state = { ...state, settings: { ...state.settings, profileNames: { travail: 'Travail' }, usedProfiles: ['travail'] } }
  const engine = {
    deleteProfileData: vi.fn(async () => {
      if (eraseFails) throw new Error('disque plein')
    }),
    clearProfileData: vi.fn(async () => undefined),
    removeRetiredProfiles: vi.fn((ids: readonly string[]) => ids.filter((id) => id === 'stuck'))
  }
  const history = { erase: vi.fn(() => true) }
  const dispatched: string[] = []
  const store = { get: () => state, dispatch: (action: Action) => (state = reduce(state, action, ctx)) }
  // The history of a profile is erased by `eraseProfileHistory`, which takes the Back lists of its closed tabs with it (`forgetClosedPages`): both are the shell's own.
  const fake: Record<string, unknown> & { store: typeof store } = {
    store,
    engine,
    history,
    isPrivate: () => false,
    isSecondary: () => false,
    // The lists kept in memory for the sleeping tabs are forgotten with the history (slept-history.ts): none here.
    leader: { slept: { forgetPages: () => undefined } },
    dispatch: (action: Action) => {
      dispatched.push(action.type)
      store.dispatch(action)
    },
    eraseProfileHistory: (id: string) => browserMethods['eraseProfileHistory']!.call(fake, id),
    forgetClosedPages: (id: string, site?: unknown) => browserMethods['forgetClosedPages']!.call(fake, id, site)
  }
  return { fake, engine, history, dispatched, state: () => state }
}

describe('the window, for a deleted profile', () => {
  it('erases everything through the engine, then forgets the name and retires the id', async () => {
    const { fake, engine, history, dispatched, state } = windowWithWork()
    await browserMethods['deleteProfile']!.call(fake, 'travail')
    expect(engine.deleteProfileData).toHaveBeenCalledWith('travail')
    expect(engine.clearProfileData).not.toHaveBeenCalled()
    expect(history.erase).toHaveBeenCalledWith('travail')
    // The pages the closed tabs of the profile went through are history too.
    expect(dispatched).toContain('archive/forget-pages')
    expect(state().settings.profileNames).toEqual({})
    expect(state().settings.usedProfiles).toEqual([])
    expect(state().settings.retiredProfileIds).toEqual(['travail'])
  })

  it('keeps the profile listed when its data could not all be erased, and says why', async () => {
    const { fake, state } = windowWithWork(true)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(browserMethods['deleteProfile']!.call(fake, 'travail')).rejects.toThrow(/disque plein/)
    expect(state().settings.profileNames).toEqual({ travail: 'Travail' })
    expect(state().settings.retiredProfileIds).toEqual([])
    error.mockRestore()
  })

  it('refuses the default profile and a profile a space uses, and erases nothing', async () => {
    const { fake, engine } = windowWithWork()
    await expect(browserMethods['deleteProfile']!.call(fake, 'default')).rejects.toThrow(/default/)
    fake.store.dispatch({ type: 'space/create', name: 'Bureau', emoji: '💼', hue: 200, profileId: 'travail' })
    await expect(browserMethods['deleteProfile']!.call(fake, 'travail')).rejects.toThrow(/in-use/)
    expect(engine.deleteProfileData).not.toHaveBeenCalled()
  })

  it('frees at launch the ids whose folders were removed, and keeps the others retired', () => {
    const { fake, engine, state } = windowWithWork()
    fake.store.dispatch({ type: 'settings/update', patch: { retiredProfileIds: ['gone', 'stuck'] } })
    expect(browserMethods['sweepRetiredProfiles']!.call(fake, false)).toEqual([])
    expect(engine.removeRetiredProfiles).not.toHaveBeenCalled()
    expect(browserMethods['sweepRetiredProfiles']!.call(fake, true)).toEqual(['gone'])
    expect(state().settings.retiredProfileIds).toEqual(['stuck'])
  })
})
