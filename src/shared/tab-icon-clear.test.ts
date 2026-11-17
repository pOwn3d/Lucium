// A page whose declared icon is refused tells an empty icon: the tab drops the icon of the page before instead of showing it over another site.

import { describe, expect, it } from 'vitest'
import { createInitialState, reduce, type Ctx } from './sidebar'

const ctx: Ctx = { now: 1_000_000, newId: (() => { let n = 0; return () => `id${++n}` })() }

function tabWithIcon() {
  const opened = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)
  const id = opened.tabs[0]!.id
  return { id, state: reduce(opened, { type: 'tab/update', id, patch: { faviconUrl: 'https://a.example/favicon.ico' } }, ctx) }
}

describe('the icon of a tab', () => {
  it('goes when the page tells an empty one, and the field with it', () => {
    const { id, state } = tabWithIcon()
    expect(state.tabs[0]!.faviconUrl).toBe('https://a.example/favicon.ico')
    const cleared = reduce(state, { type: 'tab/update', id, patch: { url: 'https://b.example/', faviconUrl: '' } }, ctx)
    expect(cleared.tabs[0]!.url).toBe('https://b.example/')
    expect('faviconUrl' in cleared.tabs[0]!).toBe(false)
  })

  it('stays when the patch says nothing of it, or something that is not an icon', () => {
    const { id, state } = tabWithIcon()
    expect(reduce(state, { type: 'tab/update', id, patch: { title: 'A' } }, ctx).tabs[0]!.faviconUrl).toBe('https://a.example/favicon.ico')
    expect(reduce(state, { type: 'tab/update', id, patch: { faviconUrl: 'file:///tmp/x.png' } }, ctx).tabs[0]!.faviconUrl).toBe('https://a.example/favicon.ico')
    expect(reduce(state, { type: 'tab/update', id, patch: { faviconUrl: undefined } }, ctx).tabs[0]!.faviconUrl).toBe('https://a.example/favicon.ico')
  })

  it('is no new state when a tab without an icon is told an empty one', () => {
    const opened = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)
    expect(reduce(opened, { type: 'tab/update', id: opened.tabs[0]!.id, patch: { faviconUrl: '' } }, ctx)).toBe(opened)
  })
})
