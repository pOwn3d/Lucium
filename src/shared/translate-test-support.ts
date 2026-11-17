// A page made of plain objects, enough DOM for the scripts of translate-page-script.ts to run in Node: nodes with a type, children, attributes, a value. The tests of the
// scripts and of the controller (main/translate/controller.test.ts) both use it. Not part of the application.

/** Where a text is drawn, in CSS pixels from the top left of the viewport (`fakePage` with a viewport answers it through `document.createRange`). */
export interface FakeBox {
  top: number
  height: number
  left?: number
  width?: number
}

export interface FakeNode {
  nodeType: 1 | 3
  nodeValue: string | null
  tagName?: string
  childNodes: FakeNode[]
  shadowRoot: { childNodes: FakeNode[] } | null
  isConnected: boolean
  isContentEditable: boolean
  classList: { contains(name: string): boolean }
  getAttribute(name: string): string | null
  /** A text's box; none: not drawn (hidden). */
  box?: FakeBox
}

export const text = (value: string, box?: FakeBox): FakeNode => ({
  nodeType: 3,
  nodeValue: value,
  childNodes: [],
  shadowRoot: null,
  isConnected: true,
  isContentEditable: false,
  classList: { contains: () => false },
  getAttribute: () => null,
  ...(box ? { box } : {})
})

export interface ElementOptions {
  attrs?: Record<string, string>
  classes?: string[]
  editable?: boolean
  shadow?: FakeNode[]
}

export function el(tagName: string, children: FakeNode[] = [], options: ElementOptions = {}): FakeNode {
  const attrs = options.attrs ?? {}
  return {
    nodeType: 1,
    nodeValue: null,
    tagName,
    childNodes: children,
    shadowRoot: options.shadow ? { childNodes: options.shadow } : null,
    isConnected: true,
    isContentEditable: options.editable === true,
    classList: { contains: (name) => (options.classes ?? []).includes(name) },
    getAttribute: (name) => attrs[name] ?? null
  }
}

export interface FakePage {
  /** What the world of the page holds between two scripts (`self`). */
  world: Record<string, unknown>
  body: FakeNode
  lang: string
  /** Runs one of the scripts of translate-page-script.ts in this page. */
  run(code: string): Promise<unknown>
  /** All the text nodes of the page, in reading order. */
  texts(): string[]
}

/**
 * A page with `body` as its body. `innerText` is what the sample script reads: the text of the body, joined by line breaks. With a `viewport`, the
 * page has a window of that size and `document.createRange()`, whose box is the text's `box` (zero when it has none); without one, no geometry at all.
 */
export function fakePage(body: FakeNode, lang = '', viewport?: { width: number; height: number }): FakePage {
  const world: Record<string, unknown> = viewport ? { innerWidth: viewport.width, innerHeight: viewport.height } : {}
  const collect = (node: FakeNode, out: string[]): string[] => {
    if (node.nodeType === 3) out.push(node.nodeValue ?? '')
    else for (const child of [...(node.shadowRoot?.childNodes ?? []), ...node.childNodes]) collect(child, out)
    return out
  }
  const texts = (): string[] => collect(body, [])
  const documentElement = { getAttribute: (name: string) => (name === 'lang' ? lang : null) }
  Object.defineProperty(body, 'innerText', { configurable: true, get: () => texts().filter((value) => value.trim() !== '').join('\n') })
  const createRange = () => {
    let selected: FakeNode | null = null
    return {
      selectNodeContents: (node: FakeNode) => void (selected = node),
      getBoundingClientRect: () => {
        const box = selected?.box
        if (!box) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
        const [left, width] = [box.left ?? 0, box.width ?? 100]
        return { top: box.top, bottom: box.top + box.height, left, right: left + width, width, height: box.height }
      }
    }
  }
  const document = viewport ? { body, documentElement, createRange } : { body, documentElement }
  return {
    world,
    body,
    lang,
    texts,
    run: async (code) => new Function('self', 'document', `return ${code}`)(world, document)
  }
}
