// On macOS the application keeps running when its last window closes, and a click on the Dock opens a window.
import { describe, expect, it } from 'vitest'
import { dockClickStep, lastWindowClosedStep, mainCloseStep, type WindowFacts } from './window-lifecycle'

const win = (patch: Partial<WindowFacts> = {}): WindowFacts => ({ destroyed: false, visible: true, minimized: false, ...patch })

describe('the last window on macOS', () => {
  it('does not quit when the last window closes on macOS', () => {
    expect(lastWindowClosedStep('darwin')).toBe('keep-running')
  })

  it('quits when the last window closes on the other systems', () => {
    for (const platform of ['win32', 'linux']) expect(lastWindowClosedStep(platform), platform).toBe('quit')
  })
})

describe('closing the main window', () => {
  it('puts it away on macOS while the application goes on, so that the Dock, ⌘N and links can bring it back', () => {
    expect(mainCloseStep('darwin', false)).toBe('put-away')
  })

  it('closes it for real once the quit is decided, and on the other systems', () => {
    expect(mainCloseStep('darwin', true)).toBe('close')
    for (const platform of ['win32', 'linux']) expect(mainCloseStep(platform, false), platform).toBe('close')
  })
})

describe('a click on the Dock', () => {
  it('opens a new window when every window is gone', () => {
    expect(dockClickStep([win({ destroyed: true, visible: false }), win({ destroyed: true, visible: false })])).toBe('open-window')
    expect(dockClickStep([])).toBe('open-window')
  })

  it('does nothing while a window is on screen (the event also fires at launch)', () => {
    expect(dockClickStep([win()])).toBe('nothing')
    expect(dockClickStep([win({ destroyed: true, visible: false }), win()])).toBe('nothing')
  })

  it('brings the last window back when the windows left are minimized or hidden, instead of opening another', () => {
    expect(dockClickStep([win({ minimized: true })])).toBe('show-last')
    expect(dockClickStep([win({ visible: false })])).toBe('show-last')
    expect(dockClickStep([win({ destroyed: true, visible: false }), win({ minimized: true })])).toBe('show-last')
  })
})
