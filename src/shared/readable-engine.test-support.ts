// Support of the tests of the readable engine (readable-engine.test.ts): a stand-in for the window the engine runs in. It is not the DOM: it keeps
// what the engine uses (elements with children, text and attributes, computed styles given by the test, stylesheets as text, a mutation observer
// and idle callbacks the test runs by hand). Computed styles are what the test says they are: the engine's own rules are not applied to them,
// which is enough to check what it decides and what it writes. The real rendering is measured by scripts/readable-bench.mjs.

import { readableEngineCall, type ReadableBudget, type ReadableCommand, type ReadableEngineConfig } from './readable-engine'

const HTML = 'http://www.w3.org/1999/xhtml'
const SVG = 'http://www.w3.org/2000/svg'

/** The computed style of an element, by CSS property name (dashed); what is not given is the browser's initial value. */
export type Styles = Record<string, string>

const INITIAL: Styles = {
  display: 'block',
  'background-color': 'rgba(0, 0, 0, 0)',
  'background-image': 'none',
  color: 'rgb(0, 0, 0)',
  opacity: '1',
  'font-size': '16px',
  'font-weight': '400',
  'color-scheme': 'normal',
  fill: 'rgb(0, 0, 0)',
  stroke: 'none',
  ...Object.fromEntries(['top', 'right', 'bottom', 'left'].flatMap((side) => [[`border-${side}-width`, '0px'], [`border-${side}-style`, 'none'], [`border-${side}-color`, 'rgb(0, 0, 0)']]))
}

const dashed = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

export class FakeText {
  readonly nodeType = 3
  parentNode: FakeElement | null = null
  constructor(public data: string) {}
  get nextSibling(): FakeNode | null {
    return siblingOf(this, 1)
  }
}

type FakeNode = FakeElement | FakeText

function siblingOf(node: FakeNode, step: number): FakeNode | null {
  const parent = node.parentNode
  if (!parent) return null
  const list: FakeNode[] = parent.childNodes
  return list[list.indexOf(node) + step] ?? null
}

export class FakeElement {
  readonly nodeType = 1
  childNodes: FakeNode[] = []
  parentNode: FakeElement | FakeShadowRoot | null = null
  attributes = new Map<string, string>()
  styles: Styles
  shadowRoot: FakeShadowRoot | null = null
  connected = true
  /** For an image: what `drawImage` draws (one colour per pixel, RGBA), and its natural size. */
  pixels: number[][] | null = null
  complete = true
  naturalWidth = 0
  naturalHeight = 0
  currentSrc = ''
  type = ''
  constructor(
    public tagName: string,
    styles: Styles = {},
    public namespaceURI = HTML
  ) {
    this.styles = styles
  }
  get nodeName(): string {
    return this.tagName
  }
  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null
  }
  get isConnected(): boolean {
    return this.connected && (this.parentNode === null ? this.tagName === 'HTML' : this.parentNode instanceof FakeShadowRoot ? this.parentNode.host.isConnected : this.parentNode.isConnected)
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }
  get nextSibling(): FakeNode | null {
    return siblingOf(this, 1)
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement)
  }
  get lastElementChild(): FakeElement | null {
    return this.children.at(-1) ?? null
  }
  get previousElementSibling(): FakeElement | null {
    const parent = this.parentNode
    if (!parent) return null
    const list = parent.children
    return list[list.indexOf(this) - 1] ?? null
  }
  append(...nodes: Array<FakeNode | string>): this {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n) : n
      node.parentNode = this
      this.childNodes.push(node)
    }
    return this
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
  /** Every element under this one, in document order (shadow trees excepted, as in the DOM). */
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()])
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((el) => matches(el, selector))
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

export class FakeShadowRoot {
  childNodes: FakeElement[] = []
  styleSheets: FakeSheet[] = []
  adoptedStyleSheets: FakeSheet[] = []
  constructor(public host: FakeElement) {}
  get children(): FakeElement[] {
    return this.childNodes
  }
  get lastElementChild(): FakeElement | null {
    return this.childNodes.at(-1) ?? null
  }
  append(...nodes: FakeElement[]): this {
    for (const node of nodes) {
      node.parentNode = this
      this.childNodes.push(node)
    }
    return this
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.childNodes.flatMap((c) => [c, ...c.descendants()]).filter((el) => matches(el, selector))
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

/** The selectors the engine asks for: `[attribute]`, `.class`, a tag, and lists of them. */
function matches(el: FakeElement, selector: string): boolean {
  // A pseudo-class of another engine: Chromium refuses the selector.
  if (selector.includes(':-moz-')) throw new SyntaxError(`'${selector}' is not a valid selector`)
  return selector.split(',').some((part) => {
    const s = part.trim()
    if (s.startsWith('[')) return el.hasAttribute(s.slice(1, -1))
    if (s.startsWith('.')) return (el.getAttribute('class') ?? '').split(/\s+/).includes(s.slice(1))
    if (s === '*') return true
    return el.tagName.toLowerCase() === s.toLowerCase()
  })
}

/** A stylesheet: its text, as the engine writes it, and the rules it inserts one by one. */
export class FakeSheet {
  static failing = false
  /** Refuses every rule inserted one by one (a value the browser reads differently). */
  static refusing = false
  text = ''
  cssRules: Array<{ cssText: string }> = []
  disabled = false
  media = { mediaText: '' }
  replaceSync(text: string): void {
    if (FakeSheet.failing) throw new Error('the browser refused the sheet')
    this.text = text
    this.cssRules = text ? [{ cssText: text }] : []
  }
  insertRule(rule: string, index: number): number {
    if (FakeSheet.refusing) throw new Error('SyntaxError')
    this.cssRules.splice(index, 0, { cssText: rule })
    return index
  }
}

export class FakeObserver {
  static all: FakeObserver[] = []
  targets: unknown[] = []
  connected = true
  constructor(public callback: (records: unknown[]) => void) {
    FakeObserver.all.push(this)
  }
  observe(target: unknown): void {
    this.targets.push(target)
  }
  disconnect(): void {
    this.connected = false
  }
}

export interface FakeWindow {
  document: {
    documentElement: FakeElement
    body: FakeElement
    styleSheets: Array<FakeSheet | { cssRules: unknown; disabled?: boolean; media?: { mediaText: string }; href?: string | null }>
    adoptedStyleSheets: FakeSheet[]
    createElement(tag: string): unknown
    addEventListener(type: string, listener: unknown, capture?: boolean): void
    removeEventListener(type: string, listener: unknown, capture?: boolean): void
    querySelectorAll(selector: string): FakeElement[]
    querySelector(selector: string): FakeElement | null
    listeners: Map<string, unknown>
  }
  getComputedStyle(el: FakeElement, pseudo?: string | null): Record<string, string> & { getPropertyValue(name: string): string }
  performance: { now(): number }
  CSSStyleSheet: typeof FakeSheet
  MutationObserver: typeof FakeObserver
  requestIdleCallback(fn: (deadline: unknown) => void): void
  console: { warn: (...args: unknown[]) => void }
  idle: Array<(deadline: unknown) => void>
  /** The clock of the page, in ms; tests move it forward to make work look slow. */
  clock: number
  /** What a pseudo-element computes, by selector of its element and pseudo (`p::after`). */
  pseudo: Map<string, Styles>
  warnings: string[]
  [key: string]: unknown
}

/** A window with an html and a body (white, black text by default), and the stand-ins the engine uses. */
export function fakeWindow(options: { html?: Styles; body?: Styles } = {}): FakeWindow {
  FakeObserver.all = []
  FakeSheet.failing = false
  FakeSheet.refusing = false
  const html = new FakeElement('HTML', options.html ?? {})
  const body = new FakeElement('BODY', options.body ?? { 'background-color': 'rgb(255, 255, 255)' })
  html.append(body)
  const listeners = new Map<string, unknown>()
  const win: FakeWindow = {
    document: {
      documentElement: html,
      body,
      styleSheets: [],
      adoptedStyleSheets: [],
      listeners,
      createElement: (tag: string) => {
        if (tag !== 'canvas') return new FakeElement(tag.toUpperCase())
        // The canvas the engine resolves colours on and draws pictures in: getImageData answers the pixels of the last picture drawn.
        let last: number[][] = []
        const context = {
          canvas: { width: 0, height: 0 },
          fillStyle: '#000000',
          clearRect: () => undefined,
          fillRect: () => undefined,
          drawImage: (img: FakeElement) => {
            if (img.getAttribute('crossorigin-tainted') !== null) last = [[-1]]
            else last = img.pixels ?? []
          },
          getImageData: () => {
            if (last[0]?.[0] === -1) throw new Error('The canvas has been tainted by cross-origin data.')
            // This stand-in draws no colour of its own: a colour the engine asks the canvas to resolve is not known here.
            if (last.length === 0) throw new Error('nothing drawn')
            return { data: last.flat() }
          }
        }
        return { getContext: () => context }
      },
      addEventListener: (type: string, listener: unknown) => void listeners.set(type, listener),
      removeEventListener: (type: string) => void listeners.delete(type),
      querySelectorAll: (selector: string) => [html, ...html.descendants()].filter((el) => matches(el, selector)),
      querySelector: (selector: string) => [html, ...html.descendants()].find((el) => matches(el, selector)) ?? null
    },
    getComputedStyle: (el: FakeElement, pseudo?: string | null) => {
      const base = pseudo ? { ...INITIAL, ...(win.pseudo.get(`${el.tagName.toLowerCase()}${pseudo}`) ?? {}) } : { ...INITIAL, ...el.styles }
      const style = new Proxy(base, { get: (target, key) => (key === 'getPropertyValue' ? (name: string) => target[name] ?? '' : typeof key === 'string' ? (target[dashed(key)] ?? '') : undefined) })
      return style as Record<string, string> & { getPropertyValue(name: string): string }
    },
    performance: { now: () => win.clock },
    CSSStyleSheet: FakeSheet,
    MutationObserver: FakeObserver,
    requestIdleCallback: (fn) => void win.idle.push(fn),
    console: { warn: (...args: unknown[]) => void win.warnings.push(args.map(String).join(' ')) },
    idle: [],
    clock: 1000,
    pseudo: new Map(),
    warnings: []
  }
  return win
}

/** Runs a command of the engine in `win` as the page runs it: the very text `readableEngineCall` builds. */
export function runEngine(win: FakeWindow, command: ReadableCommand, config?: Partial<Omit<ReadableEngineConfig, 'budget'>> & { budget?: Partial<ReadableBudget> }): any {
  const full = config ? { scheme: config.scheme ?? 'dark', fallbackCss: config.fallbackCss ?? 'html { filter: invert(1) }', ...(config.budget ? { budget: { ...defaultBudget(), ...config.budget } } : {}) } : undefined
  const call = readableEngineCall(command, full)
  return new Function('window', `return ${call}`)(win)
}

const defaultBudget = (): ReadableBudget => ({ startMs: 1500, firstChunkMs: 12, chunkMs: 8, maxElements: 60_000, busyMs: 1500, busyWindowMs: 10_000, maxRules: 5000, maxRemembered: 20_000 })

/** Runs the idle callbacks the engine asked for, until it asks for none (or `max` rounds). */
export function flushIdle(win: FakeWindow, max = 50): number {
  let rounds = 0
  while (win.idle.length > 0 && rounds < max) {
    const next = win.idle.splice(0)
    for (const fn of next) fn({ didTimeout: false, timeRemaining: () => 8 })
    rounds++
  }
  return rounds
}

/** The rules the engine wrote for its marks, as text. */
export const markRules = (win: FakeWindow): string[] => {
  const sheet = win.document.adoptedStyleSheets.at(-1)
  return sheet ? sheet.cssRules.map((r) => r.cssText) : []
}

/** The value of the engine's mark on an element (its attribute is named per document), or null. */
export const markOf = (el: FakeElement): string | null => [...el.attributes].find(([name]) => /^data-r[a-z0-9]+$/.test(name))?.[1] ?? null

/** The declarations of the rule an element's mark selects. */
export function declarationsOf(win: FakeWindow, el: FakeElement): string {
  const mark = markOf(el)
  if (mark === null) return ''
  const rule = markRules(win).find((r) => r.includes(`="${mark}"]`))
  return rule ? rule.slice(rule.indexOf('{') + 1, -1) : ''
}

export { HTML, SVG }
