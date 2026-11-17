// A space background read from a state file: only a colour or a media name of ours is kept.
import { describe, expect, it } from 'vitest'
import { VEIL_COLORS, cleanSpaceBackground, toggledVideoPause, videoBackgroundPaused, type SpaceBackground } from './space-media'
import { createInitialState, parseSavedState, persistableState, reduce, type Ctx } from './sidebar'

describe('the background of a space read from the state', () => {
  it('keeps a colour written as #rrggbb, lower case', () => {
    expect(cleanSpaceBackground({ type: 'color', value: '#AABBCC' })).toEqual({ type: 'color', value: '#aabbcc' })
  })

  it('refuses a colour that is not #rrggbb', () => {
    expect(cleanSpaceBackground({ type: 'color', value: 'url(http://evil.example/x.png)' })).toBeUndefined()
    expect(cleanSpaceBackground({ type: 'color', value: 'red; background: url(x)' })).toBeUndefined()
  })

  it('refuses a media name that is not a file of ours (no path, no other file)', () => {
    expect(cleanSpaceBackground({ type: 'image', value: '../../secret.png' })).toBeUndefined()
    expect(cleanSpaceBackground({ type: 'image', value: '/etc/passwd' })).toBeUndefined()
    expect(cleanSpaceBackground({ type: 'video', value: 'notes.txt' })).toBeUndefined()
  })
})

describe('the choice to keep a background video playing behind another window', () => {
  it('is read back only as true, and only for a video', () => {
    expect(cleanSpaceBackground({ type: 'video', value: 'v.mp4', playUnfocused: true })).toEqual({ type: 'video', value: 'v.mp4', playUnfocused: true })
    expect(cleanSpaceBackground({ type: 'video', value: 'v.mp4', playUnfocused: 'yes' })).toEqual({ type: 'video', value: 'v.mp4' })
    expect(cleanSpaceBackground({ type: 'image', value: 'p.png', playUnfocused: true })).toEqual({ type: 'image', value: 'p.png' })
  })
})

describe('the pause of a video background (WCAG 2.2.2)', () => {
  const video: SpaceBackground = { type: 'video', value: 'fond.webm', muted: true, loop: true }

  it('plays by default, and is still by default when motion is reduced', () => {
    expect(videoBackgroundPaused(video, false)).toBe(false)
    expect(videoBackgroundPaused(video, true)).toBe(true)
  })

  it('follows the choice of the space before the wish for less motion: a pause holds, a « Lire » plays', () => {
    expect(videoBackgroundPaused({ ...video, paused: true }, false)).toBe(true)
    expect(videoBackgroundPaused({ ...video, paused: false }, true)).toBe(false)
  })

  it('turns a click on the control into the opposite of what is shown, written as the choice of the space', () => {
    expect(toggledVideoPause(video, false)).toEqual({ ...video, paused: true })
    // Under reduced motion the video is still: the click plays it.
    expect(toggledVideoPause(video, true)).toEqual({ ...video, paused: false })
    expect(toggledVideoPause({ ...video, paused: true }, true)).toEqual({ ...video, paused: false })
  })

  it('remembers the pause for its space only, through a save and a reload', () => {
    let n = 0
    const ctx = (): Ctx => ({ now: 1, newId: () => `id-${++n}` })
    let state = createInitialState(ctx())
    state = reduce(state, { type: 'space/create', name: 'Deux', emoji: '2', hue: 200 }, ctx())
    const [first, second] = state.spaces
    state = reduce(state, { type: 'space/update', id: first!.id, patch: { background: toggledVideoPause(video, false) } }, ctx())
    state = reduce(state, { type: 'space/update', id: second!.id, patch: { background: video } }, ctx())
    const loaded = parseSavedState(JSON.stringify(persistableState(state)))
    const of = (id: string) => loaded.spaces.find((space) => space.id === id)!.background
    expect(of(first!.id)).toEqual({ ...video, paused: true })
    expect(videoBackgroundPaused(of(first!.id), false)).toBe(true)
    expect(of(second!.id)).toEqual(video)
    expect(videoBackgroundPaused(of(second!.id), false)).toBe(false)
    // An explicit « Lire » under reduced motion is a choice too, kept as such.
    expect(cleanSpaceBackground({ ...video, paused: false })).toEqual({ ...video, paused: false })
  })
})

describe('the shape of the veil', () => {
  it('is read back only as the text side, for a media background', () => {
    expect(cleanSpaceBackground({ type: 'video', value: 'v.mp4', veilShape: 'text' })).toEqual({ type: 'video', value: 'v.mp4', veilShape: 'text' })
    expect(cleanSpaceBackground({ type: 'video', value: 'v.mp4', veilShape: 'diagonal' })).toEqual({ type: 'video', value: 'v.mp4' })
    expect(cleanSpaceBackground({ type: 'color', value: '#112233', veilShape: 'text' })).toEqual({ type: 'color', value: '#112233' })
  })

  it('has the darkest veil of the picker first: it is the veil the text side brings when no colour was chosen', () => {
    const luminance = (hex: string): number => [0, 2, 4].reduce((sum, i, k) => sum + parseInt(hex.slice(1 + i, 3 + i), 16) * [0.2126, 0.7152, 0.0722][k]!, 0)
    expect(VEIL_COLORS.every((hex) => luminance(hex) >= luminance(VEIL_COLORS[0]))).toBe(true)
  })
})
