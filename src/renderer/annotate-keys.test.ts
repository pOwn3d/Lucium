// @vitest-environment happy-dom
// The annotation sheet from the keyboard: the picture takes the focus, the arrows move a point, Return begins and ends a shape there or opens
// the field of a text, Escape drops a shape under way and leaves the sheet open. The arrow is the tool the sheet opens with.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage, t } from '@shared/i18n'
import { annotateCentre } from '@shared/annotate'
import { button, click, installBridge, mount, settle, type Mounted } from './dom.test-support'
import { AnnotateSheet } from './AnnotateSheet'

const SIZE = { width: 300, height: 200 }

let mounted: Mounted | null = null
let closeOverlay: ReturnType<typeof vi.fn>

const picture = (): HTMLCanvasElement => mounted!.container.querySelector<HTMLCanvasElement>('canvas.annotate-canvas')!
const press = (key: string, target: Element = picture()): void => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
const undo = (): HTMLButtonElement => mounted!.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('annotate-sheet.annuler-la-derniere-annotation')}"]`)!
const point = (): { left: string; top: string } | null => {
  const ring = mounted!.container.querySelector<HTMLElement>('.annotate-cursor')
  return ring ? { left: ring.style.left, top: ring.style.top } : null
}

beforeEach(async () => {
  setLanguage('fr')
  closeOverlay = vi.fn()
  installBridge({ annotateImage: () => Promise.resolve('data:image/png;base64,AA=='), closeOverlay })
  // The picture "loads" at once, and the canvas is drawn at its own size (shown = 1): the document of the tests lays nothing out.
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_url: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: SIZE.width, height: SIZE.height } as DOMRect)
  mounted = mount(createElement(AnnotateSheet, { id: 'capture-1', ...SIZE }))
  await settle()
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the picture of the annotation sheet, from the keyboard', () => {
  it('is a stop of Tab, named, and described by the line that says its keys', () => {
    const canvas = picture()
    expect([canvas.tabIndex, canvas.getAttribute('role'), canvas.getAttribute('aria-label')]).toEqual([0, 'application', 'Capture à annoter'])
    expect(document.getElementById(canvas.getAttribute('aria-describedby')!)?.textContent).toBe(
      frenchSpaces('Au clavier, sur l’image : les flèches déplacent le point (⇧ pour aller plus vite), Entrée commence puis termine la forme, ou ouvre le texte ; Échap annule la forme en cours.')
    )
  })

  it('shows its point in the middle at the first arrow, and the next arrows move it', () => {
    expect(point()).toBeNull()
    press('ArrowRight')
    const centre = annotateCentre(SIZE)
    expect(point()).toEqual({ left: `${centre.x}px`, top: `${centre.y}px` })
    press('ArrowRight')
    press('ArrowDown')
    expect(point()).toEqual({ left: `${centre.x + 3}px`, top: `${centre.y + 3}px` })
  })

  it('draws an arrow: Return begins it at the point, the arrows stretch it, Return ends it', () => {
    expect(undo().disabled).toBe(true)
    press('Enter')
    for (let i = 0; i < 4; i++) press('ArrowRight')
    expect(undo().disabled).toBe(true)
    press('Enter')
    expect(undo().disabled).toBe(false)
  })

  it('drops a shape under way with Escape, and keeps the sheet open: a second Escape is the sheet’s', () => {
    press('Enter')
    for (let i = 0; i < 4; i++) press('ArrowDown')
    press('Escape')
    expect(undo().disabled).toBe(true)
    expect(closeOverlay).not.toHaveBeenCalled()
    press('Escape')
    expect(closeOverlay).toHaveBeenCalledTimes(1)
  })

  it('opens the field of a text at the point with the Text tool, and gives the focus back to the picture once the text is placed', async () => {
    await click(button(mounted!.container, 'Texte'))
    picture().focus()
    press('ArrowLeft')
    press('ArrowLeft')
    press('Enter')
    const field = mounted!.container.querySelector<HTMLInputElement>('input.annotate-text')!
    expect(field).not.toBeNull()
    const centre = annotateCentre(SIZE)
    expect([field.style.left, field.style.top]).toEqual([`${centre.x - 3}px`, `${centre.y}px`])
    act(() => {
      field.value = 'Ici'
    })
    press('Enter', field)
    expect(mounted!.container.querySelector('input.annotate-text')).toBeNull()
    expect(undo().disabled).toBe(false)
    expect(document.activeElement).toBe(picture())
  })
})
