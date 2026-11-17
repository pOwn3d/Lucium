// @vitest-environment happy-dom
// The capsule of a control that leaves the document while the pointer rests on it (a button of the media player when the sound stops, a tile whose
// tab closes). Such a control gets no `mouseleave` and no `blur`; the capsule is drawn by the main process and would stay over the window.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOLTIP } from '@shared/ipc'

const shown = vi.hoisted(() => ({ requests: [] as unknown[] }))
vi.mock('./api', () => ({ api: () => ({ tooltip: (request: unknown) => void shown.requests.push(request) }) }))

import { hideTooltip, tipProps } from './tooltip'

/** A control in the document, inside a group that can be removed whole, and the pointer coming to rest on it. */
function control(text: string): { button: HTMLButtonElement; group: HTMLElement; rest: () => void } {
  const group = document.createElement('div')
  const button = document.createElement('button')
  group.append(button)
  document.body.append(group)
  return { button, group, rest: () => tipProps(text).onMouseEnter({ clientX: 10, clientY: 10, currentTarget: button } as never) }
}
/** Lets the document report what changed in it. */
const reported = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined)

beforeEach(() => {
  vi.useFakeTimers()
  shown.requests.length = 0
})
afterEach(() => {
  hideTooltip()
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('the capsule of a control that leaves the document', () => {
  it('is put away when its control is removed, with no move of the pointer', async () => {
    const { button, rest } = control('Pause')
    rest()
    vi.advanceTimersByTime(TOOLTIP.delayMs)
    expect(shown.requests).toEqual([{ text: 'Pause', x: 10, y: 10 }])
    button.remove()
    await reported()
    expect(shown.requests).toEqual([{ text: 'Pause', x: 10, y: 10 }, null])
  })

  it('is put away when what holds its control is removed', async () => {
    const { group, rest } = control('Pause')
    rest()
    vi.advanceTimersByTime(TOOLTIP.delayMs)
    group.remove()
    await reported()
    expect(shown.requests).toEqual([{ text: 'Pause', x: 10, y: 10 }, null])
  })

  it('never shows when its control is removed during the wait', async () => {
    const { button, rest } = control('Pause')
    rest()
    vi.advanceTimersByTime(TOOLTIP.delayMs / 2)
    button.remove()
    await reported()
    vi.advanceTimersByTime(TOOLTIP.delayMs * 2)
    expect(shown.requests).toEqual([])
  })

  it('stays while the document changes around a control that is still there', async () => {
    const { group, rest } = control('Pause')
    rest()
    vi.advanceTimersByTime(TOOLTIP.delayMs)
    group.append(document.createElement('span'))
    document.body.append(document.createElement('div'))
    await reported()
    expect(shown.requests).toEqual([{ text: 'Pause', x: 10, y: 10 }])
  })

  it('stops watching the document once the capsule is put away', async () => {
    const disconnected = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const { rest } = control('Pause')
    rest()
    expect(disconnected).not.toHaveBeenCalled()
    hideTooltip()
    expect(disconnected).toHaveBeenCalledTimes(1)
    disconnected.mockRestore()
  })
})
