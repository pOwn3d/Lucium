// @vitest-environment happy-dom
// « Plus de réglages », in the window mounted in a document: what a static render cannot show (the line of the fold is read from the rows it holds,
// after the draw; a link or a result opens it). And the measure the fold was made for: at the opening of a page, no setting is hidden without the page
// saying where it is.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { SETTINGS_PAGES, type SettingsPage, type UiSnapshot } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { click, installBridge, mount, settle, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'
import settingsCss from './settings.css?raw'

let mounted: Mounted | null = null

const snapshotWith = (patch: Partial<Settings> = {}): UiSnapshot => {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

/** Every switch on: the rows that wait for one are drawn. */
function allOn(): Partial<Settings> {
  const on: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defaultSettings())) if (value === false) on[key] = true
  return on as Partial<Settings>
}

/** Goes to a category as its button does, the address changing (the document of the tests does not say it by itself). */
async function goTo(window: HTMLElement, pane: SettingsPage): Promise<void> {
  await click(window.querySelector<HTMLButtonElement>(`[data-cat="${pane}"]`)!)
  await settle(() => void globalThis.dispatchEvent(new HashChangeEvent('hashchange')))
}

/**
 * The window at an address, mounted: its effects have run, the line of the fold is read. Mounted once the change of address has been told (the
 * document tells it later, as a browser does), so that it does not reach the window afterwards.
 */
async function open(hash: string, patch: Partial<Settings> = {}, query = ''): Promise<HTMLElement> {
  location.hash = hash
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot: snapshotWith(patch), initialQuery: query }))
  return mounted.container
}

/** Whether a person sees `el` at the opening: no ancestor is hidden, and no <details> around it is closed. */
function shown(el: Element): boolean {
  for (let at: Element | null = el; at; at = at.parentElement) {
    if ((at as HTMLElement).hidden) return false
    if (at !== el && at.tagName === 'DETAILS' && !(at as HTMLDetailsElement).open && !at.querySelector(':scope > summary')?.contains(el)) return false
  }
  return true
}

/**
 * The settings of a page a person cannot see at its opening and that nothing on screen names: a row hidden anywhere but in « Plus de réglages »,
 * or in it under a section its line does not name. Each with its section, for the message.
 */
function hiddenWithoutMention(page: Element): string[] {
  const hidden: string[] = []
  for (const holder of Array.from(page.querySelectorAll<HTMLElement>('[data-setting]:not([data-mirror])'))) {
    if (shown(holder)) continue
    const section = holder.closest('.pref-section')?.querySelector(':scope > h3 .pref-title')?.textContent?.trim() ?? ''
    const fold = holder.closest('.more-settings')
    const line = fold?.querySelector('.more-settings-what')?.textContent ?? ''
    // In the fold, under a section its line names, the setting is said; anywhere else it is hidden without a word.
    const said = fold !== null && section !== '' && line.includes(section) && shown(fold.querySelector('.more-settings-toggle')!)
    if (!said) for (const key of (holder.dataset['setting'] ?? '').split(' ')) hidden.push(`${key} (${section || 'sans titre'})`)
  }
  return hidden
}

beforeEach(() => {
  setLanguage('fr')
  installBridge({})
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('the measure: a setting hidden without the page saying so', () => {
  it('finds what it is meant to find: a group hidden outside the fold, or in it under a section the line does not name', async () => {
    const page = document.createElement('main')
    page.innerHTML = `
      <section class="pref-section"><h3><span class="pref-title">En haut</span></h3><label class="pref-row" data-setting="a"></label></section>
      <section class="pref-section" hidden><h3><span class="pref-title">Caché</span></h3><label class="pref-row" data-setting="b"></label></section>
      <details><summary>Ouvrir</summary><section class="pref-section"><h3><span class="pref-title">Replié</span></h3><label class="pref-row" data-setting="c"></label></section></details>
      <div class="more-settings"><h2><button class="more-settings-toggle"><span class="more-settings-what">Contient : Dit.</span></button></h2><div class="more-settings-body" hidden>
        <section class="pref-section"><h3><span class="pref-title">Dit</span></h3><label class="pref-row" data-setting="d"></label></section>
        <section class="pref-section"><h3><span class="pref-title">Tu</span></h3><label class="pref-row" data-setting="e"></label></section>
        <section class="pref-section"><label class="pref-row" data-setting="f"></label></section>
      </div></div>`
    expect(hiddenWithoutMention(page)).toEqual(['b (Caché)', 'c (Replié)', 'e (Tu)', 'f (sans titre)'])
  })

  it('is 0 on every page at its opening, « Plus de réglages » closed, with the defaults and with every switch on', async () => {
    for (const patch of [{}, allOn()]) {
      for (const pane of SETTINGS_PAGES) {
        const window = await open(`#${pane}`, patch)
        expect(hiddenWithoutMention(window.querySelector('main')!), pane).toEqual([])
        mounted!.unmount()
        mounted = null
      }
    }
  })

  it('has no rule of the sheet that hides a group or a row outside a search: only the fold hides, and it says what it holds', async () => {
    const rules = [...settingsCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, , body]) => /display:\s*none/.test(body!)).map(([, selector]) => selector!.trim())
    const hiding = rules.filter((selector) => /\.pref-(section|row|group)\b/.test(selector) && !selector.split(',').every((one) => one.includes('.settings-searching')))
    expect(hiding).toEqual([])
  })
})

describe('« Plus de réglages »', () => {
  const toggleOf = (window: HTMLElement) => window.querySelector<HTMLButtonElement>('main .more-settings-toggle')!
  const bodyOf = (window: HTMLElement) => window.querySelector<HTMLElement>('main .more-settings-body')!

  it('is a button that says it is closed and names the region it opens, hidden until it is opened', async () => {
    const window = await open('#tabs')
    const toggle = toggleOf(window)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe(bodyOf(window).id)
    expect(bodyOf(window).hidden).toBe(true)
    await click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(bodyOf(window).hidden).toBe(false)
    await click(toggle)
    expect(bodyOf(window).hidden).toBe(true)
  })

  it('says what it holds before it is opened: its sections, in the order drawn, and how many settings', async () => {
    const window = await open('#tabs')
    const titles = [...bodyOf(window).querySelectorAll('.pref-section > h3 .pref-title')].map((title) => title.textContent)
    expect(titles.length).toBeGreaterThan(3)
    expect(toggleOf(window).querySelector('.more-settings-what')?.textContent).toBe(t('settings.plus-contient', { sections: [...new Set(titles)].join(' · ') }))
    const keys = new Set([...bodyOf(window).querySelectorAll<HTMLElement>('[data-setting]')].flatMap((el) => el.dataset['setting']!.split(' ')))
    expect(toggleOf(window).querySelector('.more-settings-count')?.textContent).toBe(`${keys.size} réglages`)
    expect(toggleOf(window).textContent).toContain('Plus de réglages')
  })

  it('marks its line when a setting it holds is not at its default, for a screen reader too', async () => {
    const quiet = await open('#tabs')
    expect(toggleOf(quiet).querySelector('.pref-changed')).toBeNull()
    mounted!.unmount()
    const moved = await open('#tabs', { sleepMode: 'freeze', sleepNotify: true })
    expect(toggleOf(moved).querySelector('.pref-changed .sr-only')?.textContent).toBe('2 réglages modifiés')
  })

  it('is not drawn on a page that holds nothing more (Profils)', async () => {
    expect((await open('#profiles')).querySelector('main .more-settings')?.hasAttribute('data-empty')).toBe(true)
    mounted!.unmount()
    expect((await open('#tabs')).querySelector('main .more-settings')?.hasAttribute('data-empty')).toBe(false)
  })

  it('opens by itself when a link leads to a group that waits in it, and the group is lit', async () => {
    const window = await open('#appearance/panelsize')
    await settle()
    expect(bodyOf(window).hidden).toBe(false)
    expect(toggleOf(window).getAttribute('aria-expanded')).toBe('true')
    expect(window.querySelector('#panelsize')?.classList.contains('pref-flash')).toBe(true)
  })

  it('stays closed when a link leads to a group at the top of the page', async () => {
    const window = await open('#navigation/engine')
    await settle()
    expect(bodyOf(window).hidden).toBe(true)
  })

  it('opens by itself when a result of a search leads to a row that waits in it, and the row is lit', async () => {
    const window = await open('#general', {}, 'https')
    const result = [...window.querySelectorAll<HTMLButtonElement>('main .pref-open')].find((button) => button.closest('[data-setting~="httpsUpgrade"]'))!
    expect(result).toBeDefined()
    await click(result)
    await settle()
    expect(window.querySelector('[data-cat="protection"]')?.getAttribute('aria-current')).toBe('page')
    expect(bodyOf(window).hidden).toBe(false)
    expect(window.querySelector('main [data-setting~="httpsUpgrade"]')?.classList.contains('pref-flash')).toBe(true)
  })

  it('keeps each page as it was left while the window stays open: opened on one page, closed on another', async () => {
    const window = await open('#tabs')
    await click(toggleOf(window))
    await goTo(window, 'files')
    expect(window.querySelector('[data-cat="files"]')?.getAttribute('aria-current')).toBe('page')
    expect(bodyOf(window).hidden).toBe(true)
    await goTo(window, 'tabs')
    expect(bodyOf(window).hidden).toBe(false)
  })

  it('ignores the level a state file of an earlier version kept (« Tous les réglages »): the page opens the same, with no level to choose', async () => {
    const window = await open('#tabs', { showAdvancedSettings: true })
    expect(bodyOf(window).hidden).toBe(true)
    expect(window.querySelector('.settings-level')).toBeNull()
    expect(window.textContent).not.toContain('Tous les réglages')
  })
})

describe('the pages that hold nothing more', () => {
  it('are named: « Pour commencer », Profils and « Fonctions en option », drawn whole', async () => {
    const empty: SettingsPage[] = []
    for (const pane of SETTINGS_PAGES) {
      const window = await open(`#${pane}`)
      if (window.querySelector('main .more-settings')?.hasAttribute('data-empty')) empty.push(pane)
      mounted!.unmount()
      mounted = null
    }
    expect(empty).toEqual(['home', 'profiles', 'features'])
  })
})
