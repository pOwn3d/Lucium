// @vitest-environment happy-dom
// The subpages of the Settings (shared/settings-subpages.ts), in the window mounted in a document: the row that opens one (its state, its dot), the
// subpage itself (its way back, its name, which takes the focus, its line), the way back and Escape, which give the focus to the row again; the
// addresses that open one; the search and « Réglages modifiés », which find what a subpage holds and open it to land on the row; « Rétablir ».

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { SUBPAGES } from '@shared/settings-subpages'
import { createInitialState, type Action } from '@shared/sidebar'
import { button, click, installBridge, mount, settle, type, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'
import settingsCss from './settings.css?raw'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>

const snapshotWith = (patch: Partial<Settings> = {}): UiSnapshot => {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

/** The window at an address, mounted once the change of address has been told (the document tells it later, as a browser does). */
async function open(hash: string, patch: Partial<Settings> = {}, query = ''): Promise<HTMLElement> {
  location.hash = hash
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot: snapshotWith(patch), initialQuery: query }))
  return mounted.container
}

/** What a click starts that changes the address: the window hears the change (the document tells it after the task, as a browser does) and lands. */
async function andArrive(run: () => Promise<void> | void): Promise<void> {
  await run()
  await settle(() => new Promise((resolve) => setTimeout(resolve, 0)))
  await settle(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
}

const entryOf = (window: HTMLElement, id: string) => window.querySelector<HTMLButtonElement>(`main [data-subpage-entry="${id}"] button`)
const heading = (window: HTMLElement) => window.querySelector<HTMLElement>('main #pane-heading')
const back = (window: HTMLElement) => window.querySelector<HTMLButtonElement>('main .subpage-back')
const current = (window: HTMLElement) => window.querySelector('.settings-cat[aria-current="page"]')?.getAttribute('data-cat')

const escape = async (target: Element) =>
  andArrive(() => {
    act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  })

beforeEach(() => {
  setLanguage('fr')
  dispatch = vi.fn(async () => undefined)
  installBridge({ dispatch })
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('the row that opens a subpage', () => {
  it('is a button that says the name of the subpage and its state, and opens it at its address', async () => {
    const window = await open('#protection')
    const entry = entryOf(window, 'filterlists')!
    expect(entry.getAttribute('type')).toBe('button')
    expect(entry.querySelector('.pref-label')?.textContent).toBe('Listes de filtres')
    // Standard protection of a new profile is Enhanced: the ads and the cookie banners are blocked, every shipped list is in use.
    expect(entry.querySelector('.subpage-state')?.textContent).toMatch(/^\d+ listes actives$/)
    expect(entryOf(window, 'network')?.querySelector('.subpage-state')?.textContent).toBe('Automatique')
    await andArrive(() => click(entry))
    expect(location.hash).toBe('#protection/filterlists')
    expect(heading(window)?.textContent).toBe('Listes de filtres')
  })

  it('says the state of what it holds, and moves with it', async () => {
    const window = await open('#tabs', { sleepExcludedHosts: ['a.example', 'b.example'] })
    expect(entryOf(window, 'awake')?.querySelector('.subpage-state')?.textContent).toBe('2 sites')
    mounted!.unmount()
    const none = await open('#tabs')
    expect(entryOf(none, 'awake')?.querySelector('.subpage-state')?.textContent).toBe('Aucun site')
    mounted!.unmount()
    const proxy = await open('#protection', { proxyEnabled: true })
    expect(entryOf(proxy, 'network')?.querySelector('.subpage-state')?.textContent).toBe('Proxy')
  })

  it('has the dot of a setting it holds that is not at its default, for a screen reader too; a list typed in is not « modified »', async () => {
    const window = await open('#protection', { proxyEnabled: true, blockExceptions: ['a.example'] })
    expect(entryOf(window, 'network')?.querySelector('.pref-changed .sr-only')?.textContent).toBe('Modifié')
    expect(entryOf(window, 'exceptions')?.querySelector('.pref-changed')).toBeNull()
    expect(entryOf(window, 'filterlists')?.querySelector('.pref-changed')).toBeNull()
  })
})

describe('a subpage', () => {
  it('shows its way back, its name and one line, and nothing else of its page; the page stays the current one in the sidebar', async () => {
    const window = await open('#protection/network')
    expect(current(window)).toBe('protection')
    expect(back(window)?.textContent).toBe('Vie privée et sécurité')
    expect(back(window)?.getAttribute('aria-label')).toBe('Revenir à Vie privée et sécurité')
    expect(heading(window)?.textContent).toBe('DNS chiffré et proxy')
    expect(window.querySelector('main')?.getAttribute('aria-labelledby')).toBe('pane-heading')
    expect(window.querySelector('main .subpage-head .settings-blurb')?.textContent).toBe(t('settings.sub-network-intro'))
    expect(window.querySelector('main [data-setting~="proxyEnabled"]')).not.toBeNull()
    // Nothing of the page: no other row, no fold, no « Rétablir » of the category.
    expect(window.querySelector('main [data-setting~="blockAds"]')).toBeNull()
    expect(window.querySelector('main .more-settings')).toBeNull()
    expect(window.querySelector('main .reset-bar')).toBeNull()
    expect([...window.querySelectorAll('main [data-subpage]')].map((el) => el.getAttribute('data-subpage'))).toEqual(['network'])
  })

  it('gives the focus to its name when it opens', async () => {
    const window = await open('#protection')
    await andArrive(() => click(entryOf(window, 'exceptions')!))
    expect(document.activeElement).toBe(heading(window))
    expect(heading(window)?.getAttribute('tabindex')).toBe('-1')
  })

  it('goes back to its page by its way back, the focus on the row that opened it', async () => {
    const window = await open('#protection')
    await andArrive(() => click(entryOf(window, 'network')!))
    expect(heading(window)?.textContent).toBe('DNS chiffré et proxy')
    await andArrive(() => click(back(window)!))
    expect(location.hash).toBe('#protection')
    expect(heading(window)?.textContent).toBe('Vie privée et sécurité')
    expect(document.activeElement).toBe(entryOf(window, 'network'))
  })

  it('goes back with Escape, but not while a field is typed in', async () => {
    const window = await open('#tabs/awake')
    const field = window.querySelector<HTMLInputElement>('main input.field')!
    field.focus()
    await escape(field)
    expect(location.hash).toBe('#tabs/awake')
    expect(heading(window)?.textContent).toBe('Sites gardés éveillés')
    const name = heading(window)!
    name.focus()
    await escape(name)
    expect(location.hash).toBe('#tabs')
    expect(document.activeElement).toBe(entryOf(window, 'awake'))
  })

  it('does not draw its title twice: a group named as the subpage leaves its name to the head', async () => {
    const window = await open('#protection/filterlists')
    expect([...window.querySelectorAll('main .pref-title')].map((title) => title.textContent)).not.toContain('Listes de filtres')
    expect(window.querySelectorAll('main h2').length).toBe(1)
  })

  it('has a slide that the reduced motion leaves out', () => {
    const sheet = settingsCss.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(sheet).toMatch(/\.subpage-head[^{]*\{[^}]*animation: subpage-in/)
    expect(sheet).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.subpage-head, \.subpage-head ~ \.subpage-content \{ animation: none; \} \}/)
  })
})

describe('the addresses of the subpages', () => {
  it('open each subpage on its page, by its name', async () => {
    const on: Partial<Settings> = { focusMode: true, pageWatch: true, userScripts: true, translateLocal: true, mouseGestures: true, tabContainers: true }
    for (const subpage of SUBPAGES.filter((one) => one.id !== 'lockoptions')) {
      const window = await open(`#${subpage.pane}/${subpage.id}`, on)
      expect(current(window), subpage.id).toBe(subpage.pane)
      expect(heading(window)?.textContent, subpage.id).toBe(t(subpage.title))
      expect(window.querySelector(`main [data-subpage="${subpage.id}"]`), subpage.id).not.toBeNull()
      mounted!.unmount()
      mounted = null
    }
  })

  it('keep their old meaning for the groups that moved: #protection/permissions opens the remembered permissions, #keyboard/shortcuts the editor', async () => {
    const permissions = await open('#protection/permissions')
    expect(heading(permissions)?.textContent).toBe('Autorisations mémorisées')
    expect(permissions.querySelector('main #permissions')).not.toBeNull()
    mounted!.unmount()
    const shortcuts = await open('#navigation/shortcuts')
    expect(current(shortcuts)).toBe('keyboard')
    expect(heading(shortcuts)?.textContent).toBe('Raccourcis clavier')
    expect(shortcuts.querySelector('main .shortcuts-layout')).not.toBeNull()
  })

  it('leave a subpage of another page out: the page opens at its top', async () => {
    const window = await open('#tabs/filterlists')
    expect(current(window)).toBe('tabs')
    expect(heading(window)?.textContent).toBe('Onglets et fenêtres')
    expect(back(window)).toBeNull()
  })
})

describe('the search and « Réglages modifiés »', () => {
  it('find a row of a subpage, say where it lives, and open the subpage on it, lit, its control focused', async () => {
    const window = await open('#home', {}, 'proxy')
    const row = window.querySelector<HTMLElement>('main [data-setting~="proxyEnabled"]')!
    const way = row.querySelector<HTMLButtonElement>('.pref-open')!
    expect(way.textContent).toBe('Ouvrir dans Vie privée et sécurité › DNS chiffré et proxy › Proxy')
    await andArrive(() => click(way))
    expect(location.hash).toBe('#protection/network')
    expect(heading(window)?.textContent).toBe('DNS chiffré et proxy')
    const landed = window.querySelector<HTMLElement>('main [data-setting~="proxyEnabled"]')!
    expect(landed.classList.contains('pref-flash')).toBe(true)
    expect(document.activeElement).toBe(landed.querySelector('input'))
  })

  it('find « raccourci » on the row of the editor, which opens its subpage on the editor, never on the row only a search shows', async () => {
    const window = await open('#home', {}, 'raccourci')
    const way = window.querySelector<HTMLButtonElement>('main [data-search-best] .pref-open')!
    await andArrive(() => click(way))
    expect(location.hash).toBe('#keyboard/shortcuts')
    const editor = window.querySelector<HTMLElement>('main .shortcuts-layout')!
    expect(editor.classList.contains('pref-flash')).toBe(true)
    expect(window.querySelector('main .shortcuts-jump .pref-flash')).toBeNull()
  })

  it('« Réglages modifiés » lists a setting of a subpage with its control and its « Rétablir », and puts it back', async () => {
    location.hash = '#home'
    await new Promise((resolve) => setTimeout(resolve, 0))
    mounted = mount(createElement(SettingsView, { snapshot: snapshotWith({ proxyEnabled: true }), initialView: 'modified' }))
    const window = mounted.container
    const row = [...window.querySelectorAll<HTMLElement>('main [data-setting~="proxyEnabled"]')].find((el) => !el.hidden)!
    expect(row).toBeDefined()
    expect(row.querySelector('.pref-open')?.textContent).toBe('Ouvrir dans Vie privée et sécurité › DNS chiffré et proxy › Proxy')
    await click(row.querySelector<HTMLButtonElement>('.pref-reset')!)
    expect(dispatch.mock.calls.map(([action]) => action)).toContainEqual({ type: 'settings/update', patch: { proxyEnabled: false } })
  })

  it('count a setting of a subpage in the dot of its category, and put it back with the « Rétablir » of the category', async () => {
    const window = await open('#protection', { proxyEnabled: true })
    expect(window.querySelector('[data-cat="protection"] .settings-cat-changed .sr-only')?.textContent).toBe('1 réglage modifié')
    await click(window.querySelector<HTMLButtonElement>('main .reset-bar button')!)
    expect(dispatch.mock.calls.map(([action]) => action)).toContainEqual({ type: 'settings/update', patch: { proxyEnabled: false } })
  })
})

describe('the scripts and the lock, whose subpage depends on their switch', () => {
  it('opens the subpage of the lock options only once the lock is on, and leads back to the page once it is turned off', async () => {
    const off = await open('#protection')
    expect(entryOf(off, 'lockoptions')).toBeNull()
    expect(off.querySelector('main [data-setting~="lockEnabled"]')).not.toBeNull()
    mounted!.unmount()
    const lockConfigure = vi.fn(async () => ({ ok: true }))
    installBridge({ dispatch, lockConfigure })
    location.hash = '#protection'
    await new Promise((resolve) => setTimeout(resolve, 0))
    const locked = { ...snapshotWith({ lockEnabled: true, lockApp: true }), lock: { active: true, appLocked: false, lockedSpaces: [], guardedSpaces: [], touchId: false, retryInMs: 0 } } as unknown as UiSnapshot
    mounted = mount(createElement(SettingsView, { snapshot: locked }))
    const on = mounted.container
    expect(entryOf(on, 'lockoptions')?.querySelector('.subpage-state')?.textContent).toBe(t('settings.sub-lock-app'))
    await andArrive(() => click(entryOf(on, 'lockoptions')!))
    expect(heading(on)?.textContent).toBe('Options du verrouillage')
    await click(button(on, t('lock-settings.desactiver-le-verrouillage')))
    type(on.querySelector<HTMLInputElement>(`main input[aria-label="${t('lock-settings.phrase-actuelle')}"]`)!, 'une phrase assez longue')
    await andArrive(() => click(button(on, t('lock-settings.desactiver'))))
    expect(lockConfigure).toHaveBeenCalledWith({ op: 'disable', current: 'une phrase assez longue' })
    expect(location.hash).toBe('#protection')
    expect(heading(on)?.textContent).toBe('Vie privée et sécurité')
  })

  it('counts the imported scripts on the row of their subpage, under the line of the feature in « Fonctions en option », while it is on', async () => {
    installBridge({ dispatch, userScripts: async () => ({ ok: true, scripts: [{ id: 's1', name: 'Un', version: '', matches: ['*://*/*'], excludes: [], warnings: [], enabled: true, allowPrivate: false }] }) })
    const off = await open('#features')
    expect(entryOf(off, 'userscripts')).toBeNull()
    mounted!.unmount()
    const window = await open('#features', { userScripts: true })
    await settle()
    const entry = entryOf(window, 'userscripts')!
    expect(entry.querySelector('.subpage-state')?.textContent).toBe('1 script')
    // The row follows the line of the manager of the scripts.
    const line = window.querySelector('main .pref-feature[data-setting="userScripts"]')!
    expect(line.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says under the row of the scripts that they could not be read, and why', async () => {
    installBridge({ dispatch, userScripts: async () => Promise.reject(new Error('disque occupé')) })
    const window = await open('#features', { userScripts: true })
    await settle()
    expect(entryOf(window, 'userscripts')?.querySelector('.subpage-state')).toBeNull()
    expect(window.querySelector('main [data-subpage-entry="userscripts"] + .pref-row[role="status"]')?.textContent).toBe(t('user-scripts-settings.la-liste-des-scripts-n-a-pas-pu-etre-lue', { reason: 'disque occupé' }))
  })

  it('opens the containers and the pages watched from the rows under their lines in « Fonctions en option », while the feature is on', async () => {
    const off = await open('#features')
    expect(entryOf(off, 'containers')).toBeNull()
    expect(entryOf(off, 'pagewatches')).toBeNull()
    mounted!.unmount()
    const window = await open('#features', { tabContainers: true, pageWatch: true })
    expect(entryOf(window, 'containers')?.querySelector('.pref-label')?.textContent).toBe('Vos conteneurs')
    expect(entryOf(window, 'containers')?.querySelector('.subpage-state')?.textContent).toBe('Aucun conteneur')
    expect(entryOf(window, 'pagewatches')?.querySelector('.subpage-state')?.textContent).toBe('Aucune page')
    // The lists are not on the page any more: on their subpage only.
    expect(window.querySelector('main [data-setting~="containerRules"]:not([data-subpage-entry])')).toBeNull()
    await andArrive(() => click(entryOf(window, 'containers')!))
    expect(location.hash).toBe('#features/containers')
    expect(heading(window)?.textContent).toBe('Vos conteneurs')
    expect(window.querySelector('main input[aria-label="' + t('containers-settings.nom-du-nouveau-conteneur') + '"]')).not.toBeNull()
    await andArrive(() => click(back(window)!))
    expect(document.activeElement).toBe(entryOf(window, 'containers'))
  })
})

describe('the autoplay of each site (D6)', () => {
  it('has no switch « Un réglage pour chaque site » any more, and lists the sites with their own choice on the subpage of the remembered permissions', async () => {
    const page = await open('#protection', { autoplayPerSite: false, siteAutoplay: { 'exemple.fr': 'allow' } })
    expect(page.textContent).not.toContain('Un réglage pour chaque site')
    expect(entryOf(page, 'permissions')?.querySelector('.subpage-state')?.textContent).toBe('1 site')
    mounted!.unmount()
    const sub = await open('#protection/permissions', { autoplayPerSite: false, siteAutoplay: { 'exemple.fr': 'allow' } })
    const list = sub.querySelector<HTMLElement>('main [data-setting="siteAutoplay"]')!
    expect(list.textContent).toContain('exemple.fr')
    expect(list.querySelector('select')?.getAttribute('aria-label')).toBe(t('site-privacy-settings.lecture-automatique-sur-host', { host: 'exemple.fr' }))
  })

  it('adds a site from the subpage, whatever an older state file kept', async () => {
    const window = await open('#protection/permissions', { autoplayPerSite: false })
    const field = window.querySelector<HTMLInputElement>(`main input[aria-label="${t('site-privacy-settings.site-a-regler')}"]`)!
    type(field, 'exemple.org')
    await click([...field.closest('.pref-form')!.querySelectorAll('button')].at(-1)!)
    expect(dispatch.mock.calls.map(([action]) => action)).toContainEqual({ type: 'autoplay/site', site: 'exemple.org', mode: 'allow' })
  })
})
