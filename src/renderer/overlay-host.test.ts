// @vitest-environment happy-dom
// The layer of the panels, mounted in a document and told what the main process tells it: a panel to show, then that it is closed. What is
// checked is what only a mounted tree shows: a closed panel is unmounted (what it was waiting to do is done at once, nothing of it stays in the
// document), the late closing of the site popover does not close the panel that took its place, a panel that fails to draw closes the layer, a
// panel that is writing keeps the layer, and the popovers at the side keep a focus like the other panels.

import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SITE_POPOVER_MOTION } from '@shared/command-bar'
import { t } from '@shared/i18n'
import type { LuciumApi, OverlayRequest, UiSnapshot } from '@shared/ipc'
import type { Note } from '@shared/notes'
import { createInitialState } from '@shared/sidebar'
import { OverlayHost, PanelBoundary } from './OverlayHost'
import { holdOverlay } from './overlay-hold'
import { button, click, installBridge, mount, settle, type Mounted } from './dom.test-support'

let mounted: Mounted | null = null
let show: (request: OverlayRequest | null) => void = () => undefined
let closeOverlay: ReturnType<typeof vi.fn<() => void>>

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** The bridge to the main process: `own` is what the test answers, and the layer's own subscription hands the test the way to show a panel. */
function bridge(own: Partial<LuciumApi> = {}): void {
  closeOverlay = vi.fn<() => void>()
  installBridge({
    closeOverlay,
    onShowOverlay: (listener: (request: OverlayRequest | null) => void) => {
      show = listener
      return () => undefined
    },
    ...own
  })
}

function host(own: Partial<LuciumApi> = {}): HTMLElement {
  bridge(own)
  mounted = mount(createElement(OverlayHost))
  return mounted.container
}

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('a panel the main process closed', () => {
  const PAGE = 'https://a.example/'

  it('is unmounted at once: a page that was waiting to be forgotten is forgotten, and nothing of the panel stays in the document', async () => {
    const snapshot = { state: createInitialState({ now: 0, newId: () => 'x' }) } as unknown as UiSnapshot
    const forgetHistory = vi.fn(async (_url: string, _profileId?: string) => undefined)
    const container = host({
      getSnapshot: async () => snapshot,
      searchHistory: async () => [{ url: PAGE, title: 'A', visitCount: 1, lastVisitAt: Date.now() }],
      forgetHistory
    })
    await settle(() => show({ panel: 'history' }))
    // The panel asks for its pages a moment after it opens.
    await settle(() => wait(200))
    await click(button(container, t('manage-panels.oublier')))
    // The eight seconds to take it back have only started.
    expect(forgetHistory).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()

    await settle(() => show(null))
    expect(forgetHistory).toHaveBeenCalledTimes(1)
    expect(forgetHistory.mock.calls[0]![0]).toBe(PAGE)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.innerHTML).toBe('')
  })
})

describe('the site popover, which folds back before it closes', () => {
  const escape = (): Promise<void> => settle(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))

  it('closes the layer once its fold is over', async () => {
    host()
    await settle(() => show({ panel: 'site' }))
    await escape()
    expect(closeOverlay).not.toHaveBeenCalled()
    await settle(() => wait(SITE_POPOVER_MOTION.closeMs + 80))
    expect(closeOverlay).toHaveBeenCalledTimes(1)
  })

  it('does not close the panel that opened while it was folding', async () => {
    host()
    await settle(() => show({ panel: 'site' }))
    await escape()
    await settle(() => show({ panel: 'windowname' }))
    await settle(() => wait(SITE_POPOVER_MOTION.closeMs + 80))
    expect(closeOverlay).not.toHaveBeenCalled()
  })
})

describe('a panel that fails to draw', () => {
  it('is logged with its name, and the layer is closed (an empty layer has no way out, and the question it carried would wait for good)', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bridge()
    const Broken = (): never => {
      throw new Error('cannot draw')
    }
    mounted = mount(createElement(PanelBoundary, { panel: 'permission', children: createElement(Broken) }))
    expect(logged).toHaveBeenCalledWith('[overlay] the permission panel failed to draw:', 'cannot draw')
    expect(closeOverlay).toHaveBeenCalledTimes(1)
    expect(mounted.container.innerHTML).toBe('')
  })
})

describe('a panel that is writing something that cannot be stopped', () => {
  it('keeps the layer: neither a click outside nor Escape closes it, until the panel lets go', async () => {
    const container = host()
    await settle(() => show({ panel: 'import' }))
    const backdrop = container.querySelector('.backdrop')!
    const clickOutside = (): void => act(() => void backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    const pressEscape = (): void => act(() => void backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    const release = holdOverlay()
    clickOutside()
    pressEscape()
    expect(closeOverlay).not.toHaveBeenCalled()

    release()
    clickOutside()
    expect(closeOverlay).toHaveBeenCalledTimes(1)
    pressEscape()
    expect(closeOverlay).toHaveBeenCalledTimes(2)
  })
})

describe('the popovers at the side (the site, the downloads)', () => {
  it('take the focus again when what had it goes away, like the other panels', async () => {
    const container = host()
    await settle(() => show({ panel: 'downloads' }))
    const backdrop = container.querySelector('.backdrop')!
    const panel = backdrop.querySelector<HTMLElement>('[role="dialog"]')!
    expect(panel).not.toBeNull()
    act(() => (document.activeElement as HTMLElement | null)?.blur())
    expect(backdrop.contains(document.activeElement)).toBe(false)
    // Something changes in the panel while nothing has the focus (a row removed takes the focus with it).
    await settle(async () => {
      backdrop.append(document.createElement('span'))
      await wait(20)
    })
    expect(backdrop.contains(document.activeElement)).toBe(true)
  })

  it('are drawn in their place from the first frame, with the state the layer was sent just before the request', async () => {
    // A window whose sidebar is at the right: the downloads popover hangs inside the sidebar, 8 px from its left edge, not at the window's left.
    const initial = createInitialState({ now: 0, newId: ((n = 0) => () => `id${++n}`)() })
    const state = { ...initial, settings: { ...initial.settings, sidebarRight: true, sidebarVisible: true, sidebarWidth: 323 } }
    const listeners = new Set<(snapshot: UiSnapshot) => void>()
    const container = host({
      // The panel's own read of the state comes back late when the main process is busy: here it never does.
      getSnapshot: () => new Promise<UiSnapshot>(() => undefined),
      onSnapshot: (listener: (snapshot: UiSnapshot) => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      }
    })
    // What the main process does when a panel opens on a closed layer (browser-overlay.ts): the state the layer missed, then the request.
    act(() => listeners.forEach((listener) => listener({ state, runtime: { tabs: {} }, downloads: [] } as unknown as UiSnapshot)))
    await settle(() => show({ panel: 'downloads' }))
    const backdrop = container.querySelector<HTMLElement>('.backdrop.popover-left')!
    expect(backdrop.style.getPropertyValue('--sb-left')).toBe(`${window.innerWidth - 323}px`)
  })
})

describe('the notes panel, asked with or without a scope', () => {
  const PAGE = 'https://a.example/'
  const notes: Note[] = [
    { id: 'p', text: 'Sur la page', createdAt: 1, updatedAt: 3, link: { kind: 'page', url: PAGE } },
    { id: 'o', text: 'Autre page', createdAt: 1, updatedAt: 1, link: { kind: 'page', url: 'https://b.example/' } }
  ]
  const checked = (container: HTMLElement): string | undefined => container.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? undefined

  /** The layer, the page on screen having a note of its own. */
  function onPage(): HTMLElement {
    const initial = createInitialState({ now: 0, newId: () => 'sp' })
    const tab = { id: 't1', spaceId: 'sp', url: PAGE, title: 'A', pinned: false, createdAt: 1, lastActiveAt: 1 }
    const snapshot = { state: { ...initial, tabs: [tab], activeTabBySpace: { sp: 't1' } }, runtime: { tabs: {} }, extensions: [], downloads: [], platform: 'darwin' } as unknown as UiSnapshot
    return host({ getSnapshot: async () => snapshot, notes: async () => ({ ok: true, notes }) })
  }

  it('opens on « Cette page » for the request of File › Notes, and on « Toutes » for the toolbar’s « Toutes les notes » (the scope reaches the panel)', async () => {
    const container = onPage()
    await settle(() => show({ panel: 'notes' }))
    expect(checked(container)).toBe(t('notes.cette-page'))
    await settle(() => show({ panel: 'notes', scope: 'all' }))
    expect(checked(container)).toBe(t('notes.toutes'))
  })
})
