import { Script, createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { getLanguage, setLanguage, tIn } from '@shared/i18n'
import { Window } from 'happy-dom'
import { MarkdownPicker, MARKDOWN_WORLD, pageScript, pickerScript, selectionScript } from './markdown-picker'

// The scripts themselves run in a page and are checked by the engine test (smoke-markdown.ts); here, that they are valid programs with
// what they are given, and what the main-process side does around them.

interface Fake {
  contents: WebContents
  run: ReturnType<typeof vi.fn>
  emit(event: string, ...args: unknown[]): void
  destroy(): void
}

function fakeContents(): Fake {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  let destroyed = false
  const run = vi.fn()
  const contents = {
    isDestroyed: () => destroyed,
    on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    executeJavaScriptInIsolatedWorld: run
  } as unknown as WebContents
  return {
    contents,
    run,
    emit: (event, ...args) => handlers.get(event)?.forEach((handler) => handler(...args)),
    destroy: () => {
      destroyed = true
    }
  }
}

afterEach(() => vi.restoreAllMocks())

describe('the scripts', () => {
  it('are valid programs', () => {
    expect(() => new Script(selectionScript())).not.toThrow()
    expect(() => new Script(pickerScript())).not.toThrow()
  })

  it('carry the lists and limits of the converter, as data', () => {
    for (const script of [selectionScript(), pickerScript()]) {
      expect(script).toContain('"dropped":["script","style"')
      expect(script).toContain('"depth":100')
      expect(script).not.toContain('undefined')
    }
  })

  it('build their interface with DOM calls, not markup (a page that requires Trusted Types must not stop them)', () => {
    expect(pickerScript()).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/)
  })

  it('only listen to what a person does', () => {
    expect(pickerScript().match(/isTrusted/g)?.length).toBeGreaterThanOrEqual(4)
  })
})

// The smallest DOM the picker builds its bar in: elements that keep their text, attributes, children and listeners.
class FakeElement {
  className = ''
  textContent = ''
  hidden = false
  disabled = false
  type = ''
  style = { cssText: '' }
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Array<(event?: unknown) => void>>()
  readonly isConnected = true
  constructor(readonly localName: string) {}
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 10, top: 10, right: 110, bottom: 60, width: 100, height: 50 }
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }
  appendChild(node: FakeElement): FakeElement {
    this.children.push(node)
    return node
  }
  replaceChildren(): void {
    this.children.length = 0
  }
  attachShadow(): FakeElement {
    const root = new FakeElement('#shadow')
    this.children.push(root)
    return root
  }
  addEventListener(name: string, handler: (event?: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler])
  }
  focus(): void {}
  remove(): void {}
  contains(other: FakeElement): boolean {
    return other === this || this.children.some((child) => child.contains(other))
  }
  get all(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.all)]
  }
}

/** Opens the picker on a page without a selection; gives back its bar, its promise and a way to click a block of the page. */
function openPicker(language: 'fr' | 'en'): { reply: Promise<unknown>; bar: FakeElement; buttons: FakeElement[]; state: FakeElement; click(block: FakeElement): void } {
  const before = getLanguage()
  setLanguage(language)
  const script = pickerScript()
  setLanguage(before)
  const root = new FakeElement('html')
  const page = new FakeElement('window')
  const context = createContext({
    window: { addEventListener: (name: string, handler: (event?: unknown) => void) => page.addEventListener(name, handler), removeEventListener: () => undefined },
    getComputedStyle: () => ({ display: 'block' }),
    document: { createElement: (tag: string) => new FakeElement(tag), documentElement: root, activeElement: null },
    HTMLElement: FakeElement,
    Element: FakeElement,
    getSelection: () => null,
    requestAnimationFrame: () => 0,
    innerWidth: 1200,
    innerHeight: 800
  })
  const reply = runInContext(script, context) as Promise<unknown>
  const all = root.all
  const bar = all.find((element) => element.className === 'bar')!
  const click = (block: FakeElement): void => {
    const event = { isTrusted: true, composedPath: () => [block], preventDefault: () => undefined, stopPropagation: () => undefined }
    for (const handler of page.listeners.get('click') ?? []) handler(event)
  }
  return { reply, bar, buttons: all.filter((element) => element.localName === 'button'), state: all.find((element) => element.className === 'state')!, click }
}

describe('the picker in a page', () => {
  it('opens, its words in the language of the interface (the page has no translator of its own)', async () => {
    for (const language of ['fr', 'en'] as const) {
      const { reply, bar, buttons, state } = openPicker(language)
      expect(bar, language).toBeDefined()
      expect(bar.attributes.get('aria-label')).toBe(tIn(language, 'markdown-picker.export-markdown'))
      expect(buttons.map((button) => button.textContent)).toEqual([
        tIn(language, 'markdown-picker.page-entiere'),
        tIn(language, 'markdown-picker.selection-vide'),
        tIn(language, 'markdown-picker.copier'),
        tIn(language, 'pwd.enregistrer'),
        tIn(language, 'markdown-picker.choisir-des-blocs'),
        tIn(language, 'markdown-picker.annuler')
      ])
      expect(state.textContent).toBe(tIn(language, 'markdown-picker.cliquez-sur-un-bloc-pour-l-exclure'))
      // Cancel ends it with nothing to export.
      buttons.at(-1)!.listeners.get('click')![0]!()
      await expect(reply).resolves.toBeNull()
    }
  })

  it('counts the blocks left out with the plural rules of the language', () => {
    for (const language of ['fr', 'en'] as const) {
      const { state, click } = openPicker(language)
      click(new FakeElement('p'))
      expect(state.textContent).toBe(tIn(language, 'markdown-picker.page-entiere-sauf-blocs.one').replace('{count}', '1'))
      click(new FakeElement('p'))
      expect(state.textContent).toBe(tIn(language, 'markdown-picker.page-entiere-sauf-blocs.other').replace('{count}', '2'))
    }
  })

  it('reads no translator in the page: every word is handed over as data', () => {
    expect(pickerScript()).not.toMatch(/[^\w.]t\(\s*['"`]/)
    expect(selectionScript()).not.toMatch(/[^\w.]t\(\s*['"`]/)
  })
})

describe('what the scripts say of a content they cannot convert', () => {
  /** Runs the script of the selection on a page whose selection holds a frame and a word, with the interface in `language`. */
  function selectionIn(language: 'fr' | 'en'): { nodes: unknown[]; warnings: string[] } {
    const before = getLanguage()
    setLanguage(language)
    const script = selectionScript()
    setLanguage(before)
    const text = { nodeType: 3, data: 'mot' }
    const frame = { nodeType: 1, localName: 'iframe' }
    const root = { nodeType: 1, localName: 'div', parentElement: null, shadowRoot: null, childNodes: [frame, text] }
    const range = { intersectsNode: () => true, commonAncestorContainer: root, startContainer: null, endContainer: null, startOffset: 0, endOffset: 0 }
    const context = createContext({ getSelection: () => ({ rangeCount: 1, isCollapsed: false, toString: () => 'mot', getRangeAt: () => range }) })
    return JSON.parse(runInContext(script, context) as string) as { nodes: unknown[]; warnings: string[] }
  }

  it('is a sentence of the catalogue, in the language of the interface when the script is made', () => {
    expect(selectionIn('fr')).toEqual({ nodes: ['mot'], warnings: [tIn('fr', 'markdown-picker.contenu-non-converti').replace('{tag}', 'iframe')], truncated: false })
    expect(selectionIn('en').warnings).toEqual(['iframe: content not converted.'])
    expect(selectionIn('fr').warnings[0]).toContain('contenu non converti')
  })

  it('is in no script as a text written in the code', () => {
    const before = getLanguage()
    setLanguage('en')
    try {
      for (const script of [selectionScript(), pickerScript()]) expect(script).not.toContain('contenu non converti')
    } finally {
      setLanguage(before)
    }
  })
})

describe('MarkdownPicker', () => {
  it('reads the selection in the isolated world of its own', async () => {
    const fake = fakeContents()
    fake.run.mockResolvedValue('{"nodes":[]}')
    expect(await new MarkdownPicker(fake.contents).selection()).toBe('{"nodes":[]}')
    expect(fake.run).toHaveBeenCalledWith(MARKDOWN_WORLD, [{ code: selectionScript() }])
  })

  it('answers null when the page gives back something that is not text', async () => {
    const fake = fakeContents()
    for (const reply of [null, undefined, 42, { nodes: [] }]) {
      fake.run.mockResolvedValue(reply)
      expect(await new MarkdownPicker(fake.contents).selection()).toBeNull()
    }
  })

  it('answers null and says why when the page cannot run the script', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = fakeContents()
    fake.run.mockRejectedValue(new Error('Script failed to execute'))
    expect(await new MarkdownPicker(fake.contents).selection()).toBeNull()
    expect(warn).toHaveBeenCalledWith('[markdown] the page could not be read:', 'Script failed to execute')
  })

  it('runs nothing in a page that is gone', async () => {
    const fake = fakeContents()
    fake.destroy()
    const picker = new MarkdownPicker(fake.contents)
    expect(await picker.selection()).toBeNull()
    expect(await picker.pick()).toBeNull()
    picker.stop()
    expect(fake.run).not.toHaveBeenCalled()
  })

  it('waits for the user, and gives back what they chose', async () => {
    const fake = fakeContents()
    let choose: (reply: string) => void = () => undefined
    fake.run.mockReturnValue(new Promise((resolve) => (choose = resolve)))
    const picking = new MarkdownPicker(fake.contents).pick()
    expect(fake.run).toHaveBeenCalledWith(MARKDOWN_WORLD, [{ code: pickerScript() }])
    choose('{"action":"copy"}')
    expect(await picking).toBe('{"action":"copy"}')
  })

  it('ends the picker that is up when asked again, and starts none', async () => {
    const fake = fakeContents()
    let choose: (reply: string | null) => void = () => undefined
    fake.run.mockImplementation((_world: number, scripts: Array<{ code: string }>) => (scripts[0]?.code === pickerScript() ? new Promise((resolve) => (choose = resolve)) : Promise.resolve(undefined)))
    const picker = new MarkdownPicker(fake.contents)
    const first = picker.pick()
    expect(await picker.pick()).toBeNull()
    expect(fake.run).toHaveBeenCalledTimes(2)
    expect(fake.run.mock.calls[1]![1][0]!.code).toContain('__luciumMarkdownStop')
    choose(null)
    expect(await first).toBeNull()
    // Once it is over, the next request starts a new one.
    fake.run.mockResolvedValue('{"action":"save"}')
    expect(await picker.pick()).toBe('{"action":"save"}')
  })

  it('starts a new picker after the page was left, instead of ending one that is gone', async () => {
    const fake = fakeContents()
    fake.run.mockReturnValue(new Promise(() => undefined))
    const picker = new MarkdownPicker(fake.contents)
    void picker.pick()
    fake.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    fake.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    void picker.pick()
    // Still the first picker: a frame or an anchor changed nothing, so the second request is the "end it" one.
    expect(fake.run.mock.calls.map((call) => call[1][0]!.code === pickerScript())).toEqual([true, false])
    fake.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    void picker.pick()
    expect(fake.run.mock.calls.at(-1)![1][0]!.code).toBe(pickerScript())
  })

  it('says so when the picker cannot be ended', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = fakeContents()
    fake.run.mockRejectedValue(new Error('frame gone'))
    new MarkdownPicker(fake.contents).stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith('[markdown] cannot end the picker:', 'frame gone')
  })
})

describe('the whole-page script', () => {
  it('is a valid program that builds no markup and carries the converter lists', () => {
    const script = pageScript()
    expect(() => new Script(script)).not.toThrow()
    expect(script).toContain('"dropped":["script","style"')
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/)
  })

  it('is run in the isolated world, and its answer is handed back as it is', async () => {
    const fake = fakeContents()
    fake.run.mockResolvedValue('{"action":"save"}')
    await expect(new MarkdownPicker(fake.contents).page()).resolves.toBe('{"action":"save"}')
    expect(fake.run).toHaveBeenCalledWith(MARKDOWN_WORLD, [{ code: pageScript() }])
  })

  it('answers null, with a visible warning, when the page was left while it ran', async () => {
    const fake = fakeContents()
    fake.run.mockRejectedValue(new Error('gone'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(new MarkdownPicker(fake.contents).page()).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith('[markdown] the page could not be read:', 'gone')
  })

  describe('on a document', () => {
    const run = (html: string): { nodes: unknown[] } => {
      const window = new Window()
      window.document.body.innerHTML = html
      const reply = JSON.parse(window.eval(pageScript()) as string) as { snapshot: { nodes: unknown[] } }
      return reply.snapshot
    }
    const text = (value: unknown): string => JSON.stringify(value)

    it('keeps the main part and leaves navigation, side columns and dialogs out', () => {
      const out = text(run('<nav>MENU</nav><main><h1>Titre</h1><p>Corps</p><aside>PUB</aside><div role="dialog">COOKIES</div></main><footer>PIED</footer>'))
      expect(out).toContain('Corps')
      for (const left of ['MENU', 'PUB', 'COOKIES', 'PIED']) expect(out).not.toContain(left)
    })

    it('leaves out the headers and footers of a page that has no main part, and keeps those of an article', () => {
      expect(text(run('<header>BANDEAU</header><div><p>Texte</p></div><footer>PIED</footer>'))).not.toMatch(/BANDEAU|PIED/)
      expect(text(run('<article><header><h1>Dans l’article</h1></header><p>x</p></article>'))).toContain('Dans l’article')
    })

    it('never takes what a person typed: fields, and editable regions', () => {
      const out = text(run('<main><p>Public</p><input value="SECRET1"><textarea>SECRET2</textarea><input type="password" value="SECRET3"><div contenteditable="true">SECRET4</div></main>'))
      expect(out).toContain('Public')
      expect(out).not.toContain('SECRET')
    })

    it('reads the address a lazy image keeps until it scrolls into view', () => {
      expect(text(run('<main><img data-src="https://img.example.com/lazy.png" alt="paresseuse"></main>'))).toContain('https://img.example.com/lazy.png')
    })
  })
})
