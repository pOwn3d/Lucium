// Accessibility audit of the interface: the rules the engine test applies to the accessibility tree that Chromium builds for each surface
// (sidebar, toolbar, panels, Settings…), and the colour maths of the contrast checks. Pure: the engine test (main/smoke-a11y.ts) gathers the
// tree through the debugging protocol and the pixels from the window, this file decides what is wrong.

// ---------- colour and contrast (WCAG 2.2, 1.4.3) ----------

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0 (transparent) to 1. */
  a: number
}

/** A CSS colour as Chromium computes it (`rgb()`, `rgba()`, modern space syntax) or a hex colour; null for anything else. */
export function parseColor(value: unknown): Rgba | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
    if (full.length !== 6 && full.length !== 8) return null
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 }
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text)?.[1]
  if (!fn) return null
  const parts = fn.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p))
  const [r, g, b] = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!)]
  const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
  return [r, g, b, a].every(Number.isFinite) ? { r, g, b, a: Math.min(1, Math.max(0, a)) } : null
}

/** `top` laid over the opaque colour `under`. */
export function composite(top: Rgba, under: Rgba): Rgba {
  const a = top.a + under.a * (1 - top.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mixChannel = (t: number, u: number) => (t * top.a + u * under.a * (1 - top.a)) / a
  return { r: mixChannel(top.r, under.r), g: mixChannel(top.g, under.g), b: mixChannel(top.b, under.b), a }
}

/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** The contrast ratio of a text colour on a background, 1 to 21. A translucent text is first laid over the (opaque) background. */
export function contrastRatio(text: Rgba, background: Rgba): number {
  const bg = background.a < 1 ? composite(background, { r: 255, g: 255, b: 255, a: 1 }) : background
  const fg = text.a < 1 ? composite(text, bg) : text
  const [a, b] = [relativeLuminance(fg), relativeLuminance(bg)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Large text (24 px, or 18.66 px in bold) needs 3 : 1; everything else 4.5 : 1 (WCAG AA). */
export function requiredContrast(fontSizePx: number, fontWeight: number): number {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700) ? 3 : 4.5
}

/** The minimum size of a pointer target, WCAG 2.2 (2.5.8, level AA): 24 by 24 CSS pixels. */
export const MIN_TARGET_PX = 24

// ---------- the accessibility tree ----------

/** The part of a node of `Accessibility.getFullAXTree` that the rules read. */
export interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  properties?: Array<{ name: string; value?: { value?: unknown } }>
  backendDOMNodeId?: number
}

/** Roles a person operates: each one needs a name, or a screen reader says only "button". */
export const NAMED_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'switch', 'radio', 'combobox', 'slider', 'spinbutton', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'listbox', 'menu', 'tablist', 'tree', 'dialog', 'alertdialog', 'PopUpButton',
  'ComboBoxSelect', 'img', 'image', 'progressbar', 'meter', 'scrollbar', 'toggleButton'
])

/** Roles whose state is part of what they say. */
const STATE_PROPERTY: Readonly<Record<string, string>> = { checkbox: 'checked', switch: 'checked', radio: 'checked', menuitemcheckbox: 'checked', menuitemradio: 'checked', tab: 'selected' }

export type AxProblem = 'unnamed' | 'missing-state' | 'focusable-without-role'

export interface AxFinding {
  problem: AxProblem
  role: string
  name: string
  backendDOMNodeId?: number
}

const valueOf = (node: AxNode, property: string): unknown => node.properties?.find((p) => p.name === property)?.value?.value

/**
 * What is wrong in the tree of one surface. Ignored nodes (hidden, `aria-hidden`, decorative images) are not read. A control with an
 * empty name is the worst case; a focusable thing that has no role cannot be told apart from text; a switch, checkbox, radio or tab
 * without its state tells nothing about whether it is on.
 */
export function auditAxTree(nodes: readonly AxNode[]): AxFinding[] {
  const found: AxFinding[] = []
  for (const node of nodes) {
    if (node.ignored) continue
    const role = typeof node.role?.value === 'string' ? node.role.value : ''
    const name = typeof node.name?.value === 'string' ? node.name.value.trim() : ''
    const at = node.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: node.backendDOMNodeId }
    if (NAMED_ROLES.has(role) && name === '') found.push({ problem: 'unnamed', role, name, ...at })
    const state = STATE_PROPERTY[role]
    if (state && valueOf(node, state) === undefined) found.push({ problem: 'missing-state', role, name, ...at })
    if (valueOf(node, 'focusable') === true && (role === 'generic' || role === 'none' || role === 'StaticText' || role === '')) found.push({ problem: 'focusable-without-role', role, name, ...at })
  }
  return found
}
