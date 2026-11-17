// The transparent layer that annotates a page (docs/design/annotation-partage-fenetre.md, section « Annotation directe dans la page »). It is
// injected into the page on screen by main (main/shell/page-annotate.ts) with `pageLayerCall`, which runs `annotateLayer` in an isolated world of
// the page (`PAGE_ANNOTATE_WORLD`, through `Page.runAnnotateLayer`): the layer sees the page's document, the page's scripts do not see the layer's.
//
// `annotateLayer` is sent as TEXT (its source, from `toString()`): it must stay self-contained. It may not read any name from this module
// (no import, no constant outside it, no helper outside it), or the page would fail with a ReferenceError. The tests run this very source
// against a stub window (page-annotate-test-support.ts), which is what checks the rule.
//
// The layer keeps its drawing under a closed shadow root, and its state on the `window` of its own world. The shadow root keeps the styles of
// the page off the drawing; the world keeps its scripts out: they get neither the state (the strokes, the text, the history) nor the shadow root
// (it is closed, and made with the `attachShadow` of the layer's world, which the page cannot replace), they cannot change the drawing, and they
// cannot answer in the layer's place what main asks it (`editing`). The events of the layer (the pointer over it, the keys typed in its text
// box) are taken at the window, before they go down to the document, and stopped there: the listeners of the page do not get them.
//
// What the page still knows, as it does of anything put in its document: that an element covers it (the host, empty to its eyes), which it can
// take away; and a listener it put on its `window` for the capture phase BEFORE the layer was made runs before the layer's, so that page
// gets the pointer and the keys all the same (no script of a page can be put ahead of such a listener). The state (the mode, the brush) comes
// from main with each call; the layer has no channel back.
//
// The automatic clearing (shared/annotate-auto-clear.ts) is split between the two sides that may hold it. The layer knows the activity (a mark drawn, a
// press on the layer, a pointer that draws), which happens here and nowhere else: it keeps the time of the last one in its world, without a timer. The
// clock is main's (main/shell/page-annotate.ts): it asks the layer (`expire`) when the delay may have run out, and the layer answers how long to wait
// before asking again. A timer of the layer would be a timer of the page's window (worlds share its timers): the page could see each one made in the
// numbers its own timers get, and clear it by its number. The fade is a CSS transition of the drawing under the closed shadow root, whose events stay
// in that root. So the page can neither read, change nor time the clock.

/** An isolated world of its own (the other worlds of Lucium: 4_200_017 to 4_200_099, see `*_WORLD`). */
export const PAGE_ANNOTATE_WORLD = 4_200_037

export type PageLayerAction = 'mount' | 'show' | 'hide' | 'apply' | 'undo' | 'redo' | 'clear' | 'remove' | 'editing' | 'expire'

export interface PageLayerConfig {
  mode: 'draw' | 'pass'
  brush: { tool: string; color: string; width: number }
  /** The look of the laser (`classic`, `fine`, `neon`, see shared/page-annotate.ts); `classic` when absent. */
  laser?: string
  /**
   * The automatic clearing: after this many milliseconds without activity on the page, its marks fade out and are cleared as `clear` clears them (one
   * step of the history). Absent, 0, or not a positive number: never.
   */
  autoClear?: number
  /** The marks go without a fade (Lucium's « Réduire les animations »; the system's own wish is read by the layer). */
  still?: boolean
}

/** How the layer listens: `capture` takes the event at the window before the document, `passive: false` lets it stop the default (the wheel). */
export interface PageLayerListenOptions {
  capture: boolean
  passive: boolean
}

/** The part of a window the layer uses: the window of the layer's world in production, a stub in the tests. */
export interface PageLayerWindow {
  document: any
  innerWidth: number
  innerHeight: number
  scrollBy(x: number, y: number): void
  /** The media queries of the window: read for the system's wish of less motion (absent from a window that has none). */
  matchMedia?(query: string): { matches: boolean }
  addEventListener(type: string, listener: (event: any) => void, options?: PageLayerListenOptions): void
  removeEventListener(type: string, listener: (event: any) => void, options?: PageLayerListenOptions): void
}

/** The call main sends to the layer's world of the page: the layer's source, with the action and the config as JSON. */
export function pageLayerCall(action: PageLayerAction, config?: PageLayerConfig): string {
  return `(${annotateLayer.toString()})(window, ${JSON.stringify(action)}, ${JSON.stringify(config ?? null)})`
}

/**
 * Runs one action of the layer in `win`. Returns true when the action was done, false when the layer is not there (`show`, `undo`… on a page
 * that has none) or the page cannot take one (no document element). Main reads the answer to know whether to mount the layer again. `expire`
 * answers a number instead: the milliseconds main waits before it asks again (0: the clearing is off, main stops asking).
 */
export function annotateLayer(win: PageLayerWindow, action: PageLayerAction, config: PageLayerConfig | null): boolean | number {
  const KEY = '__luciumAnnotate'
  const SVG = 'http://www.w3.org/2000/svg'
  // The limits of the picture, as in the window share (shared/window-share-draw.ts): the elements, the points of a stroke, the history, a text.
  const MAX_ELEMENTS = 300
  const MAX_POINTS = 2000
  const HISTORY_LIMIT = 100
  const TEXT_MAX = 200
  // How far from the pointer the eraser reaches, in CSS pixels, besides half the thickness of the brush.
  const REACH = 12
  // One line of a wheel, in CSS pixels, when the browser reports the wheel in lines (deltaMode 1).
  const LINE_PX = 16
  // How often the fade of the laser's trail is drawn meanwhile (the life of a trail is per look, below).
  const TICK_MS = 50
  // The pointer: the radius of its circle, in CSS pixels.
  const POINTER_RADIUS = 14
  // The length of the fade of the automatic clearing, in milliseconds.
  const FADE_MS = 400
  // The longest delay of the automatic clearing, in milliseconds: main's timer cannot wait past 2^31 ms, and the setting offers 30 s at most.
  const AUTO_CLEAR_MAX = 3_600_000
  // The tools that keep nothing: the laser and the pointer (the list PAGE_EPHEMERAL_TOOLS of shared/page-annotate.ts, kept in step by hand).
  const EPHEMERAL = ['laser', 'pointer']
  // The keys that let the pointer through in draw mode: Control (the scrolling, as before) and Command (the page's clicks, its slides and links).
  const HOLD_KEYS = ['Control', 'Meta']
  // The events of the pointer over the layer that the layer does not use itself: kept from the page all the same, since they say where the pointer draws.
  const POINTER_QUIET = ['pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointerrawupdate', 'gotpointercapture', 'lostpointercapture', 'mousedown', 'mousemove', 'mouseup', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'touchcancel']
  // The events of the text box besides the keys: each of them carries what is typed, pasted or composed in it.
  const TEXT_QUIET = ['keypress', 'beforeinput', 'input', 'textInput', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut']
  // The looks of the laser (LASER_STYLES in shared/page-annotate.ts, kept in step by hand). `core`: the radius of the point (the document's diameter
  // halved); `halo` and `glow`: the radii of the soft halo and of the wide glow (0 for none), with the opacity of the halo; `trailFrom` and `trailTo`:
  // the width of the trail from its oldest to its newest segment; `white`: the point is white (the light look, a coloured halo around it); `rim`: a
  // thin white line round the point; `stays`: the point stays where the pointer stopped, and only the trail fades; `life`: how long the trail lives, ms.
  const LASER_LOOK: Record<string, { core: number; halo: number; glow: number; haloOpacity: number; trailFrom: number; trailTo: number; white: boolean; rim: boolean; stays: boolean; life: number }> = {
    net: { core: 3, halo: 0, glow: 0, haloOpacity: 0, trailFrom: 2, trailTo: 3, white: false, rim: true, stays: true, life: 900 },
    discret: { core: 1.75, halo: 4, glow: 0, haloOpacity: 0.2, trailFrom: 1.2, trailTo: 1.5, white: false, rim: false, stays: false, life: 550 },
    lumiere: { core: 2.25, halo: 16, glow: 30, haloOpacity: 0.8, trailFrom: 2, trailTo: 2.5, white: true, rim: false, stays: false, life: 1000 }
  }
  const doc = win.document
  const store = win as unknown as Record<string, Layer | undefined>

  interface Point {
    x: number
    y: number
  }
  interface Layer {
    host: any
    root: any
    svg: any
    mode: 'draw' | 'pass'
    brush: PageLayerConfig['brush']
    elements: any[]
    past: any[][]
    future: any[][]
    draft: any
    erasing: boolean
    erased: boolean
    /** Where the eraser was at the last event of its gesture, in CSS pixels of the window: the next event erases along the way from there. */
    eraserFrom: Point | null
    input: any
    /** The key (Enter, Escape) that ended the text box, until it is released: its keypress, its repeats and its release are the box's too. */
    ending: string | null
    endText: ((keep: boolean) => void) | null
    listeners: Array<[any, string, (event: any) => void, PageLayerListenOptions | undefined]>
    /** The laser: its points (a fraction of the window, and when each was made). Not in `elements`, so not in the history. */
    trail: Array<{ at: Point; time: number }>
    /** The pointer: where it is (a fraction of the window), or null. */
    cursor: Point | null
    /** The svg of the laser and the pointer: a second picture, over the drawing. */
    ghost: any
    /** The timer that draws the fade of the trail again, or null. */
    timer: any
    /** A key that lets the pointer through is held (Control, Command): the layer lets the pointer through (see holdKey). */
    holding: boolean
    /** The keys of HOLD_KEYS that are down now. */
    holdKeys: string[]
    /** The look of the laser (a key of LASER_LOOK). */
    laser: string
    /** The last point of the laser, where the pointer stopped: the point of a look that `stays` is drawn there. */
    last: { at: Point; time: number } | null
    /** The delay of the automatic clearing, in milliseconds; 0: never. */
    autoClear: number
    /** The automatic clearing goes without a fade. */
    still: boolean
    /** When the last activity on the page was (Date.now()): the automatic clearing comes `autoClear` after it. */
    idleSince: number
    /** The drawing is fading out: the next `expire` clears it, unless activity calls the fade off first. */
    fading: boolean
  }

  const current = store[KEY]

  if (action === 'mount') {
    if (!config || !doc || !doc.documentElement) return false
    if (current) destroy(current)
    store[KEY] = create(config)
    return true
  }
  if (!current) return false
  if (action === 'show') {
    current.host.style.display = ''
    if (config) setConfig(current, config)
    else current.host.style.pointerEvents = pointerOf(current)
    // Coming back on screen is no activity: the clock goes on from the last one.
    return true
  }
  // A hidden layer is off the screen and takes no pointer; the gesture or the text box it had is ended, so that nothing is left half made.
  if (action === 'hide') {
    // A fade under way ends where nobody sees it: its delay ran out, the marks are cleared.
    if (current.fading) clearMarks(current)
    settle(current)
    current.host.style.display = 'none'
    current.host.style.pointerEvents = 'none'
    return true
  }
  if (action === 'remove') {
    destroy(current)
    delete store[KEY]
    return true
  }
  // A change of the brush, the mode, the laser or the delay is a choice of the person in the bar (or a key of a tool): activity on the page on screen.
  // A hidden page only takes the new delay: the choice was not made on it.
  if (action === 'apply') {
    if (config) setConfig(current, config)
    if (!hidden(current)) active(current)
    return true
  }
  // Main's clock asks whether the delay ran out: the layer, which knows the activity, clears (or fades) and says when to ask again.
  if (action === 'expire') return expire(current)
  // Whether the keys belong to something else: a text box open here, or a field of the page that has the focus (its typing is not ours).
  if (action === 'editing') {
    const focused = doc.activeElement
    const tag = focused ? String(focused.tagName || '').toUpperCase() : ''
    const field = focused !== null && focused !== undefined && (focused.isContentEditable === true || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')
    return current.input !== null || field
  }
  // The edits of the whole picture: nothing to undo or redo is a done action too (the layer is there). Each one is activity: what an undo brings back
  // (the marks the automatic clearing took, for one) waits a whole delay again.
  if (action === 'undo') {
    const previous = current.past.pop()
    if (previous) {
      current.future.push(current.elements.slice())
      current.elements = previous
      render(current)
    }
    active(current)
    return true
  }
  if (action === 'redo') {
    const next = current.future.pop()
    if (next) {
      current.past.push(current.elements.slice())
      current.elements = next
      render(current)
    }
    active(current)
    return true
  }
  if (action === 'clear') {
    clearMarks(current)
    active(current)
    return true
  }
  return false

  /** The part of the window the layer covers: the viewport without the scrollbars, so that the page's scrollbars stay under the pointer. */
  function size(): { width: number; height: number } {
    const root = doc.documentElement
    const width = root && root.clientWidth > 0 ? root.clientWidth : win.innerWidth
    const height = root && root.clientHeight > 0 ? root.clientHeight : win.innerHeight
    return { width: width || 1, height: height || 1 }
  }

  /** Sizes the layer to the viewport (the scrollbars are not covered), and draws again for the new size. */
  function fit(layer: Layer): void {
    const { width, height } = size()
    layer.host.style.width = `${width}px`
    layer.host.style.height = `${height}px`
    render(layer)
  }

  /** A wheel delta in CSS pixels: lines and pages are converted with the line height and the viewport. */
  function wheelPixels(delta: number, mode: number, page: number): number {
    const value = Number(delta) || 0
    return mode === 1 ? value * LINE_PX : mode === 2 ? value * page : value
  }

  /**
   * The wheel scrolls the page underneath, horizontally and vertically, in the units the browser gave. The default is stopped: the page is
   * scrolled once, by this call, and not by the browser as well.
   */
  function wheel(event: any): void {
    if (event.preventDefault) event.preventDefault()
    const { width, height } = size()
    win.scrollBy(wheelPixels(event.deltaX, event.deltaMode, width), wheelPixels(event.deltaY, event.deltaMode, height))
  }

  /** A pointer position as a fraction of the window: the drawing keeps its place when the window is resized. */
  function norm(event: any): Point {
    const { width, height } = size()
    return { x: event.clientX / width, y: event.clientY / height }
  }

  function create(cfg: PageLayerConfig): Layer {
    const host = doc.createElement('div')
    // The size is the viewport's (see fit): 100vw would cover the scrollbars, and their clicks would be drawn instead of scrolling the page.
    host.style.cssText = 'position:fixed;top:0;left:0;margin:0;padding:0;border:0;z-index:2147483647;background:transparent;'
    const root = host.attachShadow({ mode: 'closed' })
    const svg = doc.createElementNS(SVG, 'svg')
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;'
    root.appendChild(svg)
    const ghost = doc.createElementNS(SVG, 'svg')
    ghost.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;pointer-events:none;'
    root.appendChild(ghost)
    doc.documentElement.appendChild(host)
    const layer: Layer = { host, root, svg, mode: 'draw', brush: cfg.brush, elements: [], past: [], future: [], draft: null, erasing: false, erased: false, eraserFrom: null, input: null, ending: null, endText: null, listeners: [], trail: [], cursor: null, ghost, timer: null, holding: false, holdKeys: [], laser: 'net', last: null, autoClear: 0, still: false, idleSince: Date.now(), fading: false }
    // The pointer over the layer: taken at the window and kept from the page (see `guard`). In pass mode, and while a hold key is down, the host takes
    // no pointer: the events are the page's, and the layer leaves them alone.
    const onLayer = (event: any): boolean => event.target === host
    guard(layer, 'pointerdown', onLayer, (event) => down(layer, event))
    guard(layer, 'pointermove', onLayer, (event) => move(layer, event))
    guard(layer, 'pointerup', onLayer, () => up(layer))
    guard(layer, 'pointercancel', onLayer, () => up(layer))
    // The layer covers the page: its wheel (mouse or trackpad) scrolls the page underneath. The listener is not passive: it must stop the default.
    guard(layer, 'wheel', onLayer, wheel)
    for (const type of POINTER_QUIET) guard(layer, type, onLayer, null)
    listen(layer, win, 'resize', () => fit(layer))
    // The keys. While the text box is open they are its typing: kept from the page (its shortcuts, its fields, and what is typed), with Enter that
    // takes the text and Escape that drops it, unless the key belongs to a composition of the input method. Otherwise, holding Control or Command
    // while drawing lets the pointer through to the page (scrolling, clicks, changing a slide): the layer takes it back once every such key is
    // released, or on blur (no keyup comes then).
    // The key that ends the box ends it on its press, so its keypress and its release come once the box is gone, aimed at the page (the focus left
    // with the box): they are the box's all the same, or a page listening for Enter would get half of the key that placed the text.
    const typing = (event: any): boolean => (layer.input !== null && event.target === host) || (layer.ending !== null && event.key === layer.ending)
    const anyKey = (): boolean => true
    guard(
      layer,
      'keydown',
      anyKey,
      (event) => {
        if (!typing(event)) {
          if (HOLD_KEYS.includes(event.key)) holdKey(layer, event.key, true)
          return
        }
        event.stopImmediatePropagation()
        if (layer.input === null) return
        // While a text is being composed (Japanese, Chinese, Korean), Enter chooses a candidate and Escape gives the composition up: both are the
        // input method's. Ending the box there placed the text half typed (the kana before their conversion), and what the input method committed
        // next was lost. Some engines send the key that ends a composition after its end, still marked as the input method's (229).
        const composing = event.isComposing === true || event.keyCode === 229
        if (!composing && (event.key === 'Enter' || event.key === 'Escape')) {
          layer.ending = event.key
          endText(layer, event.key === 'Enter')
        }
      },
      false
    )
    guard(
      layer,
      'keyup',
      anyKey,
      (event) => {
        if (typing(event)) {
          event.stopImmediatePropagation()
          if (event.key === layer.ending) layer.ending = null
        } else if (HOLD_KEYS.includes(event.key)) holdKey(layer, event.key, false)
      },
      false
    )
    for (const type of TEXT_QUIET) guard(layer, type, typing, null)
    listen(layer, win, 'blur', () => {
      layer.holdKeys = []
      // No keyup comes after a blur: the key that ended the box is released elsewhere, and the next press of it is the page's.
      layer.ending = null
      setHolding(layer, false)
    })
    setConfig(layer, cfg)
    fit(layer)
    return layer
  }

  function listen(layer: Layer, target: any, type: string, handler: (event: any) => void, options?: PageLayerListenOptions): void {
    if (options) target.addEventListener(type, handler, options)
    else target.addEventListener(type, handler)
    layer.listeners.push([target, type, handler, options])
  }

  /**
   * Listens at the window in the capture phase: an event the layer owns (`mine`) is taken there, before it goes down to the document, and goes no
   * further (`stop`, unless the handler decides by itself), so that no listener of the page below the window, and none put on the window after
   * this one, gets it. A listener without a handler only keeps the event from the page; it is passive, since it stops no default.
   */
  function guard(layer: Layer, type: string, mine: (event: any) => boolean, handler: ((event: any) => void) | null, stop = true): void {
    listen(
      layer,
      win,
      type,
      (event: any) => {
        if (!mine(event)) return
        if (stop) event.stopImmediatePropagation()
        if (handler) handler(event)
      },
      { capture: true, passive: handler === null }
    )
  }

  function destroy(layer: Layer): void {
    endText(layer, false)
    clearFade(layer)
    for (const [target, type, handler, options] of layer.listeners) {
      if (options) target.removeEventListener(type, handler, options)
      else target.removeEventListener(type, handler)
    }
    layer.listeners = []
    layer.host.remove()
  }

  function setConfig(layer: Layer, cfg: PageLayerConfig): void {
    // Another tool than the laser or the pointer leaves their picture: nothing of them is kept on the page.
    if (!EPHEMERAL.includes(cfg.brush.tool)) clearFollow(layer)
    layer.laser = cfg.laser && LASER_LOOK[cfg.laser] ? cfg.laser : 'net'
    // The delay of the automatic clearing: anything but a positive, finite number is « never ».
    const delay = cfg.autoClear
    layer.autoClear = typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? Math.min(delay, AUTO_CLEAR_MAX) : 0
    layer.still = cfg.still === true
    layer.brush = cfg.brush
    layer.mode = cfg.mode
    layer.host.style.pointerEvents = pointerOf(layer)
    // Passing through the page ends what is being drawn: nothing is kept half made.
    if (cfg.mode === 'pass') settle(layer)
  }

  /** The pointer goes to the layer in draw mode, unless a hold key is down; in pass mode it goes to the page. */
  function pointerOf(layer: Layer): string {
    return layer.mode === 'pass' || layer.holding ? 'none' : 'auto'
  }

  /**
   * A hold key (Control, Command) down in draw mode: the layer lets the pointer through, so that the page scrolls (wheel, trackpad), takes its clicks
   * and changes its slides. The gesture in progress is ended and kept, as in pass mode. The layer takes the pointer back once no hold key is down
   * (see the blur of the window, which also takes it back: no keyup comes then).
   */
  function holdKey(layer: Layer, key: string, down: boolean): void {
    const keys = layer.holdKeys.filter((held) => held !== key)
    if (down) keys.push(key)
    layer.holdKeys = keys
    setHolding(layer, keys.length > 0)
  }

  function setHolding(layer: Layer, held: boolean): void {
    if (layer.holding === held) return
    layer.holding = held
    if (held) settle(layer)
    layer.host.style.pointerEvents = pointerOf(layer)
  }

  /** Ends the gesture in progress (a stroke, a shape, an eraser pass) and the text box: what was made is kept, what was not finished is dropped. */
  function settle(layer: Layer): void {
    layer.draft = null
    layer.erasing = false
    endText(layer, true)
    clearFollow(layer)
    render(layer)
  }

  function isEphemeral(layer: Layer): boolean {
    return EPHEMERAL.includes(layer.brush.tool)
  }

  /** Forgets the laser's trail and the pointer, and the timer of their fade. */
  function clearFollow(layer: Layer): void {
    layer.trail = []
    layer.cursor = null
    layer.last = null
    clearFade(layer)
    render(layer)
  }

  function clearFade(layer: Layer): void {
    if (layer.timer !== null) clearTimeout(layer.timer)
    layer.timer = null
  }

  function hidden(layer: Layer): boolean {
    return layer.host.style.display === 'none'
  }

  /** The system asks for less motion: the media query of the window of this world, which the page's scripts cannot answer in its place. */
  function reducedMotion(): boolean {
    return typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  }

  /**
   * Activity on the page: a mark drawn or being drawn, a press on the layer, a pointer that draws, a tool or a colour chosen, an undo. The delay of the
   * automatic clearing counts from now, and a fade under way is called off: the marks come back whole. No timer is made: main's clock asks later.
   */
  function active(layer: Layer): void {
    layer.idleSince = Date.now()
    stopFade(layer)
  }

  /**
   * Main's clock asks whether the delay ran out, and the answer is when to ask again, in milliseconds. Off: 0, main stops. A fade under way that was not
   * called off: the marks go now. A gesture under way or a text box open is activity still (what is being written is never cleared). Before the end of
   * the delay: what is left of it. At its end, with marks: they fade out (at once when the layer is hidden, or when the system or Lucium asks for less
   * motion), and main asks again once the fade is over.
   */
  function expire(layer: Layer): number {
    if (layer.autoClear === 0) {
      stopFade(layer)
      return 0
    }
    if (layer.fading) {
      clearMarks(layer)
      return layer.autoClear
    }
    if (layer.draft !== null || layer.erasing || layer.input !== null) layer.idleSince = Date.now()
    const left = layer.idleSince + layer.autoClear - Date.now()
    if (left > 0) return Math.ceil(left)
    if (layer.elements.length === 0) return layer.autoClear
    if (layer.still || hidden(layer) || reducedMotion()) {
      clearMarks(layer)
      return layer.autoClear
    }
    // A transition of the drawing's opacity, drawn by the engine under the closed shadow root: no timer of the page's window, no event out of the root.
    layer.fading = true
    layer.svg.style.transition = `opacity ${FADE_MS}ms linear`
    layer.svg.style.opacity = '0'
    return FADE_MS
  }

  /** Calls the fade off: the drawing is whole again at once. */
  function stopFade(layer: Layer): void {
    if (!layer.fading) return
    layer.fading = false
    layer.svg.style.transition = ''
    layer.svg.style.opacity = ''
  }

  /** Clears the marks of the page as one step of the history (« Page », and the automatic clearing): ⌘Z brings them back. */
  function clearMarks(layer: Layer): void {
    stopFade(layer)
    if (layer.elements.length > 0) {
      pushHistory(layer)
      layer.elements = []
    }
    render(layer)
  }

  /**
   * The laser and the pointer follow the pointer, pressed or not: the laser adds a point to its trail, the pointer moves its circle. Neither
   * touches the elements or the history: they are for the audience, and they fade or go with the pointer.
   */
  function follow(layer: Layer, event: any): void {
    const at = norm(event)
    if (layer.brush.tool === 'laser') {
      const time = Date.now()
      layer.trail.push({ at, time })
      layer.last = { at, time }
      if (layer.trail.length > MAX_POINTS) layer.trail.shift()
    } else {
      layer.cursor = at
    }
    // The laser and the pointer show a place to the audience while they move: activity, though nothing is drawn.
    active(layer)
    render(layer)
  }

  function down(layer: Layer, event: any): void {
    if (layer.mode !== 'draw') return
    // A press on the layer, whatever its button and whatever it starts, is activity.
    active(layer)
    if (layer.input !== null || (event.button !== undefined && event.button !== 0)) return
    if (event.preventDefault) event.preventDefault()
    if (isEphemeral(layer)) {
      follow(layer, event)
      return
    }
    const at = norm(event)
    const { tool, color, width } = layer.brush
    if (tool === 'text') {
      openText(layer, at)
      return
    }
    layer.erased = false
    if (tool === 'eraser') {
      layer.erasing = true
      layer.eraserFrom = null
      eraseAt(layer, event)
      return
    }
    if (tool === 'pen' || tool === 'highlighter') layer.draft = { kind: 'stroke', tool, color, width, points: [at] }
    else layer.draft = { kind: 'shape', shape: tool, color, width, from: at, to: at }
    if (layer.host.setPointerCapture) layer.host.setPointerCapture(event.pointerId)
    render(layer)
  }

  function move(layer: Layer, event: any): void {
    if (layer.mode === 'draw' && isEphemeral(layer)) {
      follow(layer, event)
      return
    }
    // A pointer that moves while it draws or erases is activity; one that only wanders over the layer is not.
    if (layer.erasing) {
      active(layer)
      eraseAt(layer, event)
      return
    }
    const draft = layer.draft
    if (!draft) return
    active(layer)
    const at = norm(event)
    if (draft.kind === 'stroke') {
      if (draft.points.length < MAX_POINTS) draft.points.push(at)
    } else {
      draft.to = at
    }
    render(layer)
  }

  function up(layer: Layer): void {
    const gesture = layer.erasing || layer.draft !== null
    layer.erasing = false
    const draft = layer.draft
    layer.draft = null
    // A shape without a size (a click) is not kept; a stroke of one point is a dot, which is kept.
    const keep = draft !== null && (draft.kind === 'stroke' || draft.from.x !== draft.to.x || draft.from.y !== draft.to.y)
    if (keep) commit(layer, draft)
    else render(layer)
    // The end of a gesture is its last activity (the eraser's too, which may leave marks): the clock counts from there.
    if (gesture) active(layer)
  }

  function pushHistory(layer: Layer): void {
    layer.past.push(layer.elements.slice())
    if (layer.past.length > HISTORY_LIMIT) layer.past.shift()
    layer.future = []
  }

  function commit(layer: Layer, element: any): void {
    if (layer.elements.length >= MAX_ELEMENTS) {
      render(layer)
      return
    }
    pushHistory(layer)
    layer.elements.push(element)
    render(layer)
    // A new mark: the clock of the automatic clearing starts from it.
    active(layer)
  }

  /**
   * Removes the elements the eraser touches on its way since its last event. The browser hands a quick move over as one event, far from the last
   * one: the way between them is erased, not only the point where the pointer is reported. One gesture is one step of the history, however many
   * elements it removes.
   */
  function eraseAt(layer: Layer, event: any): void {
    const { width, height } = size()
    const reach = REACH + layer.brush.width / 2
    const to = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 }
    const from = layer.eraserFrom ?? to
    layer.eraserFrom = to
    const kept = layer.elements.filter((element) => !touches(element, from, to, reach, width, height))
    if (kept.length === layer.elements.length) return
    if (!layer.erased) {
      pushHistory(layer)
      layer.erased = true
    }
    layer.elements = kept
    render(layer)
  }

  /** Whether the way of the eraser from `a` to `b` (CSS pixels; one point when they are the same) comes within `reach` of the element. */
  function touches(element: any, a: Point, b: Point, reach: number, width: number, height: number): boolean {
    const toPx = (point: Point): Point => ({ x: point.x * width, y: point.y * height })
    // The distance from a point to a segment.
    const toSegment = (p: Point, s: Point, e: Point): number => {
      const dx = e.x - s.x
      const dy = e.y - s.y
      const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / (dx * dx + dy * dy)))
      return Math.hypot(p.x - (s.x + t * dx), p.y - (s.y + t * dy))
    }
    const side = (s: Point, e: Point, p: Point): number => Math.sign((e.x - s.x) * (p.y - s.y) - (e.y - s.y) * (p.x - s.x))
    // The distance from the way of the eraser to a segment: none when they cross, else the nearest of their ends to the other.
    const distance = (s: Point, e: Point): number => {
      if (side(s, e, a) * side(s, e, b) < 0 && side(a, b, s) * side(a, b, e) < 0) return 0
      return Math.min(toSegment(a, s, e), toSegment(b, s, e), toSegment(s, a, b), toSegment(e, a, b))
    }
    /** Whether the way enters the box, grown by the reach on each side. */
    const box = (left: number, top: number, right: number, bottom: number): boolean => {
      const inside = (p: Point): boolean => p.x >= left - reach && p.x <= right + reach && p.y >= top - reach && p.y <= bottom + reach
      if (inside(a) || inside(b)) return true
      const corners = [{ x: left - reach, y: top - reach }, { x: right + reach, y: top - reach }, { x: right + reach, y: bottom + reach }, { x: left - reach, y: bottom + reach }]
      for (let i = 0; i < 4; i++) if (distance(corners[i]!, corners[(i + 1) % 4]!) < 0.5) return true
      return false
    }
    if (element.kind === 'stroke') {
      const points = element.points.map(toPx)
      if (points.length === 1) return toSegment(points[0], a, b) <= reach
      for (let i = 1; i < points.length; i++) if (distance(points[i - 1], points[i]) <= reach) return true
      return false
    }
    if (element.kind === 'text') {
      const at = toPx(element.at)
      const fontSize = fontSizeOf(element.width)
      const textWidth = element.text.length * fontSize * 0.55
      return box(at.x, at.y - fontSize, at.x + textWidth, at.y)
    }
    const from = toPx(element.from)
    const to = toPx(element.to)
    if (element.shape === 'line' || element.shape === 'arrow') return distance(from, to) <= reach
    return box(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.max(from.x, to.x), Math.max(from.y, to.y))
  }

  function fontSizeOf(width: number): number {
    return 14 + width * 3
  }

  function make(tag: string): any {
    return doc.createElementNS(SVG, tag)
  }

  function attrs(node: any, values: Record<string, string | number>): any {
    for (const name of Object.keys(values)) node.setAttribute(name, String(values[name]))
    return node
  }

  function pathOf(points: Point[], width: number, height: number): string {
    return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x * width} ${point.y * height}`).join(' ')
  }

  /** One element as SVG, in CSS pixels of the current window. */
  function drawElement(_layer: Layer, element: any, width: number, height: number): any {
    const group = attrs(make('g'), { fill: 'none', stroke: element.color, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
    if (element.kind === 'stroke') {
      const highlight = element.tool === 'highlighter'
      group.appendChild(attrs(make('path'), { d: pathOf(element.points, width, height), 'stroke-width': highlight ? element.width * 4 : element.width, opacity: highlight ? 0.4 : 1 }))
      return group
    }
    if (element.kind === 'text') {
      const node = attrs(make('text'), { x: element.at.x * width, y: element.at.y * height, 'font-size': fontSizeOf(element.width), 'font-family': 'system-ui, sans-serif', 'font-weight': 600, fill: element.color, stroke: 'none' })
      node.textContent = element.text
      group.appendChild(node)
      return group
    }
    const from = { x: element.from.x * width, y: element.from.y * height }
    const to = { x: element.to.x * width, y: element.to.y * height }
    group.setAttribute('stroke-width', String(element.width))
    const left = Math.min(from.x, to.x)
    const top = Math.min(from.y, to.y)
    const boxWidth = Math.abs(to.x - from.x)
    const boxHeight = Math.abs(to.y - from.y)
    if (element.shape === 'rectangle') group.appendChild(attrs(make('rect'), { x: left, y: top, width: boxWidth, height: boxHeight }))
    else if (element.shape === 'diamond') {
      // The lozenge: the middle of each side of the box, from its top to its bottom and from its left to its right.
      const middleX = left + boxWidth / 2
      const middleY = top + boxHeight / 2
      group.appendChild(attrs(make('path'), { d: `M${middleX} ${top} L${left + boxWidth} ${middleY} L${middleX} ${top + boxHeight} L${left} ${middleY} Z` }))
    }
    else if (element.shape === 'ellipse') group.appendChild(attrs(make('ellipse'), { cx: left + boxWidth / 2, cy: top + boxHeight / 2, rx: boxWidth / 2, ry: boxHeight / 2 }))
    else {
      group.appendChild(attrs(make('line'), { x1: from.x, y1: from.y, x2: to.x, y2: to.y }))
      if (element.shape === 'arrow') {
        // The head: two wings at 25 degrees back from the end, of a length that grows with the thickness.
        const angle = Math.atan2(to.y - from.y, to.x - from.x)
        const length = 12 + element.width * 2
        const wing = (sign: number): Point => ({ x: to.x - length * Math.cos(angle + sign * 0.45), y: to.y - length * Math.sin(angle + sign * 0.45) })
        const first = wing(1)
        const second = wing(-1)
        group.appendChild(attrs(make('path'), { d: `M${first.x} ${first.y} L${to.x} ${to.y} L${second.x} ${second.y}` }))
      }
    }
    return group
  }

  function render(layer: Layer): void {
    const { width, height } = size()
    const svg = layer.svg
    attrs(svg, { width: '100%', height: '100%', viewBox: `0 0 ${width} ${height}` })
    while (svg.firstChild) svg.removeChild(svg.firstChild)
    for (const element of layer.elements) svg.appendChild(drawElement(layer, element, width, height))
    if (layer.draft) svg.appendChild(drawElement(layer, layer.draft, width, height))
    renderFollow(layer, width, height)
  }

  /** The laser's trail, which fades, and the pointer's circle. A fade needs a new picture while points live: one timer at a time. */
  function renderFollow(layer: Layer, width: number, height: number): void {
    const ghost = layer.ghost
    attrs(ghost, { width: '100%', height: '100%', viewBox: `0 0 ${width} ${height}` })
    while (ghost.firstChild) ghost.removeChild(ghost.firstChild)
    const now = Date.now()
    const look = LASER_LOOK[layer.laser] ?? LASER_LOOK.net!
    layer.trail = layer.trail.filter((point) => now - point.time < look.life)
    const color = layer.brush.color
    // The halo of the point: a soft radial gradient of the colour, fading to nothing at its edge (a gradient of this picture, by id in its shadow root).
    const defs = make('defs')
    const gradient = attrs(make('radialGradient'), { id: 'lucium-laser-halo' })
    // Four stops, as a glow falls off: strong at the point, a soft shoulder, a faint tail, then nothing at the edge (a gentle halo, not a disc).
    gradient.appendChild(attrs(make('stop'), { offset: 0, 'stop-color': color, 'stop-opacity': look.haloOpacity }))
    gradient.appendChild(attrs(make('stop'), { offset: 0.3, 'stop-color': color, 'stop-opacity': (look.haloOpacity * 0.35).toFixed(3) }))
    gradient.appendChild(attrs(make('stop'), { offset: 0.7, 'stop-color': color, 'stop-opacity': (look.haloOpacity * 0.08).toFixed(3) }))
    gradient.appendChild(attrs(make('stop'), { offset: 1, 'stop-color': color, 'stop-opacity': 0 }))
    defs.appendChild(gradient)
    ghost.appendChild(defs)
    // The trail: a line that tapers and fades with age (the newest segment is the widest and the most opaque).
    for (let i = 1; i < layer.trail.length; i++) {
      const from = layer.trail[i - 1]!
      const to = layer.trail[i]!
      const fresh = Math.max(0, 1 - (now - to.time) / look.life)
      const widthNow = look.trailFrom + (look.trailTo - look.trailFrom) * fresh
      ghost.appendChild(attrs(make('line'), { x1: from.at.x * width, y1: from.at.y * height, x2: to.at.x * width, y2: to.at.y * height, stroke: color, 'stroke-width': widthNow.toFixed(2), 'stroke-linecap': 'round', opacity: fresh.toFixed(3) }))
    }
    // The point: where the pointer is (or, for a look that stays, where it stopped), with its halo, its glow and its rim; it fades with the trail,
    // except for a look that stays, whose point does not fade (it goes with the tool, or when the layer is hidden).
    const tip = look.stays ? layer.last : layer.trail.length > 0 ? layer.trail[layer.trail.length - 1]! : null
    if (tip) {
      const fresh = look.stays ? 1 : Math.max(0, 1 - (now - tip.time) / look.life)
      const opacity = fresh.toFixed(3)
      const cx = tip.at.x * width
      const cy = tip.at.y * height
      if (look.glow > 0) ghost.appendChild(attrs(make('circle'), { cx, cy, r: look.glow, fill: 'url(#lucium-laser-halo)', opacity: (fresh * 0.5).toFixed(3) }))
      if (look.halo > 0) ghost.appendChild(attrs(make('circle'), { cx, cy, r: look.halo, fill: 'url(#lucium-laser-halo)', opacity }))
      ghost.appendChild(attrs(make('circle'), { cx, cy, r: look.core, fill: look.white ? '#ffffff' : color, opacity }))
      if (look.rim) ghost.appendChild(attrs(make('circle'), { cx, cy, r: look.core + 0.5, fill: 'none', stroke: '#ffffff', 'stroke-width': 0.8, 'stroke-opacity': 0.9, opacity }))
      ghost.appendChild(attrs(make('circle'), { cx, cy, r: 1.2, fill: '#ffffff', opacity }))
    }
    if (layer.cursor && layer.brush.tool === 'pointer') {
      const { x, y } = layer.cursor
      ghost.appendChild(attrs(make('circle'), { cx: x * width, cy: y * height, r: POINTER_RADIUS, fill: color, 'fill-opacity': 0.3, stroke: color, 'stroke-width': 2, 'stroke-opacity': 0.8 }))
    }
    if (layer.trail.length > 0 && layer.timer === null) {
      layer.timer = setTimeout(() => {
        layer.timer = null
        render(layer)
      }, TICK_MS)
    }
  }

  /** The text box: it takes the text when Enter is pressed or the box loses the focus; Escape drops it. */
  function openText(layer: Layer, at: Point): void {
    const { width, height } = size()
    const { color, width: thickness } = layer.brush
    const input = doc.createElement('input')
    input.type = 'text'
    input.maxLength = TEXT_MAX
    input.style.cssText = `position:absolute;left:${at.x * width}px;top:${at.y * height}px;font:600 ${fontSizeOf(thickness)}px system-ui,sans-serif;color:${color};background:rgba(255,255,255,0.7);border:1px dashed ${color};outline:none;padding:2px 4px;min-width:140px;`
    const finish = (keep: boolean): void => {
      if (layer.input !== input) return
      layer.input = null
      layer.endText = null
      const text = String(input.value).trim()
      input.remove()
      if (keep && text.length > 0 && text.length <= TEXT_MAX) commit(layer, { kind: 'text', at, text, color, width: thickness })
      else render(layer)
      // The box was open until now: activity, whether its text was kept or dropped.
      active(layer)
    }
    layer.input = input
    layer.endText = finish
    // The keys of the box are taken at the window (see create): Enter and Escape end it there, and the page gets none of them.
    listen(layer, input, 'blur', () => finish(true))
    layer.root.appendChild(input)
    input.focus()
  }

  function endText(layer: Layer, keep: boolean): void {
    if (layer.endText) layer.endText(keep)
  }
}
