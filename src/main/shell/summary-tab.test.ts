// The answer of the summary is written only into the summary tab while it still shows the blank page: a tab the user has navigated is left as it is.
// The real method of the Browser that opens the summary tab runs on a stand-in for the window, over the real state of the sidebar.

import { describe, expect, it, vi } from 'vitest'
import { activeTab, createInitialState, reduce, type Action } from '@shared/sidebar'

// browser.ts reaches Electron only when a method runs; the import itself needs the names.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))

const { Browser } = await import('./browser')
const methods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>
const openSummaryTab = methods['openSummaryTab']!

/** A promise the test settles when the model "answers". */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

/** Lets what is waiting on already settled promises run (no timer). */
const settle = () => new Promise<void>((done) => setImmediate(done))

/** A window with a page on screen, and a summary of it that is asked for; the answer comes when the test says. */
function summaryAsked(privateSource = false) {
  let next = 0
  const ctx = { now: 1, newId: () => `id-${++next}` }
  let state = createInitialState(ctx)
  const dispatch = (action: Action) => void (state = reduce(state, action, ctx))
  if (privateSource) dispatch({ type: 'settings/update', patch: { privateTabs: true } })
  dispatch({ type: 'tab/open', url: 'https://source.example/page', ...(privateSource ? { private: true } : {}) })
  const scripts: string[] = []
  const page = { runScript: vi.fn(async (script: string) => void scripts.push(script)) }
  const answer = deferred<unknown>()
  const self = {
    store: { get: () => state },
    dispatch,
    // One page on screen: the pane the user is in is the selected tab (shell/split-pane-focus.test.ts for a split view).
    followPaneFocus: () => undefined,
    openedBy: (_origin: string, open: () => void) => open(),
    summaryTabs: new Set<string>(),
    pages: { get: () => page },
    whenPage: methods['whenPage'],
    showToast: vi.fn(),
    summarizeTab: () => answer.promise
  }
  openSummaryTab.call(self, 'normal')
  const summaryTab = activeTab(state)!
  return { dispatch, scripts, answer, summaryTab, self }
}

describe('the summary tab', () => {
  it('is a private tab when the page it sums up is in one: nothing of that page goes to a tab that is kept', () => {
    const asked = summaryAsked(true)
    expect(asked.summaryTab.url).toBe('about:blank')
    expect(asked.summaryTab.private).toBe(true)
  })

  it('is an ordinary tab for an ordinary page', () => {
    expect(summaryAsked().summaryTab.private).toBeUndefined()
  })
  it('opens on the blank page, and shows "in progress" at once', async () => {
    const asked = summaryAsked()
    await settle()
    expect(asked.summaryTab.url).toBe('about:blank')
    expect(asked.self.summaryTabs.has(asked.summaryTab.id)).toBe(true)
    expect(asked.scripts).toHaveLength(1)
  })

  it('writes the summary when it comes, while its tab still shows the blank summary page', async () => {
    const asked = summaryAsked()
    await settle()
    asked.answer.resolve({ ok: true, summary: 'Le résumé du modèle', model: 'mistral', duration: 12 })
    await settle()
    expect(asked.scripts).toHaveLength(2)
    expect(asked.scripts[1]).toContain('Le résumé du modèle')
  })

  const ANSWERS: Array<[name: string, reply: unknown, text: string]> = [
    ['a summary', { ok: true, summary: 'Le résumé du modèle', model: 'mistral', duration: 12 }, 'Le résumé du modèle'],
    ['an error', { ok: false, error: 'Le modèle ne répond pas' }, 'Le modèle ne répond pas']
  ]

  it.each(ANSWERS)('writes nothing over a tab the user has navigated meanwhile (%s)', async (_name, reply, text) => {
    const asked = summaryAsked()
    await settle()
    asked.dispatch({ type: 'tab/update', id: asked.summaryTab.id, patch: { url: 'https://elsewhere.example/' } })
    asked.answer.resolve(reply)
    await settle()
    // Only the "in progress" page was written, before the user left: the answer reached nothing.
    expect(asked.scripts).toHaveLength(1)
    expect(asked.scripts.some((script) => script.includes(text))).toBe(false)
  })
})
