// The animation « Effacer les données du site » draws on the page (site-data-overlay.ts): the choice and its cleaning, none while motion is reduced,
// and the two scripts run against a small stand-in of a document, the way the isolated world runs them: what they draw, that a second run replaces
// the first, that the end draws a tick or a cross and then nothing, that a page reloaded since gets no tick, and that nothing is left behind.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import palette from '../renderer/palette.css?raw'
import { setLanguage } from './i18n'
import {
  DEFAULT_SITE_DATA_ANIMATION,
  OVERLAY_COLOURS,
  OVERLAY_DONE_MS,
  OVERLAY_FADE_MS,
  OVERLAY_GIVE_UP_MS,
  SITE_DATA_ANIMATIONS,
  SITE_DATA_ANIMATION_GLYPHS,
  SITE_DATA_ANIMATION_LABELS,
  cleanSiteDataAnimation,
  clearingOverlayScript,
  doneOverlayScript,
  pageAnimation,
  type DrawnAnimation
} from './site-data-overlay'

/** A constructable stylesheet of the stand-in window: the rules it was given. */
class Sheet {
  rules = ''
  replaceSync(css: string) {
    this.rules = css
  }
}

/** An element of the stand-in document: enough of the DOM for the scripts, and no `innerHTML`. */
class Node {
  className = ''
  textContent = ''
  readonly style = { cssText: '', animationDelay: '' }
  readonly attributes: Record<string, string> = {}
  children: Node[] = []
  parent: Node | null = null
  shadow: Node | null = null
  shadowMode: string | null = null
  adoptedStyleSheets: Sheet[] = []
  host: Node | null = null
  root = false
  readonly classList = { add: (name: string) => void (this.className = `${this.className} ${name}`.trim()) }
  constructor(readonly tag: string) {}
  get isConnected(): boolean {
    if (this.root) return true
    if (this.host) return this.host.isConnected
    return this.parent?.isConnected ?? false
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }
  appendChild(child: Node) {
    child.remove()
    child.parent = this
    this.children.push(child)
    return child
  }
  append(...children: Node[]) {
    for (const child of children) this.appendChild(child)
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
  replaceChildren(...children: Node[]) {
    for (const child of [...this.children]) child.remove()
    this.append(...children)
  }
  attachShadow({ mode }: { mode: string }) {
    this.shadowMode = mode
    this.shadow = new Node('#shadow-root')
    this.shadow.host = this
    return this.shadow
  }
  /** Every element under this one, its shadow tree included. */
  all(): Node[] {
    const inner = [...this.children, ...(this.shadow ? [this.shadow] : [])]
    return inner.flatMap((child) => [child, ...child.all()])
  }
  find(className: string): Node[] {
    return this.all().filter((node) => (node.className || node.attributes['class'] || '').split(' ').includes(className))
  }
}

/** A tab's document and the globals of its isolated world, which keep their state from one script to the next as the world does. */
function world(options: { constructableSheets?: boolean } = {}) {
  const documentElement = new Node('html')
  documentElement.root = true
  const document = { documentElement, body: null, createElement: (tag: string) => new Node(tag), createElementNS: (_ns: string, tag: string) => new Node(tag) }
  const window: Record<string, unknown> = {}
  // A world that cannot make a constructable stylesheet (or has none) has no such constructor: the script finds out by trying.
  const CSSStyleSheet = options.constructableSheets === false ? undefined : Sheet
  const run = (code: string): unknown => new Function('window', 'document', 'setTimeout', 'clearTimeout', 'CSSStyleSheet', `return ${code}`)(window, document, setTimeout, clearTimeout, CSSStyleSheet)
  const hosts = () => documentElement.children
  return { run, hosts, documentElement }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  setLanguage('fr')
})

describe('the choice of the animation', () => {
  it('offers « Aucune » and the seven loaders of the extension, the spinner by default', () => {
    expect(SITE_DATA_ANIMATIONS).toEqual(['none', 'spinner', 'pacman', 'broom', 'matrix', 'nuke', 'fire', 'bounce'])
    expect(DEFAULT_SITE_DATA_ANIMATION).toBe('spinner')
    expect(SITE_DATA_ANIMATIONS.map((animation) => SITE_DATA_ANIMATION_LABELS[animation].name)).toEqual(['Aucune', 'Spinner', 'Pac-Man', 'Balai', 'Matrix', 'Nuke', 'Feu', 'Rebond'])
    setLanguage('en')
    expect(SITE_DATA_ANIMATIONS.map((animation) => SITE_DATA_ANIMATION_LABELS[animation].name)).toEqual(['None', 'Spinner', 'Pac-Man', 'Broom', 'Matrix', 'Nuke', 'Fire', 'Bounce'])
  })

  it('reads a saved choice it does not know as the default', () => {
    for (const animation of SITE_DATA_ANIMATIONS) expect(cleanSiteDataAnimation(animation)).toBe(animation)
    for (const bad of [undefined, null, 'disco', 3, {}, ['fire']]) expect(cleanSiteDataAnimation(bad)).toBe('spinner')
  })

  it('draws nothing while motion is reduced, whatever was chosen', () => {
    for (const animation of SITE_DATA_ANIMATIONS) {
      expect(pageAnimation(animation, { reducedMotion: true })).toBe('none')
      expect(pageAnimation(animation, { reducedMotion: false })).toBe(animation)
    }
  })

  it('gives every choice a stroked glyph', () => {
    for (const animation of SITE_DATA_ANIMATIONS) expect(SITE_DATA_ANIMATION_GLYPHS[animation].length, animation).toBeGreaterThan(0)
  })
})

describe('the drawing on the page', () => {
  const drawn = SITE_DATA_ANIMATIONS.filter((animation): animation is DrawnAnimation => animation !== 'none')

  it('is built with the DOM calls in a closed shadow root that takes no click, with the words of the loader', () => {
    for (const animation of drawn) {
      const tab = world()
      expect(tab.run(clearingOverlayScript(animation)), animation).toBe(true)
      expect(tab.hosts()).toHaveLength(1)
      const host = tab.hosts()[0]!
      expect(host.shadowMode).toBe('closed')
      expect(host.style.cssText).toContain('pointer-events:none')
      expect(host.style.cssText).toContain('z-index:2147483647')
      expect(host.find('text')[0]?.textContent, animation).toBe(SITE_DATA_ANIMATION_LABELS[animation].text)
      expect(clearingOverlayScript(animation)).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/)
    }
  })

  it('puts its rules in a constructable stylesheet, not in a <style> element a page that forbids inline styles would block', () => {
    for (const animation of drawn) {
      const tab = world()
      tab.run(clearingOverlayScript(animation))
      const host = tab.hosts()[0]!
      expect(host.shadow!.adoptedStyleSheets, animation).toHaveLength(1)
      expect(host.shadow!.adoptedStyleSheets[0]!.rules).toContain('@keyframes spin')
      expect(host.all().filter((node) => node.tag === 'style'), animation).toHaveLength(0)
    }
  })

  it('falls back to a <style> element in a world that cannot make one, so that it is still drawn with its rules', () => {
    const tab = world({ constructableSheets: false })
    expect(tab.run(clearingOverlayScript('fire'))).toBe(true)
    const host = tab.hosts()[0]!
    expect(host.shadow!.adoptedStyleSheets).toHaveLength(0)
    expect(host.all().filter((node) => node.tag === 'style').map((node) => node.textContent)).toEqual([expect.stringContaining('@keyframes spin')])
  })

  it('draws the pieces of each loader, staggered as in the extension', () => {
    const pieces = (animation: DrawnAnimation, className: string) => {
      const tab = world()
      tab.run(clearingOverlayScript(animation))
      return tab.hosts()[0]!.find(className)
    }
    expect(pieces('spinner', 'spinner')).toHaveLength(1)
    const dots = pieces('pacman', 'dots')[0]!
    expect(dots.children).toHaveLength(6)
    expect(dots.children.map((dot) => dot.style.animationDelay)).toEqual(['0.00s', '0.15s', '0.30s', '0.45s', '0.60s', '0.75s'])
    expect(pieces('broom', 'broom')[0]?.tag).toBe('svg')
    expect(pieces('matrix', 'matrix')[0]!.children.map((span) => span.textContent).join('')).toBe('01C00K1E01')
    expect(pieces('nuke', 'shockwave')).toHaveLength(1)
    expect(pieces('fire', 'fire')[0]!.children.map((flame) => flame.tag)).toEqual(['svg', 'svg', 'svg'])
    expect(pieces('bounce', 'bounce')[0]!.children).toHaveLength(3)
  })

  it('replaces the drawing of a run still on the page', () => {
    const tab = world()
    tab.run(clearingOverlayScript('spinner'))
    tab.run(clearingOverlayScript('fire'))
    expect(tab.hosts()).toHaveLength(1)
    expect(tab.hosts()[0]!.find('fire')).toHaveLength(1)
  })

  it('ends with a tick, or a cross, for a moment, then fades and leaves nothing', () => {
    for (const ok of [true, false]) {
      const tab = world()
      tab.run(clearingOverlayScript('bounce'))
      expect(tab.run(doneOverlayScript(ok))).toBe(true)
      const host = tab.hosts()[0]!
      expect(host.find('bounce')).toHaveLength(0)
      expect(host.find(ok ? 'ok' : 'err')).toHaveLength(1)
      vi.advanceTimersByTime(OVERLAY_DONE_MS)
      expect(host.find('veil')[0]!.className).toContain('out')
      expect(tab.hosts()).toHaveLength(1)
      vi.advanceTimersByTime(OVERLAY_FADE_MS)
      expect(tab.hosts()).toEqual([])
    }
  })

  it('draws no tick on a page that has no drawing any more: a tab sent back to the root of its site is a new document', () => {
    const tab = world()
    expect(tab.run(doneOverlayScript(true))).toBe(false)
    expect(tab.hosts()).toEqual([])
    tab.run(clearingOverlayScript('spinner'))
    tab.hosts()[0]!.remove()
    expect(tab.run(doneOverlayScript(true))).toBe(false)
    expect(tab.hosts()).toEqual([])
  })

  it('takes itself away when its end never comes', () => {
    const tab = world()
    tab.run(clearingOverlayScript('matrix'))
    vi.advanceTimersByTime(OVERLAY_GIVE_UP_MS - 1)
    expect(tab.hosts()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(tab.hosts()).toEqual([])
  })

  it('takes its colours from the fixed palette of the interface: a page has none of its tokens', () => {
    for (const [name, colour] of Object.entries(OVERLAY_COLOURS)) expect(palette, name).toContain(`: ${colour};`)
  })
})
