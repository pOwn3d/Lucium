// The command window of the annotated window share (docs/design/annotation-partage-fenetre.md, « Fenêtre de commande »): it chooses a window, starts or
// stops its share, holds the drawing tools for the picture of that share, and switches between drawing and passage. It is not in the picture that is
// shared (the main process leaves it out of the list). Its calls go through `window.luciumShare` (preload/window-share.ts) and nothing else.

import './styles.css'
import './settings.css'
import { t } from '@shared/i18n'
import { languageFromAddress } from './document-language'
import { shareNoticeOf, shortcutHintKey, type ShareRefusal, type ShareSource, type ShareState, type WindowShareApi } from '@shared/window-share'
import type { PassNote } from '@shared/window-share-pass'
import { DEFAULT_BRUSH, DRAW_COLORS, DRAW_TOOLS, DRAW_WIDTHS, shortcutOf, type Brush, type DrawColor, type DrawTool, type DrawWidth, type EditCommand } from '@shared/window-share-draw'
import { lockDocumentDrops } from './surface'
import { NBSP } from '@shared/french-typography'
import { UI_ERROR_PREFIX } from '@shared/ui-errors'
import { describeUiError, installUiErrorLog } from './ui-error-log'

// This page is not mounted by the root of the React surfaces: what fails in it and nothing catches is written to the log from here.
installUiErrorLog()
lockDocumentDrops()
languageFromAddress(document.documentElement, location.search)
document.title = t('window-share.titre-commande')

const api = (window as unknown as { luciumShare: WindowShareApi }).luciumShare
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const title = $<HTMLHeadingElement>('window-share-title')
const pill = $<HTMLParagraphElement>('window-share-pill')
const label = $<HTMLLabelElement>('window-share-label')
const select = $<HTMLSelectElement>('window-share-windows')
const status = $<HTMLParagraphElement>('window-share-status')
const refresh = $<HTMLButtonElement>('window-share-refresh')
const toggle = $<HTMLButtonElement>('window-share-toggle')
const switchButton = $<HTMLButtonElement>('window-share-switch')
const current = $<HTMLParagraphElement>('window-share-current')
const notice = $<HTMLDivElement>('window-share-notice')
const noticeText = $<HTMLParagraphElement>('window-share-notice-text')
const draw = $<HTMLFieldSetElement>('window-share-draw')
const capMode = $<HTMLElement>('window-share-cap-mode')
const capTools = $<HTMLElement>('window-share-cap-tools')
const capColor = $<HTMLElement>('window-share-cap-color')
const capWidth = $<HTMLElement>('window-share-cap-width')
const capEdit = $<HTMLElement>('window-share-cap-edit')
const toolsBox = $<HTMLDivElement>('window-share-tools')
const toolName = $<HTMLParagraphElement>('window-share-tool-name')
const colorsBox = $<HTMLDivElement>('window-share-colors')
const widthsBox = $<HTMLDivElement>('window-share-widths')
const undo = $<HTMLButtonElement>('window-share-undo')
const redo = $<HTMLButtonElement>('window-share-redo')
const clear = $<HTMLButtonElement>('window-share-clear')
const hint = $<HTMLParagraphElement>('window-share-hint')
const modeDraw = $<HTMLButtonElement>('window-share-mode-draw')
const modePass = $<HTMLButtonElement>('window-share-mode-pass')
const shortcutBox = $<HTMLInputElement>('window-share-shortcut')
const shortcutLabel = $<HTMLSpanElement>('window-share-shortcut-label')
const shortcutHint = $<HTMLParagraphElement>('window-share-shortcut-hint')

let sharing: ShareSource | null = null
/** The shared window is closed: the view keeps its last picture, and the list offers another window. */
let missing = false
/** The brush the drawing uses. The main process keeps the same one, to give it to a view made again. */
let brush: Brush = DEFAULT_BRUSH
/** The passage mode, as the main process holds it, and the reason of a refusal or a failed click, if any. */
let passing = false
let passNote: PassNote | null = null

const PASS_NOTE: Record<PassNote, () => string> = {
  accessibility: () => t('window-share.passage-autorisation'),
  unavailable: () => t('window-share.passage-indisponible')
}

const REFUSAL: Record<ShareRefusal, () => string> = {
  permission: () => t('window-share.permission'),
  private: () => t('window-share.privee-refusee'),
  own: () => t('window-share.fenetre-du-partage'),
  unknown: () => t('window-share.fenetre-indisponible'),
  failed: () => t('window-share.echec')
}

const TOOL_LABEL: Record<DrawTool, () => string> = {
  select: () => t('window-share.outil-selection'),
  pen: () => t('window-share.outil-crayon'),
  highlighter: () => t('window-share.outil-surligneur'),
  rectangle: () => t('window-share.outil-rectangle'),
  ellipse: () => t('window-share.outil-ellipse'),
  line: () => t('window-share.outil-ligne'),
  arrow: () => t('window-share.outil-fleche'),
  text: () => t('window-share.outil-texte'),
  eraser: () => t('window-share.outil-effacer')
}

const COLOR_LABEL: Record<DrawColor, () => string> = {
  '#e53935': () => t('window-share.couleur-rouge'),
  '#fdd835': () => t('window-share.couleur-jaune'),
  '#43a047': () => t('window-share.couleur-vert'),
  '#1e88e5': () => t('window-share.couleur-bleu'),
  '#ffffff': () => t('window-share.couleur-blanc')
}

const WIDTH_LABEL: Record<DrawWidth, () => string> = {
  2: () => t('window-share.epaisseur-fine'),
  5: () => t('window-share.epaisseur-moyenne'),
  10: () => t('window-share.epaisseur-epaisse')
}

/** The line drawn for each width, in pixels of the button: the thickness is what the choice gives. */
const WIDTH_BAR: Record<DrawWidth, number> = { 2: 2, 5: 5, 10: 10 }

/**
 * The icons: one family, 16 px on a 16 grid, drawn with the stroke of the tokens (--icon-stroke). Each icon is a list of paths; no image is
 * loaded and no text is parsed, so the page needs nothing outside itself.
 */
const ICONS: Record<DrawTool | 'refresh' | 'undo' | 'redo' | 'clear', readonly string[]> = {
  select: ['M3.5 2.5l8.5 5.2-3.7 1 2.2 3.8-1.6.9-2.2-3.8-2.7 2.5z'],
  pen: ['M10.8 2.7l2.5 2.5L6 12.5 3.5 13l.5-2.5z', 'M9.4 4.1l2.5 2.5'],
  highlighter: ['M4.2 10.8l5.6-6.3 2.6 2.3-5.6 6.3H4.2z', 'M3 13.8h10'],
  rectangle: ['M2.8 4h10.4v8H2.8z'],
  ellipse: ['M2.5 8a5.5 4 0 1 0 11 0a5.5 4 0 1 0-11 0z'],
  line: ['M3 13L13 3'],
  arrow: ['M3 13L12.5 3.5', 'M7 3.2h5.8V9'],
  text: ['M3.5 3.5h9', 'M8 3.5v9', 'M5.8 12.5h4.4'],
  eraser: ['M8.6 3.8l3.6 3.6-4.6 4.6H5.2L2.5 9.3z', 'M3 13.2h4.6'],
  refresh: ['M13 8a5 5 0 1 1-1.6-3.7', 'M13 2.8v3h-3'],
  undo: ['M5.5 4.2L2.8 7l2.7 2.8', 'M3 7h6.3a3.5 3.5 0 0 1 0 7H7'],
  redo: ['M10.5 4.2L13.2 7l-2.7 2.8', 'M13 7H6.7a3.5 3.5 0 0 0 0 7H9'],
  clear: ['M3 4.5h10', 'M6.2 4.5V3h3.6v1.5', 'M4.5 4.5l.6 8.5h5.8l.6-8.5']
}

/** An icon, as an SVG element (hidden from assistive technology: the button's own label names it). */
function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', 'ws-icon')
  for (const d of ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/** A button with an icon and a visible text (or only the icon, and its label for the reader). */
function labelled(button: HTMLButtonElement, name: keyof typeof ICONS, text: string, iconOnly = false): void {
  button.replaceChildren(icon(name))
  if (!iconOnly) button.append(text)
  button.title = text
  button.setAttribute('aria-label', text)
}

function say(text: string): void {
  status.textContent = text
}

/**
 * A request of this window to the main process. One that fails is said in the status line and written to the log (État de Lucium): before, the
 * button did nothing and the line kept its last sentence, « Partage en cours » after a stop that had failed. Answers nothing then.
 */
async function request<T>(what: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    console.error(`${UI_ERROR_PREFIX} the command window of the share: ${what} failed:`, describeUiError(error))
    say(t('window-share.demande-echouee'))
    return undefined
  }
}

/**
 * The buttons of the drawing: the choice in use is pressed, and its name is written under the tools. The whole group is disabled while nothing is
 * shared. The mode and the status pill follow the passage mode the main process holds.
 */
function renderDraw(): void {
  for (const button of toolsBox.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(button.dataset['value'] === brush.tool))
  for (const button of colorsBox.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(button.dataset['value'] === brush.color))
  for (const button of widthsBox.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(Number(button.dataset['value']) === brush.width))
  modeDraw.setAttribute('aria-pressed', String(!passing))
  modePass.setAttribute('aria-pressed', String(passing))
  toolName.textContent = `${t('window-share.outil-actif')} ${TOOL_LABEL[brush.tool]()}`
  draw.disabled = sharing === null
}

/** The passage mode is asked of the main process, which decides (it refuses without the Accessibility permission). */
function choosePass(on: boolean): void {
  if (sharing) void request('the passage mode', () => api.setPass(on))
}

function choose(next: Partial<Brush>): void {
  brush = { ...brush, ...next }
  renderDraw()
  void request('the brush', () => api.setBrush(brush))
}

function edit(command: EditCommand): void {
  if (sharing) void request(`the edit ${command}`, () => api.edit(command))
}

/** A choice button of a group: its value is kept in the data (the colour, the tool, the width), and the choice is made on a click. */
function option(container: HTMLElement, value: string, onPick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset['value'] = value
  button.addEventListener('click', onPick)
  container.append(button)
  return button
}

function buildDraw(): void {
  for (const tool of DRAW_TOOLS) {
    const button = option(toolsBox, tool, () => choose({ tool }))
    labelled(button, tool, TOOL_LABEL[tool](), true)
  }
  for (const color of DRAW_COLORS) {
    const button = option(colorsBox, color, () => choose({ color }))
    button.className = 'ws-swatch'
    button.style.background = color
    button.title = COLOR_LABEL[color]()
    button.setAttribute('aria-label', COLOR_LABEL[color]())
  }
  for (const width of DRAW_WIDTHS) {
    const button = option(widthsBox, String(width), () => choose({ width }))
    button.className = 'ws-width'
    const bar = document.createElement('span')
    bar.style.height = `${WIDTH_BAR[width]}px`
    button.append(bar)
    button.title = WIDTH_LABEL[width]()
    button.setAttribute('aria-label', WIDTH_LABEL[width]())
  }
  labelled(undo, 'undo', t('window-share.annuler'))
  labelled(redo, 'redo', t('window-share.retablir'))
  labelled(clear, 'clear', t('window-share.tout-effacer'))
  undo.addEventListener('click', () => edit('undo'))
  redo.addEventListener('click', () => edit('redo'))
  clear.addEventListener('click', () => edit('clear'))
  hint.textContent = t('window-share.raccourcis')
  modeDraw.textContent = t('window-share.mode-dessin')
  modePass.textContent = t('window-share.mode-passage')
  modeDraw.addEventListener('click', () => choosePass(false))
  modePass.addEventListener('click', () => choosePass(true))
  shortcutLabel.textContent = t('window-share.raccourci-passage')
  shortcutBox.addEventListener('change', () => void request('the shortcut of the passage', () => api.setShortcut(shortcutBox.checked)))
}

async function listWindows(): Promise<void> {
  const result = await request('the list of the windows', () => api.list())
  // The list could not be asked for: it stays as it is, with the sentence that says so.
  if (!result) return
  if (result.ok) {
    select.replaceChildren(...result.windows.map((source) => new Option(source.name || source.id, source.id)))
    // A refresh keeps the message about a closed window: it stays until another window is chosen.
    if (!missing) say(result.windows.length === 0 ? t('window-share.aucune-fenetre') : '')
  } else {
    select.replaceChildren()
    if (!missing) say(result.reason === 'permission' ? t('window-share.permission') : t('window-share.echec'))
  }
  toggle.disabled = sharing === null && select.options.length === 0
}

async function startOrStop(): Promise<void> {
  if (sharing) {
    // « Partage arrêté » is said once the stop was done: a stop that failed says so instead.
    await request('the stop', () => api.stop().then(() => say(t('window-share.arrete'))))
    return
  }
  await showWindow()
}

/** Starts the share, or moves it to the window chosen: the video app keeps the same window, only its picture changes. */
async function showWindow(): Promise<void> {
  const result = await request('the start', () => api.start(select.value))
  if (!result) return
  if (result.ok) say(t('window-share.en-cours'))
  else say(REFUSAL[result.reason]())
}

label.textContent = t('window-share.fenetre-a-partager')
title.textContent = t('window-share.titre-commande')
capMode.textContent = t('window-share.section-mode')
capTools.textContent = t('window-share.section-outils')
capColor.textContent = t('window-share.section-couleur')
capWidth.textContent = t('window-share.section-epaisseur')
capEdit.textContent = t('window-share.section-edition')
noticeText.textContent = t('window-share.fenetre-masquee')
labelled(refresh, 'refresh', t('window-share.actualiser'), true)
refresh.addEventListener('click', () => void listWindows())
toggle.addEventListener('click', () => void startOrStop())
switchButton.textContent = t('window-share.changer-fenetre')
switchButton.addEventListener('click', () => void showWindow())
buildDraw()
// The main process tells every change: the window's own start, its stop, the closing of the view, and what the window sends (minimized, hidden,
// or black: `hidden` and `blank`). The notice is shown here in words, and the view shows the same notice over its picture.
api.onState((state: ShareState) => {
  sharing = state.sharing
  missing = state.missing
  const verdict = shareNoticeOf(state)
  toggle.textContent = sharing ? t('window-share.arreter-partage') : t('window-share.demarrer-partage')
  toggle.dataset['action'] = sharing ? 'stop' : 'start'
  // The list stays usable while sharing: choosing another window moves the picture to it, in the same shared window.
  current.textContent = sharing ? `${t('window-share.fenetre-partagee')}${NBSP}: ${sharing.name || sharing.id}` : ''
  switchButton.hidden = sharing === null
  pill.textContent = sharing ? t(state.pass ? 'window-share.pastille-passage' : 'window-share.pastille-en-cours') : t('window-share.pastille-arrete')
  pill.dataset['state'] = sharing ? 'on' : 'off'
  notice.hidden = verdict !== 'away'
  if (verdict === 'closed') {
    // The window shared is gone: say so, and refresh the list so that it no longer offers that window.
    say(t('window-share.source-fermee'))
    void listWindows()
  } else say(sharing ? t(state.pass ? 'window-share.passage-actif' : 'window-share.en-cours') : t('window-share.arrete'))
  toggle.disabled = sharing === null && select.options.length === 0
  passing = state.pass
  passNote = state.passNote
  // The switch keeps the choice of the user: a shortcut that is not held says who has it, it does not untick the switch.
  const hint = shortcutHintKey(state.shortcut)
  shortcutHint.textContent = hint ? t(hint) : ''
  if (passNote) say(PASS_NOTE[passNote]())
  renderDraw()
})
// The same keys as in the view window, for the edits of the whole picture (the view handles the deletion of the selection itself).
document.addEventListener('keydown', (event) => {
  const action = shortcutOf(event)
  if (action === 'undo' || action === 'redo' || action === 'clear') {
    event.preventDefault()
    edit(action)
  }
})
renderDraw()
void listWindows()
