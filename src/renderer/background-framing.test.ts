// The frame that chooses the part of a video the sidebar shows (BackgroundFraming.tsx) and the video it frames (BackgroundVideo in Sidebar.tsx), drawn to
// markup. No window: the video's size arrives through the handler of its metadata, read from the element and called inside the render of a probe, where
// the hooks of the component are allowed. The drag itself needs a layout (the frame's box) that markup has not; its arithmetic is tested in
// shared/space-media-position.test.ts.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { SpaceBackground } from '@shared/space-media'

vi.mock('./api', () => ({ api: () => ({ dispatch: () => Promise.resolve() }), useSnapshot: () => null }))

import { BackgroundVideo } from './Sidebar'
import { BackgroundFraming } from './BackgroundFraming'
import { elementsOf, expandedElements, rendersOf, type Element } from './render.test-support'

beforeEach(() => setLanguage('fr'))

describe('the video behind a space, framed', () => {
  const draw = (choice: SpaceBackground) => renderToStaticMarkup(createElement(BackgroundVideo, { src: 'blob:fond', choice, forceReduceMotion: false }))

  it('shows the part the space chose, as the object-position of the video', () => {
    expect(draw({ type: 'video', value: 'v.mp4', position: { x: 20, y: 70 } })).toContain('style="object-position:20% 70%"')
  })

  it('leaves the centre of the stylesheet when it chose none', () => {
    expect(draw({ type: 'video', value: 'v.mp4' })).not.toContain('object-position')
  })
})

describe('the frame over the video', () => {
  const MOVED = { videoWidth: 1920, videoHeight: 1080 }

  /** What the frame draws once the metadata of a video of `size` has come, and the writes a press of `key` asks for (the key is pressed once). */
  const afterMetadata = (position: { x: number; y: number } | undefined, size: { videoWidth: number; videoHeight: number }, key?: string) => {
    const written: Array<[number, number]> = []
    let pressed = false
    const [, drawn] = rendersOf(2, (pass) => {
      const elements = expandedElements(createElement(BackgroundFraming, { src: 'blob:fond', position, onChange: (x: number, y: number) => void written.push([x, y]) }))
      if (pass === 0) {
        const video = elements.find((el: Element) => el.type === 'video')!
        ;(video.props['onLoadedMetadata'] as (event: unknown) => void)({ currentTarget: size })
      } else if (key && !pressed) {
        pressed = true
        const slider = elements.find((el: Element) => el.props['role'] === 'slider')!
        ;(slider.props['onKeyDown'] as (event: unknown) => void)({ key, preventDefault: () => undefined })
      }
      return elements
    })
    return { elements: drawn!, written }
  }
  const slider = (elements: Element[]) => elements.find((el) => el.props['role'] === 'slider')

  it('draws the video alone until its size is known, with no frame to drag', () => {
    const before = elementsOf(createElement(BackgroundFraming, { src: 'blob:fond', position: undefined, onChange: () => undefined }))
    expect(before.some((el) => el.type === 'video')).toBe(true)
    expect(slider(before)).toBeUndefined()
  })

  it('draws a frame the width of the part a wide video shows, at the position of the space', () => {
    const frame = slider(afterMetadata({ x: 100, y: 50 }, MOVED).elements)!
    const style = frame.props['style'] as { width: string; height: string; left: string; top: string }
    // 323 x 720 over 16:9: a quarter of the width, all of the height; at 100 the frame is against the right edge.
    expect(parseFloat(style.width)).toBeCloseTo(25.2, 0)
    expect(style.height).toBe('100%')
    expect(parseFloat(style.left)).toBeCloseTo(100 - parseFloat(style.width), 3)
    expect(frame.props['aria-valuetext']).toBe(t('space-media.cadrage-valeur', { x: 100, y: 50 }))
  })

  it('says the centre when the space has no position', () => {
    expect(slider(afterMetadata(undefined, MOVED).elements)!.props['aria-valuetext']).toBe(t('space-media.cadrage-valeur', { x: 50, y: 50 }))
  })

  it('moves with the arrows, a step each, and writes the position', () => {
    expect(afterMetadata({ x: 40, y: 50 }, MOVED, 'ArrowRight').written).toEqual([[45, 50]])
    expect(afterMetadata({ x: 40, y: 50 }, MOVED, 'ArrowLeft').written).toEqual([[35, 50]])
  })

  it('writes nothing for an arrow that has no room (up and down over a video that is as tall as the sidebar), nor for another key', () => {
    expect(afterMetadata({ x: 40, y: 50 }, MOVED, 'ArrowDown').written).toEqual([])
    expect(afterMetadata({ x: 40, y: 50 }, MOVED, 'Tab').written).toEqual([])
    expect(afterMetadata({ x: 100, y: 50 }, MOVED, 'ArrowRight').written).toEqual([])
  })

  it('draws no frame for a video that has the shape of the sidebar: there is no part to choose', () => {
    expect(elementsOf(createElement(BackgroundFraming, { src: 'blob:fond', position: undefined, onChange: () => undefined })).length).toBeGreaterThan(0)
    const { elements } = afterMetadata(undefined, { videoWidth: 323, videoHeight: 720 })
    expect(elements.some((el) => el.type === 'video' || el.props['role'] === 'slider')).toBe(false)
  })
})
