import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { Channel } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { commandFailed, noteFailure } from './failure-notice'
import { fakeBrowser } from './browser-fake.test-support'
import { ipcHost, sendFrom } from './ipc-fake.test-support'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
const { registerIpc } = await import('./ipc')
const { menuItems } = await import('./context-menus')
const { buildMenu } = await import('./menu')

afterEach(() => vi.restoreAllMocks())

describe('noteFailure', () => {
  it('writes the cause to the journal with its context and tells the user something did not work', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const toast = vi.fn()
    const cause = new Error('boom')
    noteFailure('[menu] page watch failed:', cause, toast)
    expect(error).toHaveBeenCalledWith('[menu] page watch failed:', cause)
    expect(toast).toHaveBeenCalledWith(commandFailed())
    expect(commandFailed()).toBe('La commande n’a pas pu être exécutée. Le détail est dans le journal.')
  })

  it('says it in the language of the moment, not in the one the module was loaded in', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const toast = vi.fn()
    try {
      setLanguage('en')
      noteFailure('[menu] page watch failed:', new Error('boom'), toast)
    } finally {
      setLanguage('fr')
    }
    expect(toast).toHaveBeenCalledWith('The command couldn’t be run. The details are in the log.')
  })

  it('says what a command chose to say', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const toast = vi.fn()
    noteFailure('[reload-all] cannot reload the tabs:', new Error('x'), toast, 'Les onglets n’ont pas pu être actualisés.')
    expect(toast).toHaveBeenCalledWith('Les onglets n’ont pas pu être actualisés.')
  })
})

// The commands that used to leave the journal alone must keep telling the user. They run here against an Electron that keeps what is
// registered (ipc-fake.test-support.ts): the IPC of a window, the context menu of a tab and the application menu, each made to fail.
describe('the commands that tell the user when they fail', () => {
  const cause = new Error('boom')
  const state = createInitialState({ now: 0, newId: () => 'x' })
  const withTab = { ...state, tabs: [{ id: 't1', spaceId: state.spaces[0]!.id, url: 'https://a.example/', title: 'A', pinned: false, createdAt: 0, lastActiveAt: 0 }] }
  const storeOf = (s: typeof state) => ({ get: () => s, subscribe: () => () => {} }) as never
  const browserWith = (own: Record<string, unknown>) => new Proxy(own, { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }) as never
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('ipc.ts: [reload-all] cannot reload the tabs: goes through noteFailure, not to the journal alone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const showToast = vi.fn()
    registerIpc(fakeBrowser({ reloadAllTabs: () => Promise.reject(cause), showToast }).self as never, storeOf(state), {} as never, new Set([1]))
    sendFrom(1, Channel.reloadAllTabs)
    await settle()
    expect(error).toHaveBeenCalledWith('[reload-all] cannot reload the tabs:', cause)
    expect(showToast).toHaveBeenCalledWith(t('ipc.les-onglets-n-ont-pas-pu-etre-actualises'))
  })

  it('context-menus.ts: [menu] cannot write to the clipboard: goes through noteFailure, not to the journal alone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const showToast = vi.fn()
    const browser = browserWith({ showToast, snapshot: () => ({ runtime: { tabs: {} } }), livePageIds: () => [], windowMoveChoices: () => [], copyable: (url: string) => url })
    const items = leaves(menuItems({ kind: 'tab', id: 't1' }, browser, storeOf(withTab), {} as never, { headers: false }) as MenuItem[])
    ipcHost.clipboardFails = true
    items.find((item) => item.label === t('ctx.copier-le-lien'))!.click!()
    await settle()
    ipcHost.clipboardFails = false
    expect(error).toHaveBeenCalledWith('[menu] cannot write to the clipboard:', expect.any(Error))
    expect(showToast).toHaveBeenCalledWith(t('ctx.impossible-de-copier-dans-le-presse-papiers'))
  })

  it('menu.ts: [menu] ${what} failed: goes through noteFailure, not to the journal alone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const showToast = vi.fn()
    const browser = browserWith({ showToast, exportMarkdown: () => Promise.reject(cause), menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) })
    const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
    const items = leaves(buildMenu(browser, storeOf(withTab), actions as never) as unknown as MenuItem[])
    items.find((item) => item.label === t('menu.exporter-la-page-en-markdown'))!.click!()
    await settle()
    expect(error).toHaveBeenCalledWith('[menu] Markdown export failed:', cause)
    expect(showToast).toHaveBeenCalledWith(commandFailed())
  })

  it('menu.ts (save as Markdown): [menu] ${what} failed: goes through noteFailure, not to the journal alone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const showToast = vi.fn()
    const browser = browserWith({ showToast, saveMarkdownPage: () => Promise.reject(cause), menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) })
    const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
    const items = leaves(buildMenu(browser, storeOf(withTab), actions as never) as unknown as MenuItem[])
    items.find((item) => item.label === t('menu.enregistrer-la-page-en-markdown'))!.click!()
    await settle()
    expect(error).toHaveBeenCalledWith('[menu] Markdown save failed:', cause)
    expect(showToast).toHaveBeenCalledWith(commandFailed())
  })
})

interface MenuItem {
  label?: string
  click?: () => void
  submenu?: MenuItem[]
}
const leaves = (items: MenuItem[]): MenuItem[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu) : [item]))
