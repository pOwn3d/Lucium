// @vitest-environment happy-dom
// The preview of a space's background in its panel (SpaceMediaPanel.tsx), mounted in a document: the file is read from the main process, and a
// space whose background changes twice in a row has two readings under way. Only the reading of the file the space has now may draw the preview.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { Space } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import type { SpaceBackgroundMediaReply } from '@shared/space-background-media'
import { mount, type Mounted } from './dom.test-support'
import { SpaceMediaPanel } from './SpaceMediaPanel'

interface Reading {
  filename: string
  answer(reply: SpaceBackgroundMediaReply): Promise<void>
  fail(error: Error): Promise<void>
}

const readings: Reading[] = []
let mounted: Mounted | null = null

const base = createInitialState({ now: 1, newId: () => 'id' }).spaces[0]!
const spaceWith = (file: string | null): Space => ({ ...base, background: file === null ? undefined : { type: 'image', value: file } }) as Space
const panel = (file: string | null) => createElement(SpaceMediaPanel, { space: spaceWith(file), onMediaChange: () => undefined })
const picture = (mimeType: string): SpaceBackgroundMediaReply => ({ ok: true, data: new Uint8Array([1, 2, 3]), mimeType }) as SpaceBackgroundMediaReply
const reading = (filename: string): Reading => readings.find((each) => each.filename === filename)!
const preview = (): string | null => mounted!.container.querySelector('.media-preview img')?.getAttribute('src') ?? null
const alert = (): string | null => mounted!.container.querySelector('.media-error')?.textContent ?? null
const builtinsBusy = (): boolean => mounted!.container.querySelector<HTMLButtonElement>('.media-builtin')!.disabled

beforeEach(() => {
  setLanguage('fr')
  readings.length = 0
  // The address of a preview says the type of the bytes it was made of, so that a test can tell which reading drew it.
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:${(blob as Blob).type}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  ;(window as unknown as { lucium: unknown }).lucium = {
    spaceBackgroundMedia: (request: { op: string; filename: string }) => {
      // The small pictures of the videos Lucium comes with: none here.
      if (!request.filename.startsWith('fond-')) return Promise.resolve({ ok: false, message: 'absent' })
      return new Promise<SpaceBackgroundMediaReply>((resolve, reject) => {
        readings.push({
          filename: request.filename,
          answer: (reply) => act(async () => resolve(reply)),
          fail: (error) => act(async () => reject(error))
        })
      })
    }
  }
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
  delete (window as unknown as { lucium?: unknown }).lucium
})

describe('the preview of the background of a space', () => {
  it('shows the file of the space once it is read', async () => {
    mounted = mount(panel('fond-a.png'))
    expect(preview()).toBeNull()
    expect(builtinsBusy()).toBe(true)
    await reading('fond-a.png').answer(picture('image/png'))
    expect(preview()).toBe('blob:image/png')
    expect(builtinsBusy()).toBe(false)
  })

  it('keeps the picture of the file the space has now when the reading of the one before answers late', async () => {
    mounted = mount(panel('fond-a.png'))
    mounted.rerender(panel('fond-b.webp'))
    expect(readings.map((each) => each.filename)).toEqual(['fond-a.png', 'fond-b.webp'])
    await reading('fond-b.webp').answer(picture('image/webp'))
    expect(preview()).toBe('blob:image/webp')
    await reading('fond-a.png').answer(picture('image/png'))
    expect(preview()).toBe('blob:image/webp')
    expect(alert()).toBeNull()
  })

  it('says nothing of a late reading that failed, and stays busy until the reading of the present file is done', async () => {
    mounted = mount(panel('fond-a.png'))
    mounted.rerender(panel('fond-b.webp'))
    await reading('fond-a.png').answer({ ok: false, message: 'gone' } as SpaceBackgroundMediaReply)
    expect(alert()).toBeNull()
    expect(builtinsBusy()).toBe(true)
    await reading('fond-b.webp').answer(picture('image/webp'))
    expect(preview()).toBe('blob:image/webp')
    expect(builtinsBusy()).toBe(false)
    expect(alert()).toBeNull()
  })

  it('still says that the present file cannot be read, whether the main process refuses or the call fails', async () => {
    mounted = mount(panel('fond-a.png'))
    await reading('fond-a.png').answer({ ok: false, message: 'gone' } as SpaceBackgroundMediaReply)
    expect(alert()).not.toBeNull()
    expect(builtinsBusy()).toBe(false)
    mounted.unmount()
    readings.length = 0
    mounted = mount(panel('fond-c.png'))
    await reading('fond-c.png').fail(new Error('channel closed'))
    expect(alert()).not.toBeNull()
    expect(preview()).toBeNull()
    expect(builtinsBusy()).toBe(false)
  })

  it('sets no state once the panel is gone', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mounted = mount(panel('fond-a.png'))
    const late = reading('fond-a.png')
    mounted.unmount()
    mounted = null
    await late.answer(picture('image/png'))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  })
})
