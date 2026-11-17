import { describe, expect, it, vi } from 'vitest'
import { SwitchedPreload, type PreloadScriptRegistration, type PreloadTarget } from './switched-preload'

/** A session as far as preload scripts go: what is registered, in order, with the failures a test asks for. */
class FakeSession implements PreloadTarget {
  scripts: PreloadScriptRegistration[] = []
  registerFails = false
  unregisterFails = false
  registerPreloadScript(script: PreloadScriptRegistration): string {
    if (this.registerFails) throw new Error('register refused')
    if (this.scripts.some((s) => s.id === script.id)) throw new Error(`duplicate ${script.id}`)
    this.scripts.push(script)
    return script.id
  }
  unregisterPreloadScript(id: string): void {
    if (this.unregisterFails) throw new Error('unregister refused')
    this.scripts = this.scripts.filter((s) => s.id !== id)
  }
}

const script = { id: 'bridge', type: 'frame' as const, path: () => '/app/bridge.js' }

describe('a preload script that follows a switch', () => {
  it('puts the script in a session when a page is made in it, once, while the switch is on', () => {
    const preload = new SwitchedPreload<FakeSession>(script, true)
    const ses = new FakeSession()
    preload.ensure(ses)
    preload.ensure(ses)
    expect(ses.scripts).toEqual([{ id: 'bridge', type: 'frame', filePath: '/app/bridge.js' }])
    expect(preload.has(ses)).toBe(true)
  })

  it('adds the documents it must stay out of to the registration, and no `excludeMatches` key at all when it has none', () => {
    const scoped = new SwitchedPreload<FakeSession>({ ...script, excludeMatches: ['https://accounts.google.com/*'] }, true)
    const ses = new FakeSession()
    scoped.ensure(ses)
    expect(ses.scripts).toEqual([{ id: 'bridge', type: 'frame', filePath: '/app/bridge.js', excludeMatches: ['https://accounts.google.com/*'] }])
    const plain = new FakeSession()
    new SwitchedPreload<FakeSession>(script, true).ensure(plain)
    expect(Object.keys(plain.scripts[0]!)).toEqual(['id', 'type', 'filePath'])
  })

  it('puts nothing in any session while the switch is off', () => {
    const path = vi.fn(() => '/app/bridge.js')
    const preload = new SwitchedPreload<FakeSession>({ ...script, path }, false)
    const ses = new FakeSession()
    preload.ensure(ses)
    expect(ses.scripts).toEqual([])
    expect(preload.has(ses)).toBe(false)
    // The file's place is not even worked out.
    expect(path).not.toHaveBeenCalled()
  })

  it('takes the script out of every session when the switch goes off, and puts it back where pages are made when it comes on', () => {
    const preload = new SwitchedPreload<FakeSession>(script, true)
    const [a, b] = [new FakeSession(), new FakeSession()]
    preload.ensure(a)
    preload.ensure(b)
    preload.set(false, [a, b])
    expect(a.scripts).toEqual([])
    expect(b.scripts).toEqual([])
    expect(preload.enabled).toBe(false)
    // A page made while it is off adds nothing.
    preload.ensure(a)
    expect(a.scripts).toEqual([])
    // On again: the live sessions get it back, and a session born later gets it with its first page.
    preload.set(true, [a, b])
    expect(a.scripts).toHaveLength(1)
    expect(b.scripts).toHaveLength(1)
    const c = new FakeSession()
    preload.ensure(c)
    expect(c.scripts).toHaveLength(1)
  })

  it('does nothing when told what it already is', () => {
    const preload = new SwitchedPreload<FakeSession>(script, true)
    const ses = new FakeSession()
    preload.ensure(ses)
    const register = vi.spyOn(ses, 'registerPreloadScript')
    const unregister = vi.spyOn(ses, 'unregisterPreloadScript')
    preload.set(true, [ses])
    expect(register).not.toHaveBeenCalled()
    expect(unregister).not.toHaveBeenCalled()
  })

  it('reports a session that will not let the script go, keeps it as carrying it, and goes on with the others', () => {
    const report = vi.fn()
    const preload = new SwitchedPreload<FakeSession>(script, true, report)
    const [stuck, fine] = [new FakeSession(), new FakeSession()]
    preload.ensure(stuck)
    preload.ensure(fine)
    stuck.unregisterFails = true
    preload.set(false, [stuck, fine])
    expect(report).toHaveBeenCalledTimes(1)
    expect(String(report.mock.calls[0]![0])).toContain('bridge')
    expect(fine.scripts).toEqual([])
    // It really is still there: switching on again must not register it twice.
    expect(preload.has(stuck)).toBe(true)
    stuck.unregisterFails = false
    preload.set(true, [stuck, fine])
    expect(stuck.scripts).toHaveLength(1)
    expect(fine.scripts).toHaveLength(1)
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('reports a session that will not take the script when it is switched on, and goes on with the others', () => {
    const report = vi.fn()
    const preload = new SwitchedPreload<FakeSession>(script, false, report)
    const [refusing, fine] = [new FakeSession(), new FakeSession()]
    refusing.registerFails = true
    preload.set(true, [refusing, fine])
    expect(report).toHaveBeenCalledTimes(1)
    expect(preload.has(refusing)).toBe(false)
    expect(fine.scripts).toHaveLength(1)
  })
})
