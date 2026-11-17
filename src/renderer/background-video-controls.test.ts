// The controls of a video behind the space (BackgroundVideoControls.tsx), drawn to markup: they show only for a video, say what a click does, and write
// the space's background with Pause / Lire or with « Toujours lire ».

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { SpaceBackground } from '@shared/space-media'
import { elementsOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ asked: [] as unknown[] }))
vi.mock('./api', () => ({ api: () => ({ dispatch: (action: unknown) => void holder.asked.push(action) }) }))

import { BackgroundVideoControls } from './BackgroundVideoControls'
import { frenchSpaces } from '@shared/french-typography'

beforeEach(() => {
  setLanguage('fr')
  holder.asked = []
})

const video: SpaceBackground = { type: 'video', value: 'v.mp4' }
const draw = (background: SpaceBackground | undefined, reduceMotion = false, saving?: boolean) => {
  const tree = createElement(BackgroundVideoControls, { space: { id: 's1', background }, reduceMotion, ...(saving === undefined ? {} : { saving }) })
  return { markup: renderToStaticMarkup(tree), buttons: elementsOf(tree).filter((el: Element) => el.type === 'button') }
}

describe('the controls of a video behind the space', () => {
  it('show only for a video', () => {
    expect(draw(undefined).markup).toBe('')
    expect(draw({ type: 'image', value: 'p.png' }).markup).toBe('')
    expect(draw({ type: 'color', value: '#112233' }).markup).toBe('')
    expect(draw(video).markup).toContain('aria-label="Vidéo de fond"')
  })

  it('pause a video that plays, and play one that is paused, by its space', () => {
    ;(draw(video).buttons[0]!.props['onClick'] as () => void)()
    expect(holder.asked).toEqual([{ type: 'space/update', id: 's1', patch: { background: { ...video, paused: true } } }])
    expect(draw({ ...video, paused: true }).markup).toContain('aria-label="Lire la vidéo de fond"')
  })

  it('play the video all the time at a click on « Toujours lire », and say so', () => {
    const { markup, buttons } = draw(video)
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).toContain('aria-label="Toujours lire la vidéo de fond"')
    ;(buttons[1]!.props['onClick'] as () => void)()
    expect(holder.asked).toEqual([{ type: 'space/update', id: 's1', patch: { background: { ...video, paused: false, playUnfocused: true } } }])
    expect(draw({ ...video, playUnfocused: true }).markup).toContain('aria-pressed="true"')
  })

  it('play a paused video at a click on « Toujours lire », for good: one click, and it turns all the time', () => {
    for (const [background, reduceMotion] of [[{ ...video, paused: true }, false], [video, true]] as const) {
      holder.asked = []
      const { markup, buttons } = draw(background, reduceMotion)
      // Paused, it does not turn all the time, whatever its space said before.
      expect(markup).toContain('aria-pressed="false"')
      expect(buttons[1]!.props['disabled']).toBeUndefined()
      ;(buttons[1]!.props['onClick'] as () => void)()
      expect(holder.asked).toEqual([{ type: 'space/update', id: 's1', patch: { background: { ...video, paused: false, playUnfocused: true } } }])
    }
  })

  it('let the video stop again behind other windows at a second click', () => {
    ;(draw({ ...video, paused: false, playUnfocused: true }).buttons[1]!.props['onClick'] as () => void)()
    expect(holder.asked).toEqual([{ type: 'space/update', id: 's1', patch: { background: { ...video, paused: false } } }])
  })
})

describe('the controls of a video held still by the battery saver', () => {
  const tipOfAlways = (markup: string): string => /aria-label="Toujours lire la vidéo de fond"[^>]*data-tip="([^"]*)"/.exec(markup)?.[1] ?? ''
  const saverTip = 'En pause tant que le mode économie de batterie est activé'

  it('say so on the « Toujours lire » button, whether or not the space asked to play all the time', () => {
    for (const background of [video, { ...video, playUnfocused: true }]) expect(tipOfAlways(draw(background, false, true).markup)).toBe(saverTip)
  })

  it('say what they always said while the mode is off', () => {
    expect(tipOfAlways(draw(video, false, false).markup)).toContain('La vidéo s’arrête quand Lucium n’est pas au premier plan')
    expect(tipOfAlways(draw({ ...video, playUnfocused: true }, false, false).markup)).toContain(frenchSpaces('Toujours lire : la vidéo tourne'))
    expect(tipOfAlways(draw(video).markup)).toContain('La vidéo s’arrête quand Lucium')
  })

  it('do not blame the mode for a video the space holds still: the pause is the space’s, the mode changes nothing', () => {
    expect(tipOfAlways(draw({ ...video, paused: true }, false, true).markup)).not.toContain('économie de batterie')
    // Under less motion a video with no choice is still too.
    expect(tipOfAlways(draw(video, true, true).markup)).not.toContain('économie de batterie')
  })

  it('leave the Pause / Lire button and its click as they are', () => {
    const { markup, buttons } = draw(video, false, true)
    expect(markup).toContain('aria-label="Mettre en pause la vidéo de fond"')
    ;(buttons[0]!.props['onClick'] as () => void)()
    expect(holder.asked).toEqual([{ type: 'space/update', id: 's1', patch: { background: { ...video, paused: true } } }])
  })

  it('say it in English too', () => {
    setLanguage('en')
    const markup = draw(video, false, true).markup
    expect(/aria-label="Always play the background video"[^>]*data-tip="([^"]*)"/.exec(markup)?.[1]).toBe('Paused while the battery saver is on')
  })
})
