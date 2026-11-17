// The layer of the page annotation (shared/page-annotate-layer.ts) run as its world of the page runs it: the call text `pageLayerCall` builds is evaluated
// against the stub window of page-annotate-test-support.ts (no DOM in the test environment).

import { describe, expect, it, vi } from 'vitest'
import { pageLayerCall, type PageLayerConfig } from './page-annotate-layer'
import { drawn, hostOf, run, stroke, stubWindow, svgOf, type StubWindow } from './page-annotate-test-support'

const PEN: PageLayerConfig = { mode: 'draw', brush: { tool: 'pen', color: '#e53935', width: 5 } }
const PASS: PageLayerConfig = { mode: 'pass', brush: PEN.brush }

describe('the call text of the layer', () => {
  it('is self-contained: it reads no name of its module and no import (it runs in the page, which has none of them)', () => {
    const call = pageLayerCall('mount', PEN)
    expect(call).not.toMatch(/\bimport\b/)
    expect(call).not.toMatch(/__name|__vite|require\(/)
    expect(call.startsWith('(function annotateLayer')).toBe(true)
  })

  it('carries the action and the config as JSON, with null for an action that takes none', () => {
    expect(pageLayerCall('hide')).toMatch(/\)\(window, "hide", null\)$/)
    expect(pageLayerCall('mount', PASS)).toContain('"mode":"pass"')
  })
})

describe('mounting the layer on a page', () => {
  it('puts a transparent layer on top of the page, in draw mode it takes the pointer', () => {
    const win = stubWindow()
    expect(run(win, 'mount', PEN)).toBe(true)
    const host = hostOf(win)
    expect(host.style['pointerEvents']).toBe('auto')
    expect(host.style['position']).toBeUndefined()
    expect(host.style.cssText).toContain('position:fixed')
    expect(host.style.cssText).toContain('z-index:2147483647')
  })

  it('refuses to mount on a page with no document element: it answers false, and nothing is put on the page', () => {
    const win = stubWindow({ html: false })
    expect(run(win, 'mount', PEN)).toBe(false)
    expect(run(win, 'show')).toBe(false)
  })

  it('in pass mode the layer lets every click through to the page', () => {
    const win = stubWindow()
    run(win, 'mount', PASS)
    expect(hostOf(win).style['pointerEvents']).toBe('none')
  })

  it('a second mount takes the old layer away: the picture starts again empty (a navigation erases the drawing)', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    stroke(win, [10, 10], [200, 200])
    expect(drawn(win)).toBe(1)
    run(win, 'mount', PEN)
    expect(drawn(win)).toBe(0)
    expect(win.document.documentElement!.children.filter((child) => child.tagName === 'div')).toHaveLength(1)
  })

  it('remove takes the layer away, and the page has no layer to show or edit afterwards', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    expect(run(win, 'remove')).toBe(true)
    expect(win.document.documentElement!.children).toHaveLength(0)
    expect(run(win, 'show', PEN)).toBe(false)
    expect(run(win, 'undo')).toBe(false)
  })

  it('hide and show keep the drawing: a hidden layer is not on screen, and comes back with its marks', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    stroke(win, [10, 10], [200, 200])
    expect(run(win, 'hide')).toBe(true)
    expect(hostOf(win).style['display']).toBe('none')
    expect(run(win, 'show', PEN)).toBe(true)
    expect(hostOf(win).style['display']).toBe('')
    expect(drawn(win)).toBe(1)
  })

  // Guard: a hidden layer takes no pointer. Without `pointerEvents = 'none'` in `hide`, a layer left on a page that is no longer on screen could still capture.
  it('a hidden layer takes no pointer, and comes back with the pointer of its mode', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    run(win, 'hide')
    expect(hostOf(win).style['pointerEvents']).toBe('none')
    run(win, 'show')
    expect(hostOf(win).style['pointerEvents']).toBe('auto')
    run(win, 'apply', PASS)
    run(win, 'hide')
    run(win, 'show')
    expect(hostOf(win).style['pointerEvents']).toBe('none')
  })

  // Guard: hiding ends the stroke in progress. Without `settle` in `hide`, the pointer moves after the layer comes back would extend it.
  it('hiding ends the stroke in progress: what was not finished is dropped, the strokes made are kept', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    stroke(win, [10, 10], [100, 100])
    hostOf(win).dispatch('pointerdown', { clientX: 300, clientY: 300 })
    run(win, 'hide')
    run(win, 'show', PEN)
    hostOf(win).dispatch('pointermove', { clientX: 400, clientY: 400 })
    hostOf(win).dispatch('pointerup', {})
    expect(drawn(win)).toBe(1)
  })

  // Guard: a text box left open is ended by hiding (what was typed is kept). Without it, the box would stay and take the next pointer press.
  it('hiding ends the text box left open: its text is kept and no box stays in the page', () => {
    const win = stubWindow()
    run(win, 'mount', { mode: 'draw', brush: { tool: 'text', color: '#ffffff', width: 2 } })
    hostOf(win).dispatch('pointerdown', { clientX: 100, clientY: 100 })
    const box = hostOf(win).shadow!.children.find((child) => child.tagName === 'input')!
    box.value = 'Relu'
    run(win, 'hide')
    expect(hostOf(win).shadow!.children.some((child) => child.tagName === 'input')).toBe(false)
    expect(drawn(win)).toBe(1)
  })
})

describe('the modes', () => {
  // Guard: in pass mode the pointer is not taken. Without the guard in `down` (the layer's mode check), a click would draw.
  it('a pointer press in pass mode draws nothing: the click belongs to the page', () => {
    const win = stubWindow()
    run(win, 'mount', PASS)
    stroke(win, [10, 10], [200, 200])
    expect(drawn(win)).toBe(0)
  })

  it('switching to pass mode ends the stroke being drawn, and keeps the strokes made', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    stroke(win, [10, 10], [100, 100])
    hostOf(win).dispatch('pointerdown', { clientX: 300, clientY: 300 })
    hostOf(win).dispatch('pointermove', { clientX: 400, clientY: 400 })
    run(win, 'apply', PASS)
    hostOf(win).dispatch('pointerup', {})
    expect(drawn(win)).toBe(1)
    expect(hostOf(win).style['pointerEvents']).toBe('none')
  })

  it('apply changes the mode and the brush of a layer on the page', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    run(win, 'apply', { mode: 'draw', brush: { tool: 'highlighter', color: '#43a047', width: 10 } })
    stroke(win, [10, 10], [200, 200])
    const group = svgOf(win).children[0]!
    expect(group.attributes['stroke']).toBe('#43a047')
    expect(group.children[0]!.attributes['opacity']).toBe('0.4')
  })

  it('the wheel scrolls the page underneath the layer', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    hostOf(win).dispatch('wheel', { deltaX: 0, deltaY: 120 })
    expect(win.scrolls).toEqual([[0, 120]])
  })

  // Guard: the default of the wheel is stopped, or the browser scrolls the page a second time next to the scrollBy. Without the call, this fails.
  it('stops the default of the wheel, so that the page scrolls once', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    const preventDefault = vi.fn()
    hostOf(win).dispatch('wheel', { deltaX: 0, deltaY: 40, preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(win.scrolls).toEqual([[0, 40]])
  })

  // Guard: a trackpad reports pixels, a mouse wheel reports lines or pages: each unit is converted, or the page moves by a few pixels only.
  it('converts the wheel in lines and pages into pixels, and scrolls sideways too', () => {
    const win = stubWindow({ width: 800, height: 600 })
    run(win, 'mount', PEN)
    const host = hostOf(win)
    host.dispatch('wheel', { deltaMode: 1, deltaX: -2, deltaY: 3 })
    host.dispatch('wheel', { deltaMode: 2, deltaX: 0, deltaY: -1 })
    host.dispatch('wheel', { deltaMode: 0, deltaX: 15, deltaY: 0 })
    expect(win.scrolls).toEqual([
      [-32, 48],
      [0, -600],
      [15, 0]
    ])
  })

  // Guard: the layer covers the viewport without the scrollbars: a click on a scrollbar must reach the page, not start a stroke.
  // Without the size from the viewport (100vw covered them), the layer would be 1000 px wide here.
  it('covers the viewport without its scrollbars, so that the page scrollbars stay usable', () => {
    const win = stubWindow({ width: 1000, height: 500, clientWidth: 985, clientHeight: 485 })
    run(win, 'mount', PEN)
    const host = hostOf(win)
    expect(host.style['width']).toBe('985px')
    expect(host.style['height']).toBe('485px')
  })

  it('follows the viewport when the window is resized', () => {
    const win = stubWindow({ width: 1000, height: 500 })
    run(win, 'mount', PEN)
    win.document.documentElement!.clientWidth = 700
    win.document.documentElement!.clientHeight = 400
    win.dispatch('resize', {})
    expect(hostOf(win).style['width']).toBe('700px')
    expect(hostOf(win).style['height']).toBe('400px')
  })
})

describe('drawing', () => {
  it('a stroke of the pen is kept as one element, and undo and redo take it away and back', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    stroke(win, [10, 10], [200, 200])
    expect(drawn(win)).toBe(1)
    expect(run(win, 'undo')).toBe(true)
    expect(drawn(win)).toBe(0)
    expect(run(win, 'redo')).toBe(true)
    expect(drawn(win)).toBe(1)
  })

  it('a new edit after an undo empties the redo: what was undone is gone', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    stroke(win, [10, 10], [200, 200])
    run(win, 'undo')
    stroke(win, [50, 50], [60, 60])
    run(win, 'redo')
    expect(drawn(win)).toBe(1)
  })

  it('clear takes every element away in one step, and undo gives them back', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    stroke(win, [10, 10], [200, 200])
    stroke(win, [300, 300], [400, 400])
    run(win, 'clear')
    expect(drawn(win)).toBe(0)
    run(win, 'undo')
    expect(drawn(win)).toBe(2)
  })

  it('a click on a shape without size is not kept; a shape dragged is', () => {
    const win = stubWindow()
    run(win, 'mount', { mode: 'draw', brush: { tool: 'rectangle', color: '#1e88e5', width: 2 } })
    stroke(win, [50, 50], [50, 50])
    expect(drawn(win)).toBe(0)
    stroke(win, [50, 50], [150, 120])
    expect(drawn(win)).toBe(1)
    expect(svgOf(win).children[0]!.children[0]!.tagName).toBe('rect')
  })

  it('an arrow is a line with its head', () => {
    const win = stubWindow()
    run(win, 'mount', { mode: 'draw', brush: { tool: 'arrow', color: '#e53935', width: 5 } })
    stroke(win, [100, 100], [300, 100])
    const parts = svgOf(win).children[0]!.children.map((child) => child.tagName)
    expect(parts).toEqual(['line', 'path'])
  })

  it('the eraser removes the element the pointer touches, as one step of the history', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    stroke(win, [10, 10], [200, 10])
    stroke(win, [10, 300], [200, 300])
    run(win, 'apply', { mode: 'draw', brush: { tool: 'eraser', color: '#e53935', width: 5 } })
    hostOf(win).dispatch('pointerdown', { clientX: 100, clientY: 12 })
    hostOf(win).dispatch('pointermove', { clientX: 150, clientY: 200 })
    hostOf(win).dispatch('pointerup', {})
    expect(drawn(win)).toBe(1)
    run(win, 'undo')
    expect(drawn(win)).toBe(2)
  })

  // The browser hands a quick move over as one event: the eraser is reported on either side of a stroke, and never on it.
  it('the eraser takes away what its way crossed between two events, not only what is under the points it was reported at', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    stroke(win, [100, 100], [300, 300])
    run(win, 'apply', { mode: 'draw', brush: { tool: 'eraser', color: '#e53935', width: 8 } })
    hostOf(win).dispatch('pointerdown', { clientX: 300, clientY: 100 })
    hostOf(win).dispatch('pointermove', { clientX: 100, clientY: 300 })
    hostOf(win).dispatch('pointerup', {})
    expect(drawn(win)).toBe(0)
    run(win, 'undo')
    expect(drawn(win)).toBe(1)
  })

  it('the way of the eraser crosses a shape and a text as it crosses a stroke, and takes away nothing it passed far from', () => {
    const win = stubWindow()
    run(win, 'mount', { mode: 'draw', brush: { tool: 'rectangle', color: '#e53935', width: 4 } })
    stroke(win, [400, 100], [500, 200])
    run(win, 'apply', { mode: 'draw', brush: { tool: 'text', color: '#e53935', width: 2 } })
    hostOf(win).dispatch('pointerdown', { clientX: 700, clientY: 150 })
    const box = hostOf(win).shadow!.children.find((child) => child.tagName === 'input')!
    box.value = 'Note'
    box.dispatch('keydown', { key: 'Enter' })
    run(win, 'apply', PEN)
    stroke(win, [100, 400], [300, 400])
    expect(drawn(win)).toBe(3)
    run(win, 'apply', { mode: 'draw', brush: { tool: 'eraser', color: '#e53935', width: 4 } })
    // From the left of the rectangle to the right of the text, along a line that goes through both and far above the stroke.
    hostOf(win).dispatch('pointerdown', { clientX: 300, clientY: 140 })
    hostOf(win).dispatch('pointermove', { clientX: 900, clientY: 140 })
    hostOf(win).dispatch('pointerup', {})
    expect(drawn(win)).toBe(1)
    expect(svgOf(win).children[0]!.children[0]!.tagName).toBe('path')
  })

  it('a new gesture of the eraser starts where it is pressed, not where the last one ended', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    stroke(win, [100, 200], [300, 200])
    run(win, 'apply', { mode: 'draw', brush: { tool: 'eraser', color: '#e53935', width: 4 } })
    hostOf(win).dispatch('pointerdown', { clientX: 200, clientY: 50 })
    hostOf(win).dispatch('pointerup', {})
    // A press below the stroke: the way from the last press above it is not the eraser's.
    hostOf(win).dispatch('pointerdown', { clientX: 200, clientY: 350 })
    hostOf(win).dispatch('pointerup', {})
    expect(drawn(win)).toBe(1)
  })

  it('a stroke kept after a resize is drawn at the same place of the window', () => {
    const win = stubWindow({ width: 1000, height: 500 })
    run(win, 'mount', PEN)
    stroke(win, [500, 250], [600, 250])
    // A resize changes the window and its viewport: the stub gives both.
    win.innerWidth = 500
    win.document.documentElement!.clientWidth = 500
    win.dispatch('resize', {})
    expect(svgOf(win).attributes['viewBox']).toBe('0 0 500 500')
    const path = svgOf(win).children[0]!.children[0]!
    // The point (500, 250) of the first window is the middle of the second one: 0.5 of its width, now at 250 px.
    expect(path.attributes['d']).toMatch(/^M250 250/)
  })

  it('a text is typed in a box and kept on Enter; Escape drops it; an empty or too long text is refused', () => {
    const win = stubWindow()
    run(win, 'mount', { mode: 'draw', brush: { tool: 'text', color: '#ffffff', width: 2 } })
    const host = hostOf(win)
    host.dispatch('pointerdown', { clientX: 100, clientY: 100 })
    const box = host.shadow!.children.find((child) => child.tagName === 'input')!
    expect(box.focused).toBe(true)
    box.value = '  Relecture  '
    box.dispatch('keydown', { key: 'Enter' })
    const text = svgOf(win).children[0]!.children[0]!
    expect(text.tagName).toBe('text')
    expect(text.textContent).toBe('Relecture')
    expect(host.shadow!.children.some((child) => child.tagName === 'input')).toBe(false)

    host.dispatch('pointerdown', { clientX: 300, clientY: 300 })
    const other = host.shadow!.children.find((child) => child.tagName === 'input')!
    other.value = 'x'.repeat(201)
    other.dispatch('keydown', { key: 'Enter' })
    expect(drawn(win)).toBe(1)

    host.dispatch('pointerdown', { clientX: 300, clientY: 300 })
    const third = host.shadow!.children.find((child) => child.tagName === 'input')!
    third.value = 'Annule'
    third.dispatch('keydown', { key: 'Escape' })
    expect(drawn(win)).toBe(1)
  })

})

// The page's scripts do not see the layer's (it runs in a world of its own, which main/engine/page-annotate-world.test.ts holds); the events of
// the layer are the other way to read it, since they pass through the page's document: the layer takes them at the window and stops them there.
describe('what the listeners of the page get of the layer', () => {
  const TEXT: PageLayerConfig = { mode: 'draw', brush: { tool: 'text', color: '#ffffff', width: 2 } }
  /** A page that listens to everything, everywhere it can once the layer is there: on its document, on its window, in both phases. */
  function listeningPage(win: StubWindow, types: readonly string[]): string[] {
    const got: string[] = []
    for (const type of types) {
      win.document.documentElement!.addEventListener(type, () => got.push(`document ${type}`))
      win.addEventListener(type, () => got.push(`window ${type}`))
      win.addEventListener(type, () => got.push(`window capture ${type}`), { capture: true })
    }
    return got
  }
  const POINTER = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointerrawupdate', 'gotpointercapture', 'lostpointercapture', 'mousedown', 'mousemove', 'mouseup', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel']
  const TYPING = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'textInput', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut']

  it('nothing of the pointer that draws: neither where it goes down, nor where it moves, nor its clicks', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    const got = listeningPage(win, POINTER)
    const host = hostOf(win)
    for (const type of POINTER) host.dispatch(type, { clientX: 40, clientY: 60, deltaX: 0, deltaY: 0 })
    expect(got).toEqual([])
    // The layer itself got them: the press and the release above made a dot, and a stroke is drawn after it.
    expect(drawn(win)).toBe(1)
    stroke(win, [10, 10], [200, 200])
    expect(drawn(win)).toBe(2)
  })

  it('nothing of what is typed in the text box: the keys, the text put in, a paste, a composition; Enter still keeps the text', () => {
    const win = stubWindow()
    run(win, 'mount', TEXT)
    const got = listeningPage(win, TYPING)
    const host = hostOf(win)
    host.dispatch('pointerdown', { clientX: 100, clientY: 100 })
    const box = host.shadow!.children.find((child) => child.tagName === 'input')!
    box.value = 'Secret'
    for (const type of TYPING) box.dispatch(type, { key: 's', data: 's' })
    expect(got).toEqual([])
    box.dispatch('keydown', { key: 'Enter' })
    expect(got).toEqual([])
    expect(svgOf(win).children[0]!.children[0]!.textContent).toBe('Secret')
  })

  // Japanese, Chinese, Korean: the text is composed with the input method, which takes Enter to choose a candidate and Escape to give the
  // composition up. Ending the box on those keys placed the text half typed, and the input method then committed its text elsewhere.
  it('a composition of the input method: its Enter and its Escape leave the box open, and the text is placed whole, once, unseen by the page', () => {
    const win = stubWindow()
    run(win, 'mount', TEXT)
    const got = listeningPage(win, TYPING)
    const host = hostOf(win)
    host.dispatch('pointerdown', { clientX: 100, clientY: 100 })
    const box = host.shadow!.children.find((child) => child.tagName === 'input')!
    const open = (): boolean => host.shadow!.children.includes(box)
    box.value = 'Note '
    box.dispatch('compositionstart', { data: '' })
    box.value = 'Note にほん'
    box.dispatch('compositionupdate', { data: 'にほん' })
    // The engine marks the keys of a composition `isComposing`, whatever their code.
    box.dispatch('keydown', { key: 'Enter', keyCode: 13, isComposing: true })
    box.dispatch('keyup', { key: 'Enter', keyCode: 13, isComposing: true })
    box.dispatch('keydown', { key: 'Escape', keyCode: 27, isComposing: true })
    box.dispatch('keyup', { key: 'Escape', keyCode: 27, isComposing: true })
    expect(open()).toBe(true)
    expect(drawn(win)).toBe(0)
    box.value = 'Note 日本'
    box.dispatch('compositionend', { data: '日本' })
    // Some engines send the key that ended the composition after its end, still as the input method's (229).
    box.dispatch('keydown', { key: 'Enter', keyCode: 229, isComposing: false })
    expect(open()).toBe(true)
    box.dispatch('keydown', { key: 'Enter', keyCode: 13, isComposing: false })
    expect(open()).toBe(false)
    expect(svgOf(win).children.map((group) => group.children[0]!.textContent)).toEqual(['Note 日本'])
    win.document.documentElement!.dispatch('keyup', { key: 'Enter', keyCode: 13 })
    expect(got).toEqual([])
  })

  // Enter ends the box on its press: its keypress, its repeats and its release come after, from the page the focus went back to.
  it('nothing of the key that ends the text box, until it is released; the next press of that key is the page’s', () => {
    for (const key of ['Enter', 'Escape']) {
      const win = stubWindow()
      run(win, 'mount', TEXT)
      const got = listeningPage(win, TYPING)
      const host = hostOf(win)
      host.dispatch('pointerdown', { clientX: 100, clientY: 100 })
      const box = host.shadow!.children.find((child) => child.tagName === 'input')!
      box.value = 'Secret'
      box.dispatch('keydown', { key })
      const page = win.document.documentElement!
      page.dispatch('keypress', { key })
      page.dispatch('keydown', { key, repeat: true })
      page.dispatch('keyup', { key })
      expect(got).toEqual([])
      expect(drawn(win)).toBe(key === 'Enter' ? 1 : 0)
      page.dispatch('keydown', { key })
      page.dispatch('keyup', { key })
      expect(got).toEqual(['window capture keydown', 'document keydown', 'window keydown', 'window capture keyup', 'document keyup', 'window keyup'])
    }
  })

  it('a blur of the window gives the key that ended the box back to the page: its release came elsewhere', () => {
    const win = stubWindow()
    run(win, 'mount', TEXT)
    const got = listeningPage(win, ['keyup'])
    const host = hostOf(win)
    host.dispatch('pointerdown', { clientX: 100, clientY: 100 })
    const box = host.shadow!.children.find((child) => child.tagName === 'input')!
    box.value = 'Secret'
    box.dispatch('keydown', { key: 'Enter' })
    win.dispatch('blur', {})
    win.document.documentElement!.dispatch('keyup', { key: 'Enter' })
    expect(got).toHaveLength(3)
  })

  it('the pointer of the page is the page’s: in pass mode, and on what is not the layer, nothing is taken from it', () => {
    const win = stubWindow()
    run(win, 'mount', PASS)
    const got = listeningPage(win, ['pointerdown', 'click', 'wheel'])
    const link = win.document.createElement('a')
    win.document.documentElement!.appendChild(link)
    for (const type of ['pointerdown', 'click', 'wheel']) link.dispatch(type, { clientX: 5, clientY: 5 })
    expect(got).toEqual(['window capture pointerdown', 'document pointerdown', 'window pointerdown', 'window capture click', 'document click', 'window click', 'window capture wheel', 'document wheel', 'window wheel'])
    expect(win.scrolls).toEqual([])
  })

  it('the keys of the page are the page’s: with no text box open, a key typed in the page reaches it', () => {
    const win = stubWindow()
    run(win, 'mount', TEXT)
    const got = listeningPage(win, ['keydown', 'keyup', 'input'])
    const field = win.document.createElement('textarea')
    win.document.documentElement!.appendChild(field)
    for (const type of ['keydown', 'keyup', 'input']) field.dispatch(type, { key: 'a' })
    expect(got).toHaveLength(9)
    // A text box open in the layer does not take the keys of a field of the page either (the box loses the focus then, and is closed: see blur).
    hostOf(win).dispatch('pointerdown', { clientX: 100, clientY: 100 })
    got.length = 0
    field.dispatch('keydown', { key: 'a' })
    expect(got).toHaveLength(3)
  })

  it('listens at the window before the document; only the wheel and the pointer it handles may stop a default, the rest is passive', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    const guards = win.listening.filter((one) => one.capture)
    expect(guards.map((one) => one.type).sort()).toEqual([...new Set([...POINTER, ...TYPING])].sort())
    expect(guards.filter((one) => !one.passive).map((one) => one.type).sort()).toEqual(['keydown', 'keyup', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup', 'wheel'])
  })

  it('leaves no listener on the window when it is taken away', () => {
    const win = stubWindow()
    run(win, 'mount', TEXT)
    hostOf(win).dispatch('pointerdown', { clientX: 100, clientY: 100 })
    expect(win.listening.length).toBeGreaterThan(30)
    run(win, 'remove')
    expect(win.listening).toEqual([])
  })
})

describe('the diamond and the check of the fields', () => {
  it('the diamond is a closed figure drawn from the pointer press to its release', () => {
    const win = stubWindow()
    run(win, 'mount', { mode: 'draw', brush: { tool: 'diamond', color: '#1e88e5', width: 5 } })
    stroke(win, [100, 100], [300, 260])
    expect(drawn(win)).toBe(1)
    const figure = svgOf(win).children[0]!.children[0]!
    expect(figure.tagName).toBe('path')
    expect(figure.attributes['d']).toMatch(/Z$/)
  })

  // Guard: a field of the page keeps its typing. Without the field check in `editing`, the bar's letters would take the keys typed in a field.
  it('editing answers yes for a field of the page or an open text box, and no for the rest of the page', () => {
    const win = stubWindow()
    run(win, 'mount', PEN)
    expect(run(win, 'editing')).toBe(false)
    win.document.activeElement = { tagName: 'INPUT', isContentEditable: false }
    expect(run(win, 'editing')).toBe(true)
    win.document.activeElement = { tagName: 'DIV', isContentEditable: true }
    expect(run(win, 'editing')).toBe(true)
    win.document.activeElement = { tagName: 'BUTTON', isContentEditable: false }
    expect(run(win, 'editing')).toBe(false)
    win.document.activeElement = null
    run(win, 'apply', { mode: 'draw', brush: { tool: 'text', color: '#ffffff', width: 2 } })
    hostOf(win).dispatch('pointerdown', { clientX: 100, clientY: 100 })
    expect(run(win, 'editing')).toBe(true)
  })

  it('editing is no when there is no layer on the page', () => {
    expect(run(stubWindow(), 'editing')).toBe(false)
  })
})


describe('holding Control', () => {
  const PEN_DRAW: PageLayerConfig = { mode: 'draw', brush: { tool: 'pen', color: '#e53935', width: 5 } }
  const control = (win: StubWindow, type: 'keydown' | 'keyup') => win.dispatch(type, { key: 'Control' })

  // Guard: holding Control in draw mode lets the pointer through (the page scrolls). Without the keydown listener, the layer would keep it.
  it('while Control is held in draw mode, the layer takes no pointer, so that the page scrolls; it takes it back on release', () => {
    const win = stubWindow()
    run(win, 'mount', PEN_DRAW)
    control(win, 'keydown')
    expect(hostOf(win).style['pointerEvents']).toBe('none')
    control(win, 'keyup')
    expect(hostOf(win).style['pointerEvents']).toBe('auto')
  })

  // Guard: the window losing the focus gives no keyup: the blur takes the hold back, so the layer never stays in scrolling mode.
  it('a blur of the window ends the hold: the layer takes the pointer back', () => {
    const win = stubWindow()
    run(win, 'mount', PEN_DRAW)
    control(win, 'keydown')
    win.dispatch('blur', {})
    expect(hostOf(win).style['pointerEvents']).toBe('auto')
  })

  // Guard: the gesture in progress is ended when Control is held (as in pass mode): an unfinished stroke is not left half made.
  // Guard: a show without a config (the layer comes back after a hide) keeps the hold: the layer does not take the pointer while Control is held.
  it('showing the layer again while Control is held keeps the pass-through', () => {
    const win = stubWindow()
    run(win, 'mount', PEN_DRAW)
    run(win, 'hide')
    control(win, 'keydown')
    run(win, 'show')
    expect(hostOf(win).style['pointerEvents']).toBe('none')
  })

  it('a stroke in progress is ended when Control is held, and a change of the brush while held keeps the pass-through', () => {
    const win = stubWindow()
    run(win, 'mount', PEN_DRAW)
    hostOf(win).dispatch('pointerdown', { clientX: 10, clientY: 10 })
    hostOf(win).dispatch('pointermove', { clientX: 200, clientY: 200 })
    control(win, 'keydown')
    expect(drawn(win)).toBe(0)
    run(win, 'apply', PEN_DRAW)
    expect(hostOf(win).style['pointerEvents']).toBe('none')
    control(win, 'keyup')
    expect(hostOf(win).style['pointerEvents']).toBe('auto')
  })

  it('in pass mode the layer stays click-through whatever Control does', () => {
    const win = stubWindow()
    run(win, 'mount', PASS)
    control(win, 'keyup')
    expect(hostOf(win).style['pointerEvents']).toBe('none')
  })
})

describe('holding Command', () => {
  const PEN_DRAW: PageLayerConfig = { mode: 'draw', brush: { tool: 'pen', color: '#e53935', width: 5 } }
  const key = (win: StubWindow, type: 'keydown' | 'keyup', name: string) => win.dispatch(type, { key: name })

  // Guard: holding Command in draw mode lets the clicks through to the page (changing a slide, following a link); releasing it draws again. Without the
  // Command in the hold keys, the layer would take every click of the page while Command is down.
  it('while Command is held in draw mode, the layer takes no pointer; releasing it draws again', () => {
    const win = stubWindow()
    run(win, 'mount', PEN_DRAW)
    key(win, 'keydown', 'Meta')
    expect(hostOf(win).style['pointerEvents']).toBe('none')
    key(win, 'keyup', 'Meta')
    expect(hostOf(win).style['pointerEvents']).toBe('auto')
  })

  // Guard: a blur of the window (Command released in another application) takes the hold back: the layer draws again.
  it('a blur of the window ends the Command hold', () => {
    const win = stubWindow()
    run(win, 'mount', PEN_DRAW)
    key(win, 'keydown', 'Meta')
    win.dispatch('blur', {})
    expect(hostOf(win).style['pointerEvents']).toBe('auto')
    // The Command released in the other application is not remembered: Control alone, later, holds and releases on its own.
    key(win, 'keydown', 'Control')
    key(win, 'keyup', 'Control')
    expect(hostOf(win).style['pointerEvents']).toBe('auto')
  })

  // Guard: Control and Command together: releasing one keeps the pass-through until the other is released too.
  it('with Control and Command both held, releasing one keeps the pass-through', () => {
    const win = stubWindow()
    run(win, 'mount', PEN_DRAW)
    key(win, 'keydown', 'Control')
    key(win, 'keydown', 'Meta')
    key(win, 'keyup', 'Control')
    expect(hostOf(win).style['pointerEvents']).toBe('none')
    key(win, 'keyup', 'Meta')
    expect(hostOf(win).style['pointerEvents']).toBe('auto')
  })

  // Guard: Control alone behaves as before: held, the pass-through; released, the drawing. Command is not needed for it.
  it('Control alone keeps its behaviour', () => {
    const win = stubWindow()
    run(win, 'mount', PEN_DRAW)
    key(win, 'keydown', 'Control')
    expect(hostOf(win).style['pointerEvents']).toBe('none')
    key(win, 'keyup', 'Control')
    expect(hostOf(win).style['pointerEvents']).toBe('auto')
  })

  // Guard: a stroke in progress is ended when Command is held, as with Control (what was made is kept, the rest dropped).
  it('a stroke in progress is ended when Command is held', () => {
    const win = stubWindow()
    run(win, 'mount', PEN_DRAW)
    hostOf(win).dispatch('pointerdown', { clientX: 10, clientY: 10 })
    hostOf(win).dispatch('pointermove', { clientX: 200, clientY: 200 })
    key(win, 'keydown', 'Meta')
    expect(drawn(win)).toBe(0)
  })
})

describe('the laser and the pointer', () => {
  const LASER: PageLayerConfig = { mode: 'draw', brush: { tool: 'laser', color: '#e53935', width: 5 } }
  const POINTER: PageLayerConfig = { mode: 'draw', brush: { tool: 'pointer', color: '#1e88e5', width: 5 } }
  /** The picture of the laser and the pointer: the second svg of the layer, over the drawing. */
  const ghostOf = (win: StubWindow) => hostOf(win).shadow!.children[1]!
  /** The drawn shapes of the picture (the gradient of the halo, in defs, is not a shape). */
  const shapesOf = (win: StubWindow) => ghostOf(win).children.filter((child) => child.tagName !== 'defs')
  const moveTo = (win: StubWindow, x: number, y: number) => hostOf(win).dispatch('pointermove', { clientX: x, clientY: y })
  /** Runs `body` with a clock the test moves: the fade and the timer of the layer follow it. */
  function withClock(body: () => void): void {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      body()
    } finally {
      vi.useRealTimers()
    }
  }

  // Guard: the laser keeps nothing: its points are not elements, so the drawing stays empty and there is nothing in the history to undo.
  // Without the split, the laser would be a stroke of the drawing, and the clear would take it.
  it('the laser follows the pointer, pressed or not, and draws no element', () => {
    const win = stubWindow()
    run(win, 'mount', LASER)
    moveTo(win, 10, 10)
    moveTo(win, 200, 200)
    expect(drawn(win)).toBe(0)
    expect(shapesOf(win).length).toBeGreaterThan(0)
    expect(run(win, 'undo')).toBe(true)
    expect(drawn(win)).toBe(0)
  })

  // Guard: the trail fades in 1.5 s and is then gone, and the timer stops with it. Without the life limit, the trail would stay on the page.
  // Guard: the trail of the net look fades over 0.9 s, and then only the trail is gone: the point stays where the pointer stopped (the net look
  // keeps it); the fade timer stops with the trail. Without the life of the net look, the trail would last 0.6 s, the old duration.
  it('the net trail fades over 0.9 s, then is gone; the net point stays and the fade timer stops', () => {
    withClock(() => {
      const win = stubWindow()
      run(win, 'mount', LASER)
      moveTo(win, 10, 10)
      moveTo(win, 200, 200)
      expect(shapesOf(win).length).toBe(4)
      vi.advanceTimersByTime(450)
      expect(Number(shapesOf(win)[0]!.attributes['opacity'])).toBeCloseTo(0.5, 2)
      vi.advanceTimersByTime(500)
      expect(shapesOf(win).filter((child) => child.tagName === 'line')).toHaveLength(0)
      expect(shapesOf(win).length).toBe(3)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  // Guard: the clear of the drawing does not take the laser or the pointer: they are not drawing (the clear is about the drawing).
  it('the clear of the drawing does not take the laser nor the pointer', () => {
    const win = stubWindow()
    run(win, 'mount', POINTER)
    moveTo(win, 50, 50)
    run(win, 'clear')
    expect(shapesOf(win).length).toBe(1)
  })

  // Guard: the pointer is a circle that follows the pointer and does not fade. Without the cursor, nothing shows the place.
  it('the pointer is a circle at the pointer, which does not fade and draws no element', () => {
    withClock(() => {
      const win = stubWindow({ width: 1000, height: 500 })
      run(win, 'mount', POINTER)
      moveTo(win, 500, 250)
      expect(drawn(win)).toBe(0)
      const circle = shapesOf(win).find((child) => child.tagName === 'circle')!
      expect(circle.tagName).toBe('circle')
      expect(circle.attributes['cx']).toBe('500')
      expect(circle.attributes['cy']).toBe('250')
      vi.advanceTimersByTime(5000)
      expect(shapesOf(win).length).toBe(1)
    })
  })

  // Guard: a tool other than the laser or the pointer leaves their picture: nothing of them stays on the page when the pen is taken.
  it('choosing another tool takes the laser trail and the pointer away', () => {
    const win = stubWindow()
    run(win, 'mount', POINTER)
    moveTo(win, 50, 50)
    run(win, 'apply', PEN)
    expect(shapesOf(win).length).toBe(0)
  })
})

describe('the look of the laser', () => {
  const LASER: PageLayerConfig = { mode: 'draw', brush: { tool: 'laser', color: '#e53935', width: 5 } }
  const ghostOf = (win: StubWindow) => hostOf(win).shadow!.children[1]!

  // Guard: the light look has a soft halo filled with a gradient of its colour (in defs), and the glow circle is filled with it. Without the gradient,
  // the point would be a flat dot.
  it('the light look has a soft halo filled with a gradient of its colour', () => {
    const win = stubWindow()
    run(win, 'mount', { ...LASER, laser: 'lumiere' })
    hostOf(win).dispatch('pointermove', { clientX: 300, clientY: 200 })
    const gradient = ghostOf(win).children.find((child) => child.tagName === 'defs')!.children[0]!
    expect(gradient.tagName).toBe('radialGradient')
    expect(gradient.children.map((stop) => stop.attributes['stop-color'])).toEqual(['#e53935', '#e53935', '#e53935', '#e53935'])
    const halo = ghostOf(win).children.find((child) => child.attributes['fill'] === 'url(#lucium-laser-halo)' && Number(child.attributes['r']) === 16)
    expect(halo).toBeDefined()
  })

  // Guard: each look draws its own point: the net one a solid point with a rim and a highlight (no halo), the subtle one a small point with a faint
  // halo, the light one a white point in a wider coloured halo with a glow. Without the look table, the three would be the same.
  it('draws each look with its own point, rim, halo and glow', () => {
    const drawWith = (laser: string) => {
      const win = stubWindow()
      run(win, 'mount', { ...LASER, laser })
      hostOf(win).dispatch('pointermove', { clientX: 300, clientY: 200 })
      return ghostOf(win).children.filter((child) => child.tagName === 'circle')
    }
    const net = drawWith('net')
    const discret = drawWith('discret')
    const lumiere = drawWith('lumiere')
    expect(net.map((c) => Number(c.attributes['r']))).toEqual([3, 3.5, 1.2])
    expect(net[0]!.attributes['fill']).toBe('#e53935')
    expect(net[1]!.attributes['fill']).toBe('none')
    expect(discret.map((c) => Number(c.attributes['r']))).toEqual([4, 1.75, 1.2])
    expect(lumiere.map((c) => Number(c.attributes['r']))).toEqual([30, 16, 2.25, 1.2])
    expect(lumiere.find((c) => Number(c.attributes['r']) === 2.25)!.attributes['fill']).toBe('#ffffff')
  })

  // Guard: the discret and the light trails last their own life (0.55 s and 1 s) and their point goes with them: only the net point stays.
  it('the discret and the light trails fade out with their point after their own life', () => {
    for (const [laser, life] of [['discret', 550], ['lumiere', 1000]] as const) {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      try {
        const win = stubWindow()
        run(win, 'mount', { ...LASER, laser })
        hostOf(win).dispatch('pointermove', { clientX: 10, clientY: 10 })
        hostOf(win).dispatch('pointermove', { clientX: 200, clientY: 200 })
        vi.advanceTimersByTime(life - 100)
        expect(ghostOf(win).children.filter((child) => child.tagName === 'line').length).toBe(1)
        vi.advanceTimersByTime(200)
        expect(ghostOf(win).children.filter((child) => child.tagName !== 'defs')).toHaveLength(0)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  })

  // Guard: the trail is thinner than before (4 px) and tapers: the newest segment is the thickest, an older one is thinner.
  it('the trail is a thin line that tapers with age', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const win = stubWindow()
      run(win, 'mount', LASER)
      hostOf(win).dispatch('pointermove', { clientX: 10, clientY: 10 })
      vi.advanceTimersByTime(300)
      hostOf(win).dispatch('pointermove', { clientX: 200, clientY: 200 })
      vi.advanceTimersByTime(50)
      hostOf(win).dispatch('pointermove', { clientX: 300, clientY: 300 })
      const segments = ghostOf(win).children.filter((child) => child.tagName === 'line')
      expect(segments).toHaveLength(2)
      const older = Number(segments[0]!.attributes['stroke-width'])
      const newer = Number(segments[1]!.attributes['stroke-width'])
      expect(newer).toBeGreaterThan(older)
      expect(newer).toBeLessThan(4)
    } finally {
      vi.useRealTimers()
    }
  })
})

// The automatic clearing: the layer keeps the time of the last activity and answers main's clock (`expire`) with the time to wait before it asks again. The
// test is that clock: it sets the time the layer reads (Date.now) and asks. The layer makes no timer of its own (a timer of the page's window).
describe('the automatic clearing', () => {
  const DELAY = 3000
  const FADE = 400
  const CLEARING: PageLayerConfig = { ...PEN, autoClear: DELAY }
  const RECTANGLE: PageLayerConfig = { mode: 'draw', brush: { tool: 'rectangle', color: '#e53935', width: 5 }, autoClear: DELAY }
  const LASER: PageLayerConfig = { mode: 'draw', brush: { tool: 'laser', color: '#e53935', width: 5 }, autoClear: DELAY }
  const BLUE: PageLayerConfig = { ...CLEARING, brush: { ...PEN.brush, color: '#1e88e5' } }
  /** The opacity and the transition of the drawing: under the closed shadow root, never on the host. */
  const fadeOf = (win: StubWindow): { opacity: string; transition: string } => ({ opacity: svgOf(win).style['opacity'] ?? '', transition: svgOf(win).style['transition'] ?? '' })
  /** Main's clock asks the layer at the time `ms` of the test (from 0). */
  const expireAt = (win: StubWindow, ms: number): boolean | number => {
    vi.setSystemTime(ms)
    return run(win, 'expire')
  }
  /** Runs `body` with a clock the test sets. */
  function withClock(body: () => void): void {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      body()
      // The layer made no timer: nothing of the clearing lives in the page's window but its state.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  }
  /** A layer with one stroke drawn at the time 0, the clearing as `config` says. */
  function drawnLayer(config: PageLayerConfig = CLEARING): StubWindow {
    const win = stubWindow()
    run(win, 'mount', config)
    stroke(win, [10, 10], [200, 200])
    expect(drawn(win)).toBe(1)
    return win
  }

  // Guard: off is the default. Without the check of the delay, a layer told nothing would clear its marks, and main would be asked to come back.
  it('clears nothing when the setting is off, and tells main to stop asking', () => {
    withClock(() => {
      const win = drawnLayer(PEN)
      expect(expireAt(win, 10 * 60_000)).toBe(0)
      expect(drawn(win)).toBe(1)
    })
  })

  // Guard: the marks fade once the delay is over, without a question, then go at the next ask; not before. The answer is the time left, to the millisecond.
  it('says what is left of the delay, fades the marks at its end, and clears them once the fade is over', () => {
    withClock(() => {
      const win = drawnLayer()
      expect(expireAt(win, 1000)).toBe(2000)
      expect(expireAt(win, DELAY - 1)).toBe(1)
      expect(drawn(win)).toBe(1)
      expect(fadeOf(win)).toEqual({ opacity: '', transition: '' })
      expect(expireAt(win, DELAY)).toBe(FADE)
      expect(drawn(win)).toBe(1)
      expect(fadeOf(win)).toEqual({ opacity: '0', transition: `opacity ${FADE}ms linear` })
      expect(expireAt(win, DELAY + FADE)).toBe(DELAY)
      expect(drawn(win)).toBe(0)
      expect(fadeOf(win)).toEqual({ opacity: '', transition: '' })
      // Nothing to clear: main is told to come back a delay later.
      expect(expireAt(win, DELAY * 3)).toBe(DELAY)
    })
  })

  // Guard: the fade is drawn under the closed shadow root. Fading the host instead would show the page, in its own document, when the clock runs out.
  it('fades under the closed shadow root: the host the page can see does not change', () => {
    withClock(() => {
      const win = drawnLayer()
      const before = JSON.stringify(hostOf(win).style)
      expireAt(win, DELAY)
      expect(fadeOf(win).opacity).toBe('0')
      expect(JSON.stringify(hostOf(win).style)).toBe(before)
    })
  })

  // Each kind of activity starts the delay again: a new mark, a press on the layer (a click that makes no shape, a press of another button), a colour, a tool
  // or the Cursor chosen in the bar (an `apply`, also what main sends for the key of a tool), an undo, a redo. Guard of each: without the call that marks it
  // as activity, the marks would fade a delay after the last stroke.
  const activities: Array<[string, (win: StubWindow) => void]> = [
    ['a new stroke', (win) => stroke(win, [300, 300], [400, 400])],
    ['a press of the secondary button on the layer', (win) => hostOf(win).dispatch('pointerdown', { clientX: 50, clientY: 50, button: 2 })],
    [
      'a click that makes no shape',
      (win) => {
        // The layer of this case draws rectangles: a click without a move makes none.
        hostOf(win).dispatch('pointerdown', { clientX: 50, clientY: 50 })
        hostOf(win).dispatch('pointerup', {})
      }
    ],
    ['a colour chosen in the bar', (win) => run(win, 'apply', BLUE)],
    ['a tool chosen (in the bar, or by its key, which main applies)', (win) => run(win, 'apply', RECTANGLE)],
    ['the Cursor chosen', (win) => run(win, 'apply', { ...CLEARING, mode: 'pass' })],
    ['an undo', (win) => run(win, 'undo')],
    ['a redo with nothing to redo', (win) => run(win, 'redo')]
  ]
  it.each(activities)('starts the delay again on %s', (name, act) => {
    withClock(() => {
      const win = drawnLayer(name === 'a click that makes no shape' ? RECTANGLE : CLEARING)
      // A second mark, so that an undo still leaves one to clear.
      stroke(win, [20, 300], [220, 400])
      vi.setSystemTime(2500)
      act(win)
      expect(expireAt(win, DELAY)).toBe(2500)
      expect(expireAt(win, 2500 + DELAY - 1)).toBe(1)
      expect(fadeOf(win).opacity).toBe('')
      expect(drawn(win)).toBeGreaterThan(0)
      expect(expireAt(win, 2500 + DELAY)).toBe(FADE)
      expect(expireAt(win, 2500 + DELAY + FADE)).toBe(DELAY)
      expect(drawn(win)).toBe(0)
    })
  })

  // Guard: a pointer that moves while it draws holds the marks, and a gesture held past the delay is not cut short: the delay counts from its end.
  it('holds the marks while the pointer draws, and counts from the end of the gesture', () => {
    withClock(() => {
      const win = drawnLayer()
      vi.setSystemTime(1000)
      hostOf(win).dispatch('pointerdown', { clientX: 300, clientY: 300 })
      vi.setSystemTime(2500)
      hostOf(win).dispatch('pointermove', { clientX: 320, clientY: 300 })
      expect(expireAt(win, 4000)).toBe(DELAY)
      // The press held still past the delay: nothing goes while the gesture is under way.
      expect(expireAt(win, 9000)).toBe(DELAY)
      expect(fadeOf(win).opacity).toBe('')
      vi.setSystemTime(9500)
      hostOf(win).dispatch('pointerup', {})
      expect(drawn(win)).toBe(2)
      expect(expireAt(win, 9500 + DELAY - 1)).toBe(1)
      expect(expireAt(win, 9500 + DELAY)).toBe(FADE)
    })
  })

  // Guard: the end of a gesture is activity, even when it leaves no mark: a press held still past the delay and let go without a shape counts from its
  // release. Without it, the delay would count from main's last ask during the press, and the marks would fade a moment after the release.
  it('counts from the release of a press held still that makes no shape', () => {
    withClock(() => {
      const win = drawnLayer()
      run(win, 'apply', RECTANGLE)
      vi.setSystemTime(1000)
      hostOf(win).dispatch('pointerdown', { clientX: 300, clientY: 300 })
      expect(expireAt(win, 4000)).toBe(DELAY)
      expect(expireAt(win, 7000)).toBe(DELAY)
      vi.setSystemTime(9500)
      hostOf(win).dispatch('pointerup', {})
      expect(drawn(win)).toBe(1)
      expect(expireAt(win, 10_000)).toBe(DELAY - 500)
    })
  })

  // Guard: a pointer that only wanders over the layer, without drawing, is no activity. Without the check of the gesture in `move`, a hand left on the mouse
  // would keep the marks for ever.
  it('does not start the delay again for a pointer that wanders without drawing', () => {
    withClock(() => {
      const win = drawnLayer()
      for (let at = 100; at < DELAY; at += 100) {
        vi.setSystemTime(at)
        hostOf(win).dispatch('pointermove', { clientX: 500 + at / 100, clientY: 100 })
      }
      expect(expireAt(win, DELAY)).toBe(FADE)
    })
  })

  // Guard: the laser and the pointer show a place while they move, without drawing: that is activity, and the marks stay while they are used.
  it('starts the delay again while the laser moves', () => {
    withClock(() => {
      const win = drawnLayer()
      run(win, 'apply', LASER)
      for (let at = 1000; at <= 6000; at += 1000) {
        vi.setSystemTime(at)
        hostOf(win).dispatch('pointermove', { clientX: 500 + at / 100, clientY: 100 })
      }
      expect(expireAt(win, 6000 + DELAY - 1)).toBe(1)
      expect(expireAt(win, 6000 + DELAY)).toBe(FADE)
      // The trail of the laser fades on a timer of its own (as before the clearing): let it end.
      vi.advanceTimersByTime(2000)
    })
  })

  // Guard: activity during the fade calls it off: the marks are whole again, and the next ask of main finds a delay to wait, not marks to clear.
  it('calls the fade off when the person draws again', () => {
    withClock(() => {
      const win = drawnLayer()
      expect(expireAt(win, DELAY)).toBe(FADE)
      vi.setSystemTime(DELAY + 200)
      stroke(win, [300, 300], [400, 400])
      expect(fadeOf(win)).toEqual({ opacity: '', transition: '' })
      expect(expireAt(win, DELAY + FADE)).toBe(DELAY - 200)
      expect(drawn(win)).toBe(2)
    })
  })

  // Guard: the clearing is one step of the history, as « Page »: ⌘Z brings the marks back, and they wait a whole delay again before they go.
  it('is undone by ⌘Z, and what is brought back waits a whole delay again', () => {
    withClock(() => {
      const win = drawnLayer()
      stroke(win, [300, 300], [400, 400])
      expireAt(win, DELAY)
      expireAt(win, DELAY + FADE)
      expect(drawn(win)).toBe(0)
      vi.setSystemTime(5000)
      expect(run(win, 'undo')).toBe(true)
      expect(drawn(win)).toBe(2)
      expect(expireAt(win, 5000 + DELAY - 1)).toBe(1)
      expect(expireAt(win, 5000 + DELAY)).toBe(FADE)
      expireAt(win, 5000 + DELAY + FADE)
      expect(drawn(win)).toBe(0)
      // A second undo brings them back again: each clearing is a step of its own.
      run(win, 'undo')
      expect(drawn(win)).toBe(2)
    })
  })

  // Guard: a text box open is never cleared, and holds the other marks: what is being written stays, and the delay counts from the end of the box.
  it('never clears while a text box is open, and counts from its end', () => {
    withClock(() => {
      const win = drawnLayer()
      run(win, 'apply', { ...CLEARING, brush: { ...PEN.brush, tool: 'text' } })
      hostOf(win).dispatch('pointerdown', { clientX: 100, clientY: 100 })
      const box = hostOf(win).shadow!.children.find((child) => child.tagName === 'input')!
      box.value = 'Relu'
      expect(expireAt(win, DELAY * 5)).toBe(DELAY)
      expect(drawn(win)).toBe(1)
      expect(hostOf(win).shadow!.children.includes(box)).toBe(true)
      vi.setSystemTime(DELAY * 6)
      box.dispatch('keydown', { key: 'Enter' })
      expect(drawn(win)).toBe(2)
      expect(expireAt(win, DELAY * 7 - 1)).toBe(1)
      expect(expireAt(win, DELAY * 7)).toBe(FADE)
    })
  })

  // Guard: the setting switched off on the way (the bar's button, the Settings) calls a fade under way off, and main is told to stop asking.
  it('stops when the setting is switched off on the way, even during the fade', () => {
    withClock(() => {
      const win = drawnLayer()
      expect(expireAt(win, DELAY)).toBe(FADE)
      run(win, 'apply', PEN)
      expect(fadeOf(win)).toEqual({ opacity: '', transition: '' })
      expect(expireAt(win, DELAY + FADE)).toBe(0)
      expect(expireAt(win, DELAY * 10)).toBe(0)
      expect(drawn(win)).toBe(1)
    })
  })

  // Guard: a choice in the bar is activity on the page on screen, not on a hidden one, which only takes the new delay; a hidden page's marks go without a fade.
  it('takes a new delay on a hidden page without counting the choice as activity there', () => {
    withClock(() => {
      const win = drawnLayer()
      run(win, 'hide')
      vi.setSystemTime(2000)
      run(win, 'apply', { ...CLEARING, autoClear: 10_000 })
      expect(expireAt(win, 2000)).toBe(8000)
      expect(expireAt(win, 10_000)).toBe(10_000)
      expect(drawn(win)).toBe(0)
      // Shown again, the page's own history brings them back.
      run(win, 'show', CLEARING)
      run(win, 'undo')
      expect(drawn(win)).toBe(1)
    })
  })

  // Guard: coming back on screen is no activity: the delay goes on from the last one. A fade that the hiding of the page interrupts ends: the marks go.
  it('does not count a return on screen as activity, and ends a fade when the page is hidden', () => {
    withClock(() => {
      const win = drawnLayer()
      run(win, 'hide')
      vi.setSystemTime(2000)
      run(win, 'show', CLEARING)
      expect(expireAt(win, 2000)).toBe(1000)
      expect(expireAt(win, DELAY)).toBe(FADE)
      run(win, 'hide')
      expect(drawn(win)).toBe(0)
      expect(fadeOf(win).opacity).toBe('')
    })
  })

  // Guard: the system's wish of less motion, and Lucium's own setting, clear at once at the end of the delay: no fade.
  it('clears without a fade when less motion is asked for', () => {
    withClock(() => {
      const reduced = Object.assign(stubWindow(), { matchMedia: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }) })
      run(reduced, 'mount', CLEARING)
      stroke(reduced, [10, 10], [200, 200])
      const still = drawnLayer({ ...CLEARING, still: true })
      const moving = drawnLayer()
      expect(expireAt(reduced, DELAY)).toBe(DELAY)
      expect(drawn(reduced)).toBe(0)
      expect(run(still, 'expire')).toBe(DELAY)
      expect(drawn(still)).toBe(0)
      // A window that asks for none of that fades.
      expect(run(moving, 'expire')).toBe(FADE)
      expect(drawn(moving)).toBe(1)
    })
  })

  // Guard: the delay main sends is a number of milliseconds within bounds: nothing else turns the clearing on, and a huge one does not make main's timer fire at
  // once (a timer past 2^31 ms runs at once).
  it('takes only a positive delay, and bounds a huge one', () => {
    withClock(() => {
      for (const bad of [0, -5, Number.NaN, '3000', null]) {
        const win = drawnLayer({ ...PEN, autoClear: bad as never })
        expect(expireAt(win, 60_000), String(bad)).toBe(0)
        expect(drawn(win), String(bad)).toBe(1)
      }
      vi.setSystemTime(0)
      const huge = drawnLayer({ ...PEN, autoClear: 2 ** 40 })
      expect(run(huge, 'expire')).toBe(3_600_000)
    })
  })

  // Guard: a page that has no layer (taken away, or a new document) answers false: main's clock of that page stops.
  it('answers false when the layer is gone', () => {
    withClock(() => {
      const win = drawnLayer()
      run(win, 'remove')
      expect(run(win, 'expire')).toBe(false)
    })
  })
})
