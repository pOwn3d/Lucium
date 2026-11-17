// Test support (nothing of the application imports it): what `Browser.sync` needs of a window to run on a stand-in (browser-fake.test-support.ts): the real
// state of the sidebar with a few tabs, the table of the pages, the sets and maps `sync` reads, and `ensurePage` made by the test. Everything else `sync` calls
// (the layout, the publication, the engine…) is a recorder: `calls` says which of them were called, in order.

import { activeTab, createInitialState, reduce } from '@shared/sidebar'
import type { SidebarState, TabItem } from '@shared/model'
import { fakeBrowser, type FakeBrowser } from './browser-fake.test-support'

export interface SyncHost {
  readonly fake: FakeBrowser
  /** The pages `sync` finds for each tab: a test puts one in, or `ensurePage` does. */
  readonly pages: Map<string, object>
  state(): SidebarState
  /** The tab on show, as the state says. */
  active(): TabItem | undefined
}

/**
 * A window whose state holds one tab for each address, the last one on show. `ensurePage` makes the page of a tab (it is called by `sync` for every tab on
 * screen); `over` replaces or adds a member of the stand-in.
 */
export function syncHost(addresses: string[], ensurePage: (tab: TabItem, pages: Map<string, object>) => void = () => undefined, over: Record<string, unknown> = {}): SyncHost {
  const ctx = {
    now: 1,
    newId: (() => {
      let next = 0
      return () => `t${++next}`
    })()
  }
  let state = createInitialState(ctx)
  for (const url of addresses) state = reduce(state, { type: 'tab/open', url }, ctx)
  const pages = new Map<string, object>()
  const shown = activeTab(state)
  const fake = fakeBrowser({
    store: { get: () => state },
    pages,
    runtime: { tabs: {} },
    visible: new Set(shown ? [shown.id] : []),
    shownTabId: shown?.id ?? null,
    visibleIds: () => (shown ? [shown.id] : []),
    ensurePage: (tab: TabItem) => ensurePage(tab, pages),
    isPrivate: () => false,
    isSecondary: () => true,
    creating: new Set(),
    frozen: new Set(),
    group: new Set(),
    summaryTabs: new Set(),
    iconBase: new Map(),
    usedAt: new Map(),
    committed: new Set(),
    overlayRequest: null,
    ...over
  })
  return { fake, pages, state: () => state, active: () => activeTab(state) }
}
