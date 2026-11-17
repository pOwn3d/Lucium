// What a screen reader hears on a few controls, read on the real components drawn with no window: a name where there was none, a name that
// is a word and not a code, a state said once, and a wait that is not said again at every second.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { frenchSpaces } from '@shared/french-typography'
import type { UiSnapshot } from '@shared/ipc'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { ILLUSTRATIONS } from '@shared/settings-illustrations'
import { swatchName } from '@shared/space-customize'
import { TEXT_COLORS, VEIL_COLORS } from '@shared/space-media'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => holder.snapshot }))

import { AutoReloadPanel } from './AutoReloadPanel'
import { NamedText } from './EngineStatus'
import { LockScreen } from './LockScreen'
import { RevealButton } from './PasswordsPanel'
import { ReadLater } from './ReadLater'
import { SettingIllustration } from './SettingIllustration'
import { SpaceCustomize } from './SpaceCustomize'
import { SpaceMediaPanel } from './SpaceMediaPanel'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const html = (node: ReactElement): string => renderToStaticMarkup(node)

function stateWith(change: (state: SidebarState) => SidebarState = (state) => state): SidebarState {
  const state = change(createInitialState(ctx))
  holder.snapshot = { state, runtime: { tabs: {} }, extensions: [], platform: 'darwin' }
  return state
}

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) })
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  setLanguage('fr')
})

describe('the filter of « Lire plus tard »', () => {
  it('has a name of its own, as the filters of the other lists have: the placeholder alone was a last resort', () => {
    stateWith((state) => ({ ...state, readLater: [{ id: 'r1', url: 'https://exemple.fr/a', title: 'Un article', savedAt: 1 }] }))
    const field = /<input class="field"[^>]*>/.exec(html(createElement(ReadLater)))?.[0]
    expect(field).toBeDefined()
    expect(field).toContain('aria-label="Filtrer la liste"')
  })
})

describe('the wait of the lock screen', () => {
  const screen = (retryInMs: number): string => {
    const state = stateWith()
    const snapshot = { ...(holder.snapshot as object), lock: { active: true, appLocked: true, lockedSpaces: [], guardedSpaces: [], touchId: false, retryInMs } } as unknown as UiSnapshot
    return html(createElement(LockScreen, { snapshot, kind: 'app', space: state.spaces[0]!, systemDark: false }))
  }

  it('is a timer inside the alert: the alert is said when it comes, the seconds that tick are not said again', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const markup = screen(30_000)
    const alert = /<p class="lock-message" role="alert">(.*?)<\/p>/.exec(markup)?.[1]
    expect(alert).toBe(`<span role="timer" aria-live="off"> ${frenchSpaces('Réessayez dans 30 s.')}</span>`)
  })

  it('is not there without a wait', () => {
    expect(screen(0)).not.toContain('lock-message')
  })
})

describe('a button whose text says what a click does', () => {
  it('carries no pressed state beside it (« Masquer, enfoncé »): the password being typed, the scene of a setting, the video of a background', () => {
    for (const shown of [true, false]) {
      const button = RevealButton({ shown, onToggle: () => undefined })
      expect(button.props.children).toBe(shown ? 'Masquer' : 'Afficher')
      expect('aria-pressed' in button.props).toBe(false)
    }
    const scene = html(createElement(SettingIllustration, { illustration: ILLUSTRATIONS[0]!, name: 'Réglage' }))
    // The opening tag, whole: no aria-pressed in it. The pause it shows is the one of media-glyphs.tsx.
    expect(scene).toContain('<button type="button" class="play" aria-label="Mettre l’animation en pause"><svg viewBox="0 0 9 12"')
  })
})

describe('the animated card of a setting', () => {
  it('hides its drawing from a screen reader, words included; the name of the figure, the caption and the pause button stay', () => {
    const scene = html(createElement(SettingIllustration, { illustration: ILLUSTRATIONS[0]!, name: 'Réglage' }))
    expect(scene).toContain('<div class="scene" aria-hidden="true">')
    const said = scene.slice(scene.indexOf('</div><figcaption>'))
    expect(said).toMatch(/^<\/div><figcaption>[^<]+<\/figcaption><button type="button" class="play"/)
    expect(scene).toMatch(/<figure class="illu" data-illu="[^"]+" aria-label="[^"]*Réglage[^"]*">/)
  })
})

describe('the texts of the engine pane', () => {
  it('are named groups: the name of a bare <pre> is not exposed', () => {
    expect(html(createElement(NamedText, { className: 'insight-log', name: 'Journal des erreurs', text: 'a\nb' }))).toBe('<pre class="insight-log" role="group" aria-label="Journal des erreurs">a\nb</pre>')
  })
})

describe('the background of a space', () => {
  it('names its group by its title, and leaves the hidden file input out of reach', () => {
    const state = stateWith()
    const markup = html(createElement(SpaceMediaPanel, { space: state.spaces[0]!, onMediaChange: () => undefined }))
    const id = /^<div class="space-media-panel" role="group" aria-labelledby="([^"]+)">/.exec(markup)?.[1]
    expect(id).toBeDefined()
    expect(markup).toContain(`<div id="${id}" class="media-label">`)
    // A <label for> pointed at an input that is not displayed: it named nothing, and a click on it did nothing.
    expect(markup).not.toContain('<label for=')
    expect(/<input[^>]*type="file"[^>]*>/.exec(markup)?.[0]).toContain('aria-hidden="true"')
  })

  it('says the colours of the veil and of the text by a name in both languages, never by a code spelled out', () => {
    const all = [...new Set([...VEIL_COLORS, ...TEXT_COLORS])]
    const french = all.map(swatchName)
    setLanguage('en')
    const english = all.map(swatchName)
    for (const names of [french, english]) {
      expect(new Set(names).size).toBe(all.length)
      expect(names.filter((name) => name.startsWith('#') || name.includes('space-media.'))).toEqual([])
    }
    expect(french).not.toEqual(english)
    expect(swatchName('#FFFFFF')).toBe('White')
    // A colour that is in neither list keeps its code: something is still said.
    expect(swatchName('#123456')).toBe('#123456')
  })

  it('draws each swatch with that name', () => {
    const state = stateWith((state) => {
      const space = state.spaces[0]!
      return { ...state, spaces: [{ ...space, background: { type: 'image', value: 'a.png', veilColor: VEIL_COLORS[0], textColor: TEXT_COLORS[0] } }] }
    })
    const markup = html(createElement(SpaceCustomize, { spaceId: state.spaces[0]!.id }))
    const names = [...markup.matchAll(/<button type="button" role="radio" aria-checked="(?:true|false)" aria-label="([^"]+)" class="space-veil-swatch/g)].map((match) => match[1])
    expect(names).toEqual([...VEIL_COLORS, ...TEXT_COLORS].map(swatchName))
  })
})

describe('the interval of the automatic reload', () => {
  it('is named by the label one reads beside it (« Toutes les »), not by another word', () => {
    const state = stateWith((state) => reduce(state, { type: 'tab/open', url: 'https://exemple.fr/a', spaceId: state.spaces[0]!.id }, ctx))
    const markup = html(createElement(AutoReloadPanel, { tabId: state.tabs[0]!.id }))
    const id = /<label for="([^"]+)">Toutes les<\/label>/.exec(markup)?.[1]
    expect(id).toBeDefined()
    const field = new RegExp(`<input class="tk-field" id="${id}"[^>]*>`).exec(markup)?.[0]
    expect(field).toBeDefined()
    expect(field).not.toContain('aria-label')
  })
})
