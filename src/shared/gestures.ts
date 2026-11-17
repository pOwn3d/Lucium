// Mouse gestures: the right button held and moved draws a gesture, and releasing it runs the action
// the gesture stands for: left goes back, right goes forward, down opens a tab, up then down reloads. A right click that does not move
// is a right click: the page's menu opens as it always did. The gesture is read by a script in the page (page-tools.ts), which also
// draws the trail under the pointer; what the gestures mean, and the sites where they are off, are decided here.

import { GESTURE_MAX_STEPS, toolPreamble, type ToolScripts } from './page-tools'
import { isSiteExcluded } from './sleep'
import { t } from './i18n'

export type GestureAction = 'back' | 'forward' | 'new-tab' | 'reload' | 'close-tab' | 'reopen-tab'

/** What each drawn shape does: U up, D down, L left, R right, in the order drawn. A shape that is not here does nothing. */
export const GESTURES: Readonly<Record<string, GestureAction>> = Object.freeze({
  L: 'back',
  R: 'forward',
  D: 'new-tab',
  UD: 'reload',
  DR: 'close-tab',
  DL: 'reopen-tab'
})

/** A shape of two strokes, as the settings write it ("↑ puis ↓"). */
const twoStrokes = (first: string, second: string): string => t('gestures.first-puis-second', { first, second })

/** What the settings list for each action: the shape drawn and the action, in the language of the interface. */
export function gestureLabels(): ReadonlyArray<readonly [string, string]> {
  return [
    ['←', t('menu.page-precedente')],
    ['→', t('menu.page-suivante')],
    ['↓', t('sidebar.nouvel-onglet')],
    [twoStrokes('↑', '↓'), t('menu.actualiser-la-page')],
    [twoStrokes('↓', '→'), t('menu.archiver-l-onglet')],
    [twoStrokes('↓', '←'), t('menu.rouvrir-le-dernier-onglet-ferme')]
  ]
}

/** The shapes and their actions as one run of text, for the footnote of the settings ("← : Page précédente ; → : Page suivante ; …"). */
export const gesturesSummary = (): string => gestureLabels().map(([shape, action]) => t('gestures.shape-action', { shape, action })).join(t('gestures.separateur'))

/** The action of a drawn shape, or null for a plain click (nothing drawn) and for a shape that means nothing. */
export const gestureAction = (path: string): GestureAction | null => (Object.hasOwn(GESTURES, path) ? GESTURES[path]! : null)

/** A move shorter than this (pixels) is no stroke of a gesture: the hand shook, it did not draw. */
export const GESTURE_STEP = 24

/**
 * The stroke from the anchor to the point, if it is long enough: the dominant axis names the direction. Self-contained on purpose: the
 * page script is built from this function's source.
 */
export function gestureStroke(anchorX: number, anchorY: number, x: number, y: number, step: number): 'U' | 'D' | 'L' | 'R' | '' {
  const dx = x - anchorX
  const dy = y - anchorY
  if (Math.hypot(dx, dy) < step) return ''
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : dy > 0 ? 'D' : 'U'
}

/** The shape a pointer path draws, as the directions in order with repeats folded ("LLU" is "LU"). Empty when nothing was drawn. */
export function gesturePath(points: ReadonlyArray<readonly [number, number]>, step = GESTURE_STEP): string {
  if (points.length < 2) return ''
  let path = ''
  let [ax, ay] = points[0]!
  for (const [x, y] of points.slice(1)) {
    const stroke = gestureStroke(ax, ay, x, y, step)
    if (stroke === '') continue
    if (path.at(-1) !== stroke) path += stroke
    ax = x
    ay = y
    if (path.length > GESTURE_MAX_STEPS) return path.slice(0, GESTURE_MAX_STEPS)
  }
  return path
}

/** Whether the gestures are on for a page: the setting, and the site not in the list of those that are left out. */
export const gesturesOn = (enabled: boolean, excludedHosts: readonly string[], url: string): boolean => enabled && !isSiteExcluded(url, excludedHosts)

/** The trail's colour: Lucium's blue, drawn under the pointer while the right button is down. */
const TRAIL_COLOR = 'rgba(88,101,242,0.9)'

function installScript(nonce: string): string {
  return `(function () {
  'use strict';
  ${toolPreamble(nonce)}
  if (tools.mouseGestures) return;
  const stroke = ${gestureStroke.toString()};
  const STEP = ${GESTURE_STEP};
  const MAX = ${GESTURE_MAX_STEPS};
  let live = null;
  const trail = (state) => {
    if (state.canvas) return state.canvas;
    const canvas = document.createElement('canvas');
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * ratio);
    canvas.height = Math.round(innerHeight * ratio);
    // all:initial first: a rule of the page (canvas { display: none }) must not hide or move the trail.
    canvas.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;margin:0;padding:0';
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    context.lineWidth = 3;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = ${JSON.stringify(TRAIL_COLOR)};
    context.beginPath();
    context.moveTo(state.x0, state.y0);
    document.documentElement.append(canvas);
    state.canvas = canvas;
    state.context = context;
    return canvas;
  };
  const clear = () => {
    if (live && live.canvas) live.canvas.remove();
    live = null;
  };
  const onDown = (event) => {
    if (!event.isTrusted || event.button !== 2) return;
    live = { x0: event.clientX, y0: event.clientY, ax: event.clientX, ay: event.clientY, path: '', canvas: null, context: null, moved: false };
  };
  const onMove = (event) => {
    if (!live) return;
    if ((event.buttons & 2) === 0) { clear(); return; }
    const state = live;
    if (!state.moved && Math.hypot(event.clientX - state.x0, event.clientY - state.y0) > 6) state.moved = true;
    if (state.moved) {
      trail(state);
      state.context.lineTo(event.clientX, event.clientY);
      state.context.stroke();
    }
    const next = stroke(state.ax, state.ay, event.clientX, event.clientY, STEP);
    if (next === '') return;
    if (state.path.charAt(state.path.length - 1) !== next) state.path += next;
    state.ax = event.clientX;
    state.ay = event.clientY;
  };
  const onUp = (event) => {
    if (!live || !event.isTrusted || event.button !== 2) return;
    const state = live;
    clear();
    report({ tool: 'gesture', path: state.path.slice(0, MAX) });
  };
  const onHide = () => clear();
  addEventListener('mousedown', onDown, true);
  addEventListener('mousemove', onMove, true);
  addEventListener('mouseup', onUp, true);
  addEventListener('blur', onHide);
  addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onHide);
  tools.mouseGestures = {
    off() {
      clear();
      removeEventListener('mousedown', onDown, true);
      removeEventListener('mousemove', onMove, true);
      removeEventListener('mouseup', onUp, true);
      removeEventListener('blur', onHide);
      removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    }
  };
})()`
}

export const GESTURE_SCRIPTS: ToolScripts = {
  install: installScript,
  uninstall: `(function () { const tools = self.__lucium_tools; if (!tools || !tools.mouseGestures) return; try { tools.mouseGestures.off() } finally { delete tools.mouseGestures } })()`
}
