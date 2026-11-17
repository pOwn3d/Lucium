// @vitest-environment happy-dom
// The layer where a zone is chosen for a capture, from the keyboard: the arrows show a zone and move it, Shift and the arrows size it, Return
// takes it; the layer is a dialog that says so, and the buttons of the bar name their keys.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import { startZone, ZONE_STEP } from '@shared/capture-zone'
import { installBridge, mount, type Mounted } from './dom.test-support'
import { RegionCapture } from './Panels'

let mounted: Mounted | null = null
let bridge: { captureRegion: ReturnType<typeof vi.fn>; closeOverlay: ReturnType<typeof vi.fn>; captureFullPage: ReturnType<typeof vi.fn>; captureVisible: ReturnType<typeof vi.fn> }

const surface = (): HTMLElement => mounted!.container.querySelector<HTMLElement>('.capture-surface')!
const press = (key: string, shiftKey = false): void => act(() => void surface().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })))
/** The zone drawn, as numbers, or null. */
function drawn(): { x: number; y: number; width: number; height: number } | null {
  const box = mounted!.container.querySelector<HTMLElement>('.capture-box')
  if (!box) return null
  const px = (value: string): number => Number(value.replace('px', ''))
  return { x: px(box.style.left), y: px(box.style.top), width: px(box.style.width), height: px(box.style.height) }
}

beforeEach(() => {
  setLanguage('fr')
  bridge = { captureRegion: vi.fn(), closeOverlay: vi.fn(), captureFullPage: vi.fn(), captureVisible: vi.fn() }
  installBridge(bridge)
  mounted = mount(createElement(RegionCapture))
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the zone of a capture, from the keyboard', () => {
  const start = (): ReturnType<typeof startZone> => startZone({ width: window.innerWidth, height: window.innerHeight })

  it('shows at the first arrow, in the middle of the window, and the next arrows move it', () => {
    expect(drawn()).toBeNull()
    press('ArrowRight')
    expect(drawn()).toEqual(start())
    press('ArrowRight')
    press('ArrowDown')
    expect(drawn()).toEqual({ ...start(), x: start().x + ZONE_STEP, y: start().y + ZONE_STEP })
  })

  it('grows with Shift and the arrows, and Return captures exactly the zone drawn', () => {
    press('ArrowDown')
    press('ArrowRight', true)
    press('ArrowDown', true)
    const zone = { ...start(), width: start().width + ZONE_STEP, height: start().height + ZONE_STEP }
    expect(drawn()).toEqual(zone)
    press('Enter')
    expect(bridge.captureRegion).toHaveBeenCalledTimes(1)
    expect(bridge.captureRegion).toHaveBeenCalledWith(zone)
  })

  it('captures nothing on Return before a zone is shown, and Escape still cancels', () => {
    press('Enter')
    expect(bridge.captureRegion).not.toHaveBeenCalled()
    press('Escape')
    expect(bridge.closeOverlay).toHaveBeenCalledTimes(1)
  })

  it('gives way to the pointer: a press starts a drag and the zone of the keyboard goes', () => {
    press('ArrowLeft')
    expect(drawn()).not.toBeNull()
    act(() => void surface().dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 6, bubbles: true })))
    expect(drawn()).toEqual({ x: 5, y: 6, width: 0, height: 0 })
    // Return during the drag does not take the zone the keyboard had shown.
    press('Enter')
    expect(bridge.captureRegion).not.toHaveBeenCalled()
  })

  it('keeps the bar and its help in sight while the zone is placed from the keyboard', () => {
    press('ArrowUp')
    expect(mounted!.container.querySelector('.capture-hint')).not.toBeNull()
  })
})

describe('the layer, for a screen reader', () => {
  it('is a dialog named « Zone à capturer », described by the help that names the keys', () => {
    const layer = surface()
    expect([layer.getAttribute('role'), layer.getAttribute('aria-modal'), layer.getAttribute('aria-label')]).toEqual(['dialog', 'true', 'Zone à capturer'])
    const help = document.getElementById(layer.getAttribute('aria-describedby')!)
    expect(help?.textContent).toBe(frenchSpaces('Faites glisser pour choisir la zone, ou utilisez les flèches (⇧ pour la taille) et Entrée · Échap pour annuler'))
  })

  it('names the keys of the whole page and of the screen on their buttons', () => {
    const buttons = [...mounted!.container.querySelectorAll('.capture-full')]
    expect(buttons.map((button) => [button.textContent, button.getAttribute('aria-keyshortcuts'), button.getAttribute('title')])).toEqual([
      ['Page entière', '2', 'Capturer toute la page, du haut en bas (touche 2)'],
      ['Fenêtre visible', '3', 'Capturer ce qui est affiché à l’écran (touche 3)']
    ])
  })
})
