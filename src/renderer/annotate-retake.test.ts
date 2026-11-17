// @vitest-environment happy-dom
// The annotation sheet, mounted: « Nouvelle capture » sits beside Annuler and Rétablir and drops the picture with what was drawn on it. With
// an annotation on the picture it asks first, as « Abandonner » does; with none it starts the new capture at once.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { LuciumApi, OverlayRequest } from '@shared/ipc'
import { button, click, mount, type Mounted } from './dom.test-support'

// The sheet opens with these annotations already on the picture (drawing one asks for a canvas that draws, which this document has not).
const seeded = vi.hoisted(() => ({ items: [] as unknown[] }))
vi.mock('@shared/annotate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/annotate')>()
  return { ...actual, initialAnnotate: (size: Parameters<typeof actual.initialAnnotate>[0]) => ({ ...actual.initialAnnotate(size), items: seeded.items }) }
})

const { AnnotateSheet } = await import('./AnnotateSheet')

const ARROW = { kind: 'arrow', from: { x: 1, y: 1 }, to: { x: 9, y: 9 }, color: '#ff0000', strength: 1 }

let mounted: Mounted | null = null
let openOverlay: ReturnType<typeof vi.fn<(request: OverlayRequest) => void>>

function sheet(items: unknown[]): HTMLElement {
  seeded.items = items
  mounted = mount(createElement(AnnotateSheet, { id: 'capture-1', width: 100, height: 80 }))
  return mounted.container
}

const retake = (container: Element): HTMLButtonElement => container.querySelector<HTMLButtonElement>(`.annotate-toolbar button[aria-label="${t('annotate-sheet.reprendre-la-capture')}"]`)!

beforeEach(() => {
  openOverlay = vi.fn<(request: OverlayRequest) => void>()
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = { openOverlay, closeOverlay: vi.fn(), annotateImage: () => new Promise(() => undefined) }
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('« Nouvelle capture » in the annotation sheet', () => {
  it('starts the new capture at once when nothing was drawn', async () => {
    const container = sheet([])
    await click(retake(container))
    expect(openOverlay).toHaveBeenCalledWith({ panel: 'capture' })
  })

  it('asks first when the picture has an annotation, and « Continuer à annoter » keeps everything', async () => {
    const container = sheet([ARROW])
    await click(retake(container))
    expect(openOverlay).not.toHaveBeenCalled()
    const question = container.querySelector('.annotate-note[role="alert"]')!
    expect(question.textContent).toContain(t('annotate-sheet.reprendre-abandonne-les-annotations'))

    await click(button(question, t('annotate-sheet.continuer-a-annoter')))
    expect(openOverlay).not.toHaveBeenCalled()
    expect(container.querySelector('.annotate-note[role="alert"]')).toBeNull()
  })

  it('starts the new capture once the question is answered yes', async () => {
    const container = sheet([ARROW])
    await click(retake(container))
    await click(button(container.querySelector('.annotate-note[role="alert"]')!, t('annotate-sheet.reprendre-la-capture')))
    expect(openOverlay).toHaveBeenCalledTimes(1)
    expect(openOverlay).toHaveBeenCalledWith({ panel: 'capture' })
  })
})
