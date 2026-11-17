import { describe, expect, it } from 'vitest'
import { TOOL_CHANNEL, VIM_APP_ACTIONS, VIM_URL_MAX, isOpenableLink, parseToolMessage, toolMessageText, type ToolMessage } from './page-tools'
import { setLanguage } from './i18n'
import { VIM_HINT_ALPHABET, VIM_HINT_MAX, VIM_KEY_SCRIPTS, VIM_PENDING_MS, VIM_SCAN_MAX, hintFilter, hintLabels, vimKeyLabels, vimKeysOn, vimKeysSummary, vimStep } from './vim-keys'

const NONCE = 'n0nce-1'

describe('the key table of the normal mode', () => {
  const run = (...keys: string[]) => {
    let pending = ''
    const commands: string[] = []
    for (const key of keys) {
      const step = vimStep(pending, key)
      pending = step.pending
      commands.push(step.command)
    }
    return { commands, pending }
  }

  it('maps the keys of the list in the settings', () => {
    const table: Record<string, string> = { j: 'scroll-down', k: 'scroll-up', h: 'scroll-left', l: 'scroll-right', d: 'half-down', u: 'half-up', G: 'bottom', f: 'hints', F: 'hints-tab', H: 'back', L: 'forward', J: 'tab-previous', K: 'tab-next', r: 'reload', '/': 'find' }
    for (const [key, command] of Object.entries(table)) expect(vimStep('', key), key).toEqual({ pending: '', command })
  })

  it('waits for the second g of gg, and only then goes to the top', () => {
    expect(run('g')).toEqual({ commands: [''], pending: 'g' })
    expect(run('g', 'g')).toEqual({ commands: ['', 'top'], pending: '' })
  })

  it('drops a g that is followed by anything else, and gives that key no command', () => {
    expect(run('g', 'j')).toEqual({ commands: ['', ''], pending: '' })
    expect(run('g', 'x', 'j')).toEqual({ commands: ['', '', 'scroll-down'], pending: '' })
  })

  it('does nothing with a key it does not know, a letter of the wrong case, or a word', () => {
    for (const key of ['a', 'x', 'J ', 'Escape', 'Enter', 'ArrowDown', 'Tab', ' ', '', 'jj', 'constructor', '__proto__', 'toString']) expect(vimStep('', key), JSON.stringify(key)).toEqual({ pending: '', command: '' })
  })

  it('says what every key does in the list the settings show', () => {
    const keys = vimKeyLabels().flatMap(([keys]) => keys.split(', '))
    for (const key of ['j', 'k', 'h', 'l', 'd', 'u', 'gg', 'G', 'f', 'F', 'H', 'L', 'J', 'K', 'r', '/']) expect(keys, key).toContain(key)
  })

  it('writes the list with the punctuation of the language of the interface', () => {
    expect(vimKeysSummary()).toMatch(/^j, k\u00a0: Défiler vers le bas, vers le haut\u202f; h, l\u00a0: Défiler à gauche, à droite\u202f; .*\u202f; Échap\u00a0: Quitter les repères$/)
    try {
      setLanguage('en')
      expect(vimKeysSummary()).toMatch(/^j, k: Scroll down, up; h, l: Scroll left, right; .*; Esc: Leave the link hints$/)
      expect(vimKeyLabels().map(([keys]) => keys)).toContain('Esc')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('the labels of the link hints', () => {
  const prefixFree = (labels: string[]) => labels.every((a, i) => labels.every((b, j) => i === j || !b.startsWith(a)))

  it('are single letters while the alphabet is enough', () => {
    const labels = hintLabels(5, VIM_HINT_ALPHABET)
    expect(labels).toEqual(['a', 's', 'd', 'f', 'g'])
    expect(hintLabels(VIM_HINT_ALPHABET.length, VIM_HINT_ALPHABET).every((label) => label.length === 1)).toBe(true)
  })

  it('are all different and no one begins another, whatever the count', () => {
    for (const count of [1, 2, 14, 15, 16, 17, 30, 100, 224, 225, 226, 400]) {
      const labels = hintLabels(count, VIM_HINT_ALPHABET)
      expect(labels, String(count)).toHaveLength(count)
      expect(new Set(labels).size, String(count)).toBe(count)
      expect(prefixFree(labels), `prefix-free ${count}`).toBe(true)
      expect(labels.every((label) => [...label].every((letter) => VIM_HINT_ALPHABET.includes(letter))), String(count)).toBe(true)
    }
  })

  it('stay as short as the count allows: two letters up to a few hundred links, never more than three for the most that are labelled', () => {
    expect(Math.max(...hintLabels(200, VIM_HINT_ALPHABET).map((label) => label.length))).toBe(2)
    expect(Math.max(...hintLabels(VIM_HINT_MAX, VIM_HINT_ALPHABET).map((label) => label.length))).toBe(3)
  })

  it('give shorter labels first', () => {
    const lengths = hintLabels(100, VIM_HINT_ALPHABET).map((label) => label.length)
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
  })

  it('give nothing for no link or for an alphabet that cannot tell two links apart', () => {
    expect(hintLabels(0, VIM_HINT_ALPHABET)).toEqual([])
    expect(hintLabels(-3, VIM_HINT_ALPHABET)).toEqual([])
    expect(hintLabels(Number.NaN, VIM_HINT_ALPHABET)).toEqual([])
    expect(hintLabels(5, '')).toEqual([])
    expect(hintLabels(5, 'a')).toEqual([])
  })

  it('narrow down as the letters are typed, and name the link when a whole label is typed', () => {
    const labels = hintLabels(20, 'abc')
    expect(hintFilter(labels, '').open).toHaveLength(20)
    expect(hintFilter(labels, '').hit).toBe(-1)
    const first = labels.find((label) => label.length === 2)!
    const afterOne = hintFilter(labels, first[0]!)
    expect(afterOne.open.every((index) => labels[index]!.startsWith(first[0]!))).toBe(true)
    expect(afterOne.hit).toBe(-1)
    expect(hintFilter(labels, first)).toEqual({ open: [labels.indexOf(first)], hit: labels.indexOf(first) })
    expect(hintFilter(labels, 'zz')).toEqual({ open: [], hit: -1 })
  })
})

describe('the sites where the keys are left out', () => {
  it('are on only for a site that is not in the list, the site and its subdomains', () => {
    expect(vimKeysOn(true, [], 'https://example.org/')).toBe(true)
    expect(vimKeysOn(true, ['example.org'], 'https://example.org/page')).toBe(false)
    expect(vimKeysOn(true, ['example.org'], 'https://mail.example.org/')).toBe(false)
    expect(vimKeysOn(true, ['example.org'], 'https://notexample.org/')).toBe(true)
    expect(vimKeysOn(false, [], 'https://example.org/')).toBe(false)
  })
})

describe('the line the keys write to ask the application', () => {
  it('is read back as it was written, for every action', () => {
    for (const action of VIM_APP_ACTIONS.filter((a) => a !== 'open-tab')) {
      const message = { tool: 'vim', action } as ToolMessage
      expect(parseToolMessage(toolMessageText(NONCE, message), NONCE), action).toEqual(message)
    }
    const open: ToolMessage = { tool: 'vim', action: 'open-tab', url: 'https://example.org/a?b=1#c' }
    expect(parseToolMessage(toolMessageText(NONCE, open), NONCE)).toEqual(open)
  })

  it('carries an address of the length the script sends, in a line the other tools could not write', () => {
    const url = `https://example.org/${'a'.repeat(VIM_URL_MAX - 'https://example.org/'.length)}`
    expect(url.length).toBe(VIM_URL_MAX)
    const text = toolMessageText(NONCE, { tool: 'vim', action: 'open-tab', url })
    expect(text.length).toBeGreaterThan(512)
    expect(parseToolMessage(text, NONCE)).toEqual({ tool: 'vim', action: 'open-tab', url })
  })

  it('refuses an address that is not a web page, or too long for the line', () => {
    const prefix = `${TOOL_CHANNEL}${NONCE}:`
    const bad = [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'chrome://settings',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html',
      'about:blank',
      'mailto:a@example.org',
      'blob:https://example.org/1',
      'not a url',
      '',
      `https://example.org/${'a'.repeat(VIM_URL_MAX)}`
    ]
    for (const url of bad) expect(parseToolMessage(prefix + JSON.stringify({ tool: 'vim', action: 'open-tab', url }), NONCE), url.slice(0, 40)).toBe('invalid')
    for (const url of [42, null, undefined, ['https://example.org/'], { href: 'https://example.org/' }]) expect(parseToolMessage(prefix + JSON.stringify({ tool: 'vim', action: 'open-tab', url }), NONCE)).toBe('invalid')
    expect(isOpenableLink('https://example.org/')).toBe(true)
    expect(isOpenableLink('http://localhost:3000/x')).toBe(true)
    expect(isOpenableLink(undefined)).toBe(false)
  })

  it('refuses an action it does not know, and names no one by the prototype chain', () => {
    const prefix = `${TOOL_CHANNEL}${NONCE}:`
    for (const body of ['{"tool":"vim"}', '{"tool":"vim","action":"close-tab"}', '{"tool":"vim","action":"constructor"}', '{"tool":"vim","action":"__proto__"}', '{"tool":"vim","action":3}', '{"tool":"vim","action":null}']) {
      expect(parseToolMessage(prefix + body, NONCE), body).toBe('invalid')
    }
  })

  it('is not believed without the secret of the page, and a longer line is a vim line only', () => {
    const text = toolMessageText(NONCE, { tool: 'vim', action: 'back' })
    expect(parseToolMessage(text, 'another-secret')).toBeNull()
    expect(parseToolMessage(text, '')).toBeNull()
    const prefix = `${TOOL_CHANNEL}${NONCE}:`
    // The other tools keep the short limit: padding a gesture or a scroll past 512 characters is refused as before.
    expect(parseToolMessage(`${prefix}{"tool":"scroll","x":0,"y":0,"pad":"${'x'.repeat(600)}"}`, NONCE)).toBeNull()
    expect(parseToolMessage(`${prefix}{"tool":"speech","state":"end","pad":"${'x'.repeat(600)}"}`, NONCE)).toBeNull()
    // …and nothing is read past the longest line the Vim keys write.
    expect(parseToolMessage(`${prefix}{"tool":"vim","action":"back","pad":"${'x'.repeat(2500)}"}`, NONCE)).toBeNull()
  })
})

// ---------- the script, run in a stand-in for a page ----------

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface FakeKey {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  isTrusted?: boolean
  isComposing?: boolean
  defaultPrevented?: boolean
  target?: unknown
}

class FakeElement {
  attrs: Record<string, string> = {}
  type = ''
  isContentEditable = false
  shadowRoot: { activeElement: FakeElement | null } | null = null
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  scrollHeight = 0
  clientHeight = 0
  scrollWidth = 0
  clientWidth = 0
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 }
  computed: Record<string, string> = {}
  href: unknown = undefined
  control: FakeElement | null = null
  isConnected = true
  clicks = 0
  focuses = 0
  removed = false
  style: Record<string, string> = { cssText: '' }
  textContent = ''
  scrolls: Array<Record<string, unknown>> = []
  shadow: { children: FakeElement[]; append(...nodes: FakeElement[]): void } | null = null
  constructor(readonly tagName: string) {}
  getAttribute(name: string) {
    return this.attrs[name] ?? null
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect
    return { left, top, width, height, right: left + width, bottom: top + height }
  }
  contains(other: FakeElement): boolean {
    return other === this || this.children.some((child) => child.contains(other))
  }
  click() {
    this.clicks++
  }
  focus() {
    this.focuses++
  }
  scrollBy(arg: Record<string, unknown>) {
    this.scrolls.push({ by: arg })
  }
  scrollTo(arg: Record<string, unknown>) {
    this.scrolls.push({ to: arg })
  }
  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      node.parentElement = this
      this.children.push(node)
    }
  }
  attachShadow() {
    const shadow = { children: [] as FakeElement[], append: (...nodes: FakeElement[]) => void shadow.children.push(...nodes) }
    this.shadow = shadow
    return shadow
  }
  remove() {
    this.removed = true
    this.isConnected = false
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
  }
}

function fakePage(options: { scrollHeight?: number; clientHeight?: number; scrollWidth?: number; clientWidth?: number } = {}) {
  const listeners = new Map<string, Array<{ fn: (event: FakeKey & Record<string, unknown>) => void; capture: boolean }>>()
  const lines: string[] = []
  let clock = 5000
  const root = new FakeElement('HTML')
  Object.assign(root, { scrollHeight: options.scrollHeight ?? 4000, clientHeight: options.clientHeight ?? 800, scrollWidth: options.scrollWidth ?? 1000, clientWidth: options.clientWidth ?? 1000 })
  const body = new FakeElement('BODY')
  root.append(body)
  const everything: FakeElement[] = [root, body]
  /** The things the script may label, in document order. */
  const targets: FakeElement[] = []
  let active: FakeElement | null = body
  const document = {
    designMode: 'off',
    scrollingElement: root,
    documentElement: root,
    body,
    get activeElement() {
      return active
    },
    querySelectorAll: (selector: string) => (selector === '*' ? everything : targets),
    // The topmost of the things at the point: the last one in document order whose box holds it.
    elementFromPoint: (x: number, y: number) => [...everything].reverse().find((el) => el.rect.width > 0 && x >= el.rect.left && x <= el.rect.left + el.rect.width && y >= el.rect.top && y <= el.rect.top + el.rect.height) ?? null,
    createElement: (tag: string) => new FakeElement(tag.toUpperCase())
  }
  const sandbox: Record<string, unknown> = {
    console: { debug: (line: string) => lines.push(line) },
    performance: { now: () => clock },
    addEventListener: (type: string, fn: (event: FakeKey & Record<string, unknown>) => void, capture?: boolean | { capture?: boolean }) => {
      const list = listeners.get(type) ?? []
      list.push({ fn, capture: typeof capture === 'object' ? capture.capture === true : capture === true })
      listeners.set(type, list)
    },
    removeEventListener: (type: string, fn: unknown) => listeners.set(type, (listeners.get(type) ?? []).filter((l) => l.fn !== fn)),
    document,
    getComputedStyle: (el: FakeElement) => ({ visibility: 'visible', display: 'block', opacity: '1', pointerEvents: 'auto', overflowX: 'visible', overflowY: 'visible', ...el.computed }),
    Element: FakeElement,
    innerWidth: 1000,
    innerHeight: 800
  }
  sandbox['self'] = sandbox
  sandbox['window'] = sandbox
  const evaluate = new Function('scope', 'script', 'with (scope) { return eval(script) }') as (scope: unknown, script: string) => unknown
  const page = {
    root,
    body,
    lines,
    sandbox,
    document,
    run: (script: string) => evaluate(sandbox, script),
    install: () => evaluate(sandbox, VIM_KEY_SCRIPTS.install(NONCE)),
    advance: (ms: number) => (clock += ms),
    setActive: (el: FakeElement | null) => (active = el),
    /** Adds a thing to the document; with `label: true` the script may label it. */
    add(tag: string, rect: Rect, extra: Partial<FakeElement> = {}, label = true): FakeElement {
      const el = new FakeElement(tag)
      el.rect = rect
      Object.assign(el, extra)
      body.append(el)
      everything.push(el)
      if (label) targets.push(el)
      return el
    },
    /** Something that is neither a field nor a link (a scrolling box, a covering banner). */
    plain(tag: string, rect: Rect, extra: Partial<FakeElement> = {}) {
      return page.add(tag, rect, extra, false)
    },
    /** Presses a key. Returns the event, with what the script did to it. */
    key(input: FakeKey | string): { prevented: boolean; stopped: boolean } {
      const base: FakeKey = typeof input === 'string' ? { key: input } : input
      const outcome = { prevented: false, stopped: false }
      const event = {
        isTrusted: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        ...base,
        composedPath: () => [base.target ?? body],
        preventDefault: () => void (outcome.prevented = true),
        stopImmediatePropagation: () => void (outcome.stopped = true)
      }
      for (const { fn } of [...(listeners.get('keydown') ?? [])]) {
        fn(event as never)
        if (outcome.stopped) break
      }
      return outcome
    },
    fire: (type: string) => {
      for (const { fn } of [...(listeners.get(type) ?? [])]) fn({} as never)
    },
    listenerCount: () => [...listeners.values()].reduce((sum, list) => sum + list.length, 0),
    hosts: () => root.children.filter((child) => child.shadow !== null),
    boxes: () => page.hosts().flatMap((host) => host.shadow?.children ?? []),
    /** The label of each box, in order, as the script wrote it (typed part, then the rest). */
    labels: () => page.boxes().map((box) => box.children.map((part) => part.textContent).join('|')),
    reports: () => lines.map((line) => parseToolMessage(line, NONCE)),
    tool: () => (sandbox['__lucium_tools'] as Record<string, { off(): void }> | undefined)?.['vimKeys']
  }
  return page
}

const BOX: Rect = { left: 10, top: 10, width: 100, height: 20 }

describe('the script of the keys', () => {
  it('compiles, and so does the one that takes it out', () => {
    expect(() => new Function(VIM_KEY_SCRIPTS.install(NONCE))).not.toThrow()
    expect(() => new Function(VIM_KEY_SCRIPTS.uninstall)).not.toThrow()
  })

  it('is installed once: a second run adds no listener', () => {
    const page = fakePage()
    page.install()
    const count = page.listenerCount()
    expect(count).toBe(1)
    page.install()
    expect(page.listenerCount()).toBe(count)
  })

  it('is taken out whole by the script that uninstalls it: no listener, no hints left, no name in the world', () => {
    const page = fakePage()
    page.add('A', BOX, { href: 'https://example.org/' })
    page.install()
    page.key('f')
    expect(page.hosts()).toHaveLength(1)
    page.run(VIM_KEY_SCRIPTS.uninstall)
    expect(page.listenerCount()).toBe(0)
    expect(page.hosts()).toHaveLength(0)
    expect(page.tool()).toBeUndefined()
    // Once out, the keys are the page's again.
    expect(page.key('j').prevented).toBe(false)
  })

  it('keeps to one name in the world of the page', () => {
    const page = fakePage()
    page.install()
    expect(Object.keys(page.sandbox).filter((key) => key.startsWith('__'))).toEqual(['__lucium_tools'])
  })

  describe('scrolling', () => {
    it('scrolls the page by a few lines with j and k, and sideways with l and h', () => {
      const page = fakePage({ scrollWidth: 3000 })
      page.install()
      page.key('j')
      page.key('k')
      page.key('l')
      page.key('h')
      expect(page.root.scrolls).toEqual([
        { by: { left: 0, top: 60, behavior: 'instant' } },
        { by: { left: 0, top: -60, behavior: 'instant' } },
        { by: { left: 60, top: 0, behavior: 'instant' } },
        { by: { left: -60, top: 0, behavior: 'instant' } }
      ])
    })

    it('scrolls half a screen with d and u, whatever the size of the window', () => {
      const page = fakePage()
      page.install()
      page.key('d')
      page.key('u')
      page.sandbox['innerHeight'] = 301
      page.key('d')
      expect(page.root.scrolls).toEqual([
        { by: { left: 0, top: 400, behavior: 'instant' } },
        { by: { left: 0, top: -400, behavior: 'instant' } },
        { by: { left: 0, top: 150, behavior: 'instant' } }
      ])
    })

    it('goes to the top with gg and to the bottom with G', () => {
      const page = fakePage({ scrollHeight: 9000 })
      page.install()
      page.key('g')
      page.key('g')
      page.key('G')
      expect(page.root.scrolls).toEqual([{ to: { top: 0, behavior: 'instant' } }, { to: { top: 9000, behavior: 'instant' } }])
    })

    it('forgets a g that waited too long, and a g that a key other than g followed', () => {
      const page = fakePage()
      page.install()
      page.key('g')
      page.advance(VIM_PENDING_MS + 1)
      page.key('g')
      expect(page.root.scrolls).toEqual([])
      const after = page.key('x')
      expect(after.prevented).toBe(false)
      page.key('g')
      const other = page.key('x')
      expect(other.prevented).toBe(false)
      page.key('g')
      expect(page.root.scrolls).toEqual([])
    })

    it('scrolls the box of a web app when the page itself does not scroll', () => {
      const page = fakePage({ scrollHeight: 800, clientHeight: 800 })
      const small = page.plain('DIV', BOX, { scrollHeight: 900, clientHeight: 100, clientWidth: 100, computed: { overflowY: 'auto' } })
      const main = page.plain('MAIN', BOX, { scrollHeight: 5000, clientHeight: 700, clientWidth: 900, computed: { overflowY: 'scroll' } })
      const hidden = page.plain('DIV', BOX, { scrollHeight: 9000, clientHeight: 300, clientWidth: 900, computed: { overflowY: 'hidden' } })
      page.install()
      page.key('j')
      expect(main.scrolls).toEqual([{ by: { left: 0, top: 60, behavior: 'instant' } }])
      expect(small.scrolls).toEqual([])
      expect(hidden.scrolls).toEqual([])
      expect(page.root.scrolls).toEqual([])
    })

    it('scrolls the box that holds the focus first', () => {
      const page = fakePage()
      const pane = page.plain('DIV', BOX, { scrollHeight: 2000, clientHeight: 300, clientWidth: 300, computed: { overflowY: 'auto' } })
      const item = new FakeElement('BUTTON')
      pane.append(item)
      page.setActive(item)
      page.install()
      page.key('j')
      expect(pane.scrolls).toHaveLength(1)
      expect(page.root.scrolls).toEqual([])
    })

    it('lets key repeat scroll, but does not repeat a command that changes the page or the tab', () => {
      const page = fakePage()
      page.install()
      page.key({ key: 'j', repeat: true })
      page.key({ key: 'H', repeat: true })
      page.key({ key: 'K', repeat: true })
      page.key({ key: 'f', repeat: true })
      expect(page.root.scrolls).toHaveLength(1)
      expect(page.lines).toEqual([])
      expect(page.hosts()).toHaveLength(0)
    })
  })

  describe('what only the application can do', () => {
    it('asks for back, forward, reload, the previous and next tab and the search, one line each', () => {
      const page = fakePage()
      page.install()
      for (const key of ['H', 'L', 'r', 'J', 'K', '/']) page.key(key)
      expect(page.reports()).toEqual([
        { tool: 'vim', action: 'back' },
        { tool: 'vim', action: 'forward' },
        { tool: 'vim', action: 'reload' },
        { tool: 'vim', action: 'tab-previous' },
        { tool: 'vim', action: 'tab-next' },
        { tool: 'vim', action: 'find' }
      ])
      expect(page.lines.every((line) => line.startsWith(`${TOOL_CHANNEL}${NONCE}:`))).toBe(true)
    })
  })

  describe('where the keys are left to the page', () => {
    const typingTargets: Array<[string, () => FakeElement]> = [
      ['a text field', () => Object.assign(new FakeElement('INPUT'), { type: 'text' })],
      ['a field with no type', () => new FakeElement('INPUT')],
      ['a search field', () => Object.assign(new FakeElement('INPUT'), { type: 'search' })],
      ['a password field', () => Object.assign(new FakeElement('INPUT'), { type: 'password' })],
      ['a number field', () => Object.assign(new FakeElement('INPUT'), { type: 'number' })],
      ['a text area', () => new FakeElement('TEXTAREA')],
      ['a list box', () => new FakeElement('SELECT')],
      ['an editable area', () => Object.assign(new FakeElement('DIV'), { isContentEditable: true })],
      ['a text box of a web app', () => Object.assign(new FakeElement('DIV'), { attrs: { role: 'textbox' } })],
      ['a combo box of a web app', () => Object.assign(new FakeElement('DIV'), { attrs: { role: 'combobox' } })]
    ]

    for (const [name, make] of typingTargets) {
      it(`leaves every key alone in ${name}`, () => {
        const page = fakePage()
        page.install()
        const target = make()
        for (const key of ['j', 'k', 'f', 'F', 'H', 'L', 'J', 'K', 'r', '/', 'G', 'g', 'd', 'u']) {
          const outcome = page.key({ key, target })
          expect(outcome, `${name}: ${key}`).toEqual({ prevented: false, stopped: false })
        }
        expect(page.root.scrolls).toEqual([])
        expect(page.lines).toEqual([])
        expect(page.hosts()).toHaveLength(0)
      })
    }

    it('leaves the keys alone when the focus is in a field inside a shadow tree, whoever the event says it came from', () => {
      const page = fakePage()
      page.install()
      const field = Object.assign(new FakeElement('INPUT'), { type: 'text' })
      const host = new FakeElement('MY-SEARCH')
      host.shadowRoot = { activeElement: field }
      page.setActive(host)
      expect(page.key('j')).toEqual({ prevented: false, stopped: false })
      expect(page.root.scrolls).toEqual([])
    })

    it('leaves the keys alone in a document being edited as a whole', () => {
      const page = fakePage()
      page.install()
      page.document.designMode = 'on'
      expect(page.key('j')).toEqual({ prevented: false, stopped: false })
      page.document.designMode = 'off'
      expect(page.key('j').prevented).toBe(true)
    })

    it('still works over a button, a link or a box that is ticked: those take no text', () => {
      const page = fakePage()
      page.install()
      for (const target of [new FakeElement('BUTTON'), Object.assign(new FakeElement('INPUT'), { type: 'checkbox' }), Object.assign(new FakeElement('INPUT'), { type: 'radio' }), Object.assign(new FakeElement('INPUT'), { type: 'submit' }), new FakeElement('A')]) {
        expect(page.key({ key: 'j', target }).prevented, target.tagName + target.type).toBe(true)
      }
    })

    it('never answers ⌘, ⌃ or ⌥ chords (the browser’s own shortcuts), a key the user did not press, or a composition', () => {
      const page = fakePage()
      page.install()
      for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { isTrusted: false }, { isComposing: true }, { defaultPrevented: true }]) {
        expect(page.key({ key: 'j', ...mods }), JSON.stringify(mods)).toEqual({ prevented: false, stopped: false })
        expect(page.key({ key: 'H', ...mods }), JSON.stringify(mods)).toEqual({ prevented: false, stopped: false })
      }
      expect(page.root.scrolls).toEqual([])
      expect(page.lines).toEqual([])
    })

    it('hides a key it acts on from the page, and shows the page the ones it does not use', () => {
      const page = fakePage()
      page.install()
      expect(page.key('j')).toEqual({ prevented: true, stopped: true })
      expect(page.key('H')).toEqual({ prevented: true, stopped: true })
      for (const key of ['a', 'x', 'Enter', 'ArrowDown', 'Escape', 'Tab', ' ', 'J ']) expect(page.key(key), key).toEqual({ prevented: false, stopped: false })
    })

    it('does not answer capital letters typed with shift as the small ones, nor the other way round', () => {
      const page = fakePage()
      page.install()
      page.key({ key: 'J', shiftKey: true })
      expect(page.root.scrolls).toEqual([])
      expect(page.reports()).toEqual([{ tool: 'vim', action: 'tab-previous' }])
    })
  })

  describe('the link hints', () => {
    const link = (page: ReturnType<typeof fakePage>, top: number, href = 'https://example.org/a') => page.add('A', { left: 10, top, width: 100, height: 20 }, { href })
    /** `count` links laid out in a grid, none over another. */
    const grid = (page: ReturnType<typeof fakePage>, count: number) =>
      Array.from({ length: count }, (_, index) => page.add('A', { left: (index % 9) * 100, top: Math.floor(index / 9) * 16, width: 90, height: 14 }, { href: `https://example.org/${index}` }))

    it('puts a label on each link on screen, and none on what a click does nothing to', () => {
      const page = fakePage()
      const first = link(page, 10)
      const second = link(page, 50)
      link(page, 900)
      page.add('A', { left: 10, top: 90, width: 2, height: 2 }, { href: 'https://example.org/tiny' })
      page.add('A', { left: 10, top: 130, width: 100, height: 20 }, { href: 'https://example.org/hidden', computed: { visibility: 'hidden' } })
      page.add('A', { left: 10, top: 170, width: 100, height: 20 }, { href: 'https://example.org/invisible', computed: { opacity: '0' } })
      page.add('A', { left: 10, top: 210, width: 100, height: 20 }, { href: 'https://example.org/inert', computed: { pointerEvents: 'none' } })
      page.add('A', { left: -300, top: 250, width: 100, height: 20 }, { href: 'https://example.org/left' })
      const covered = link(page, 300)
      page.plain('DIV', { left: 0, top: 290, width: 400, height: 60 })
      page.install()
      page.key('f')
      expect(page.hosts()).toHaveLength(1)
      expect(page.labels()).toEqual(['|a', '|s'])
      expect(first.clicks + second.clicks + covered.clicks).toBe(0)
    })

    it('does not even look at the style of what is off screen or too small: a long page costs a few boxes, not thousands', () => {
      const page = fakePage()
      let styled = 0
      const real = page.sandbox['getComputedStyle'] as (el: FakeElement) => unknown
      page.sandbox['getComputedStyle'] = (el: FakeElement) => (styled++, real(el))
      for (let index = 0; index < 50; index++) page.add('A', { left: 10, top: 900 + index * 30, width: 100, height: 20 }, { href: 'https://example.org/below' })
      for (let index = 0; index < 50; index++) page.add('A', { left: -500, top: 10 + index * 10, width: 100, height: 20 }, { href: 'https://example.org/left' })
      for (let index = 0; index < 50; index++) page.add('A', { left: 10, top: 10, width: 3, height: 3 }, { href: 'https://example.org/dot' })
      page.install()
      page.key('f')
      expect(styled).toBe(0)
      expect(page.hosts()).toHaveLength(0)
    })

    it('keeps the labels in a closed shadow tree of an element of its own, over everything', () => {
      const page = fakePage()
      link(page, 10)
      page.install()
      page.key('f')
      const [host] = page.hosts()
      expect(host!.style['cssText']).toContain('z-index:2147483647')
      expect(host!.style['cssText']).toContain('pointer-events:none')
      expect(host!.shadow).not.toBeNull()
      expect(host!.shadow!.children).toHaveLength(1)
      expect(host!.shadow!.children[0]!.style['cssText']).toContain('left:10px;top:10px')
    })

    it('draws them in a plain element: no tag of the application tells the page which browser this is', () => {
      const page = fakePage()
      link(page, 10)
      page.install()
      page.key('f')
      expect(page.root.children.map((child) => child.tagName)).toEqual(['BODY', 'DIV'])
      expect(page.hosts()[0]!.style['cssText']).toMatch(/^all:initial;/)
    })

    it('shows nothing when there is nothing to follow', () => {
      const page = fakePage()
      page.install()
      page.key('f')
      expect(page.hosts()).toHaveLength(0)
      // …and the next key is still a command, not a letter of a label.
      expect(page.key('j').prevented).toBe(true)
      expect(page.root.scrolls).toHaveLength(1)
    })

    it('follows the link whose letters are typed, and ends the hints', () => {
      const page = fakePage()
      const first = link(page, 10)
      const second = link(page, 50)
      page.install()
      page.key('f')
      const outcome = page.key('s')
      expect(outcome).toEqual({ prevented: true, stopped: true })
      expect(second.clicks).toBe(1)
      expect(first.clicks).toBe(0)
      expect(page.hosts()).toHaveLength(0)
      expect(page.reports()).toEqual([])
    })

    it('takes capital letters for small ones, and swallows a letter that names no link without leaving the hints', () => {
      const page = fakePage()
      const first = link(page, 10)
      const second = link(page, 50)
      page.install()
      page.key('f')
      expect(page.key('z')).toEqual({ prevented: true, stopped: true })
      expect(page.key('1')).toEqual({ prevented: true, stopped: true })
      expect(page.key('Enter')).toEqual({ prevented: true, stopped: true })
      expect(page.hosts()).toHaveLength(1)
      page.key('A')
      expect(first.clicks).toBe(1)
      expect(second.clicks).toBe(0)
    })

    it('needs the second letter when there are more links than letters, and shows only what is still possible', () => {
      const page = fakePage()
      const count = VIM_HINT_ALPHABET.length + 3
      const links = grid(page, count)
      page.install()
      page.key('f')
      const labels = page.labels().map((label) => label.replace('|', ''))
      expect(new Set(labels).size).toBe(count)
      const long = labels.find((label) => label.length === 2)!
      page.key(long[0]!)
      const shown = page.boxes().filter((box) => box.style['display'] === 'block').length
      const withFirstLetter = labels.filter((label) => label.startsWith(long[0]!)).length
      expect(shown).toBe(withFirstLetter)
      expect(links.some((l) => l.clicks > 0)).toBe(false)
      page.key(long[1]!)
      expect(links[labels.indexOf(long)]!.clicks).toBe(1)
      expect(links.filter((l) => l.clicks > 0)).toHaveLength(1)
    })

    it('shows the typed part of a label apart from the rest', () => {
      const page = fakePage()
      grid(page, VIM_HINT_ALPHABET.length + 3)
      page.install()
      page.key('f')
      const long = page.labels().map((label) => label.replace('|', '')).find((label) => label.length === 2)!
      page.key(long[0]!)
      const mine = page.labels().find((label) => label === `${long[0]}|${long[1]}`)
      expect(mine).toBeDefined()
    })

    it('goes back one letter with Backspace, and leaves the hints with Backspace on an empty label or with Escape', () => {
      const page = fakePage()
      grid(page, VIM_HINT_ALPHABET.length + 3)
      page.install()
      page.key('f')
      const long = page.labels().map((label) => label.replace('|', '')).find((label) => label.length === 2)!
      page.key(long[0]!)
      page.key('Backspace')
      expect(page.boxes().every((box) => box.style['display'] === 'block')).toBe(true)
      expect(page.hosts()).toHaveLength(1)
      page.key('Backspace')
      expect(page.hosts()).toHaveLength(0)
      page.key('f')
      expect(page.hosts()).toHaveLength(1)
      expect(page.key('Escape').prevented).toBe(true)
      expect(page.hosts()).toHaveLength(0)
      // Escape in the normal mode is the page's.
      expect(page.key('Escape').prevented).toBe(false)
    })

    it('ends when the page scrolls, is resized, is clicked or loses the focus', () => {
      for (const event of ['scroll', 'resize', 'mousedown', 'blur']) {
        const page = fakePage()
        link(page, 10)
        page.install()
        page.key('f')
        expect(page.hosts()).toHaveLength(1)
        page.fire(event)
        expect(page.hosts(), event).toHaveLength(0)
        // The listeners that were added for the hints go with them.
        expect(page.listenerCount(), event).toBe(1)
      }
    })

    it('leaves the chords of the browser alone while the hints are up', () => {
      const page = fakePage()
      link(page, 10)
      page.install()
      page.key('f')
      expect(page.key({ key: 'w', metaKey: true })).toEqual({ prevented: false, stopped: false })
      expect(page.key({ key: 'a', ctrlKey: true })).toEqual({ prevented: false, stopped: false })
      expect(page.hosts()).toHaveLength(1)
    })

    it('opens a link in a new tab with F by asking the application, and does not click it', () => {
      const page = fakePage()
      const a = link(page, 10, 'https://example.org/a?x=1')
      page.install()
      page.key('F')
      page.key('a')
      expect(page.reports()).toEqual([{ tool: 'vim', action: 'open-tab', url: 'https://example.org/a?x=1' }])
      expect(a.clicks).toBe(0)
    })

    it('clicks, with F, what is not a web address (javascript:, mailto:), has no address of its own, or has one too long for the line', () => {
      const page = fakePage()
      const script = link(page, 10, 'javascript:void(0)')
      const mail = link(page, 40, 'mailto:a@example.org')
      const button = page.add('BUTTON', { left: 10, top: 70, width: 100, height: 20 })
      const long = link(page, 100, `https://example.org/${'a'.repeat(VIM_URL_MAX)}`)
      const svg = page.add('A', { left: 10, top: 130, width: 100, height: 20 })
      page.install()
      for (const [label, el] of [['a', script], ['s', mail], ['d', button], ['f', long], ['g', svg]] as const) {
        page.key('F')
        page.key(label)
        expect(el.clicks, label).toBe(1)
      }
      expect(page.reports()).toEqual([])
    })

    it('puts the focus in a text field and does not click it, but clicks a box to tick', () => {
      const page = fakePage()
      const field = page.add('INPUT', { left: 10, top: 10, width: 100, height: 20 }, { type: 'text' })
      const area = page.add('TEXTAREA', { left: 10, top: 40, width: 100, height: 20 })
      const select = page.add('SELECT', { left: 10, top: 70, width: 100, height: 20 })
      const check = page.add('INPUT', { left: 10, top: 100, width: 100, height: 20 }, { type: 'checkbox' })
      page.install()
      page.key('f')
      const labels = page.labels().map((label) => label.replace('|', ''))
      page.key('Escape')
      for (const letter of labels) {
        page.key('f')
        page.key(letter)
      }
      expect([field.clicks, area.clicks, select.clicks, check.clicks]).toEqual([0, 0, 0, 1])
      expect([field.focuses, area.focuses, select.focuses, check.focuses]).toEqual([1, 1, 1, 0])
    })

    it('gives one label to a field and the label that stands for it', () => {
      const page = fakePage()
      const box = page.add('INPUT', { left: 10, top: 10, width: 20, height: 20 }, { type: 'checkbox' })
      const label = page.add('LABEL', { left: 40, top: 10, width: 100, height: 20 }, { control: box })
      const alone = page.add('LABEL', { left: 40, top: 50, width: 100, height: 20 }, { control: null })
      page.install()
      page.key('f')
      expect(page.boxes()).toHaveLength(2)
      // Following each hint reaches the field and the label that stands for nothing else, never the label of the field.
      const labels = page.labels().map((text) => text.replace('|', ''))
      page.key('Escape')
      for (const letter of labels) {
        page.key('f')
        page.key(letter)
      }
      expect([box.clicks, label.clicks, alone.clicks]).toEqual([1, 0, 1])
    })

    it('labels at most the most it can write, and looks at no more than it can afford to', () => {
      const page = fakePage()
      grid(page, VIM_HINT_MAX + 50)
      page.install()
      page.key('f')
      expect(page.boxes()).toHaveLength(VIM_HINT_MAX)
      expect(VIM_SCAN_MAX).toBeGreaterThanOrEqual(VIM_HINT_MAX)
    })

    it('ends the hints and the keys with the tool itself', () => {
      const page = fakePage()
      link(page, 10)
      page.install()
      page.key('f')
      page.tool()!.off()
      expect(page.hosts()).toHaveLength(0)
      expect(page.listenerCount()).toBe(0)
    })

    it('does not answer keys the page made up, while the hints are up either', () => {
      const page = fakePage()
      const a = link(page, 10)
      page.install()
      page.key('f')
      expect(page.key({ key: 'a', isTrusted: false })).toEqual({ prevented: false, stopped: false })
      expect(a.clicks).toBe(0)
    })
  })
})
