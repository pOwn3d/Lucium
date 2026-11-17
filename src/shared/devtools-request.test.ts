import { describe, expect, it } from 'vitest'
import { DEVTOOLS_EXTRA_ACCELERATOR, devToolsExtraAccelerator, devToolsFailureMessage, devToolsReply, devToolsRequestForKey, devToolsScript, devToolsStep, devToolsTarget, inspectPoint, type DevToolsKey } from './devtools-request'

describe('devToolsStep', () => {
  it('asks the frontend for nothing when only the tools are asked for, for a panel by its id, and for the picking mode', () => {
    expect(devToolsStep('tools')).toEqual({ kind: 'raise' })
    expect(devToolsStep('elements')).toEqual({ kind: 'panel', panel: 'elements' })
    expect(devToolsStep('console')).toEqual({ kind: 'panel', panel: 'console' })
    expect(devToolsStep('network')).toEqual({ kind: 'panel', panel: 'network' })
    expect(devToolsStep('inspect')).toEqual({ kind: 'inspect' })
  })
})

/** A frontend as the script sees it: `DevToolsAPI`, and a document whose tab bar and picking button are given. */
function frontend(over: { api?: boolean | 'inspector-only'; tabs?: Array<{ id: string; selected: boolean }>; toggle?: 'true' | 'false' | 'absent' } = {}) {
  const calls: string[] = []
  const element = (attributes: Record<string, string>, extra: object = {}) => ({ getAttribute: (name: string) => attributes[name] ?? null, shadowRoot: null, querySelectorAll: () => [], ...extra })
  const tabs = (over.tabs ?? [{ id: 'tab-elements', selected: true }, { id: 'tab-console', selected: false }]).map((tab) => ({ ...element({ 'aria-selected': String(tab.selected) }), id: tab.id }))
  const button = element({ 'aria-pressed': over.toggle ?? 'false' })
  const toggle = over.toggle === 'absent' ? [] : [element({}, { shadowRoot: { querySelector: () => button, querySelectorAll: () => [] } })]
  const document = {
    querySelectorAll: (selector: string) => {
      if (selector === '*') return []
      if (selector === '[role=tab]') return tabs
      if (selector.startsWith('#tab-')) return tabs.filter((tab) => `#${tab.id}` === selector)
      if (selector.includes('elements.toggle-element-search')) return toggle
      return []
    }
  }
  const api = over.api === false || over.api === 'inspector-only' ? undefined : { showPanel: (panel: string) => calls.push(`showPanel ${panel}`), enterInspectElementMode: () => calls.push('enterInspectElementMode') }
  return { calls, run: (script: string) => {
      // 'inspector-only': `DevToolsAPI` exists but without the calls; they are on `InspectorFrontendAPI`.
      const both = over.api === 'inspector-only' ? { DevToolsAPI: {}, InspectorFrontendAPI: { showPanel: (panel: string) => calls.push(`showPanel ${panel}`), enterInspectElementMode: () => calls.push('enterInspectElementMode') } } : { DevToolsAPI: api }
      return new Function('document', 'globalThis', `return ${script}`)(document, both) as string
    }, select: (id: string) => tabs.forEach((tab) => ((tab as unknown as { getAttribute: unknown }).getAttribute = (name: string) => (name === 'aria-selected' ? String(tab.id === id) : null))), press: () => (button.getAttribute = () => 'true') }
}

describe('devToolsScript', () => {
  it('calls showPanel with the id of the panel and says pending until that panel is the selected one', () => {
    const page = frontend()
    const script = devToolsScript({ kind: 'panel', panel: 'console' })
    expect(page.run(script)).toBe('pending')
    expect(page.calls).toEqual(['showPanel console'])
    page.select('tab-console')
    expect(page.run(script)).toBe('done')
  })

  it('calls enterInspectElementMode, and says pending until the picking button is pressed', () => {
    const page = frontend({ toggle: 'false' })
    const script = devToolsScript({ kind: 'inspect' })
    expect(page.run(script)).toBe('pending')
    expect(page.calls).toEqual(['enterInspectElementMode'])
    page.press()
    expect(page.run(script)).toBe('done')
  })

  it('does not call when it is only to look (the picking mode is a toggle: asked twice it is left)', () => {
    const page = frontend({ toggle: 'false' })
    expect(page.run(devToolsScript({ kind: 'inspect' }, { call: false }))).toBe('pending')
    expect(page.calls).toEqual([])
  })

  it('waits, and calls nothing, while the frontend has no DevToolsAPI or has built no tab bar yet', () => {
    const noApi = frontend({ api: false })
    expect(noApi.run(devToolsScript({ kind: 'panel', panel: 'network' }))).toBe('waiting')
    const noTabs = frontend({ tabs: [] })
    expect(noTabs.run(devToolsScript({ kind: 'panel', panel: 'network' }))).toBe('waiting')
    expect(noTabs.calls).toEqual([])
  })

  it('reads the calls from InspectorFrontendAPI when DevToolsAPI has none (another measure found it so), and waits when neither has them', () => {
    const page = frontend({ api: 'inspector-only', toggle: 'true' })
    expect(page.run(devToolsScript({ kind: 'inspect' }))).toBe('done')
    expect(page.calls).toEqual(['enterInspectElementMode'])
    expect(frontend({ api: 'inspector-only' }).run(devToolsScript({ kind: 'panel', panel: 'console' }))).toBe('pending')
    expect(frontend({ api: false }).run(devToolsScript({ kind: 'inspect' }))).toBe('waiting')
  })

  it('counts the call as done when the frontend has nothing to read back (a panel without its tab, no picking button)', () => {
    expect(frontend({ tabs: [{ id: 'tab-elements', selected: true }] }).run(devToolsScript({ kind: 'panel', panel: 'console' }))).toBe('done')
    expect(frontend({ toggle: 'absent' }).run(devToolsScript({ kind: 'inspect' }))).toBe('done')
  })

  it('reads any answer but its own words as not there yet', () => {
    expect(devToolsReply('done')).toBe('done')
    expect(devToolsReply('pending')).toBe('pending')
    expect(devToolsReply('waiting')).toBe('waiting')
    expect(devToolsReply(undefined)).toBe('waiting')
    expect(devToolsReply(true)).toBe('waiting')
  })
})

describe('inspectPoint', () => {
  it('leaves the point of a page at 100 % as it is', () => {
    expect(inspectPoint({ x: 360, y: 280 }, 1)).toEqual({ x: 360, y: 280 })
  })

  it('divides by the zoom of the page: the menu reports the point times the zoom (measured: 810, 630 for a click at 540, 420 at 150 %)', () => {
    expect(inspectPoint({ x: 810, y: 630 }, 1.5)).toEqual({ x: 540, y: 420 })
    expect(inspectPoint({ x: 203, y: 158 }, 0.75)).toEqual({ x: 271, y: 211 })
  })

  it('takes a zoom that is not a number above zero for 100 %', () => {
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(inspectPoint({ x: 10, y: 20 }, zoom)).toEqual({ x: 10, y: 20 })
  })
})

describe('devToolsTarget', () => {
  it('is the Glance while one is on screen, else the tab, else nothing', () => {
    expect(devToolsTarget({ peekShown: true, hasTab: true })).toBe('peek')
    expect(devToolsTarget({ peekShown: true, hasTab: false })).toBe('peek')
    expect(devToolsTarget({ peekShown: false, hasTab: true })).toBe('tab')
    expect(devToolsTarget({ peekShown: false, hasTab: false })).toBe('none')
  })
})

describe('devToolsExtraAccelerator', () => {
  it('adds F12', () => {
    expect(devToolsExtraAccelerator(undefined)).toBe(DEVTOOLS_EXTRA_ACCELERATOR)
    expect(DEVTOOLS_EXTRA_ACCELERATOR).toBe('F12')
  })

  it('leaves F12 alone once the user gave it to a command, the tools included', () => {
    expect(devToolsExtraAccelerator({ reload: 'F12' })).toBeUndefined()
    expect(devToolsExtraAccelerator({ devTools: 'F12' })).toBeUndefined()
  })

  it('does not mind a shortcut the user gave to another key', () => {
    expect(devToolsExtraAccelerator({ devTools: 'CmdOrCtrl+Alt+D' })).toBe('F12')
  })
})

const key = (k: string, over: Partial<DevToolsKey> = {}): DevToolsKey => ({ key: k, meta: false, shift: false, alt: false, control: false, ...over })

describe('devToolsRequestForKey', () => {
  it('maps ⌥⌘I, ⌥⌘C, ⌥⌘J and F12 to the tools, the picking mode, the console and the tools', () => {
    expect(devToolsRequestForKey(key('i', { meta: true, alt: true }), undefined)).toBe('tools')
    expect(devToolsRequestForKey(key('c', { meta: true, alt: true }), undefined)).toBe('inspect')
    expect(devToolsRequestForKey(key('j', { meta: true, alt: true }), undefined)).toBe('console')
    expect(devToolsRequestForKey(key('F12'), undefined)).toBe('tools')
  })

  it('reads the physical key when ⌥ turned the character into another one (macOS: ⌥J gives ∆)', () => {
    expect(devToolsRequestForKey(key('∆', { meta: true, alt: true, code: 'KeyJ' }), undefined)).toBe('console')
    expect(devToolsRequestForKey(key('ˆ', { meta: true, alt: true, code: 'KeyI' }), undefined)).toBe('tools')
  })

  it('follows the shortcut the user gave a command, and drops the one it had', () => {
    const bindings = { jsConsole: 'CmdOrCtrl+Alt+K' }
    expect(devToolsRequestForKey(key('k', { meta: true, alt: true }), bindings)).toBe('console')
    expect(devToolsRequestForKey(key('j', { meta: true, alt: true }), bindings)).toBeNull()
  })

  it('lets every other key go to the page, F12 included once it is another command’s', () => {
    expect(devToolsRequestForKey(key('i', { meta: true }), undefined)).toBeNull()
    expect(devToolsRequestForKey(key('i'), undefined)).toBeNull()
    expect(devToolsRequestForKey(key('F11'), undefined)).toBeNull()
    expect(devToolsRequestForKey(key('F12'), { reload: 'F12' })).toBeNull()
  })
})

describe('devToolsFailureMessage', () => {
  it('says the tools did not open when they never did, or went away, or only they were asked for', () => {
    const opened = 'Les outils de développement n’ont pas pu s’ouvrir.'
    expect(devToolsFailureMessage('not-opened', 'console')).toBe(opened)
    expect(devToolsFailureMessage('closed', 'inspect')).toBe(opened)
    expect(devToolsFailureMessage('frontend', 'tools')).toBe(opened)
  })

  it('says they are open but the panel, or the picking of an element, did not follow', () => {
    expect(devToolsFailureMessage('frontend', 'network')).toBe('Les outils de développement sont ouverts, mais le panneau demandé n’a pas pu s’afficher.')
    expect(devToolsFailureMessage('script', 'inspect')).toBe('Les outils de développement sont ouverts, mais la sélection d’un élément n’a pas démarré.')
  })
})
