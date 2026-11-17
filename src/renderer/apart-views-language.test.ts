// @vitest-environment happy-dom
// The views of a mini window that are pages apart (the space picker, the tray of downloads) and the header of a site opened as an application:
// each is its own page, and a page reads French until something sets its language. Only the header of the mini window did, so with the interface
// in English these three stayed in French, their `lang` too. The page is loaded for real, on each address the main process gives it.

import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLanguage, setLanguage } from '@shared/i18n'
import { createInitialState } from '@shared/sidebar'
import { languageOfSnapshot, type LanguageRoot } from './document-language'
import { mount, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ page: null as unknown, snapshot: null as unknown, fails: false }))
vi.mock('./root', () => ({ mountRoot: (node: unknown) => void (holder.page = node) }))
vi.mock('./api', () => ({
  api: () => ({
    getSnapshot: () => (holder.fails ? Promise.reject(new Error('the main process is gone')) : Promise.resolve(holder.snapshot)),
    onLittleState: () => () => undefined,
    littleAction: () => undefined,
    downloadAction: () => undefined
  }),
  useSnapshot: () => null
}))

const state = createInitialState({ now: 1, newId: () => 'id' })
const snapshotIn = (language: 'fr' | 'en') => ({ state: { ...state, settings: { ...state.settings, interfaceTranslated: true, language } } })

let mounted: Mounted | null = null

/** The page of the mini window loaded on this address, as the main process loads it, once its first requests have been answered. */
async function page(search: string): Promise<HTMLElement> {
  vi.resetModules()
  history.replaceState(null, '', `/${search}`)
  holder.page = null
  await import('./littlearc')
  mounted = mount(holder.page as ReactNode as never)
  await act(async () => {})
  return mounted.container
}

beforeEach(() => {
  document.documentElement.lang = 'fr'
  holder.snapshot = snapshotIn('en')
  holder.fails = false
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  setLanguage('fr')
  vi.restoreAllMocks()
})

describe('a view of the mini window that is a page apart', () => {
  it('reads the header of a site opened as an application in the language of the interface, and says it on its root', async () => {
    const container = await page('?id=w1&app=1')
    expect([...container.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Back', 'Forward', 'Reload', 'Open in a Tab'])
    expect(document.documentElement.lang).toBe('en')
  })

  it('reads the space picker in the language of the interface', async () => {
    const container = await page('?id=w1&picker=1')
    expect(container.querySelector('input')?.getAttribute('aria-label')).toBe('Search Spaces')
    expect(document.documentElement.lang).toBe('en')
  })

  it('reads the tray of downloads in the language of the interface', async () => {
    const container = await page('?id=w1&tray=1')
    expect(container.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Downloads')
    expect(document.documentElement.lang).toBe('en')
  })

  it('stays in French when the interface is', async () => {
    holder.snapshot = snapshotIn('fr')
    const container = await page('?id=w1&app=1')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Précédent')
    expect(document.documentElement.lang).toBe('fr')
  })

  it('is drawn all the same when the language cannot be read, and the failure is written to the log', async () => {
    holder.fails = true
    const container = await page('?id=w1&app=1')
    expect(container.querySelectorAll('button')).toHaveLength(4)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('the language of the interface could not be read'), expect.any(Error))
  })
})

describe('the language read from a snapshot', () => {
  const rootOf = (lang: string): LanguageRoot => ({ lang, hasAttribute: () => false })

  it('is set for the texts and said on the root', async () => {
    const root = rootOf('fr')
    expect(await languageOfSnapshot(root, () => Promise.resolve(snapshotIn('en')), 'fr-FR')).toBe('en')
    expect(root.lang).toBe('en')
    expect(getLanguage()).toBe('en')
  })

  it('keeps the language the view has when no snapshot comes, and says so in the log', async () => {
    const root = rootOf('fr')
    expect(await languageOfSnapshot(root, () => Promise.resolve(null), 'en-US')).toBe('fr')
    expect(await languageOfSnapshot(root, () => Promise.reject(new Error('gone')), 'en-US')).toBe('fr')
    expect(root.lang).toBe('fr')
    expect(console.error).toHaveBeenCalledTimes(2)
  })
})
