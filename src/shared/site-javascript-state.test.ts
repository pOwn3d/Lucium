// The JavaScript switch of a site, through the reducer: what the list keeps, what a private window does, what a forged action does.

import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { privateAction } from './private-window'
import { createInitialState, reduce, type Action } from './sidebar'
import { clampSettings } from './sidebar-state'

let counter = 0
const ctx = { now: 1, newId: () => `id${++counter}` }
const run = (state: ReturnType<typeof createInitialState>, action: Action) => reduce(state, action, ctx)

describe('the JavaScript list of the state', () => {
  it('is empty by default', () => {
    expect(defaultSettings().siteJavascriptOff).toEqual([])
  })

  it('adds and takes out the site of a page, and changes nothing for what is not a web site', () => {
    const start = createInitialState(ctx)
    const off = run(start, { type: 'javascript/site', site: 'https://shop.example/panier', off: true })
    expect(off.settings.siteJavascriptOff).toEqual(['shop.example'])
    expect(run(off, { type: 'javascript/site', site: 'shop.example', off: true })).toBe(off)
    expect(run(off, { type: 'javascript/site', site: 'shop.example', off: false }).settings.siteJavascriptOff).toEqual([])
    expect(run(start, { type: 'javascript/site', site: 'lucium://settings', off: true })).toBe(start)
    expect(run(start, { type: 'javascript/site', site: 'shop.example', off: false })).toBe(start)
  })

  it('treats anything but a real true as "on again" (the interface is not trusted)', () => {
    const off = run(createInitialState(ctx), { type: 'javascript/site', site: 'shop.example', off: true })
    const forged = { type: 'javascript/site', site: 'autre.example', off: 'yes' } as unknown as Action
    expect(run(off, forged)).toBe(off)
  })

  it('writes nothing for a private tab', () => {
    const start = createInitialState(ctx)
    const tab = { ...start.tabs[0]!, id: 'private-tab', private: true }
    const withPrivate = { ...start, tabs: [...start.tabs, tab] }
    expect(run(withPrivate, { type: 'javascript/site', site: 'shop.example', off: true, tabId: 'private-tab' })).toBe(withPrivate)
  })

  it('is let through by a private window, whose store lives as long as the window', () => {
    const action: Action = { type: 'javascript/site', site: 'shop.example', off: true }
    expect(privateAction(action)).toEqual(action)
  })

  it('reads a saved file with only valid hosts, once each', () => {
    const settings = clampSettings({ ...defaultSettings(), siteJavascriptOff: ['Shop.EXAMPLE', 'https://pas-un-hote.example/x', 42, null, 'shop.example', 'a b'] } as never)
    expect(settings.siteJavascriptOff).toEqual(['shop.example'])
    expect(clampSettings({ ...defaultSettings(), siteJavascriptOff: 'shop.example' } as never).siteJavascriptOff).toEqual([])
  })
})
