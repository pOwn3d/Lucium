// @vitest-environment happy-dom
// The panel of the site, mounted and used with the keyboard in mind: the button that arms the clearing of the site's data is named after what
// it does, the confirmation that takes its place takes its focus (and the bin of a Tweak takes it back when « Supprimer ? » is answered
// « Annuler »), the row of a Tweak has its switch then three buttons named after it and is renamed with F2 or a double-click on its name, the
// row of automatic Picture in Picture says that it is for every site and is not counted as a setting of this one, and an extension the main
// process cannot add is said.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Boost, SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { sectionTitle, type SiteSectionId } from '@shared/site-sections'
import { NAME_DOUBLE_CLICK_MS, SitePanel } from './SitePanel'
import { button, click, installBridge, mount, settle, type, type Mounted } from './dom.test-support'

const TWEAK = { id: 'tweak-1', name: 'Mon réglage', host: 'exemple.fr', enabled: true, css: '', js: '', zoom: 1, zap: [] } as unknown as Boost

let mounted: Mounted | null = null
beforeEach(() => localStorage.clear())
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

async function panel(settings: Partial<SidebarState['settings']> = {}, own: object = {}): Promise<HTMLElement> {
  const ctx = { now: 1, newId: ((n = 0) => () => `id${++n}`)() }
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://exemple.fr/a', spaceId: state.spaces[0]!.id }, ctx)
  state = reduce(state, { type: 'settings/update', patch: settings }, ctx)
  state = { ...state, boosts: [TWEAK] }
  installBridge({ getSnapshot: async () => ({ state, extensions: [], runtime: { tabs: {} }, private: false }) as unknown as UiSnapshot, dispatch: async () => undefined, ...own })
  mounted = mount(createElement(SitePanel))
  await settle()
  return mounted.container
}

const head = (container: Element, id: SiteSectionId): HTMLElement => [...container.querySelectorAll<HTMLElement>('.scc-section-head')].find((one) => one.querySelector('.scc-section-title')?.textContent === sectionTitle(id))!
/** Unfolds a section (the panel remembers the ones that were opened). */
const open = async (container: Element, id: SiteSectionId): Promise<void> => {
  if (head(container, id).getAttribute('aria-expanded') !== 'true') await click(head(container, id))
}

describe('the button that clears the data of the site', () => {
  it('is named after what it does, not « Plus »', async () => {
    const container = await panel()
    const more = container.querySelector('.scc-more')!
    expect(more.getAttribute('aria-label')).toBe(t('site-panel.effacer-les-cookies-et-donnees-du-site'))
  })

  it('hands its focus to the confirmation that takes its place', async () => {
    const container = await panel()
    const more = container.querySelector<HTMLElement>('.scc-more')!
    more.focus()
    await click(more)
    const confirm = button(container, t('site-panel.effacer-question'))
    expect(document.activeElement).toBe(confirm)
  })
})

describe('« Supprimer ? » on a Tweak, answered « Annuler »', () => {
  it('gives the focus back to the bin of that Tweak, which is drawn again', async () => {
    const container = await panel()
    await open(container, 'boosts')
    // As a click does: the bin has the focus when the question takes its place.
    container.querySelector<HTMLElement>('.scc-delete')!.focus()
    await click(container.querySelector('.scc-delete')!)
    const cancel = button(container.querySelector('.scc-boost-confirm')!, t('confirm-box.annuler'))
    // « Annuler » has the focus, not the red button: a Return typed at once deletes nothing.
    expect(document.activeElement).toBe(cancel)
    await click(cancel)
    const bin = container.querySelector('.scc-delete')
    expect(bin).not.toBeNull()
    expect(document.activeElement).toBe(bin)
  })
})

describe('the row of a Tweak', () => {
  const row = (container: Element): HTMLElement => container.querySelector<HTMLElement>('.scc-boost-row')!
  const name = (container: Element): HTMLElement => container.querySelector<HTMLElement>('.scc-boost-name')!
  /** A click of the pointer: `detail` is the count of the clicks in a row (a key that presses a button makes a click of detail 0). */
  const pointerClick = (target: Element, detail: number) => settle(() => void target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })))
  const key = (target: Element, which: string) => settle(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: which, bubbles: true, cancelable: true })))
  afterEach(() => vi.useRealTimers())

  it('has its switch, then « Modifier », « Exporter » and « Supprimer », each named after the Tweak, in the order of the keyboard', async () => {
    const container = await panel({ boostSharing: true })
    await open(container, 'boosts')
    const buttons = [...row(container).querySelectorAll('button')]
    expect(buttons[0]!.getAttribute('role')).toBe('switch')
    const actions = buttons.slice(1).map((one) => [one.getAttribute('aria-label'), one.getAttribute('title')])
    const names = [t('site-panel.modifier-name', { name: TWEAK.name }), t('site-panel.exporter-name', { name: TWEAK.name }), t('site-panel.supprimer-name', { name: TWEAK.name })]
    expect(actions).toEqual(names.map((label) => [label, label]))
    expect(buttons.every((one) => one.tabIndex === 0)).toBe(true)
  })

  it('has no « Exporter » while the sharing of Tweaks is off', async () => {
    const container = await panel({ boostSharing: false })
    await open(container, 'boosts')
    expect([...row(container).querySelectorAll('.scc-boost-action')].map((one) => one.getAttribute('aria-label'))).toEqual([t('site-panel.modifier-name', { name: TWEAK.name }), t('site-panel.supprimer-name', { name: TWEAK.name })])
  })

  it('opens the editor of the Tweak with « Modifier »', async () => {
    const openOverlay = vi.fn()
    const container = await panel({}, { openOverlay })
    await open(container, 'boosts')
    await click(container.querySelector('.scc-edit')!)
    expect(openOverlay).toHaveBeenCalledWith({ panel: 'boost', host: TWEAK.host, id: TWEAK.id })
  })

  it('is renamed with F2, from its switch or from « Modifier », and Return gives the focus back to the switch', async () => {
    const dispatch = vi.fn(async (_action: unknown) => undefined)
    const container = await panel({}, { dispatch })
    await open(container, 'boosts')
    for (const from of ['.scc-boost', '.scc-edit']) {
      container.querySelector<HTMLElement>(from)!.focus()
      await key(container.querySelector(from)!, 'F2')
      const field = container.querySelector<HTMLInputElement>('.scc-rename-field')
      expect(field, from).not.toBeNull()
      expect(document.activeElement).toBe(field)
      type(field!, 'Lecture')
      await key(field!, 'Enter')
      expect(document.activeElement).toBe(container.querySelector('.scc-boost'))
    }
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([0, 1].map(() => ({ type: 'boost/save', boost: { ...TWEAK, name: 'Lecture' } })))
  })

  it('is renamed by a double-click on its name, which does not flip it', async () => {
    const dispatch = vi.fn(async (_action: unknown) => undefined)
    const container = await panel({}, { dispatch })
    await open(container, 'boosts')
    vi.useFakeTimers()
    await pointerClick(name(container), 1)
    await pointerClick(name(container), 2)
    await settle(() => void name(container).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 })))
    expect(container.querySelector('.scc-rename-field')).not.toBeNull()
    vi.advanceTimersByTime(NAME_DOUBLE_CLICK_MS * 2)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('flips after the wait for a second click on its name, at once for a key or a click beside the name, and still when the panel closes during the wait', async () => {
    const dispatch = vi.fn(async (_action: unknown) => undefined)
    const container = await panel({}, { dispatch })
    await open(container, 'boosts')
    const off = { type: 'boost/save', boost: { ...TWEAK, enabled: false } }
    vi.useFakeTimers()
    await pointerClick(name(container), 1)
    expect(dispatch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(NAME_DOUBLE_CLICK_MS)
    expect(dispatch.mock.calls).toEqual([[off]])
    await pointerClick(container.querySelector('.scc-boost .scc-badge')!, 1)
    await pointerClick(container.querySelector('.scc-boost')!, 0)
    expect(dispatch.mock.calls).toEqual([[off], [off], [off]])
    await pointerClick(name(container), 1)
    mounted?.unmount()
    mounted = null
    expect(dispatch.mock.calls).toEqual([[off], [off], [off], [off]])
  })
})

describe('automatic Picture in Picture, in the display settings of the site', () => {
  const summary = (container: Element): string => head(container, 'display').querySelector('.scc-section-sum')?.textContent ?? ''

  it('says that the switch is for every site, on and off', async () => {
    for (const [on, text] of [[true, 'site-panel.autorisee-pour-tous-les-sites'], [false, 'site-panel.desactivee-pour-tous-les-sites']] as const) {
      const container = await panel({ autoPictureInPicture: on })
      await open(container, 'display')
      const row = [...container.querySelectorAll('.scc-setting')].find((one) => one.querySelector('strong')?.textContent === t('site-panel.image-dans-l-image-automatique'))!
      expect(row.querySelector('.scc-setting-text span')?.textContent).toBe(t(text))
      mounted?.unmount()
      mounted = null
    }
  })

  it('is not counted among the settings that are on for this site', async () => {
    const off = summary(await panel({ autoPictureInPicture: false }))
    mounted?.unmount()
    mounted = null
    const on = summary(await panel({ autoPictureInPicture: true }))
    expect(on).toBe(off)
  })
})

describe('« Ajouter une extension »', () => {
  it('says that the extension could not be added when the main process fails, and writes why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = new Error('no folder')
    const container = await panel({ webStoreInstall: false }, { loadExtension: () => Promise.reject(failure) })
    await open(container, 'extensions')
    await click(container.querySelector(`[aria-label="${t('site-panel.ajouter-une-extension')}"]`)!)
    await settle()
    expect([...container.querySelectorAll('[role="alert"]')].map((one) => one.textContent)).toEqual([t('site-panel.l-extension-n-a-pas-pu-etre-ajoutee')])
    expect(warn).toHaveBeenCalledWith('[extensions] the extension could not be added from the panel of the site:', failure)
  })
})
