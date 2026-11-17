// The command bar of the page annotation (docs/design/annotation-partage-fenetre.md, section « Annotation directe dans la page »): a bar that stands
// where the user put it (an edge of the page on screen, or a place of its own: « Position de la barre »), in a column or in a row, with the tools (the letter
// of each shortcut under its icon), the colours, the edits and the end. It is a window of its own, outside the browser window: sharing the browser window
// does not share it. Its calls go through
// `window.luciumPageAnnotate` (preload) and nothing else. The keys of the page are read by main, not here (shell/page-annotate.ts).

import './styles.css'
import './settings.css'
import { t } from '@shared/i18n'
import { languageFromAddress } from './document-language'
import type { LaserStyle, PageAnnotateApi, PageAnnotateState, PageBrush, PageEdit, PageNote, PageTool } from '@shared/page-annotate'
import { DEFAULT_BAR_HUE, DEFAULT_LASER_STYLE, DEFAULT_PAGE_BRUSH, PAGE_TOOLS, barHue } from '@shared/page-annotate'
import { DRAW_COLORS, type DrawColor } from '@shared/window-share-draw'
import { nextAutoClear, type AutoClear } from '@shared/annotate-auto-clear'
import { lockDocumentDrops } from './surface'
import { autoClearButton, clearTitles, dismissesHint, gripDrag, gripKeyAction, hiddenSpan, laserChips, laserSelector, menuAnchorUnder, modeAfterChoice, modeButtonTitle, strokedIcon, TIMER_ICON, toolButtonText } from './page-annotate-command-view'

lockDocumentDrops()
languageFromAddress(document.documentElement, location.search)
document.title = t('page-annotate.titre-commande')

const api = (window as unknown as { luciumPageAnnotate: PageAnnotateApi }).luciumPageAnnotate
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const bar = $<HTMLElement>('page-annotate-bar')
const grip = $<HTMLButtonElement>('page-annotate-grip')
const positionButton = $<HTMLButtonElement>('page-annotate-position')
const hint = $<HTMLDivElement>('page-annotate-hint')
const hintText = $<HTMLSpanElement>('page-annotate-hint-text')
const hintOk = $<HTMLButtonElement>('page-annotate-hint-ok')
const modeButton = $<HTMLButtonElement>('page-annotate-mode')
const toolsBox = $<HTMLDivElement>('page-annotate-tools')
const colorsBox = $<HTMLDivElement>('page-annotate-colors')
const laserBox = $<HTMLDivElement>('page-annotate-laser')
const laserName = $<HTMLSpanElement>('page-annotate-laser-name')
const timer = $<HTMLButtonElement>('page-annotate-timer')
const undo = $<HTMLButtonElement>('page-annotate-undo')
const redo = $<HTMLButtonElement>('page-annotate-redo')
const clear = $<HTMLButtonElement>('page-annotate-clear')
const clearAll = $<HTMLButtonElement>('page-annotate-clear-all')
const note = $<HTMLParagraphElement>('page-annotate-note')
const stop = $<HTMLButtonElement>('page-annotate-stop')

/** The state the main process holds. The window only shows it and asks for changes. */
let state: PageAnnotateState = { on: false, mode: 'draw', brush: DEFAULT_PAGE_BRUSH, note: null, laser: DEFAULT_LASER_STYLE, layout: 'column', hint: false, hue: DEFAULT_BAR_HUE, autoClear: 0, letterKeys: true }

/** The icons of the tools (24 px grid, thin strokes), and the letter of each shortcut. */
const TOOL_ICON: Record<PageTool, string> = {
  pen: 'M4 20l4-1L19 8l-3-3L5 16z',
  highlighter: 'M4 20h16M7 16l8-8 3 3-8 8H7z',
  rectangle: 'M4 6h16v12H4z',
  diamond: 'M12 3l9 9-9 9-9-9z',
  ellipse: 'M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0',
  arrow: 'M4 12h15m-5-5l5 5-5 5',
  line: 'M4 12h16',
  eraser: 'M4 16l8-10 8 6-6 6H8z',
  laser: 'M5 19l7-7M14 6a2 2 0 1 1 0 4a2 2 0 1 1 0-4',
  pointer: 'M20 12a8 8 0 1 1-16 0a8 8 0 1 1 16 0M12 9v6M9 12h6'
}
/** The letter of each shortcut of a tool. The eraser has none (it is a tool of the bar only). */
const TOOL_LETTER: Partial<Record<PageTool, string>> = { pen: 'P', highlighter: 'H', rectangle: 'R', diamond: 'D', ellipse: 'O', arrow: 'A', line: 'L', laser: 'K', pointer: 'Q' }

const TOOL_LABEL: Record<PageTool, () => string> = {
  pen: () => t('page-annotate.outil-crayon'),
  highlighter: () => t('page-annotate.outil-surligneur'),
  rectangle: () => t('page-annotate.outil-rectangle'),
  diamond: () => t('page-annotate.outil-losange'),
  ellipse: () => t('page-annotate.outil-ellipse'),
  arrow: () => t('page-annotate.outil-fleche'),
  line: () => t('page-annotate.outil-ligne'),
  eraser: () => t('page-annotate.outil-effacer'),
  laser: () => t('page-annotate.outil-laser'),
  pointer: () => t('page-annotate.outil-pointeur')
}

const COLOR_LABEL: Record<DrawColor, () => string> = {
  '#e53935': () => t('page-annotate.couleur-rouge'),
  '#fdd835': () => t('page-annotate.couleur-jaune'),
  '#43a047': () => t('page-annotate.couleur-vert'),
  '#1e88e5': () => t('page-annotate.couleur-bleu'),
  '#ffffff': () => t('page-annotate.couleur-blanc')
}

const NOTE: Record<NonNullable<PageNote>, () => string> = {
  refused: () => t('page-annotate.note-refusee'),
  shortcut: () => t('page-annotate.note-raccourci'),
  'shortcut-own': () => t('page-annotate.note-raccourci-partage')
}

/** The brush the window sends: a change keeps the others. The main process checks it against the palette. */
function choose(next: Partial<PageBrush>): void {
  const brush = { ...state.brush, ...next }
  const mode = modeAfterChoice(state.mode, next)
  const backToDraw = mode !== state.mode
  state = { ...state, brush, mode }
  render()
  void api.setBrush(brush)
  if (backToDraw) void api.setMode(mode)
}

/** The look of the laser: kept by main for the session; the window shows it at once. */
function chooseLaser(style: LaserStyle): void {
  state = { ...state, laser: style }
  render()
  void api.setLaser(style)
}

/** The arrow of the Cursor button: the page takes the pointer. */
const CURSOR_ICON = 'M6 3.5 L6 18.5 L10 14.6 L12.8 20.5 L15.2 19.4 L12.4 13.6 L18 13.6 Z'

/** The timer button: the next delay of the automatic clearing (or off). Main writes it in the settings; the window shows it at once. */
function chooseAutoClear(value: AutoClear): void {
  state = { ...state, autoClear: value }
  render()
  void api.setAutoClear(value)
}

function toggleMode(): void {
  const mode = state.mode === 'draw' ? 'pass' : 'draw'
  state = { ...state, mode }
  render()
  void api.setMode(mode)
}

function edit(command: PageEdit): void {
  if (state.on) void api.edit(command)
}

/** The title and the letter chip of a tool's button: drawn again when the keys of one letter are switched on or off (`state.letterKeys`). */
function nameTool(button: HTMLButtonElement, tool: PageTool): void {
  const text = toolButtonText(TOOL_LABEL[tool](), TOOL_LETTER[tool], state.letterKeys)
  button.title = text.title
  button.replaceChildren(strokedIcon(document, TOOL_ICON[tool]), ...(text.letter ? [hiddenSpan(document, 'page-annotate-letter', text.letter)] : []))
}

function buildTools(): void {
  for (const tool of PAGE_TOOLS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'page-annotate-tool'
    button.dataset['value'] = tool
    button.setAttribute('aria-label', TOOL_LABEL[tool]())
    nameTool(button, tool)
    button.addEventListener('click', () => choose({ tool }))
    toolsBox.append(button)
  }
  for (const color of DRAW_COLORS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'page-annotate-swatch'
    button.dataset['value'] = color
    button.style.background = color
    button.title = COLOR_LABEL[color]()
    button.setAttribute('aria-label', COLOR_LABEL[color]())
    button.addEventListener('click', () => choose({ color }))
    colorsBox.append(button)
  }
  // The selector of the laser's look: shown while the laser is the tool (see render).
  laserBox.setAttribute('aria-label', t('page-annotate.styles-laser'))
  for (const { style, title, label, dotClass } of laserChips()) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'page-annotate-style'
    button.dataset['value'] = style
    button.title = title
    button.setAttribute('aria-label', label)
    button.replaceChildren(hiddenSpan(document, dotClass))
    button.addEventListener('click', () => chooseLaser(style))
    laserBox.insertBefore(button, laserName)
  }
  modeButton.addEventListener('click', toggleMode)
  timer.addEventListener('click', () => chooseAutoClear(nextAutoClear(state.autoClear)))
  undo.addEventListener('click', () => edit('undo'))
  redo.addEventListener('click', () => edit('redo'))
  clear.addEventListener('click', () => edit('clear'))
  clearAll.addEventListener('click', () => edit('clear-all'))
  stop.addEventListener('click', () => void api.stop())
}

/**
 * The grip at the head of the bar. A press and a drag with the primary button move the bar: this page only tells main where the pointer is on the screen
 * (the bar is a window of its own, which only main can move), and main follows it, shows where it would land near an edge, and keeps the place on the drop.
 * A right click opens the menu of the positions, and so do the menu key and Return or Space; the arrow keys move a floating bar.
 */
function buildGrip(): void {
  grip.title = t('page-annotate.deplacer-titre')
  grip.setAttribute('aria-label', t('page-annotate.deplacer'))
  const drag = gripDrag((message) => api.dragBar(message), () => state.on)
  const release = (event: PointerEvent): void => {
    document.body.classList.remove('page-annotate-dragging')
    if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId)
  }
  grip.addEventListener('pointerdown', (event) => {
    if (!drag.down(event)) return
    grip.setPointerCapture(event.pointerId)
    document.body.classList.add('page-annotate-dragging')
  })
  grip.addEventListener('pointermove', (event) => drag.move(event))
  grip.addEventListener('pointerup', (event) => {
    if (drag.up(event)) release(event)
  })
  // The pointer was taken away (the system took it, or the capture was lost): the bar goes back where it was.
  for (const name of ['pointercancel', 'lostpointercapture'] as const) {
    grip.addEventListener(name, (event) => {
      if (drag.cancel(event)) release(event)
    })
  }
  grip.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    void api.openBarMenu(null)
  })
  grip.addEventListener('keydown', (event) => {
    const action = gripKeyAction(event)
    if (!action) return
    event.preventDefault()
    if (action.kind === 'nudge') {
      void api.nudgeBar(action.direction, action.large)
      return
    }
    // Opened from the keyboard, the menu stands under the grip.
    void api.openBarMenu(menuAnchorUnder(grip.getBoundingClientRect()))
  })
}

/** The Position button: a click opens the menu of the positions, under the button, as the right click on the grip does; it is a button, so the keyboard reaches it. */
function buildPositionButton(): void {
  positionButton.title = t('page-annotate.position-titre')
  positionButton.setAttribute('aria-label', t('page-annotate.position-titre'))
  positionButton.addEventListener('click', () => void api.openBarMenu(menuAnchorUnder(positionButton.getBoundingClientRect())))
}

/** The first-use hint: « OK » dismisses it, and so does Escape (the page takes the key, and the annotation does not end with it). Main keeps that it was seen. */
function dismissHint(): void {
  if (!state.hint) return
  state = { ...state, hint: false }
  render()
  void api.dismissHint()
}

function buildHint(): void {
  hintText.textContent = t('page-annotate.astuce')
  hintOk.textContent = t('page-annotate.astuce-ok')
  hintOk.addEventListener('click', dismissHint)
}

/** The buttons show the choice in use. The tools and the edits are disabled while the annotation is off. */
function render(): void {
  // The layout main sized the window for: a column on a side edge, a row on the top or bottom one (the page's styles do the rest).
  bar.dataset['layout'] = state.layout
  // The accent of the bar is the one of the space on screen in the annotated window: the tokens work it out from the hue set on the root.
  document.documentElement.style.setProperty('--hue', String(barHue(state.hue)))
  for (const button of toolsBox.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset['value'] === state.brush.tool))
    button.disabled = !state.on
    // The letters are named only while their keys act: drawn again only when that changed.
    if (button.dataset['letters'] !== String(state.letterKeys)) {
      button.dataset['letters'] = String(state.letterKeys)
      nameTool(button, button.dataset['value'] as PageTool)
    }
  }
  for (const button of colorsBox.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset['value'] === state.brush.color))
    button.disabled = !state.on
  }
  // The selector of the laser shows only while the laser is the tool; its choice is the look main keeps.
  const selector = laserSelector(state)
  laserBox.hidden = selector.hidden
  laserName.textContent = selector.name
  for (const button of laserBox.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset['value'] === state.laser))
    button.disabled = !state.on
  }
  modeButton.setAttribute('aria-pressed', String(state.mode === 'pass'))
  modeButton.disabled = !state.on
  // A tool of its own, pressed while the page gets the pointer: the drawing stays on show, the clicks and the scrolling go to the page.
  modeButton.title = modeButtonTitle(state.mode)
  modeButton.setAttribute('aria-label', t('page-annotate.curseur'))
  modeButton.replaceChildren(strokedIcon(document, CURSOR_ICON), hiddenSpan(document, 'page-annotate-letter', `${t('page-annotate.curseur')} ⌥⌘P`))
  // The timer of the automatic clearing: the delay beside its icon and the accent while it is on, the icon alone while it is off.
  const clearing = autoClearButton(state.autoClear)
  timer.dataset['on'] = String(clearing.on)
  timer.title = clearing.title
  timer.setAttribute('aria-label', clearing.label)
  timer.replaceChildren(strokedIcon(document, TIMER_ICON), ...(clearing.text ? [hiddenSpan(document, 'page-annotate-timer-delay', clearing.text)] : []))
  timer.disabled = !state.on
  undo.disabled = !state.on
  redo.disabled = !state.on
  clear.disabled = !state.on
  // The keys of the two clears are named, the letter of each only while the keys of one letter act.
  const clears = clearTitles(state.letterKeys)
  clear.title = clears.page
  clearAll.title = clears.all
  clearAll.disabled = !state.on
  note.textContent = state.note ? NOTE[state.note]() : ''
  stop.disabled = !state.on
  hint.hidden = !(state.on && state.hint)
}

bar.setAttribute('aria-label', t('page-annotate.barre'))
undo.textContent = t('page-annotate.annuler')
redo.textContent = t('page-annotate.retablir')
clear.textContent = t('page-annotate.effacer-page')
clearAll.textContent = t('page-annotate.effacer-tout')
stop.textContent = t('page-annotate.quitter')
stop.title = t('page-annotate.arreter')
buildTools()
buildGrip()
buildPositionButton()
buildHint()
api.onState((next) => {
  state = next
  render()
})
document.addEventListener('keydown', (event) => {
  if (state.hint && dismissesHint(event)) {
    event.preventDefault()
    dismissHint()
    return
  }
  // ⌘Z and ⇧⌘Z edit the drawing from this window too, as in the view of the window share.
  if (!state.on || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return
  event.preventDefault()
  edit(event.shiftKey ? 'redo' : 'undo')
})
void api.getState().then((next) => {
  state = next
  render()
})
render()
