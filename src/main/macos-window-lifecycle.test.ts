// On macOS the application keeps running when its last window closes, and a click on the Dock opens a window.
import { describe, expect, it } from 'vitest'
import { activationPlan, dockClickPlan, dockClickStep, lastWindowClosedStep, mainCloseStep, type DockWindowFacts, type WindowFacts } from './window-lifecycle'

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

const dockWin = (id: string, patch: Partial<WindowFacts> = {}): DockWindowFacts => ({ id, ...win(patch) })

describe('a click on the Dock brings every window forward', () => {
  it('brings all the windows that sit behind another application, the last used one last so that it keeps the focus', () => {
    const windows = [dockWin('main'), dockWin('window-2'), dockWin('private-1'), dockWin('guest-1')]
    expect(dockClickPlan('darwin', windows, 'window-2')).toEqual({ open: false, raise: ['main', 'private-1', 'guest-1', 'window-2'] })
    expect(dockClickPlan('darwin', windows, 'main')).toEqual({ open: false, raise: ['window-2', 'private-1', 'guest-1', 'main'] })
  })

  it('brings back the minimized and the hidden windows with the others', () => {
    const windows = [dockWin('main', { minimized: true }), dockWin('window-2', { visible: false }), dockWin('private-1')]
    expect(dockClickPlan('darwin', windows, 'private-1')).toEqual({ open: false, raise: ['main', 'window-2', 'private-1'] })
  })

  it('never brings back a window that is destroyed, even the last used one', () => {
    const windows = [dockWin('main'), dockWin('window-2', { destroyed: true, visible: false }), dockWin('private-1')]
    expect(dockClickPlan('darwin', windows, 'window-2')).toEqual({ open: false, raise: ['main', 'private-1'] })
  })

  it('brings a single window, and falls back to the list order when the last used one is not listed', () => {
    expect(dockClickPlan('darwin', [dockWin('main')], 'main')).toEqual({ open: false, raise: ['main'] })
    expect(dockClickPlan('darwin', [dockWin('main'), dockWin('window-2')], 'gone')).toEqual({ open: false, raise: ['main', 'window-2'] })
  })

  it('opens a window when none is left, and brings nothing', () => {
    expect(dockClickPlan('darwin', [], 'main')).toEqual({ open: true, raise: [] })
    expect(dockClickPlan('darwin', [dockWin('main', { destroyed: true, visible: false })], 'main')).toEqual({ open: true, raise: [] })
  })

  it('with the setting off, brings the last used window only', () => {
    const windows = [dockWin('main'), dockWin('window-2', { minimized: true }), dockWin('private-1')]
    expect(dockClickPlan('darwin', windows, 'window-2', false)).toEqual({ open: false, raise: ['window-2'] })
    expect(dockClickPlan('darwin', [dockWin('main'), dockWin('window-2', { destroyed: true, visible: false })], 'window-2', false)).toEqual({ open: false, raise: [] })
    // With every window gone it still opens a new one: the setting only limits what comes back.
    expect(dockClickPlan('darwin', [], 'main', false)).toEqual({ open: true, raise: [] })
  })

  it('is a macOS matter: the Dock does not exist elsewhere', () => {
    for (const platform of ['win32', 'linux']) expect(dockClickPlan(platform, [dockWin('main'), dockWin('window-2')], 'main'), platform).toEqual({ open: false, raise: [] })
  })
})

describe('switching to the application (⌘⇥, a click in a window) brings its windows forward', () => {
  it('raises every window on screen, the one that has the focus last so that it stays on top', () => {
    const windows = [dockWin('main'), dockWin('window-2'), dockWin('private-1')]
    expect(activationPlan('darwin', windows, 'window-2')).toEqual(['main', 'private-1', 'window-2'])
    expect(activationPlan('darwin', windows, 'main')).toEqual(['window-2', 'private-1', 'main'])
  })

  it('leaves the minimized, the hidden and the destroyed windows as they are (the switcher does not restore them, the Dock click does)', () => {
    const windows = [dockWin('main'), dockWin('window-2', { minimized: true }), dockWin('private-1', { visible: false }), dockWin('guest-1', { destroyed: true, visible: false })]
    expect(activationPlan('darwin', windows, 'main')).toEqual(['main'])
    expect(activationPlan('darwin', windows.slice(1), 'main')).toEqual([])
  })

  it('takes the list order when no listed window has the focus', () => {
    expect(activationPlan('darwin', [dockWin('main'), dockWin('window-2')], null)).toEqual(['main', 'window-2'])
  })

  it('with the setting off, moves nothing', () => {
    expect(activationPlan('darwin', [dockWin('main'), dockWin('window-2')], 'main', false)).toEqual([])
  })

  it('is a macOS matter', () => {
    for (const platform of ['win32', 'linux']) expect(activationPlan(platform, [dockWin('main'), dockWin('window-2')], 'main'), platform).toEqual([])
  })
})
