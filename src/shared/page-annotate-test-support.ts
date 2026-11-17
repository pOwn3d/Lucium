// Support of the tests of the page annotation (page-annotate-layer.test.ts, main/shell/page-annotate.test.ts): a stub window that runs the layer
// as its world of the page would. It is not the DOM: it keeps what the layer uses (elements with children and attributes, a shadow root, listeners,
// the size of the window) and the way an event travels: from the window down (the listeners of the capture phase), to the element, then up through
// its parents to the window, seen from outside a shadow root as an event of its host. The real rendering is checked by hand on a Mac
// (docs/design/annotation-partage-fenetre.md), and what a real page sees of the layer by the engine suite `annotate` (main/smoke-annotate.ts).

import { pageLayerCall, type PageLayerAction, type PageLayerConfig } from './page-annotate-layer'

type Listener = (event: any) => void
interface Listening {
  type: string
  listener: Listener
  capture: boolean
  passive: boolean
}
/** The window of a node, as far as an event needs it: its listeners of one phase, in the order they were added. */
interface View {
  listenersOf(type: string, capture: boolean): Listener[]
}

export class Node {
  children: Node[] = []
  parent: Node | null = null
  attributes: Record<string, string> = {}
  style: Record<string, string> = {}
  listeners = new Map<string, Set<Listener>>()
  textContent = ''
  value = ''
  focused = false
  shadow: Node | null = null
  /** The element a shadow root is the root of. */
  host: Node | null = null
  /** The window of the document that made this node. */
  view: View | null = null
  /** The size of the page's viewport without its scrollbars (the document element only; the tests set it). */
  clientWidth = 0
  clientHeight = 0
  constructor(readonly tagName: string) {}
  get firstChild(): Node | null {
    return this.children[0] ?? null
  }
  appendChild(child: Node): Node {
    child.parent = this
    this.children.push(child)
    return child
  }
  removeChild(child: Node): Node {
    this.children = this.children.filter((item) => item !== child)
    child.parent = null
    return child
  }
  remove(): void {
    this.parent?.removeChild(this)
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
  }
  attachShadow(): Node {
    this.shadow = new Node('#shadow-root')
    this.shadow.host = this
    return this.shadow
  }
  focus(): void {
    this.focused = true
  }
  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }
  /** The nodes an event of this node goes up through, from its parent to the root of its document (a shadow root hands it to its host). */
  private ancestors(): Node[] {
    const above: Node[] = []
    for (let node: Node | null = this.parent ?? this.host; node; node = node.parent ?? node.host) above.push(node)
    return above
  }
  /**
   * An event of this node, as the browser sends it: the capture listeners of the window, the listeners of the node, then those of its parents and
   * of the window. Outside a shadow root the target is the host of that root. `stopImmediatePropagation` ends the travel where it is called.
   */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const path = [this, ...this.ancestors()]
    const hosts = path.filter((node) => node.shadow !== null && path.includes(node.shadow))
    const target = hosts.at(-1) ?? this
    const view = path.map((node) => node.view).find((found) => found !== null) ?? null
    let stopped = false
    const given = event['stopImmediatePropagation'] as (() => void) | undefined
    const sent = { preventDefault: () => {}, stopPropagation: () => {}, button: 0, pointerId: 1, target, ...event, stopImmediatePropagation: () => ((stopped = true), given?.()) }
    const tell = (listeners: Listener[]): void => {
      for (const listener of listeners) if (!stopped) listener(sent)
    }
    tell(view?.listenersOf(type, true) ?? [])
    for (const node of path) tell([...(node.listeners.get(type) ?? [])])
    tell(view?.listenersOf(type, false) ?? [])
  }
}

/** A stub window: a document with an html element, a size, and the window's own listeners. */
export function stubWindow(options: { html?: boolean; width?: number; height?: number; clientWidth?: number; clientHeight?: number } = {}) {
  const listening: Listening[] = []
  const view: View = { listenersOf: (type, capture) => listening.filter((one) => one.type === type && one.capture === capture).map((one) => one.listener) }
  const made = (tag: string): Node => {
    const node = new Node(tag)
    node.view = view
    return node
  }
  const documentElement = options.html === false ? null : made('html')
  if (documentElement) {
    // By default the viewport is the window; a test gives less when the page shows its scrollbars.
    documentElement.clientWidth = options.clientWidth ?? options.width ?? 1000
    documentElement.clientHeight = options.clientHeight ?? options.height ?? 500
  }
  const scrolls: Array<[number, number]> = []
  const win = {
    document: {
      documentElement,
      // The field the page has the focus on: null, or a stub of an input (the tests set it).
      activeElement: null as any,
      createElement: (tag: string) => made(tag),
      createElementNS: (_ns: string, tag: string) => made(tag)
    },
    innerWidth: options.width ?? 1000,
    innerHeight: options.height ?? 500,
    scrollBy: (x: number, y: number) => scrolls.push([x, y]),
    addEventListener: (type: string, listener: Listener, options?: { capture?: boolean; passive?: boolean }) => {
      const capture = options?.capture === true
      if (!listening.some((one) => one.type === type && one.listener === listener && one.capture === capture)) listening.push({ type, listener, capture, passive: options?.passive === true })
    },
    // As in the DOM, a listener is taken away by its type, its function and its phase: one added for the capture phase stays when the phase is left out.
    removeEventListener: (type: string, listener: Listener, options?: { capture?: boolean }) => {
      const at = listening.findIndex((one) => one.type === type && one.listener === listener && one.capture === (options?.capture === true))
      if (at >= 0) listening.splice(at, 1)
    },
    scrolls,
    /** The listeners the window has now: their type, their phase, and whether they are passive. */
    listening,
    /** An event of the window itself (a key with no field in the layer, a resize, a blur): every listener of the window gets it. */
    dispatch: (type: string, event: Record<string, unknown> = {}) => {
      let stopped = false
      const sent = { target: win, stopImmediatePropagation: () => (stopped = true), ...event }
      for (const one of listening.filter((entry) => entry.type === type)) if (!stopped) one.listener(sent)
    }
  }
  return win
}
export type StubWindow = ReturnType<typeof stubWindow>

/** Runs a call text (what main sends to the page) against a stub window, the way the layer's world of the page runs it. `expire` answers a number. */
export function run(win: StubWindow, action: PageLayerAction, config?: PageLayerConfig): boolean | number {
  const call = pageLayerCall(action, config)
  return new Function('window', `return ${call}`)(win) as boolean | number
}

/** The host the layer put in the page, and the svg it draws in (under the shadow root). */
export function hostOf(win: StubWindow): Node {
  const host = win.document.documentElement!.children.find((child) => child.tagName === 'div')
  if (!host) throw new Error('no layer in the page')
  return host
}
export function svgOf(win: StubWindow): Node {
  return hostOf(win).shadow!.children[0]!
}
/** The drawn elements, one group each. */
export const drawn = (win: StubWindow): number => svgOf(win).children.length

export function stroke(win: StubWindow, from: [number, number], to: [number, number]): void {
  const host = hostOf(win)
  host.dispatch('pointerdown', { clientX: from[0], clientY: from[1] })
  host.dispatch('pointermove', { clientX: to[0], clientY: to[1] })
  host.dispatch('pointerup', {})
}
