// The page contrast (in the code: the readable mode) in the command bar: "Contraste de la page : sombre / clair / original pour ce site" and "…comme les autres sites", offered when typed, for a
// web page that is not private; each runs as the `readable/site` action of the reducer, from the tab on screen.

import { describe, expect, it } from 'vitest'
import { actionToDispatch, rankCandidates, type Candidate, type CommandAction } from './command-bar'
import type { ReadableMode } from './readable-mode'
import type { SidebarState } from './model'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { frenchSpaces } from './french-typography'

let n = 0
const ctx: Ctx = { now: 1000, newId: () => `id${++n}` }
const stateOn = (url: string, ...more: Action[]): SidebarState => [{ type: 'tab/open', url } as Action, ...more].reduce((s, a) => reduce(s, a, ctx), createInitialState(ctx))

const readable = (query: string, state: SidebarState, options: { private?: boolean } = {}) =>
  rankCandidates(query, state, [], [], [], options).filter((c): c is Candidate & { kind: 'action' } => c.kind === 'action' && c.action.startsWith('readable-'))

const ACTIONS: ReadonlyArray<readonly [CommandAction, string, ReadableMode | null]> = [
  ['readable-dark', frenchSpaces('Contraste de la page : sombre pour ce site'), 'dark'],
  ['readable-light', frenchSpaces('Contraste de la page : clair pour ce site'), 'light'],
  ['readable-original', frenchSpaces('Contraste de la page : original pour ce site'), 'original'],
  ['readable-default', frenchSpaces('Contraste de la page : comme les autres sites'), null]
]

describe('the readable mode in the command bar', () => {
  const web = stateOn('https://www.example.org/article')

  it('offers sombre, clair and original for the site on screen when "contraste" is typed, and only then', () => {
    expect(readable('contraste', web).map((c) => c.label)).toEqual([frenchSpaces('Contraste de la page : sombre pour ce site'), frenchSpaces('Contraste de la page : clair pour ce site'), frenchSpaces('Contraste de la page : original pour ce site')])
    expect(readable('sombre', web).map((c) => c.action)).toEqual(['readable-dark'])
    expect(readable('', web)).toEqual([])
    expect(readable('zzzz', web)).toEqual([])
  })

  it('is still found by its former name, "mode lisible", which no label writes any more', () => {
    for (const typed of ['mode lisible', 'lisible']) expect(readable(typed, web).map((c) => c.action), typed).toEqual(['readable-dark', 'readable-light', 'readable-original'])
    expect(readable('mode lisible', web).every((c) => !/lisible/i.test(c.label))).toBe(true)
  })

  it('offers to give the site back to the other sites only once it has a mode of its own', () => {
    expect(readable('autres sites', web)).toEqual([])
    const own = reduce(web, { type: 'readable/site', site: 'example.org', mode: 'dark' }, ctx)
    expect(readable('autres sites', own).map((c) => c.action)).toEqual(['readable-default'])
    // A mode of the parent domain is the site's own mode too: the page follows it.
    const parent = stateOn('https://blog.example.org/', { type: 'readable/site', site: 'example.org', mode: 'light' })
    expect(readable('autres sites', parent).map((c) => c.action)).toEqual(['readable-default'])
  })

  it('is not offered for what is not a web page, nor without a tab', () => {
    for (const url of ['about:blank', 'file:///tmp/a.html', 'view-source:https://example.org/', 'chrome-extension://abc/page.html']) for (const typed of ['contraste', 'mode lisible']) expect(readable(typed, stateOn(url)), url).toEqual([])
    expect(readable('contraste', createInitialState(ctx))).toEqual([])
  })

  it('is not offered for a private tab, nor in a private window: their sites are not written to the settings', () => {
    const priv = stateOn('https://example.org/', { type: 'tab/open', url: 'https://secret.example/', private: true })
    expect(priv.tabs.at(-1)?.private).toBe(true)
    for (const typed of ['contraste', 'mode lisible']) {
      expect(readable(typed, priv), typed).toEqual([])
      expect(readable(typed, web, { private: true }), typed).toEqual([])
    }
  })

  it('dispatches the right action for each command, from the tab on screen', () => {
    const tabId = web.tabs[0]!.id
    for (const [command, , mode] of ACTIONS) {
      expect(actionToDispatch(command, web), command).toEqual({ type: 'readable/site', site: 'https://www.example.org/article', mode, tabId })
    }
  })

  it('does nothing for a page that is no web page or a private tab, even when the command is forced', () => {
    const priv = stateOn('https://secret.example/', { type: 'tab/open', url: 'https://secret.example/', private: true })
    for (const [command] of ACTIONS) {
      expect(actionToDispatch(command, stateOn('about:blank')), command).toBeNull()
      expect(actionToDispatch(command, priv), command).toBeNull()
      expect(actionToDispatch(command, createInitialState(ctx)), command).toBeNull()
    }
  })

  it('names and runs each command the same way: what the label says is the mode the action sets', () => {
    for (const [command, label, mode] of ACTIONS) {
      const own = reduce(web, { type: 'readable/site', site: 'example.org', mode: 'dark' }, ctx)
      const found = readable(label, own).find((c) => c.action === command)
      expect(found?.label, command).toBe(label)
      const after = reduce(own, actionToDispatch(command, own)!, ctx)
      expect(after.settings.siteReadableMode, command).toEqual(mode === null ? {} : { 'example.org': mode })
    }
  })
})
