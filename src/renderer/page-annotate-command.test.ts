// The command bar of the page annotation (page-annotate-command.html, page-annotate-command.ts). The script runs against the page as soon as it is loaded
// (no window here): what it shows is worked out in page-annotate-command-view.ts and tested as such. The page is read as a stylesheet: its rules are the
// contract of the layout of the bar, as stylesheets.test.ts does for the sheets of the interface.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { DEFAULT_PAGE_BRUSH, LASER_STYLES, type BarDrag } from '@shared/page-annotate'
import { BAR_LAYOUTS, barMetricVars } from '@shared/annotate-bar'
import html from './page-annotate-command.html?raw'
import { autoClearButton, clearTitles, toolButtonText, hiddenSpan, strokedIcon, type ElementMaker, dismissesHint, gripDrag, gripKeyAction, laserChips, laserSelector, menuAnchorUnder, modeAfterChoice, modeButtonTitle } from './page-annotate-command-view'
import { frenchSpaces } from '@shared/french-typography'

beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

describe('the laser looks in the bar', () => {
  // Guard: the looks are listed, each with its preview (a dot class). Without the list, a look could be missing from the bar while the layer draws it.
  it('has one chip per look the layer draws, in the order of the list, each named', () => {
    const chips = laserChips()
    expect(chips.map((chip) => chip.style)).toEqual([...LASER_STYLES])
    for (const chip of chips) {
      expect(chip.label, chip.style).not.toBe('')
      expect(chip.dotClass.split(' ')).toEqual(['page-annotate-dot', `page-annotate-dot-${chip.style}`])
    }
    // The light look is for dark backgrounds only: its title says so.
    expect(chips.find((chip) => chip.style === 'lumiere')?.title).toBe(t('page-annotate.laser-lumiere-titre'))
  })

  // Guard: a look that the layer draws and the main process keeps (LASER_STYLES) has its preview styled in the page. Without the rule, the chip of a new
  // look is an empty button in the selector.
  it.each(LASER_STYLES)('the page styles the preview of the look %s', (look) => {
    expect(html).toMatch(new RegExp(`\\.page-annotate-dot-${look}\\s*\\{`))
  })

  // Guard: the chosen look is named under the chips; the chips appear only while the laser is the tool.
  it('shows the selector only with the laser, and names the look the main process keeps', () => {
    expect(laserSelector({ brush: { ...DEFAULT_PAGE_BRUSH, tool: 'laser' }, laser: 'discret' })).toEqual({ hidden: false, name: t('page-annotate.laser-discret') })
    expect(laserSelector({ brush: { ...DEFAULT_PAGE_BRUSH, tool: 'pen' }, laser: 'discret' }).hidden).toBe(true)
    for (const look of LASER_STYLES) expect(laserSelector({ brush: { ...DEFAULT_PAGE_BRUSH, tool: 'laser' }, laser: look }).name, look).toBe(laserChips().find((chip) => chip.style === look)?.label)
  })
})

describe('the timer button of the automatic clearing', () => {
  // Guard: the button says its state in its accessible name and shows the delay beside its icon while the clearing is on; off, the icon is alone. Without
  // the name, a screen reader would read a bare icon whose meaning changes with each click.
  it('names its state in a whole sentence and shows the delay while on, in French and in English', () => {
    expect(autoClearButton(0)).toMatchObject({ on: false, text: '', label: t('page-annotate.effacement-auto-desactive') })
    const on = autoClearButton(5)
    expect(on).toMatchObject({ on: true, text: frenchSpaces('5 s'), label: 'Effacement automatique après 5 secondes sans activité' })
    expect(on.title.startsWith(`${on.label} · `)).toBe(true)
    expect(on.title).toContain(frenchSpaces('3, 5, 10, 20, 30 s'))
    setLanguage('en')
    expect(autoClearButton(0).label).toBe('Automatic clearing: off')
    expect(autoClearButton(30)).toMatchObject({ text: '30 s', label: 'Automatic clearing after 30 seconds without activity' })
  })

  // Guard: the button stands with the edits, before Annuler, and the script cycles it through the choices main accepts (shared/annotate-auto-clear.ts).
  it('stands before Annuler, and a click asks main for the next delay', () => {
    expect(html.indexOf('id="page-annotate-timer"')).toBeLessThan(html.indexOf('id="page-annotate-undo"'))
    expect(html.indexOf('class="page-annotate-edits"')).toBeLessThan(html.indexOf('id="page-annotate-timer"'))
    const script = readFileSync(join(__dirname, 'page-annotate-command.ts'), 'utf8')
    expect(script).toContain("timer.addEventListener('click', () => chooseAutoClear(nextAutoClear(state.autoClear)))")
    expect(script).toContain('void api.setAutoClear(value)')
    expect(script).toContain("timer.setAttribute('aria-label', clearing.label)")
  })

  // Guard: on, the button takes the accent of the bar (the roles of tokens.css), as the chosen tool does; in the row it is a tool's width, which the model counts.
  it('is drawn in the accent while on, and is as wide as a tool in the row', () => {
    const on = html.slice(html.indexOf(".page-annotate-timer[data-on='true'],"), html.indexOf('}', html.indexOf(".page-annotate-timer[data-on='true'],")))
    expect(on).toContain('background: var(--accent-soft)')
    expect(on).toContain('color: var(--accent-text)')
    expect(on).toContain('var(--accent)')
    const row = html.slice(html.indexOf(".page-annotate-bar[data-layout='row'] .page-annotate-timer {"), html.indexOf('}', html.indexOf(".page-annotate-bar[data-layout='row'] .page-annotate-timer {")))
    expect(row).toContain('width: var(--pa-tool-w)')
    expect(row).toContain('height: var(--pa-button-h)')
  })
})

describe('the colours of the bar', () => {
  // Guard: the bar takes the hue of the space on screen in the annotated window: its accent (the pressed buttons, the hint) is the one of that window. The hue
  // goes on the root, where tokens.css works the accent out. Without it the bar keeps the blue the tokens start from on every space.
  it('sets the hue main tells it on the root, cleaned, each time it shows the state', () => {
    const script = readFileSync(join(__dirname, 'page-annotate-command.ts'), 'utf8')
    const render = script.slice(script.indexOf('function render(): void {'), script.indexOf("bar.setAttribute('aria-label'"))
    expect(render).toContain("document.documentElement.style.setProperty('--hue', String(barHue(state.hue)))")
    // The page writes no hue of its own over it, and its rules name roles of the tokens.
    expect(html).not.toMatch(/--hue\s*:/)
    expect(html).toContain('var(--accent)')
    const tokens = readFileSync(join(__dirname, 'tokens.css'), 'utf8')
    expect(tokens).toMatch(/\/\* The tokens that hold the hue[^\n]*\*\/\n:root,/)
  })
})

describe('the layout of the bar', () => {
  // Guard: every button of the column has one size (72 × 42): the tools, the mode key and the actions line up. Without the single size, a group
  // would be taller or narrower than the others.
  it('gives every button of the column the same size', () => {
    expect(html).toContain('.page-annotate-key,\n      .page-annotate-tool,\n      .page-annotate-text {\n        width: var(--pa-key-w);\n        height: var(--pa-button-h);')
    expect(barMetricVars()['--pa-key-w']).toBe('72px')
    expect(barMetricVars()['--pa-button-h']).toBe('42px')
    expect(html).not.toContain('height: 36px')
    expect(html).not.toContain('height: 46px')
  })

  // Guard: the actions Annuler, Rétablir, Page, Tout and Quitter share one class (one weight); Quitter is no longer a dark button of its own.
  it('gives the actions and Quitter the same weight', () => {
    for (const id of ['page-annotate-undo', 'page-annotate-redo', 'page-annotate-clear', 'page-annotate-clear-all', 'page-annotate-stop']) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*class="[^"]*page-annotate-text`))
    }
    expect(html).not.toContain('.page-annotate-quit')
  })

  // Guard: the reset of the buttons has no specificity, so that the classes of the bar (the font of the actions, their colour) apply. With the
  // reset at (0,1,1), `.page-annotate-text` and `.page-annotate-danger` lost.
  it('keeps the reset of the buttons below the classes of the bar', () => {
    expect(html).toContain(':where(.page-annotate-bar) button {')
    expect(html).not.toMatch(/(^|\n)\s*\.page-annotate-bar button \{/)
  })

  // Guard: the column is centred, so that the spare height is shared, not gathered at the foot under Quitter; and `safe`, so that a window shorter than the
  // bar keeps its top in view (a plain `center` put half the overflow above the top, where no scrolling reaches: the grip and the first tools were lost).
  it('centres its groups in the column, and keeps the top in view when the window is shorter', () => {
    expect(html).toMatch(/\.page-annotate-bar \{[^}]*justify-content: safe center/)
    expect(html).toMatch(/\.page-annotate-bar \{[^}]*overflow-y: auto/)
  })
})

describe('the hint of the draw mode', () => {
  // Guard: the mode button says how to reach the page while drawing (Control or Command held), in the title of the button. Without the hint, the
  // hold is not discoverable.
  it('the title of the mode button gives the hold keys in draw mode, and not in pass mode', () => {
    expect(modeButtonTitle('draw')).toBe(`${t('page-annotate.curseur-titre')} (⌥⌘P) · ${t('page-annotate.aide-maintien')}`)
    expect(modeButtonTitle('pass')).toBe(`${t('page-annotate.curseur-actif')} (⌥⌘P)`)
  })
})

describe('the Cursor button of the bar', () => {
  it('gives the pointer back to the drawing when a tool is picked, not when a colour is', () => {
    expect(modeAfterChoice('pass', { tool: 'pen' })).toBe('draw')
    expect(modeAfterChoice('pass', { color: '#e5484d' } as { tool?: unknown })).toBe('pass')
    expect(modeAfterChoice('draw', { tool: 'arrow' })).toBe('draw')
  })
})

describe('the layouts of the bar', () => {
  /** The body of the rule of a selector, as written in the page. */
  const rule = (selector: string): string => {
    const start = html.indexOf(`${selector} {`)
    return start < 0 ? '' : html.slice(start, html.indexOf('}', start))
  }

  // Guard: the page lays the bar out with the numbers the window was sized with (shared/annotate-bar.ts): the properties it declares are exactly those, and
  // with the same values. A width changed on one side only would cut the row (or leave it a gap), and nothing else would say.
  it('declares the sizes the window is made for, and nothing else', () => {
    const root = /:root \{([^}]*)\}/.exec(html)?.[1] ?? ''
    const declared = Object.fromEntries([...root.matchAll(/(--pa-[a-z-]+): ([^;]+);/g)].map((match) => [match[1], match[2]]))
    expect(declared).toEqual(barMetricVars())
  })

  it('uses every size it declares, and no other --pa- size', () => {
    const used = new Set([...html.matchAll(/var\((--pa-[a-z-]+)\)/g)].map((match) => match[1]))
    expect([...used].filter((name) => !(name! in barMetricVars()))).toEqual([])
    expect(Object.keys(barMetricVars()).filter((name) => !used.has(name))).toEqual([])
  })

  // Guard: the page has the two layouts the window can be given, and starts as a column (the default position): a state that arrives later changes it.
  it('starts as a column and styles the row', () => {
    expect(html).toContain('<nav class="page-annotate-bar" id="page-annotate-bar" data-layout="column">')
    for (const layout of BAR_LAYOUTS.filter((layout) => layout !== 'column')) expect(html).toContain(`.page-annotate-bar[data-layout='${layout}'] {`)
  })

  // Guard: the row wraps by group, a group whole, and every button of the column is there too: the grip and the Cursor key, the tools, the colours, the four
  // edits, Quit. A button only the column had would be missing from the row.
  it('holds every button of the column in its groups, and wraps by group', () => {
    expect(rule(".page-annotate-bar[data-layout='row']")).toContain('flex-wrap: wrap')
    expect(rule(".page-annotate-bar[data-layout='row']")).toContain('flex-direction: row')
    const ids = [...html.matchAll(/<button id="([^"]+)"/g)].map((match) => match[1])
    expect(ids).toEqual([
      'page-annotate-hint-ok',
      'page-annotate-grip',
      'page-annotate-position',
      'page-annotate-mode',
      'page-annotate-timer',
      'page-annotate-undo',
      'page-annotate-redo',
      'page-annotate-clear',
      'page-annotate-clear-all',
      'page-annotate-stop'
    ])
    expect(html).toContain(".page-annotate-bar[data-layout='row'] .page-annotate-head,\n      .page-annotate-bar[data-layout='row'] .page-annotate-edits {\n        display: flex;")
  })

  // Guard: in the column the groups are flat children of the bar (`display: contents`), so that the column has the spacing it always had.
  it('keeps the column flat: the head and the edits take no box of their own', () => {
    expect(html).toContain('.page-annotate-head,\n      .page-annotate-edits {\n        display: contents;')
  })

  // Guard: the row never has a scrollbar. Its window is the size of its groups (shared/annotate-bar.ts), and a scrollbar of the page (8 points) took the room of the
  // last group, which wrapped out of sight, and the scrollbar stayed: « Quitter » was lost in a row that had just been made, from the column's tall content in a window
  // of a row's height. `auto` is what the column has, for a window shorter than it.
  it('never scrolls in the row, and scrolls in the column only when the window is shorter', () => {
    const row = rule(".page-annotate-bar[data-layout='row']")
    expect(row).toMatch(/overflow: hidden;/)
    expect(row).not.toMatch(/overflow(-x|-y)?: (auto|scroll)/)
    expect(rule('.page-annotate-bar')).toMatch(/overflow-y: auto;/)
  })

  it('takes the rules away in the row (a rule could end a line) and gives the note a line of its own', () => {
    expect(rule(".page-annotate-bar[data-layout='row'] .page-annotate-rule")).toContain('display: none')
    expect(rule(".page-annotate-bar[data-layout='row'] p")).toContain('flex: 0 0 100%')
  })
})

describe('the grip', () => {
  const key = (name: string, modifiers: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers })

  // Guard: the grip is focusable (a button), has a name and a title that says what it does, and opens a menu.
  it('is a button at the head of the bar, named, and offering a menu', () => {
    expect(html).toContain('<button id="page-annotate-grip" type="button" class="page-annotate-grip" aria-haspopup="menu">')
    expect(html.indexOf('id="page-annotate-grip"')).toBeLessThan(html.indexOf('id="page-annotate-mode"'))
    expect(t('page-annotate.deplacer')).not.toBe('')
    expect(t('page-annotate.deplacer-titre')).toContain('clic droit')
  })

  // Guard: the menu opens with the menu key and Shift + F10 (the keys of a control's menu), and with Return and Space (a Mac keyboard has no menu key).
  it.each([[key('ContextMenu')], [key('F10', { shiftKey: true })], [key('Enter')], [key(' ')]])('opens the menu with %j', (event) => {
    expect(gripKeyAction(event)).toEqual({ kind: 'menu' })
  })

  it('does not open the menu with F10 alone', () => {
    expect(gripKeyAction(key('F10'))).toBeNull()
  })

  // Guard: an arrow moves a floating bar a step, and with Shift a larger one.
  it.each([
    ['ArrowLeft', 'left'],
    ['ArrowRight', 'right'],
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down']
  ] as const)('moves the bar with %s', (name, direction) => {
    expect(gripKeyAction(key(name))).toEqual({ kind: 'nudge', direction, large: false })
    expect(gripKeyAction(key(name, { shiftKey: true }))).toEqual({ kind: 'nudge', direction, large: true })
  })

  // Guard: a key with Command, Control or Alt is not the grip's (⌘Z and the other shortcuts of the bar keep their meaning), nor are other keys.
  it('leaves the keys with a modifier, and the other keys, alone', () => {
    for (const modifiers of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(gripKeyAction(key('ArrowLeft', modifiers))).toBeNull()
      expect(gripKeyAction(key('Enter', modifiers))).toBeNull()
    }
    for (const other of ['a', 'Tab', 'Escape', 'Home', 'constructor', '']) expect(gripKeyAction(key(other))).toBeNull()
  })
})

describe('the drag of the grip', () => {
  const pointer = (screenX: number, screenY: number, modifiers: Partial<{ button: number; ctrlKey: boolean }> = {}) => ({ button: 0, ctrlKey: false, screenX, screenY, ...modifiers })
  function grip(enabled = true) {
    const sent: BarDrag[] = []
    return { sent, drag: gripDrag((message) => sent.push(message), () => enabled) }
  }

  // Guard: a press, moves and a release tell main the phase and where the pointer is on the screen, in that order. Main moves the window with them.
  it('tells main where the pointer is: start, move, end', () => {
    const { sent, drag } = grip()
    expect(drag.down(pointer(100, 200))).toBe(true)
    drag.move(pointer(110, 205))
    drag.move(pointer(150, 260))
    expect(drag.up(pointer(150, 260))).toBe(true)
    expect(sent).toEqual([
      { phase: 'start', x: 100, y: 200 },
      { phase: 'move', x: 110, y: 205 },
      { phase: 'move', x: 150, y: 260 },
      { phase: 'end', x: 150, y: 260 }
    ])
  })

  it('tells main when the pointer was taken away, and then says nothing more', () => {
    const { sent, drag } = grip()
    drag.down(pointer(1, 2))
    expect(drag.cancel(pointer(3, 4))).toBe(true)
    drag.move(pointer(5, 6))
    expect(drag.up(pointer(7, 8))).toBe(false)
    expect(sent).toEqual([
      { phase: 'start', x: 1, y: 2 },
      { phase: 'cancel', x: 3, y: 4 }
    ])
  })

  // Guard: only the primary button drags, and not with Control held (a right click on a Mac, which opens the menu): else the menu would open under a drag.
  it('is not started by another button, nor by a Control + click', () => {
    const { sent, drag } = grip()
    expect(drag.down(pointer(1, 1, { button: 2 }))).toBe(false)
    expect(drag.down(pointer(1, 1, { button: 1 }))).toBe(false)
    expect(drag.down(pointer(1, 1, { ctrlKey: true }))).toBe(false)
    drag.move(pointer(5, 5))
    expect(drag.up(pointer(5, 5))).toBe(false)
    expect(sent).toEqual([])
  })

  // Guard: the grip does nothing while the annotation is off (the bar is then only closing).
  it('is not started while the annotation is off', () => {
    const { sent, drag } = grip(false)
    expect(drag.down(pointer(1, 1))).toBe(false)
    expect(sent).toEqual([])
  })

  it('says nothing for a pointer that moves without having been pressed on the grip', () => {
    const { sent, drag } = grip()
    drag.move(pointer(10, 10))
    expect(sent).toEqual([])
  })
})

/** The body of the rule of a selector, as written in the page ('' when there is none). */
const ruleOf = (selector: string): string => {
  const start = html.indexOf(`${selector} {`)
  return start < 0 ? '' : html.slice(start, html.indexOf('}', start))
}

/** The role a declaration of a rule takes (`color`, `background`): the name of a token, '' for anything else (a colour written in place). */
const roleIn = (rule: string, property: 'color' | 'background'): string => new RegExp(`(?:^|[\\s;{])${property}: var\\((--[a-z0-9-]+)\\);`).exec(rule)?.[1] ?? ''

describe('the grip as a handle', () => {
  // Guard: the grip says what it does where the pointer rests on it, in the language of the interface: « Glisser pour déplacer la barre · clic droit : position ».
  it('has a tooltip that says to drag it, and that the right click gives the position, in both languages', () => {
    expect(t('page-annotate.deplacer-titre')).toBe(frenchSpaces('Glisser pour déplacer la barre · clic droit : position'))
    setLanguage('en')
    expect(t('page-annotate.deplacer-titre')).toBe('Drag to move the bar · right click: position')
  })

  // Guard: the handle looks like one: a tinted strip with a hand cursor, which closes while it is dragged, and a hover. Without them the bar is a plain panel again,
  // and where to take it is a mystery (« pas simple de comprendre où ou comment le faire »).
  it('shows a hand over it, a closed hand while it is dragged, a tinted strip, and a hover', () => {
    const grip = ruleOf('.page-annotate-grip')
    expect(grip).toContain('cursor: grab;')
    expect(roleIn(grip, 'background')).toBe('--surface-3')
    expect(ruleOf('.page-annotate-dragging,\n      .page-annotate-dragging *')).toContain('cursor: grabbing;')
    expect(html).toMatch(/\.page-annotate-bar \.page-annotate-grip:hover \{[^}]*background: var\(--accent-soft\);/)
    expect(html).toMatch(/\.page-annotate-dragging \.page-annotate-grip \{[^}]*background: var\(--accent-soft\);/)
  })

  // Guard: the six dots and their strip are two roles of the tokens, at rest and under the pointer, so that they follow the light and the dark appearance
  // together. How well the dots read on the strip is measured in both appearances by seen-surfaces-contrast.test.ts (« the texts of the annotation bar »).
  it('has dots and a strip that take their colours from the tokens, at rest and on the hover', () => {
    const grip = ruleOf('.page-annotate-grip')
    expect([roleIn(grip, 'color'), roleIn(grip, 'background')]).toEqual(['--text-2', '--surface-3'])
    const hover = /\.page-annotate-bar \.page-annotate-grip:hover \{[^}]*\}/.exec(html)?.[0] ?? ''
    expect([roleIn(hover, 'color'), roleIn(hover, 'background')]).toEqual(['--accent-text', '--accent-soft'])
  })

  // Guard: the hit area is the handle: the grip fills the strip but for the Position button, and the strip is as high as 28 points in the column, a whole button in the row.
  it('takes all of its strip but the Position button, which is a strip of its own height', () => {
    expect(ruleOf('.page-annotate-grip')).toContain('flex: 1 1 auto;')
    expect(ruleOf('.page-annotate-handle')).toContain('height: var(--pa-head-h);')
    expect(ruleOf(".page-annotate-bar[data-layout='row'] .page-annotate-handle")).toContain('height: var(--pa-button-h);')
    expect(barMetricVars()['--pa-head-h']).toBe('28px')
  })
})

describe('the Position button', () => {
  // Guard: a button, named, which has a menu, in the handle next to the grip and before the Cursor key: the position can be reached without knowing the right click.
  it('is a button of the handle, beside the grip, that opens a menu', () => {
    expect(html).toContain('<button id="page-annotate-position" type="button" class="page-annotate-position" aria-haspopup="menu">')
    const handle = html.slice(html.indexOf('<div class="page-annotate-handle">'), html.indexOf('id="page-annotate-mode"'))
    expect(handle.indexOf('id="page-annotate-grip"')).toBeGreaterThan(-1)
    expect(handle.indexOf('id="page-annotate-position"')).toBeGreaterThan(handle.indexOf('id="page-annotate-grip"'))
  })

  // Guard: the button has an icon only: its name is the menu's title, in both languages (an accessible name and a tooltip).
  it('is named « Position de la barre », in both languages', () => {
    expect(t('page-annotate.position-titre')).toBe('Position de la barre')
    setLanguage('en')
    expect(t('page-annotate.position-titre')).toBe('Bar position')
  })

  it('is tinted like the grip, and has a hover', () => {
    expect(roleIn(ruleOf('.page-annotate-position'), 'background')).toBe(roleIn(ruleOf('.page-annotate-grip'), 'background'))
    expect(roleIn(ruleOf('.page-annotate-position'), 'background')).toBe('--surface-3')
    expect(html).toMatch(/\.page-annotate-bar \.page-annotate-position:hover \{[^}]*background: var\(--accent-soft\);/)
  })

  // Guard: the menu opens under the control that asked, in the coordinates of the window, whole and never negative (what main accepts), from the keyboard or the button.
  it('opens its menu under itself, at a whole, non-negative place', () => {
    expect(menuAnchorUnder({ left: 50.4, bottom: 29.6 })).toEqual({ x: 50, y: 30 })
    expect(menuAnchorUnder({ left: -3, bottom: -1 })).toEqual({ x: 0, y: 0 })
  })
})

describe('the hint of the first use', () => {
  // Guard: the hint is in the page, hidden until the state asks for it, as a group named by its text, with a button « OK ».
  it('is a hidden group above the handle, named by its text, with an OK button', () => {
    expect(html).toContain('<div id="page-annotate-hint" class="page-annotate-hint" role="group" aria-labelledby="page-annotate-hint-text" hidden>')
    expect(html).toContain('<span id="page-annotate-hint-text" class="page-annotate-hint-text"></span>')
    expect(html).toContain('<button id="page-annotate-hint-ok" type="button" class="page-annotate-hint-ok"></button>')
    expect(html.indexOf('id="page-annotate-hint"')).toBeLessThan(html.indexOf('class="page-annotate-handle"'))
    expect(ruleOf('.page-annotate-hint[hidden]')).toContain('display: none;')
  })

  it('says to drag the grip, in both languages, with an OK', () => {
    expect(t('page-annotate.astuce')).toBe(frenchSpaces('Astuce : glissez la poignée pour placer la barre où vous voulez'))
    expect(t('page-annotate.astuce-ok')).toBe('OK')
    setLanguage('en')
    expect(t('page-annotate.astuce')).toBe('Tip: drag the grip to put the bar wherever you like')
    expect(t('page-annotate.astuce-ok')).toBe('OK')
  })

  // Guard: only Escape alone dismisses it; Escape with a modifier, and every other key, leave it (a letter, Return, a shortcut of the bar are not « OK »).
  it('is dismissed by Escape alone', () => {
    const key = (name: string, modifiers: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers })
    expect(dismissesHint(key('Escape'))).toBe(true)
    for (const modifiers of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) expect(dismissesHint(key('Escape', modifiers))).toBe(false)
    for (const other of ['Enter', ' ', 'Esc', 'e', 'Tab', 'q']) expect(dismissesHint(key(other)), other).toBe(false)
  })

  // Guard: reduced motion is respected: the bubble has an animation, and the system's wish removes it, as it removes the transitions and the shrink of the buttons.
  it('appears with a short fade, and at once when the system asks for less motion', () => {
    expect(ruleOf('.page-annotate-bubble')).toMatch(/animation: page-annotate-hint-in \d+ms/)
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n      \}\n/.exec(html)?.[0] ?? ''
    expect(reduced).toMatch(/\.page-annotate-bubble \{\s*animation: none;/)
    expect(reduced).toMatch(/:where\(\.page-annotate-bar\) button \{\s*transition: none;/)
    expect(reduced).toMatch(/button:active:not\(:disabled\) \{\s*transform: none;/)
  })

  // Guard: the hint has the room the window is made for: its height is the model's, in the column and in the row.
  it('is as high as the model says, in the column and in the row', () => {
    expect(ruleOf('.page-annotate-hint')).toContain('height: calc(var(--pa-hint-col-h) - 8px);')
    expect(ruleOf(".page-annotate-bar[data-layout='row'] .page-annotate-hint")).toContain('height: calc(var(--pa-hint-row-h) - var(--pa-line-gap));')
    expect(barMetricVars()['--pa-hint-col-h']).toBe('128px')
    expect(barMetricVars()['--pa-hint-row-h']).toBe('44px')
  })
})

describe('the elements of the buttons of the bar', () => {
  /** An element that records what it is given, in place of the DOM (no window here). */
  interface Fake {
    name: string
    namespace: string | null
    attributes: Record<string, string>
    children: Fake[]
    className: string
    textContent: string
    setAttribute(name: string, value: string): void
    append(...nodes: Fake[]): void
  }
  const fake = (name: string, namespace: string | null): Fake => ({
    name,
    namespace,
    attributes: {},
    children: [],
    className: '',
    textContent: '',
    setAttribute(key, value) {
      this.attributes[key] = value
    },
    append(...nodes) {
      this.children.push(...nodes)
    }
  })
  const maker = { createElement: (name: string) => fake(name, null), createElementNS: (namespace: string, name: string) => fake(name, namespace) } as unknown as ElementMaker

  it('draws an icon as an SVG element with its path, hidden from the screen reader', () => {
    const svg = strokedIcon(maker, 'M4 4l16 16') as unknown as Fake
    expect([svg.name, svg.namespace]).toEqual(['svg', 'http://www.w3.org/2000/svg'])
    expect(svg.attributes).toEqual({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'aria-hidden': 'true' })
    expect(svg.children.map((child) => [child.name, child.namespace, child.attributes])).toEqual([['path', 'http://www.w3.org/2000/svg', { d: 'M4 4l16 16' }]])
  })

  // A label of the catalogue of texts is text: a « < » in a translation must be read, never parsed.
  it('puts a label in as text, whatever it holds', () => {
    const span = hiddenSpan(maker, 'page-annotate-letter', '<img src=x onerror=alert(1)> ⌥⌘P') as unknown as Fake
    expect(span.name).toBe('span')
    expect(span.className).toBe('page-annotate-letter')
    expect(span.attributes).toEqual({ 'aria-hidden': 'true' })
    expect(span.textContent).toBe('<img src=x onerror=alert(1)> ⌥⌘P')
    expect(span.children).toEqual([])
  })

  it('is how the bar is built: no script of the interface writes markup', () => {
    const scripts = (readdirSync(__dirname, { recursive: true }) as string[]).filter((file) => /\.tsx?$/.test(file) && !/\.test\./.test(file))
    expect(scripts.length).toBeGreaterThan(100)
    const writing = scripts.filter((file) => /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write/.test(readFileSync(join(__dirname, file), 'utf8')))
    expect(writing).toEqual([])
  })
})

describe('the letters of the keys, in the bar', () => {
  // Guard: the bar names the letter of a tool (in its title and as a chip) only while its key acts. Without the check, a person who switched the letters off
  // would be told to press a key that does nothing.
  it('names the letter of a tool while the keys of one letter act, and not otherwise', () => {
    expect(toolButtonText('Crayon', 'P', true)).toEqual({ title: 'Crayon (P)', letter: 'P' })
    expect(toolButtonText('Crayon', 'P', false)).toEqual({ title: 'Crayon', letter: null })
    // The eraser has no letter either way.
    expect(toolButtonText('Gomme', undefined, true)).toEqual({ title: 'Gomme', letter: null })
  })

  it('names E and X in the titles of the two clears while they act, and keeps the keys with ⌘ and ⌥ always', () => {
    const on = clearTitles(true)
    expect(on.page).toContain('(⌥⌘⌫, E)')
    expect(on.all).toContain('(⇧⌥⌘⌫, X)')
    const off = clearTitles(false)
    expect(off.page).toContain('(⌥⌘⌫)')
    expect(off.all).toContain('(⇧⌥⌘⌫)')
    expect(off.page).not.toContain('E)')
    expect(off.all).not.toContain('X)')
  })

  it('is read from the state the main process sends, for the tools and for the two clears', () => {
    const script = readFileSync(join(__dirname, 'page-annotate-command.ts'), 'utf8')
    expect(script).toContain('toolButtonText(TOOL_LABEL[tool](), TOOL_LETTER[tool], state.letterKeys)')
    expect(script).toContain('clearTitles(state.letterKeys)')
  })
})
