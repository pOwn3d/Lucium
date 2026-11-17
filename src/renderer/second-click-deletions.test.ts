// @vitest-environment happy-dom
// Two deletions that one click made: the cookies of a site (« Supprimer », beside the box « Garder »: a click beside signs the person out) and a
// translation model (tens of megabytes to download again). Both now ask a second click, as « Nettoyer » does, and « Annuler » sits where the first
// click was. With them, what the translation panel says of an address that is no address, and the sentence of the models folder.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { ExtensionInfo } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import type { TranslateView } from '@shared/translate-local'
import { click, mount, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, bridge: {} as Record<string, (...args: unknown[]) => unknown> }))
vi.mock('./api', () => ({ api: () => holder.bridge, useSnapshot: () => holder.snapshot }))

import { CookieManager } from './CookieManager'
import { byExtension } from './ExtensionSettings'
import { TranslatePanel, shownHost } from './TranslatePanel'

const state = createInitialState({ now: 1, newId: () => 'id' })
let mounted: Mounted | null = null
async function shown(node: ReturnType<typeof createElement>, bridge: Record<string, (...args: unknown[]) => unknown>): Promise<HTMLElement> {
  holder.bridge = bridge
  holder.snapshot = { state, runtime: { tabs: {} }, extensions: [], platform: 'darwin' }
  mounted = mount(node)
  await act(async () => {})
  return mounted.container
}
const action = (container: HTMLElement, name: string): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
  setLanguage('fr')
  vi.restoreAllMocks()
})

describe('« Supprimer » of the cookies of a site', () => {
  const sheet = async (removed: string[]): Promise<HTMLElement> =>
    shown(createElement(CookieManager), {
      cookieSites: () => Promise.resolve([{ host: 'exemple.fr', count: 2, bytes: 120 }]),
      cookieNames: () => Promise.resolve([]),
      removeCookieSite: (host: unknown) => (removed.push(host as string), Promise.resolve({ removed: 2, failed: 0 })),
      dispatch: () => Promise.resolve(),
      closeOverlay: () => undefined
    })

  it('removes nothing at the first click: it asks, and « Annuler » is where the click was', async () => {
    const removed: string[] = []
    const container = await sheet(removed)
    await click(action(container, 'remove')!)
    expect(removed).toEqual([])
    expect(action(container, 'remove')).toBeNull()
    expect(action(container, 'remove-confirm')?.getAttribute('aria-label')).toBe('Confirmer la suppression des cookies du site exemple.fr')
    const line = [...container.querySelectorAll('.cookies-line > button')]
    expect(line.at(-1)).toBe(action(container, 'remove-cancel'))
    await click(action(container, 'remove-cancel')!)
    expect(removed).toEqual([])
    expect(action(container, 'remove')).not.toBeNull()
  })

  it('removes the cookies of the site at the second click', async () => {
    const removed: string[] = []
    const container = await sheet(removed)
    await click(action(container, 'remove')!)
    await click(action(container, 'remove-confirm')!)
    expect(removed).toEqual(['exemple.fr'])
  })
})

describe('the translation panel', () => {
  const view = (over: Partial<TranslateView> = {}): TranslateView => ({
    enabled: true,
    readOnly: false,
    page: null,
    target: 'fr',
    proposed: null,
    packs: [{ from: 'en', to: 'fr', engine: 'bergamot', version: '1', bytes: 40_000_000, verified: true, folder: 'en-fr' }],
    engines: ['bergamot'],
    ready: ['bergamot'],
    route: null,
    state: 'idle',
    message: '',
    offer: null,
    folder: { path: '/Users/moi/Modèles', isDefault: true },
    lookupUrl: null,
    system: null,
    using: [],
    ...over
  } as TranslateView)
  const panel = async (asked: unknown[], given: TranslateView = view()): Promise<HTMLElement> =>
    shown(createElement(TranslatePanel), { translate: (request: unknown) => (asked.push(request), Promise.resolve(given)), closeOverlay: () => undefined })

  it('removes a model at the second click only, « Annuler » where the first one was', async () => {
    const asked: unknown[] = []
    const container = await panel(asked)
    asked.length = 0
    await click(action(container, 'remove')!)
    expect(asked).toEqual([])
    const offered = [...container.querySelectorAll('.translate-packs li button')]
    expect(offered.map((button) => button.getAttribute('data-action'))).toEqual(['remove-confirm', 'remove-cancel'])
    expect(offered[0]!.textContent).toBe('Supprimer le modèle anglais → français')
    await click(action(container, 'remove-cancel')!)
    expect(asked).toEqual([])
    await click(action(container, 'remove')!)
    await click(action(container, 'remove-confirm')!)
    expect(asked).toEqual([{ action: 'remove', from: 'en', to: 'fr', engine: 'bergamot' }])
  })

  it('says where the models are in a whole sentence of the language, the path in its own element', async () => {
    setLanguage('en')
    const container = await panel([])
    const line = [...container.querySelectorAll('p')].find((p) => p.querySelector('code')?.textContent === '/Users/moi/Modèles')
    expect(line?.textContent).toBe('Models folder: /Users/moi/Modèles')
  })

  it('is drawn with an offer whose address is no address: the layer of panels does not fall with it', async () => {
    const offer = { from: 'en', to: 'de', catalogue: 'x', files: [{ name: 'model.bin', url: 'pas une adresse', size: 10, kind: 'model' as const }], totalBytes: 10, diskBytes: 10 }
    const container = await panel([], view({ offer, lookupUrl: '::::' }))
    expect(container.querySelector('.translate-files code')?.textContent).toBe('pas une adresse')
  })

  it('names the host of an address, and shows as given what is no address', () => {
    expect(shownHost('https://models.example.org/index.json')).toBe('models.example.org')
    expect(shownHost('pas une adresse')).toBe('pas une adresse')
    expect(shownHost(null)).toBe('')
    expect(shownHost(undefined)).toBe('')
  })
})

describe('the extensions of the settings', () => {
  it('are sorted by name in the language of the interface, not always in French', () => {
    const compare = vi.spyOn(String.prototype, 'localeCompare')
    setLanguage('en')
    const sorted = byExtension([{ id: 'b', name: 'Zeta' }, { id: 'a', name: 'Alpha' }] as ExtensionInfo[])
    expect(sorted.map((group) => group[0]!.name)).toEqual(['Alpha', 'Zeta'])
    expect(compare.mock.calls.map((call) => call[1])).toEqual(['en'])
  })
})
