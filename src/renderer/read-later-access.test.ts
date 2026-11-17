// Where the pages to read later arrive, and how to reach them: the list has a button in the footer of the sidebar, and the
// notice of saving a page offers to open it. The sidebar is rendered to markup with the real component (no window, as tidy-panel.test.ts does) and the footer is
// read; the notice is built by the real methods of the shell, run on a stand-in for the window (browser.ts reaches Electron only when a method runs).

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { readLaterNotice } from '@shared/read-later'

/** What the sidebar asked of the bridge. */
const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as unknown[][] }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => void holder.asked.push([name, ...args]) }), useSnapshot: () => holder.snapshot }))
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))

import { Sidebar } from './Sidebar'

const { Browser } = await import('../main/shell/browser')
const shellMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

/** The footer of the sidebar of a window with its one empty space, in a private window or not, with these key bindings. */
function footer(options: { private?: boolean; keyBindings?: Record<string, string> } = {}): string {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const snapshot = {
    state: { ...state, settings: { ...state.settings, ...(options.keyBindings ? { keyBindings: options.keyBindings } : {}) } },
    runtime: { tabs: {}, canGoBack: false, canGoForward: false },
    engine: {},
    extensions: [],
    downloads: [],
    find: null,
    peek: null,
    sidePanel: null,
    toast: null,
    platform: 'darwin',
    private: options.private === true
  } as unknown as UiSnapshot
  const markup = renderToStaticMarkup(createElement(Sidebar, { snapshot, space: snapshot.state.spaces[0]! }))
  return /<footer[\s\S]*?<\/footer>/.exec(markup)?.[0] ?? ''
}

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('the footer of the sidebar', () => {
  it('has a button for the list of "Lire plus tard" after the archive and before the downloads, named for a screen reader', () => {
    const markup = footer()
    const archive = markup.indexOf('footer-archive')
    const readLater = markup.indexOf('footer-readlater')
    const downloads = markup.indexOf('footer-downloads')
    expect(archive).toBeGreaterThan(0)
    expect(readLater).toBeGreaterThan(archive)
    expect(downloads).toBeGreaterThan(readLater)
    expect(markup).toMatch(/<button class="footer-side footer-readlater" data-tip="Lire plus tard" aria-label="Lire plus tard">/)
  })

  it('says the shortcut of the list in the bubble of the button once the command has one', () => {
    expect(footer({ keyBindings: { readLaterList: 'CmdOrCtrl+Shift+L' } })).toMatch(/class="footer-side footer-readlater" data-tip="Lire plus tard · [^"]+" aria-label="Lire plus tard · [^"]+"/)
  })

  it('does not have it in a private window, which keeps no list', () => {
    const markup = footer({ private: true })
    expect(markup).toContain('footer-archive')
    expect(markup).toContain('footer-downloads')
    expect(markup).not.toContain('footer-readlater')
  })
})

describe('the notice of saving a page for later', () => {
  type Offer = { label: string; run: () => void; second?: { label: string; run: () => void } }
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }

  /** The shell after "Lire plus tard" on a page: the state before and after, what it dispatched and opened, and the notice it showed. */
  function saved(url = 'https://exemple.fr/article', alreadyListed = false) {
    let state: SidebarState = createInitialState(ctx)
    const open = () => {
      state = reduce(state, { type: 'tab/open', url, spaceId: state.spaces[0]!.id }, ctx)
      return state.tabs.at(-1)!.id
    }
    // Already listed: the page was saved from another tab (which the list closed), and is open again.
    if (alreadyListed) {
      const first = open()
      state = reduce(state, { type: 'readlater/add', tabId: first }, ctx)
    }
    const tabId = open()
    const before = state
    state = reduce(state, { type: 'readlater/add', tabId }, ctx)
    const done: unknown[] = []
    const shown: Array<[message: string, offer: Offer | undefined]> = []
    const shell = {
      store: { get: () => state },
      dispatch: (action: Action) => void done.push(action),
      openOverlay: (request: unknown) => void done.push({ openOverlay: request }),
      showToast: (message: string, offer?: Offer) => void shown.push([message, offer])
    }
    shellMethods['announceReadLater']!.call(shell, tabId, before)
    return { done, shown, item: state.readLater[0]! }
  }

  it('offers to open the list beside "Annuler", which stays the first button', () => {
    const { done, shown, item } = saved()
    expect(shown).toHaveLength(1)
    const [message, offer] = shown[0]!
    expect(message).toBe(readLaterNotice('saved'))
    expect(offer?.label).toBe(t('menu.annuler'))
    expect(offer?.second?.label).toBe(t('read-later.ouvrir-la-liste'))
    offer!.second!.run()
    expect(done).toEqual([{ openOverlay: { panel: 'readlater' } }])
    done.length = 0
    offer!.run()
    expect(done[0]).toEqual({ type: 'readlater/remove', id: item.id })
  })

  it('offers the list alone when there is nothing to undo (the page was already in it)', () => {
    const { done, shown } = saved('https://exemple.fr/article', true)
    const [message, offer] = shown[0]!
    expect(message).toBe(readLaterNotice('already'))
    expect(offer?.label).toBe(t('read-later.ouvrir-la-liste'))
    expect(offer?.second).toBeUndefined()
    offer!.run()
    expect(done).toEqual([{ openOverlay: { panel: 'readlater' } }])
  })

  it('reaches the action of the button that was clicked, once, for the notice still on screen', () => {
    const ran: string[] = []
    const shell = { toast: { id: 7, run: () => void ran.push('first'), runSecond: () => void ran.push('second') }, dismissToast() { this.toast = null as never } }
    const run = (id: number, second?: boolean) => shellMethods['runToastAction']!.call(shell, id, second)
    run(6, true)
    expect(ran).toEqual([])
    run(7, true)
    expect(ran).toEqual(['second'])
    run(7, true)
    expect(ran).toEqual(['second'])
    shell.toast = { id: 8, run: () => void ran.push('first'), runSecond: () => void ran.push('second') }
    run(8)
    expect(ran).toEqual(['second', 'first'])
  })

  it('draws its second button in the sidebar, which asks the shell for the second action', () => {
    const state = createInitialState({ now: 1, newId: () => 'id' })
    const toast = { id: 4, message: readLaterNotice('saved'), durationMs: 8000, action: t('menu.annuler'), secondAction: t('read-later.ouvrir-la-liste') }
    const snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast, platform: 'darwin', private: false } as unknown as UiSnapshot
    let buttons: ReactElement<Record<string, unknown>>[] = []
    const Probe = (): null => {
      buttons = expanded(createElement(Sidebar, { snapshot, space: state.spaces[0]! })).filter((element) => element.type === 'button' && element.props['className'] === 'toast-action')
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    expect(renderToStaticMarkup(createElement(Sidebar, { snapshot, space: state.spaces[0]! }))).toMatch(/<div class="toast has-second"[\s\S]*?<button class="toast-action">Annuler<\/button><button class="toast-action">Ouvrir la liste<\/button>/)
    expect(buttons).toHaveLength(2)
    holder.asked.length = 0
    ;(buttons[1]!.props['onClick'] as () => void)()
    ;(buttons[0]!.props['onClick'] as () => void)()
    expect(holder.asked).toEqual([['toastAction', 4, true], ['toastAction', 4]])
  })
})

/** Every element a tree draws, the function components called and what they return walked too. */
function expanded(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(expanded)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  const type = element.type as unknown
  // A memo component is its function under `type`.
  const component = typeof type === 'object' && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for('react.memo') ? (type as { type: unknown }).type : type
  if (typeof component === 'function' && !(component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    return [element, ...expanded((component as (props: unknown) => ReactNode)(element.props))]
  }
  return [element, ...expanded(element.props['children'] as ReactNode)]
}
