// @vitest-environment happy-dom
// The row of the extensions in the panel of the site, mounted and used: a tile per extension of the profile of the tab, « + », and the folder
// that loads an unpacked extension while « + » opens the Chrome Web Store. Each tile has a menu (right click, its ⋯, the Menu key, Shift+F10)
// that switches the extension off or on, reloads a folder, opens its page, and removes it after a question whose « Annuler » has the focus;
// the main process is asked through the request of the Extensions page, and what it refuses is said under the row.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { ExtensionInfo, UiSnapshot } from '@shared/ipc'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { sectionTitle } from '@shared/site-sections'
import panelCss from './site-panel.css?raw'
import { SitePanel } from './SitePanel'
import { button, click, installBridge, mount, settle, type Mounted } from './dom.test-support'

const DEV: ExtensionInfo = { id: 'a'.repeat(32), name: 'Dev', version: '1.0', profileId: 'default', source: 'unpacked', enabled: true }
const STORE: ExtensionInfo = { id: 'b'.repeat(32), name: 'Vimium', version: '2.1', profileId: 'default', source: 'store', enabled: true }
const ELSEWHERE: ExtensionInfo = { id: 'c'.repeat(32), name: 'Travail', version: '1.0', profileId: 'travail', source: 'store', enabled: true }

let mounted: Mounted | null = null
beforeEach(() => localStorage.clear())
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

/** The panel on a page of exemple.fr, with these extensions and settings, its section of the extensions unfolded. */
async function panel(extensions: ExtensionInfo[], settings: Partial<SidebarState['settings']> = {}, own: object = {}): Promise<HTMLElement> {
  const ctx = { now: 1, newId: ((n = 0) => () => `id${++n}`)() }
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://exemple.fr/a', spaceId: state.spaces[0]!.id }, ctx)
  state = reduce(state, { type: 'settings/update', patch: { webStoreInstall: true, ...settings } }, ctx)
  installBridge({ getSnapshot: async () => ({ state, extensions, runtime: { tabs: {} }, private: false }) as unknown as UiSnapshot, dispatch: async () => undefined, ...own })
  mounted = mount(createElement(SitePanel))
  await settle()
  const head = [...mounted.container.querySelectorAll<HTMLElement>('.scc-section-head')].find((one) => one.querySelector('.scc-section-title')?.textContent === sectionTitle('extensions'))!
  if (head.getAttribute('aria-expanded') !== 'true') await click(head)
  return mounted.container
}

const row = (container: Element): HTMLElement => container.querySelector<HTMLElement>('.scc-extensions')!
const tile = (container: Element, extension: ExtensionInfo): HTMLButtonElement => container.querySelector<HTMLButtonElement>(`[data-extension="${extension.id}"] .scc-tile`)!
const more = (container: Element, extension: ExtensionInfo): HTMLButtonElement => container.querySelector<HTMLButtonElement>(`[data-extension="${extension.id}"] .scc-ext-more`)!
const items = (container: Element): string[] => [...container.querySelectorAll('[role="menuitem"]')].map((one) => one.textContent ?? '')
const key = (target: Element, which: string, init: KeyboardEventInit = {}) => settle(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: which, bubbles: true, cancelable: true, ...init })))
const rightClick = (target: Element) => settle(() => void target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
const alerts = (container: Element): string[] => [...container.querySelectorAll('[role="alert"]')].map((one) => one.textContent ?? '')
/** The name of the folder, in the language of the run. */
const folder = (): string => t('site-panel.charger-une-extension-non-empaquetee')
/** The name of the button that opens the Extensions page, in the language of the run. */
const pageName = (): string => t('site-panel.ouvrir-la-page-extensions')

describe('the folder beside « + »', () => {
  it('is there while « + » opens the Chrome Web Store, after it in the order of the keyboard, and named after what it does', async () => {
    const container = await panel([DEV], { webStoreInstall: true })
    const buttons = [...row(container).querySelectorAll('button')]
    // The tile of the extension and its ⋯, then « + », then the folder, then the page of the extensions.
    expect(buttons.map((one) => one.getAttribute('aria-label'))).toEqual([DEV.name, t('site-panel.actions-de-name', { name: DEV.name }), t('site-panel.ajouter-une-extension'), folder(), pageName()])
    expect(buttons.at(-2)!.getAttribute('title')).toBe(folder())
    expect(buttons.every((one) => one.tabIndex === 0)).toBe(true)
  })

  it('is not there while the Store is off: « + » loads a folder itself', async () => {
    const container = await panel([DEV], { webStoreInstall: false })
    expect(container.querySelector(`[aria-label="${folder()}"]`)).toBeNull()
    expect(container.querySelector(`[aria-label="${t('site-panel.ajouter-une-extension')}"]`)?.getAttribute('title')).toBe(t('menu.ajouter-une-extension'))
  })

  it('asks the main process for a folder, and says when the extension could not be added, writing why', async () => {
    const loadExtension = vi.fn(async () => undefined)
    const openWebStore = vi.fn()
    let container = await panel([], { webStoreInstall: true }, { loadExtension, openWebStore })
    await click(container.querySelector(`[aria-label="${folder()}"]`)!)
    expect(loadExtension).toHaveBeenCalledTimes(1)
    expect(openWebStore).not.toHaveBeenCalled()
    mounted?.unmount()
    mounted = null

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = new Error('no folder')
    container = await panel([], { webStoreInstall: true }, { loadExtension: () => Promise.reject(failure) })
    await click(container.querySelector(`[aria-label="${folder()}"]`)!)
    await settle()
    expect(alerts(container)).toEqual([t('site-panel.l-extension-n-a-pas-pu-etre-ajoutee')])
    expect(warn).toHaveBeenCalledWith('[extensions] the extension could not be added from the panel of the site:', failure)
  })

  it('shows the extensions of the profile of the tab only: the menu acts on that copy', async () => {
    const container = await panel([DEV, ELSEWHERE, { ...DEV, profileId: 'travail' }])
    expect([...container.querySelectorAll('[data-extension]')].map((one) => one.getAttribute('data-extension'))).toEqual([DEV.id])
  })
})

// The last button of the row opens the page of the extensions (chrome://extensions in Chrome), which « + » and the folder do not: they add an extension.
describe('the button of the Extensions page', () => {
  it('is the last of the row, whether or not the Web Store is on and whether or not an extension is installed, and is named after what it opens', async () => {
    for (const [extensions, webStoreInstall] of [[[DEV], true], [[DEV], false], [[], true], [[], false]] as const) {
      const container = await panel([...extensions], { webStoreInstall })
      const last = [...row(container).querySelectorAll('button')].at(-1)!
      expect(last.getAttribute('aria-label'), `${extensions.length} extensions, Store ${webStoreInstall}`).toBe(pageName())
      expect(last.getAttribute('title')).toBe(pageName())
      // A native button in the order of the keyboard, as its neighbours are: Return and Space press it.
      expect(last.type).toBe('button')
      expect(last.disabled).toBe(false)
      expect(last.tabIndex).toBe(0)
      // Same shape as its neighbours, and a picture without a name of its own (the button carries the name).
      expect(last.classList.contains('scc-tile') && last.classList.contains('small')).toBe(true)
      expect(last.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
      mounted?.unmount()
      mounted = null
    }
  })

  it('closes the panel and asks the main process for the whole page, no extension targeted: the road « Gérer… » takes, which opens the tab', async () => {
    const asked: unknown[] = []
    const extensionsPage = vi.fn(async () => ({ ok: true }))
    const loadExtension = vi.fn(async () => undefined)
    const openWebStore = vi.fn()
    const container = await panel([DEV], {}, { extensionsPage, loadExtension, openWebStore, closeOverlay: () => asked.push('closeOverlay'), openOverlay: (request: unknown) => asked.push(request) })
    await click(container.querySelector(`[aria-label="${pageName()}"]`)!)
    expect(asked).toEqual(['closeOverlay', { panel: 'extensions' }])
    // It opens the page and adds nothing: neither the Store, nor a folder, nor a request of the page.
    expect(loadExtension).not.toHaveBeenCalled()
    expect(openWebStore).not.toHaveBeenCalled()
    expect(extensionsPage).not.toHaveBeenCalled()
  })
})

// The tiles were in a row that never went to the line: past five, they were cut at the edge of the card. Where they land is measured in the
// application (tests/e2e/site-panel.spec.ts); this is the rule.
describe('the row of the extensions, in the sheet', () => {
  /** The rules of the sheet for the row and its tiles, comments left out. */
  const rules = (css: string) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector!.trim(), body: body! }))
  const wraps = (css: string): boolean => rules(css).some(({ selector, body }) => selector === 'body.overlay .scc-extensions' && /flex-wrap:\s*wrap/.test(body))
  /** No rule lays a tile of the row out of the flow (the ⋯ and the barred disc sit over their own tile, inside `.scc-ext`). */
  const inFlow = (css: string): boolean => rules(css).filter(({ selector }) => /\.scc-(extensions|ext|tile|ext-folder)(?![-\w])/.test(selector) && !/\.scc-ext-(more|off)\b/.test(selector)).every(({ body }) => !/position:\s*(absolute|fixed)/.test(body))

  it('goes to the line when it is full, and lays no tile over another', () => {
    expect(wraps(panelCss)).toBe(true)
    expect(inFlow(panelCss)).toBe(true)
  })

  it('measures what it says: a row that does not wrap, or a tile out of the flow, is refused', () => {
    expect(wraps(panelCss.replace(/flex-wrap:\s*wrap;\s*/, ''))).toBe(false)
    expect(inFlow(`${panelCss}\nbody.overlay .scc-ext-folder { position: absolute; right: 0; }`)).toBe(false)
    expect(inFlow(`${panelCss}\nbody.overlay .scc-ext { position: absolute; }`)).toBe(false)
  })
})

describe('the menu of a tile', () => {
  it('opens on a right click with its first entry focused, and « Désactiver » switches the extension off in the profile of the tab', async () => {
    const extensionsPage = vi.fn(async () => ({ ok: true }))
    const activateExtension = vi.fn()
    const container = await panel([DEV, STORE], {}, { extensionsPage, activateExtension })
    await rightClick(tile(container, DEV))
    expect(container.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(t('site-panel.actions-de-name', { name: DEV.name }))
    expect(items(container)).toEqual([t('site-panel.desactiver'), t('extpage.recharger'), t('site-panel.gerer'), t('site-panel.retirer-points')])
    expect(document.activeElement?.textContent).toBe(t('site-panel.desactiver'))
    expect(more(container, DEV).getAttribute('aria-expanded')).toBe('true')
    await click(button(container, t('site-panel.desactiver')))
    expect(extensionsPage).toHaveBeenCalledWith({ op: 'set-enabled', profileId: 'default', extensionId: DEV.id, enabled: false })
    // The menu is closed, and its tile has the focus back; its action was not run.
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(tile(container, DEV))
    expect(activateExtension).not.toHaveBeenCalled()
  })

  it('opens with its ⋯, whose name says whose actions they are, and with the Menu key or Shift+F10 on the tile', async () => {
    const container = await panel([DEV, STORE])
    expect(more(container, STORE).getAttribute('aria-label')).toBe(t('site-panel.actions-de-name', { name: STORE.name }))
    expect(more(container, STORE).getAttribute('aria-haspopup')).toBe('menu')
    await click(more(container, STORE))
    // A Web Store extension has no folder to reload.
    expect(items(container)).toEqual([t('site-panel.desactiver'), t('site-panel.gerer'), t('site-panel.retirer-points')])
    expect(more(container, STORE).getAttribute('aria-controls')).toBe(container.querySelector('[role="menu"]')!.id)
    await click(more(container, STORE))
    expect(container.querySelector('[role="menu"]')).toBeNull()
    for (const init of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
      tile(container, DEV).focus()
      await key(tile(container, DEV), init.key, init)
      expect(items(container)[0], init.key).toBe(t('site-panel.desactiver'))
      await key(document.activeElement!, 'Escape')
      expect(container.querySelector('[role="menu"]'), init.key).toBeNull()
    }
    // F10 alone opens nothing.
    await key(tile(container, DEV), 'F10')
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('closes on Escape, which does not reach the panel, gives the focus back to the tile, and goes through its entries with the arrows', async () => {
    const container = await panel([DEV])
    const heard = vi.fn()
    window.addEventListener('keydown', heard)
    try {
      await rightClick(tile(container, DEV))
      await key(document.activeElement!, 'ArrowDown')
      expect(document.activeElement?.textContent).toBe(t('extpage.recharger'))
      await key(document.activeElement!, 'ArrowUp')
      await key(document.activeElement!, 'ArrowUp')
      expect(document.activeElement?.textContent).toBe(t('site-panel.retirer-points'))
      await key(document.activeElement!, 'Home')
      expect(document.activeElement?.textContent).toBe(t('site-panel.desactiver'))
      heard.mockClear()
      await key(document.activeElement!, 'Escape')
      expect(container.querySelector('[role="menu"]')).toBeNull()
      expect(document.activeElement).toBe(tile(container, DEV))
      // The window (where the panel listens for Escape to close itself) did not hear it.
      expect(heard).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', heard)
    }
  })

  it('reloads a folder, and opens the page of the extension in the Extensions window', async () => {
    const extensionsPage = vi.fn(async () => ({ ok: true, message: '« Dev » est rechargée.' }))
    const asked: unknown[] = []
    const container = await panel([DEV], {}, { extensionsPage, closeOverlay: () => asked.push('closeOverlay'), openOverlay: (request: unknown) => asked.push(request) })
    await rightClick(tile(container, DEV))
    await click(button(container, t('extpage.recharger')))
    expect(extensionsPage).toHaveBeenCalledWith({ op: 'reload', profileId: 'default', extensionId: DEV.id })
    // What the main process did is said in the zone that is read out.
    expect(container.querySelector('[role="status"]')?.textContent).toBe('« Dev » est rechargée.')
    await rightClick(tile(container, DEV))
    await click(button(container, t('site-panel.gerer')))
    expect(asked).toEqual(['closeOverlay', { panel: 'extensions', target: { view: 'detail', extensionId: DEV.id, profileId: 'default' } }])
  })

  it('says what the main process refused, and why a request failed, and writes both with their context', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = { ok: false, message: 'Cette extension n’est pas installée dans ce profil.' }
    let container = await panel([DEV], {}, { extensionsPage: vi.fn(async () => refused) })
    await rightClick(tile(container, DEV))
    await click(button(container, t('site-panel.desactiver')))
    await settle()
    expect(alerts(container)).toEqual([refused.message])
    expect(warn).toHaveBeenCalledWith(`[extensions] « set-enabled » of ${DEV.id} was refused from the panel of the site:`, refused.message)
    mounted?.unmount()
    mounted = null

    const failure = new Error("Error invoking remote method 'lucium:extensions-page': Error: gone")
    container = await panel([DEV], {}, { extensionsPage: vi.fn(async () => Promise.reject(failure)) })
    await rightClick(tile(container, DEV))
    await click(button(container, t('extpage.recharger')))
    await settle()
    expect(alerts(container)).toEqual([t('extpage.l-action-a-echoue-message', { message: 'gone' })])
    expect(warn).toHaveBeenCalledWith(`[extensions] « reload » of ${DEV.id} failed from the panel of the site:`, failure)
  })
})

describe('an extension that is off', () => {
  const OFF = { ...DEV, enabled: false }

  it('stays in the row, faded with a barred disc, named as off, and a click opens its menu, « Activer » first, instead of its action', async () => {
    const extensionsPage = vi.fn(async () => ({ ok: true }))
    const activateExtension = vi.fn()
    const container = await panel([OFF], {}, { extensionsPage, activateExtension })
    const off = tile(container, OFF)
    expect(off.getAttribute('aria-label')).toBe(t('site-panel.name-desactivee', { name: DEV.name }))
    expect(off.closest('.scc-ext')!.classList.contains('off')).toBe(true)
    expect(off.querySelector('.scc-ext-off')).not.toBeNull()
    expect(off.getAttribute('aria-haspopup')).toBe('menu')
    await click(off)
    expect(activateExtension).not.toHaveBeenCalled()
    // Nothing to reload while it is off.
    expect(items(container)).toEqual([t('site-panel.activer'), t('site-panel.gerer'), t('site-panel.retirer-points')])
    expect(off.getAttribute('aria-expanded')).toBe('true')
    await click(button(container, t('site-panel.activer')))
    expect(extensionsPage).toHaveBeenCalledWith({ op: 'set-enabled', profileId: 'default', extensionId: DEV.id, enabled: true })
  })

  it('is not marked when it is on, and a click runs its action', async () => {
    const activateExtension = vi.fn()
    const container = await panel([DEV], {}, { activateExtension })
    expect(tile(container, DEV).querySelector('.scc-ext-off')).toBeNull()
    expect(tile(container, DEV).hasAttribute('aria-haspopup')).toBe(false)
    await click(tile(container, DEV))
    expect(activateExtension).toHaveBeenCalledWith(DEV.id)
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('« Retirer… »', () => {
  const ask = async (container: HTMLElement, extension: ExtensionInfo) => {
    await rightClick(tile(container, extension))
    await click(button(container, t('site-panel.retirer-points')))
  }

  it('asks first, « Annuler » having the focus, and « Annuler » removes nothing and gives the focus back to the tile', async () => {
    const extensionsPage = vi.fn(async () => ({ ok: true }))
    const container = await panel([DEV], {}, { extensionsPage })
    await ask(container, DEV)
    const question = container.querySelector('.scc-ext-confirm')!
    expect(question.getAttribute('aria-label')).toBe(t('site-panel.retirer-name-question', { name: DEV.name }))
    // A folder leaves every profile and its files stay.
    expect(question.querySelector('p')?.textContent).toBe(t('extpage.sort-l-extension-de-tous-les-profils-le-dossier-n-est-pas-touche'))
    const cancel = button(question, t('confirm-box.annuler'))
    expect(document.activeElement).toBe(cancel)
    await click(cancel)
    expect(extensionsPage).not.toHaveBeenCalled()
    expect(container.querySelector('.scc-ext-confirm')).toBeNull()
    expect(document.activeElement).toBe(tile(container, DEV))
    // Escape answers « Annuler » too.
    await ask(container, DEV)
    await key(document.activeElement!, 'Escape')
    expect(extensionsPage).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(tile(container, DEV))
  })

  it('takes a folder out of every profile, and gives the focus to « + », the next thing of the row', async () => {
    const extensionsPage = vi.fn(async () => ({ ok: true, message: '« Dev » est retirée ; le dossier n’est pas touché.' }))
    const container = await panel([DEV], {}, { extensionsPage })
    await ask(container, DEV)
    await click(button(container.querySelector('.scc-ext-confirm')!, t('site-panel.retirer')))
    await settle()
    expect(extensionsPage.mock.calls).toEqual([[{ op: 'remove-folder', extensionId: DEV.id }]])
    expect(document.activeElement?.getAttribute('aria-label')).toBe(t('site-panel.ajouter-une-extension'))
  })

  it('uninstalls a Web Store extension from the profile with its data, the question being the one asked here', async () => {
    const extensionsPage = vi.fn(async () => ({ ok: true }))
    const container = await panel([STORE], {}, { extensionsPage })
    await ask(container, STORE)
    expect(container.querySelector('.scc-ext-confirm p')?.textContent).toBe(t('extpage.l-extension-et-ses-donnees-seront-supprimees-du-profil', { profile: t('menu.profil-par-defaut') }))
    await click(button(container.querySelector('.scc-ext-confirm')!, t('site-panel.retirer')))
    expect(extensionsPage.mock.calls).toEqual([[{ op: 'uninstall', profileId: 'default', extensionId: STORE.id, asked: true }]])
  })
})
