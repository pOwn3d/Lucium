import { describe, expect, it } from 'vitest'
import { DEFAULT_BAR_HUE, barHue, DEFAULT_LASER_STYLE, DEFAULT_PAGE_BRUSH, LASER_STYLES, PAGE_EPHEMERAL_TOOLS, PAGE_SHORTCUT, PAGE_TOGGLE_SHORTCUT, annotateToolbarFlag, canAnnotateHere, isLaserStyle, isBarDrag, isBarMenuAnchor, BAR_DRAG_PHASES, sameWindow, windowNumber, PAGE_TOOLS, PAGE_TOOL_KEYS, injectableUrl, isPageBrush, isPageEdit, isPageMode, pageKeyAction, sharesOwnWindow } from './page-annotate'

/** A key press of the page, as the rule reads it. */
const key = (k: string, modifiers: Record<string, boolean> = {}) => ({ type: 'keyDown' as const, key: k, meta: false, control: false, alt: false, shift: false, ...modifiers })

describe('what the command window may send', () => {
  it('takes a brush of the palette only: a tool of the layer, one of the colours, one of the thicknesses', () => {
    expect(isPageBrush(DEFAULT_PAGE_BRUSH)).toBe(true)
    // Guard: the text tool is gone from the bar (the maintainer does not use it): a brush with it is refused. Without the removal, it would pass.
    expect(isPageBrush({ tool: 'text', color: '#ffffff', width: 10 })).toBe(false)
    expect(isPageBrush({ tool: 'eraser', color: '#ffffff', width: 10 })).toBe(true)
    // Guard: the selection of the window share is not a tool of the page layer. Without the tool check, `select` would pass.
    expect(isPageBrush({ tool: 'select', color: '#e53935', width: 5 })).toBe(false)
    expect(isPageBrush({ tool: 'pen', color: '#000000', width: 5 })).toBe(false)
    expect(isPageBrush({ tool: 'pen', color: '#e53935', width: 7 })).toBe(false)
    expect(isPageBrush(null)).toBe(false)
  })

  it('takes a mode and an edit of the list only', () => {
    expect(isPageMode('draw')).toBe(true)
    expect(isPageMode('pass')).toBe(true)
    expect(isPageMode('select')).toBe(false)
    expect(isPageEdit('undo')).toBe(true)
    expect(isPageEdit('remove')).toBe(false)
  })
})

describe('which pages take a layer', () => {
  // Guard: only web addresses are injectable. Without the scheme check, the pages of Lucium and the files would be refused by the page instead of by the rule.
  it('takes the web pages, http and https', () => {
    expect(injectableUrl('https://example.org/article?x=1')).toBe(true)
    expect(injectableUrl('http://intranet/page')).toBe(true)
  })

  it('refuses the pages of Lucium, the files, the extensions and the internal pages', () => {
    expect(injectableUrl('lucium://settings')).toBe(false)
    expect(injectableUrl('file:///Users/me/notes.html')).toBe(false)
    expect(injectableUrl('chrome-extension://abc/popup.html')).toBe(false)
    expect(injectableUrl('about:blank')).toBe(false)
    expect(injectableUrl('chrome-error://chromewebdata/')).toBe(false)
    expect(injectableUrl('https://')).toBe(false)
    expect(injectableUrl('')).toBe(false)
  })
})

describe('the shortcuts', () => {
  it('⌥⌘P switches the mode, and ⌥⌘M starts and stops the annotation (not the same key)', () => {
    expect(PAGE_SHORTCUT).toBe('Alt+CmdOrCtrl+P')
    expect(PAGE_TOGGLE_SHORTCUT).toBe('Alt+CmdOrCtrl+M')
    expect(PAGE_TOGGLE_SHORTCUT).not.toBe(PAGE_SHORTCUT)
  })
})

describe('the keys of the bar', () => {

  it('a letter picks its tool in draw mode', () => {
    expect(pageKeyAction(key('p'), 'draw')).toEqual({ kind: 'tool', tool: 'pen' })
    expect(pageKeyAction(key('H'), 'draw')).toEqual({ kind: 'tool', tool: 'highlighter' })
    expect(pageKeyAction(key('d'), 'draw')).toEqual({ kind: 'tool', tool: 'diamond' })
    expect(pageKeyAction(key('a'), 'draw')).toEqual({ kind: 'tool', tool: 'arrow' })
    // Guard: X clears every page (as ⇧⌥⌘⌫), and the eraser has no letter: it is a tool of the bar only. Without the X branch, X would pick nothing.
    expect(pageKeyAction(key('x'), 'draw')).toEqual({ kind: 'edit', command: 'clear-all' })
    expect(pageKeyAction(key('x'), 'pass')).toBeNull()
    expect(Object.values(PAGE_TOOL_KEYS)).not.toContain('eraser')
    expect(Object.values(PAGE_TOOL_KEYS)).not.toContain('text')
    // Guard: E clears the page on screen, it is not the eraser tool any more. Without the E branch, E would pick nothing.
    expect(pageKeyAction(key('e'), 'draw')).toEqual({ kind: 'edit', command: 'clear' })
    expect(pageKeyAction(key('e'), 'pass')).toBeNull()
  })

  // Guard: the setting `annotateLetterKeys` off leaves every key of one letter to the page, and nothing else: X (every page of the session) and E included.
  // Without the `letters` check, a person who switched the letters off would still lose their pages to a key pressed by reflex.
  it('takes no letter at all when the keys of one letter are off, and keeps every other key', () => {
    for (const letter of [...Object.keys(PAGE_TOOL_KEYS), 'e', 'x']) {
      expect(pageKeyAction(key(letter), 'draw', true), letter).not.toBeNull()
      expect(pageKeyAction(key(letter), 'draw', false), letter).toBeNull()
    }
    expect(pageKeyAction(key('z', { meta: true }), 'draw', false)).toEqual({ kind: 'edit', command: 'undo' })
    expect(pageKeyAction(key('Z', { meta: true, shift: true }), 'pass', false)).toEqual({ kind: 'edit', command: 'redo' })
    expect(pageKeyAction(key('Escape'), 'draw', false)).toEqual({ kind: 'stop' })
    expect(pageKeyAction(key('Backspace', { meta: true, alt: true }), 'draw', false)).toEqual({ kind: 'edit', command: 'clear' })
    expect(pageKeyAction(key('Backspace', { meta: true, alt: true, shift: true }), 'draw', false)).toEqual({ kind: 'edit', command: 'clear-all' })
  })

  // Guard: the letters are for the draw mode only; in pass mode they belong to the page.
  it('a letter is not taken in pass mode, nor with a modifier or with Shift', () => {
    expect(pageKeyAction(key('p'), 'pass')).toBeNull()
    expect(pageKeyAction(key('p', { meta: true }), 'draw')).toBeNull()
    expect(pageKeyAction(key('P', { shift: true }), 'draw')).toBeNull()
    expect(pageKeyAction(key('v'), 'draw')).toBeNull()
  })

  it('⌥ is never ours, and a key release is nothing', () => {
    expect(pageKeyAction(key('p', { alt: true }), 'draw')).toBeNull()
    expect(pageKeyAction({ ...key('p'), type: 'keyUp' }, 'draw')).toBeNull()
  })

  it('⌘Z, ⇧⌘Z edit the drawing in either mode; Échap ends the annotation', () => {
    expect(pageKeyAction(key('z', { meta: true }), 'pass')).toEqual({ kind: 'edit', command: 'undo' })
    expect(pageKeyAction(key('Z', { meta: true, shift: true }), 'draw')).toEqual({ kind: 'edit', command: 'redo' })
    expect(pageKeyAction(key('Escape'), 'pass')).toEqual({ kind: 'stop' })
  })

  // Guard: ⌥⌘⌫ clears the page on screen and ⇧⌥⌘⌫ every page; the scope is the only difference. Without the alt branch, neither would work.
  it('⌥⌘⌫ clears this page and ⇧⌥⌘⌫ clears all pages, in either mode', () => {
    expect(pageKeyAction(key('Backspace', { meta: true, alt: true }), 'draw')).toEqual({ kind: 'edit', command: 'clear' })
    expect(pageKeyAction(key('Backspace', { meta: true, alt: true }), 'pass')).toEqual({ kind: 'edit', command: 'clear' })
    expect(pageKeyAction(key('Backspace', { meta: true, alt: true, shift: true }), 'draw')).toEqual({ kind: 'edit', command: 'clear-all' })
  })

  // Guard: ⇧⌘⌫ (the former shortcut of the clear) and ⌥⌫ alone are not ours.
  it('⇧⌘⌫ and ⌥⌫ without ⌘ are not taken', () => {
    expect(pageKeyAction(key('Backspace', { meta: true, shift: true }), 'draw')).toBeNull()
    expect(pageKeyAction(key('Backspace', { alt: true }), 'draw')).toBeNull()
  })
})

describe('the window of the annotation', () => {
  // Guard: with no shared window any window with a source may start it; once one is shared only that window may, and an unknown window never.
  it('a window starts the annotation when none is shared, or when it is the shared one; the others and an unknown window do not', () => {
    expect(canAnnotateHere('win-1', null)).toBe(true)
    expect(canAnnotateHere('win-1', 'win-1')).toBe(true)
    expect(canAnnotateHere('window:12:0', 'window:12:1')).toBe(true)
    expect(canAnnotateHere('window:13:0', 'window:12:0')).toBe(false)
    expect(canAnnotateHere('win-2', 'win-1')).toBe(false)
    // Guard: two ids without a window number are compared as text: 'win-2' is not 'win-1' (both numbers are null, and null is not a number).
    expect(sameWindow('win-2', 'win-1')).toBe(false)
    expect(sameWindow('win-1', 'win-1')).toBe(true)
    expect(canAnnotateHere(null, null)).toBe(false)
    expect(canAnnotateHere('', null)).toBe(false)
  })
})

describe('the source of the sharing', () => {
  // Guard: only the window of Lucium itself starts the annotation. Without the comparison, another application's window would too.
  it('the window of Lucium is the chosen source; another source, none, or no own window is not', () => {
    expect(sharesOwnWindow('window:12:0', 'window:12:0')).toBe(true)
    expect(sharesOwnWindow('window:99:0', 'window:12:0')).toBe(false)
    expect(sharesOwnWindow(null, 'window:12:0')).toBe(false)
    expect(sharesOwnWindow('window:12:0', null)).toBe(false)
    expect(sharesOwnWindow('window:12:0', '')).toBe(false)
  })

  // Guard: the window is named by its number, not by the whole text of its id: the same number in another format is the same window.
  // Without the number comparison, a difference of format (suffix, leading zeros, spaces) would hide the window of Lucium.
  it('compares the number of the window: the same number in another format is the same window', () => {
    expect(sharesOwnWindow('window:12:0', 'window:12:1')).toBe(true)
    expect(sharesOwnWindow('window:12', 'window:12:0')).toBe(true)
    expect(sharesOwnWindow('window:012:0', 'window:12:0')).toBe(true)
    expect(sharesOwnWindow(' window:12:0 ', 'window:12:0')).toBe(true)
  })

  // Guard: another window (another number), a screen with the same number, and an unreadable id are not Lucium's window.
  it('refuses another window, a screen, and an id it cannot read', () => {
    expect(sharesOwnWindow('window:13:0', 'window:12:0')).toBe(false)
    expect(sharesOwnWindow('screen:12:0', 'window:12:0')).toBe(false)
    expect(sharesOwnWindow('window:abc:0', 'window:abc:0')).toBe(false)
    expect(windowNumber('window:7:0')).toBe('7')
    expect(windowNumber('screen:7:0')).toBeNull()
  })
})

describe('the tools', () => {
  it('the diamond is a tool of the bar, with its letter', () => {
    expect(PAGE_TOOLS).toContain('diamond')
    expect(isPageBrush({ tool: 'diamond', color: '#e53935', width: 5 })).toBe(true)
    expect(PAGE_TOOL_KEYS['d']).toBe('diamond')
  })

  // Guard: the laser (K) and the pointer (Q) are tools of the bar in draw mode, and they keep nothing: they are the ephemeral ones.
  it('the laser is K and the pointer is Q, in draw mode only, and both are ephemeral', () => {
    expect(pageKeyAction(key('k'), 'draw')).toEqual({ kind: 'tool', tool: 'laser' })
    expect(pageKeyAction(key('q'), 'draw')).toEqual({ kind: 'tool', tool: 'pointer' })
    expect(pageKeyAction(key('q'), 'pass')).toBeNull()
    expect(isPageBrush({ tool: 'laser', color: '#e53935', width: 5 })).toBe(true)
    expect(PAGE_EPHEMERAL_TOOLS).toEqual(['laser', 'pointer'])
  })

  it('the clear of the page and the clear of all pages are two edits of the list', () => {
    expect(isPageEdit('clear-all')).toBe(true)
    expect(isPageEdit('clear')).toBe(true)
  })
})


describe('the looks of the laser', () => {
  // Guard: three looks, the glow by default; a look outside the list is refused (the window only sends names of the list).
  it('has three looks, the glow by default, and refuses any other name', () => {
    expect(LASER_STYLES).toEqual(['net', 'discret', 'lumiere'])
    expect(DEFAULT_LASER_STYLE).toBe('lumiere')
    expect(isLaserStyle('lumiere')).toBe(true)
    expect(isLaserStyle('classic')).toBe(false)
    expect(isLaserStyle('rainbow')).toBe(false)
    expect(isLaserStyle(undefined)).toBe(false)
  })
})

describe('the button of the toolbar', () => {
  // Guard: the button « Annoter » is there with the flag, at all times (not only while a window is shared), and absent without it: the state
  // carries the flag and nothing else. Without the flag check, the button would show in the production build.
  it('is in the state by default, and absent only with LUCIUM_ANNOTATE=0', () => {
    expect(annotateToolbarFlag({})).toEqual({ annotateEnabled: true })
    expect(annotateToolbarFlag({ LUCIUM_ANNOTATE: '1' })).toEqual({ annotateEnabled: true })
    expect(annotateToolbarFlag({ LUCIUM_ANNOTATE: '0' })).toEqual({})
  })
})

describe('what the grip of the bar may send', () => {
  // Guard: a drag is a phase of the list and a pointer with finite coordinates of a sane size. Without the checks, a page that reached the channel could hand
  // main a text, NaN or an enormous number to place a window with.
  it('takes a phase of the list and a pointer on the screen', () => {
    expect(BAR_DRAG_PHASES).toEqual(['start', 'move', 'end', 'cancel'])
    for (const phase of BAR_DRAG_PHASES) expect(isBarDrag({ phase, x: 120.5, y: -30 })).toBe(true)
    // A second screen above or to the left of the first has negative coordinates.
    expect(isBarDrag({ phase: 'move', x: -1920, y: -1080 })).toBe(true)
  })

  it.each([
    ['null', null],
    ['a text', 'move'],
    ['a phase that is not one', { phase: 'drop', x: 1, y: 1 }],
    ['no phase', { x: 1, y: 1 }],
    ['an x that is a text', { phase: 'move', x: '1', y: 1 }],
    ['a y that is missing', { phase: 'move', x: 1 }],
    ['an x that is NaN', { phase: 'move', x: Number.NaN, y: 1 }],
    ['a y that is infinite', { phase: 'move', x: 1, y: Infinity }],
    ['an x beyond any screen', { phase: 'move', x: 1_000_001, y: 1 }],
    ['a y beyond any screen', { phase: 'move', x: 1, y: -1_000_001 }]
  ])('refuses %s', (_name, raw) => {
    expect(isBarDrag(raw)).toBe(false)
  })

  // Guard: the menu opens at the pointer (null) or at a point of the window; a point before the corner of the window, a text, or a number past any screen is refused.
  it('takes null or a point of the window for the place of the menu', () => {
    expect(isBarMenuAnchor(null)).toBe(true)
    expect(isBarMenuAnchor({ x: 0, y: 0 })).toBe(true)
    expect(isBarMenuAnchor({ x: 12.5, y: 80 })).toBe(true)
    for (const raw of [undefined, 'here', 3, {}, { x: 1 }, { x: '1', y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }, { x: Number.NaN, y: 1 }, { x: 1, y: 1_000_001 }]) expect(isBarMenuAnchor(raw)).toBe(false)
  })
})

describe('the hue of the annotation bar', () => {
  // Guard: the hue goes into a stylesheet (the bar's root, the page of the drop zones): only a whole number of the circle gets there.
  it('is a whole number from 0 to 359, and the hue the tokens start from for anything else', () => {
    expect(barHue(0)).toBe(0)
    expect(barHue(359)).toBe(359)
    expect(barHue(41.4)).toBe(41)
    expect(barHue(359.7)).toBe(0)
    for (const odd of [undefined, null, '30', Number.NaN, Number.POSITIVE_INFINITY, -1, 360, {}]) expect(barHue(odd), String(odd)).toBe(DEFAULT_BAR_HUE)
    expect(DEFAULT_BAR_HUE).toBe(250)
  })
})
