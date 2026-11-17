// A hidden space background is not loaded: the footer's buttons draw no picture, so reading their file (up to ~13 MB of video) was wasted. The video
// behind a space keeps still under reduced motion and at the pause of its space, and stops while nobody looks at it. No window: the decisions are the
// functions of shared/space-media.ts, the components are drawn to markup, and their handlers are read from the elements they return (called inside the
// render of a probe, where their hooks are allowed).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { SidebarState, Space } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { backgroundFileToRead, backgroundVideoOnChoice, backgroundVideoOnView, toggledAlwaysPlay, toggledVideoPause, videoAlwaysPlays, withVeilShape, type SpaceBackground } from '@shared/space-media'
import { builtinBackground } from '@shared/builtin-backgrounds'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, dispatched: [] as unknown[] }))
vi.mock('./api', () => ({ api: () => ({ dispatch: (action: unknown) => (holder.dispatched.push(action), Promise.resolve()) }), useSnapshot: () => holder.snapshot }))

import { BackgroundVideoControls } from './BackgroundVideoControls'
import { BackgroundVideo, Sidebar } from './Sidebar'
import { SpaceCustomize } from './SpaceCustomize'
import { BuiltinBackgroundChoices, SpaceMediaPanel } from './SpaceMediaPanel'
import { ThemeEditor } from './ThemeEditor'

type Element = ReactElement<Record<string, unknown>>

/** Every element a tree draws, the function components called and what they return walked too. */
function expandedElements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(expandedElements)
  if (!isValidElement(node)) return []
  const element = node as Element
  const type = element.type as unknown
  // A memo component is its function under `type`.
  const component = typeof type === 'object' && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for('react.memo') ? (type as { type: unknown }).type : type
  if (typeof component === 'function' && !(component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    return [element, ...expandedElements((component as (props: unknown) => ReactNode)(element.props))]
  }
  return [element, ...expandedElements(element.props['children'] as ReactNode)]
}

/** The elements of `node`, every component in it called inside the render of a probe. */
function elementsOf(node: ReactElement): Element[] {
  let found: Element[] = []
  const Probe = (): null => {
    found = expandedElements(node)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return found
}

const video: SpaceBackground = { type: 'video', value: 'fond.mp4', muted: true, loop: true }
let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** Two spaces, the one on screen with a video behind it, Lucium's « Réduire les animations » as given. */
function twoSpaces(forceReduceMotion = false): { state: SidebarState; space: Space } {
  let state = createInitialState(ctx)
  const first = state.spaces[0]!.id
  state = run(state, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 100 }, { type: 'space/select', id: first }, { type: 'space/update', id: first, patch: { background: video } }, { type: 'settings/update', patch: { forceReduceMotion } })
  return { state, space: state.spaces.find((space) => space.id === first)! }
}

/** The system's « Réduire les animations », as the media query answers it. */
function systemReducesMotion(on: boolean): void {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: on, addEventListener: () => undefined, removeEventListener: () => undefined }), innerWidth: 1200, lucium: {}, requestAnimationFrame: () => 0 })
}

beforeEach(() => {
  systemReducesMotion(false)
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
  holder.dispatched.length = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('the background of a space in the sidebar', () => {
  it('reads its file only when the layer is drawn', () => {
    expect(backgroundFileToRead(video, true)).toBe('fond.mp4')
    expect(backgroundFileToRead(video, false)).toBeNull()
  })

  it('reads the file of a picture, a GIF or a video, never of a colour or of a background that has nothing', () => {
    expect(backgroundFileToRead({ type: 'image', value: 'fond.png' }, true)).toBe('fond.png')
    expect(backgroundFileToRead({ type: 'gif', value: 'fond.gif' }, true)).toBe('fond.gif')
    expect(backgroundFileToRead({ type: 'color', value: '#336699' }, true)).toBeNull()
    expect(backgroundFileToRead({ type: 'image', value: '' }, true)).toBeNull()
    expect(backgroundFileToRead(undefined, true)).toBeNull()
  })

  it('draws the layer of the space on screen, with Lucium’s « Réduire les animations », and not the layers of the footer’s buttons', () => {
    for (const force of [false, true]) {
      const { state, space } = twoSpaces(force)
      const snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false } as unknown as UiSnapshot
      holder.snapshot = snapshot
      // The layers are the elements of the sidebar's own SpaceBackgroundLayer (not exported: known by its name).
      const layers = elementsOf(createElement(Sidebar, { snapshot, space })).filter((element) => (element.type as { name?: string }).name === 'SpaceBackgroundLayer')
      const drawn = layers.filter((layer) => layer.props['enabled'] !== false)
      expect(drawn.map((layer) => [layer.props['className'], layer.props['forceReduceMotion']])).toEqual([['sidebar-background', force]])
      // One button a space in the footer, its layer not drawn: its file is not read.
      const footer = layers.filter((layer) => layer.props['enabled'] === false)
      expect(footer).toHaveLength(2)
      for (const layer of footer) expect(backgroundFileToRead((layer.props['space'] as Space).background, layer.props['enabled'] as boolean)).toBeNull()
    }
  })
})

describe('the video behind a space', () => {
  const autoplays = (choice: SpaceBackground, forceReduceMotion = false, saving?: boolean): boolean => /<video[^>]*autoPlay=""/.test(renderToStaticMarkup(createElement(BackgroundVideo, { src: 'blob:fond', choice, forceReduceMotion, ...(saving === undefined ? {} : { saving }) })))

  it('starts by itself when nothing asks for less motion', () => {
    expect(autoplays(video)).toBe(true)
  })

  it('does not start by itself under reduced motion, the system’s or Lucium’s, unless the user played it', () => {
    expect(autoplays(video, true)).toBe(false)
    systemReducesMotion(true)
    expect(autoplays(video)).toBe(false)
    expect(autoplays({ ...video, paused: false })).toBe(true)
  })

  it('does not start at the pause of its space', () => {
    expect(autoplays({ ...video, paused: true })).toBe(false)
  })

  it('does not start by itself while the battery saver is on', () => {
    expect(autoplays(video, false, true)).toBe(false)
    expect(autoplays(video, false, false)).toBe(true)
  })

  it('is held still at the pause of its space, and played again at once after « Lire » unless the window is hidden', () => {
    expect(backgroundVideoOnChoice(true, { hidden: false, videoPaused: false })).toBe('pause')
    expect(backgroundVideoOnChoice(false, { hidden: false, videoPaused: true })).toBe('play')
    expect(backgroundVideoOnChoice(false, { hidden: true, videoPaused: true })).toBe('keep')
    expect(backgroundVideoOnChoice(false, { hidden: false, videoPaused: false })).toBe('keep')
  })

  it('is not played again by « Lire » while the battery saver is on, but still held still at the pause of its space', () => {
    expect(backgroundVideoOnChoice(false, { hidden: false, videoPaused: true, saving: true })).toBe('keep')
    expect(backgroundVideoOnChoice(true, { hidden: false, videoPaused: false, saving: true })).toBe('pause')
    expect(backgroundVideoOnChoice(false, { hidden: false, videoPaused: true, saving: false })).toBe('play')
  })

  it('pauses while the window is hidden or has lost the focus, and resumes when it is shown again, unless its space holds it still', () => {
    expect(backgroundVideoOnView({ hidden: true, focused: true }, false)).toBe('pause')
    expect(backgroundVideoOnView({ hidden: false, focused: false }, false)).toBe('pause')
    expect(backgroundVideoOnView({ hidden: false, focused: true }, false)).toBe('play')
    expect(backgroundVideoOnView({ hidden: false, focused: true }, true)).toBe('keep')
  })
})

describe('the video behind a space while the battery saver is on', () => {
  // The mode holds the video still, whatever the space says (« Toujours lire » included), and it plays again when the mode ends, unless its space holds
  // it still: the pause of the space is the user's, the mode's is not.
  it('pauses, even in front and even for a space that keeps it playing behind other windows', () => {
    expect(backgroundVideoOnView({ hidden: false, focused: true, saving: true }, false)).toBe('pause')
    expect(backgroundVideoOnView({ hidden: false, focused: true, saving: true }, false, true)).toBe('pause')
    expect(backgroundVideoOnView({ hidden: false, focused: false, saving: true }, false, true)).toBe('pause')
  })

  it('plays again when the mode ends, unless its space holds it still', () => {
    expect(backgroundVideoOnView({ hidden: false, focused: true, saving: false }, false)).toBe('play')
    expect(backgroundVideoOnView({ hidden: false, focused: true }, false, true)).toBe('play')
    expect(backgroundVideoOnView({ hidden: false, focused: true, saving: false }, true)).toBe('keep')
  })

  it('is told by the snapshot of the window to the layer of the video and to its controls', () => {
    const layersOf = (batterySaverOn: true | undefined) => {
      const { state, space } = twoSpaces()
      const snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false, ...(batterySaverOn ? { batterySaverOn } : {}) } as unknown as UiSnapshot
      holder.snapshot = snapshot
      const elements = elementsOf(createElement(Sidebar, { snapshot, space }))
      const drawn = elements.filter((element) => (element.type as { name?: string }).name === 'SpaceBackgroundLayer' && element.props['enabled'] !== false)
      const controls = elements.filter((element) => element.type === BackgroundVideoControls)
      return { layer: drawn.map((layer) => layer.props['saving']), controls: controls.map((control) => control.props['saving']) }
    }
    expect(layersOf(true)).toEqual({ layer: [true], controls: [true] })
    expect(layersOf(undefined)).toEqual({ layer: [false], controls: [false] })
  })

  // The effects of BackgroundVideo do not run in a markup render, and the project has no DOM to run them in: the lines that carry the mode into the
  // decision are read from the source. Without them the video would go on playing, or would not play again when the mode ends.
  it('is carried by the layer to the video, into the decision of its effect, and is a dependency of that effect', () => {
    const source = readFileSync(join(__dirname, 'Sidebar.tsx'), 'utf8')
    expect(source).toContain('<BackgroundVideo src={src} choice={background} forceReduceMotion={forceReduceMotion} saving={saving} />')
    expect(source).toContain('backgroundVideoOnView({ hidden: document.hidden, focused: windowFocused, saving }, paused, playUnfocused)')
    expect(source).toContain('}, [paused, playUnfocused, windowFocused, saving])')
    expect(source).toContain('backgroundVideoOnChoice(paused, { hidden: document.hidden, videoPaused: element.paused, saving })')
  })
})

describe('a video that keeps playing behind another window (« Toujours lire »)', () => {
  // The user's choice: the background goes on while another window is in front, as long as Lucium's window can be seen. A window hidden (minimised,
  // covered whole) still stops it: nobody sees it then, and its decoding would cost for nothing.
  it('goes on when the window loses the focus, if its space says so, and still stops while the window is hidden', () => {
    expect(backgroundVideoOnView({ hidden: false, focused: false }, false, true)).toBe('play')
    expect(backgroundVideoOnView({ hidden: true, focused: false }, false, true)).toBe('pause')
    // Its space holds it still: the pause wins.
    expect(backgroundVideoOnView({ hidden: false, focused: false }, true, true)).toBe('keep')
  })

  it('is turned on by one click that also plays a paused video, and off by another, the rest of the background kept', () => {
    const video: SpaceBackground = { type: 'video', value: 'v.mp4', paused: true, veil: 30 }
    const on = toggledAlwaysPlay(video, false)
    expect(on).toEqual({ ...video, paused: false, playUnfocused: true })
    expect(videoAlwaysPlays(on, false)).toBe(true)
    expect(toggledAlwaysPlay(on, false)).toEqual({ ...video, paused: false })
    // Under less motion a video without a choice is still: the click plays it too.
    expect(toggledAlwaysPlay({ type: 'video', value: 'v.mp4' }, true)).toEqual({ type: 'video', value: 'v.mp4', paused: false, playUnfocused: true })
  })

  it('does not count as playing all the time while the video is paused', () => {
    expect(videoAlwaysPlays({ paused: true, playUnfocused: true }, false)).toBe(false)
    expect(videoAlwaysPlays({ playUnfocused: true }, true)).toBe(false)
  })
})

describe('the Pause / Lire control of a video background', () => {
  const control = (elements: Element[]): Element | undefined => elements.find((element) => element.type === 'button' && element.props['className'] === 'media-button' && [t('space-customize.fond-video-pause'), t('space-customize.fond-video-lire')].includes(element.props['children'] as string))

  it('says what a click does, and writes the background with the opposite of what is shown', () => {
    const changed: SpaceBackground[] = []
    const { space } = twoSpaces()
    const playing = renderToStaticMarkup(createElement(SpaceMediaPanel, { space, onMediaChange: () => undefined, onBackgroundChange: (b) => void changed.push(b) }))
    // The text of the button is its state: a pressed state beside it was read « Lire, enfoncé » by a screen reader.
    expect(playing).toContain(`<button type="button" class="media-button">${t('space-customize.fond-video-pause')}</button>`)
    const still = { ...space, background: { ...video, paused: true } }
    expect(renderToStaticMarkup(createElement(SpaceMediaPanel, { space: still, onMediaChange: () => undefined, onBackgroundChange: () => undefined }))).toContain(`<button type="button" class="media-button">${t('space-customize.fond-video-lire')}</button>`)
    ;(control(elementsOf(createElement(SpaceMediaPanel, { space, onMediaChange: () => undefined, onBackgroundChange: (b) => void changed.push(b) })))!.props['onClick'] as () => void)()
    expect(changed).toEqual([toggledVideoPause(video, false)])
  })

  it('is not there without a way to write the background, or for a background that is not a video', () => {
    const { space } = twoSpaces()
    expect(control(elementsOf(createElement(SpaceMediaPanel, { space, onMediaChange: () => undefined })))).toBeUndefined()
    expect(control(elementsOf(createElement(SpaceMediaPanel, { space: { ...space, background: { type: 'image', value: 'fond.png' } }, onMediaChange: () => undefined, onBackgroundChange: () => undefined })))).toBeUndefined()
  })

  it('is in the panel that chooses the media, for the customization of the space and the theme editor alike, and saves the background of the space', () => {
    const { state, space } = twoSpaces(true)
    holder.snapshot = { state, extensions: [], downloads: [], runtime: { tabs: {} } }
    const paused = { ...video, paused: true }
    for (const node of [createElement(SpaceCustomize, { spaceId: space.id }), createElement(ThemeEditor, { spaceId: space.id })]) {
      holder.dispatched.length = 0
      const panel = elementsOf(node).find((element) => element.type === SpaceMediaPanel)
      expect(panel?.props['forceReduceMotion']).toBe(true)
      ;(panel?.props['onBackgroundChange'] as (background: SpaceBackground) => void)(paused)
      expect(holder.dispatched).toEqual([{ type: 'space/update', id: space.id, patch: { background: paused } }])
    }
  })
})

describe('the videos Lucium comes with, in the panel that chooses the media', () => {
  it('are all offered by name, the one the space has pressed', () => {
    const { space } = twoSpaces()
    const markup = renderToStaticMarkup(createElement(SpaceMediaPanel, { space: { ...space, background: { type: 'video', value: 'lucium-village.mp4' } }, onMediaChange: () => undefined }))
    expect(markup).toContain(`aria-labelledby="media-builtins-title"`)
    expect(markup.match(/class="media-builtin"/g)).toHaveLength(9)
    expect(markup).toContain(`aria-pressed="true" aria-label="${t('space-media.village-enneige')}"`)
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1)
  })

  it('become the background of the space at a click, as a video that loops without sound, in the customization of the space and the theme editor alike', () => {
    const { state, space } = twoSpaces(true)
    holder.snapshot = { state, extensions: [], downloads: [], runtime: { tabs: {} } }
    for (const node of [createElement(SpaceCustomize, { spaceId: space.id }), createElement(ThemeEditor, { spaceId: space.id })]) {
      holder.dispatched.length = 0
      const choices = elementsOf(node).find((element) => element.type === BuiltinBackgroundChoices)
      ;(choices?.props['onChoose'] as (filename: string) => void)('lucium-aurores-boreales.mp4')
      expect(holder.dispatched).toEqual([{ type: 'space/update', id: space.id, patch: { background: expect.objectContaining({ type: 'video', value: 'lucium-aurores-boreales.mp4', muted: true, loop: true }) } }])
    }
  })

  it('come with their look in the same update: the dark veil on the text side, white text with its shadow, a veil as strong as the video needs', () => {
    const { state, space } = twoSpaces()
    // The space has a look of its own already: the look of the video replaces it, and what the video has not (a tone) does not come back.
    const toned = run(state, { type: 'space/update', id: space.id, patch: { background: { ...video, tone: 'dark', veilColor: '#f4f4f6', veil: 20 } } })
    holder.snapshot = { state: toned, extensions: [], downloads: [], runtime: { tabs: {} } }
    for (const node of [createElement(SpaceCustomize, { spaceId: space.id }), createElement(ThemeEditor, { spaceId: space.id })]) {
      holder.dispatched.length = 0
      const choices = elementsOf(node).find((element) => element.type === BuiltinBackgroundChoices)
      ;(choices?.props['onChoose'] as (filename: string) => void)('lucium-temple-brume.mp4')
      expect(holder.dispatched).toEqual([{ type: 'space/update', id: space.id, patch: { background: { type: 'video', value: 'lucium-temple-brume.mp4', muted: true, loop: true, veilColor: '#0b0c12', veilShape: 'text', veil: 60, textColor: '#ffffff', textHalo: true } } }])
      expect(holder.dispatched).toEqual([{ type: 'space/update', id: space.id, patch: { background: builtinBackground('lucium-temple-brume.mp4') } }])
    }
  })

  it('give a file of the user the look measured from it, or keep the look set by hand of the one it replaces, in the customization of the space and the theme editor alike', () => {
    const { state, space } = twoSpaces()
    const upload = { filename: '1730000000000-0a1b2c3d.mp4', mimeType: 'video/mp4' }
    const plain = { type: 'video', value: upload.filename, muted: true, loop: true }
    const look = { veilColor: '#0b0c12', veil: 55, veilShape: 'text', textColor: '#ffffff', textHalo: true, veilAuto: true } as const
    // A tone chosen by hand stays, and nothing was measured; a background never set by hand takes the measured look.
    const cases: Array<[SpaceBackground, { filename: string; mimeType: string; look?: typeof look }, object]> = [
      [{ ...video, tone: 'dark' }, upload, { ...plain, tone: 'dark' }],
      [video, { ...upload, look }, { ...plain, ...look }]
    ]
    for (const [before, media, background] of cases) {
      holder.snapshot = { state: run(state, { type: 'space/update', id: space.id, patch: { background: before } }), extensions: [], downloads: [], runtime: { tabs: {} } }
      for (const node of [createElement(SpaceCustomize, { spaceId: space.id }), createElement(ThemeEditor, { spaceId: space.id })]) {
        holder.dispatched.length = 0
        const panel = elementsOf(node).find((element) => element.type === SpaceMediaPanel)
        ;(panel?.props['onMediaChange'] as (given: typeof media) => void)(media)
        expect(holder.dispatched).toEqual([{ type: 'space/update', id: space.id, patch: { background } }])
      }
    }
  })
})

describe('the shape of the veil (« Forme du voile »)', () => {
  const sidebarWith = (background: SpaceBackground): string => {
    const { state, space } = twoSpaces()
    const veiled = run(state, { type: 'space/update', id: space.id, patch: { background } })
    const snapshot = { state: veiled, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false } as unknown as UiSnapshot
    holder.snapshot = snapshot
    return renderToStaticMarkup(createElement(Sidebar, { snapshot, space: veiled.spaces.find((entry) => entry.id === space.id)! }))
  }

  it('draws the veil on the text side only when the space chose that shape and a veil colour', () => {
    expect(sidebarWith({ ...video, veilColor: '#0b0c12', veilShape: 'text' })).toMatch(/class="sidebar-background video veil veil-text text-light"/)
    expect(sidebarWith({ ...video, veilColor: '#0b0c12' })).not.toContain('veil-text')
    expect(sidebarWith({ ...video, veilShape: 'text' })).not.toContain('veil-text')
  })

  it('raises a veil too weak for its gradient to show under the text, and leaves a strong one or the default as it is', () => {
    expect(withVeilShape({ ...video, veilColor: '#0b0c12', veil: 10 }, 'text')).toEqual({ ...video, veilColor: '#0b0c12', veil: 60, veilShape: 'text' })
    expect(withVeilShape({ ...video, veilColor: '#0b0c12', veil: 80 }, 'text')).toMatchObject({ veil: 80, veilShape: 'text' })
    expect(withVeilShape({ ...video, veilColor: '#0b0c12' }, 'text')).not.toHaveProperty('veil')
    expect(withVeilShape({ ...video, veilColor: '#0b0c12', veil: 60, veilShape: 'text' }, 'even')).toEqual({ ...video, veilColor: '#0b0c12', veil: 60 })
  })

  it('brings the darkest veil at 60 when the text side is chosen with no veil colour, whatever strength was left over', () => {
    expect(withVeilShape(video, 'text')).toEqual({ ...video, veilColor: '#0b0c12', veil: 60, veilShape: 'text' })
    expect(withVeilShape({ ...video, veil: 10 }, 'text')).toEqual({ ...video, veilColor: '#0b0c12', veil: 60, veilShape: 'text' })
    expect(withVeilShape({ ...video, veil: 90 }, 'text')).toEqual({ ...video, veilColor: '#0b0c12', veil: 60, veilShape: 'text' })
    // The rest of the background is kept, and the even shape adds no veil.
    expect(withVeilShape({ ...video, textColor: '#ffffff', textHalo: true }, 'text')).toMatchObject({ textColor: '#ffffff', textHalo: true })
    expect(withVeilShape(video, 'even')).toEqual(video)
  })

  it('is chosen in the customization of the space, once it has a veil colour', () => {
    const { state, space } = twoSpaces()
    const veiled = run(state, { type: 'space/update', id: space.id, patch: { background: { ...video, veilColor: '#0b0c12', veil: 10 } } })
    holder.snapshot = { state: veiled, extensions: [], downloads: [], runtime: { tabs: {} } }
    holder.dispatched.length = 0
    const textSide = elementsOf(createElement(SpaceCustomize, { spaceId: space.id })).find((element) => element.type === 'button' && element.props['children'] === t('space-media.voile-cote-texte'))
    expect(textSide?.props['aria-checked']).toBe(false)
    ;(textSide!.props['onClick'] as () => void)()
    expect(holder.dispatched).toEqual([{ type: 'space/update', id: space.id, patch: { background: { ...video, veilColor: '#0b0c12', veil: 60, veilShape: 'text' } } }])
  })

  it('is offered for every picture, GIF and video, even with no veil colour, and gives them the darkest veil on the text side', () => {
    for (const background of [video, { type: 'image', value: 'fond.png' }, { type: 'gif', value: 'fond.gif', loop: true }] as const) {
      const { state, space } = twoSpaces()
      const plain = run(state, { type: 'space/update', id: space.id, patch: { background } })
      holder.snapshot = { state: plain, extensions: [], downloads: [], runtime: { tabs: {} } }
      holder.dispatched.length = 0
      const textSide = elementsOf(createElement(SpaceCustomize, { spaceId: space.id })).find((element) => element.type === 'button' && element.props['children'] === t('space-media.voile-cote-texte'))
      expect(textSide, background.type).toBeDefined()
      ;(textSide!.props['onClick'] as () => void)()
      expect(holder.dispatched, background.type).toEqual([{ type: 'space/update', id: space.id, patch: { background: { ...background, veilColor: '#0b0c12', veil: 60, veilShape: 'text' } } }])
    }
  })

  it('is not offered for a colour, which has no veil', () => {
    const { state, space } = twoSpaces()
    const colour = run(state, { type: 'space/update', id: space.id, patch: { background: { type: 'color', value: '#336699' } } })
    holder.snapshot = { state: colour, extensions: [], downloads: [], runtime: { tabs: {} } }
    expect(renderToStaticMarkup(createElement(SpaceCustomize, { spaceId: space.id }))).not.toContain(t('space-media.forme-du-voile'))
  })
})

describe('the Fond panel of the customization of the space', () => {
  const panelOf = (background: SpaceBackground): string => {
    const { state, space } = twoSpaces()
    holder.snapshot = { state: run(state, { type: 'space/update', id: space.id, patch: { background } }), extensions: [], downloads: [], runtime: { tabs: {} } }
    return renderToStaticMarkup(createElement(SpaceCustomize, { spaceId: space.id }))
  }
  /** Where each group of the panel begins in the markup, by the name its radio group carries. */
  const at = (markup: string, label: string): number => markup.indexOf(`role="radiogroup" aria-label="${label}"`)

  it('puts the veil first (its colour, its strength, its shape), then the text (its tone, its exact colour)', () => {
    const markup = panelOf({ ...video, veilColor: '#0b0c12', veil: 60 })
    const strength = markup.indexOf(`aria-label="${t('space-media.veil-label', { percent: 60 })}"`)
    const order = [at(markup, t('space-media.voile')), strength, at(markup, t('space-media.forme-du-voile')), at(markup, t('space-media.text-color')), at(markup, t('space-media.text-palette'))]
    expect(order.every((index) => index >= 0), String(order)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // The shadow of the text goes with the exact colour of the text, after it.
    expect(markup.indexOf(t('space-media.text-halo'))).toBeGreaterThan(order[4]!)
  })

  it('calls the veil « Voile », with « Aucun » to take it away, and keeps « Automatique » for the text', () => {
    const markup = panelOf({ ...video, veilColor: '#0b0c12' })
    const veil = markup.slice(at(markup, t('space-media.voile')), at(markup, t('space-media.forme-du-voile')))
    expect(veil).toContain(`>${t('space-media.aucun')}</button>`)
    expect(veil).not.toContain(t('space-media.veil-none'))
    expect(veil).toContain('<span>Voile</span>')
    expect(t('space-media.voile')).toBe('Voile')
    expect(t('space-media.aucun')).toBe('Aucun')
    const text = markup.slice(at(markup, t('space-media.text-palette')))
    expect(text).toContain(`>${t('space-media.veil-none')}</button>`)
    expect(t('space-media.veil-none')).toBe('Automatique')
    setLanguage('en')
    expect([t('space-media.voile'), t('space-media.aucun'), t('space-media.veil-none')]).toEqual(['Veil', 'None', 'Automatic'])
  })

  it('shows the strength of the veil only once there is a veil colour, and its shape always', () => {
    const without = panelOf(video)
    expect(without).not.toContain('type="range"')
    expect(at(without, t('space-media.forme-du-voile'))).toBeGreaterThan(-1)
    expect(panelOf({ ...video, veilColor: '#0b0c12' })).toContain('type="range"')
  })

  it('takes the veil away with « Aucun », and the tone that went with it, and keeps the rest of the background', () => {
    const { state, space } = twoSpaces()
    const veiled = run(state, { type: 'space/update', id: space.id, patch: { background: { ...video, veilColor: '#0b0c12', veil: 60, veilShape: 'text', tone: 'light' } } })
    holder.snapshot = { state: veiled, extensions: [], downloads: [], runtime: { tabs: {} } }
    holder.dispatched.length = 0
    const none = elementsOf(createElement(SpaceCustomize, { spaceId: space.id })).find((element) => element.type === 'button' && element.props['children'] === t('space-media.aucun'))
    ;(none!.props['onClick'] as () => void)()
    expect(holder.dispatched).toEqual([{ type: 'space/update', id: space.id, patch: { background: { ...video, veil: 60, veilShape: 'text' } } }])
  })
})
