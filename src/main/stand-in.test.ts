import { describe, expect, it } from 'vitest'
import { nothing, standIn } from './stand-in.test-support'

describe('a stand-in that says what it was not given', () => {
  it('answers the members it was given, with `this` still the stand-in', () => {
    const shell = standIn('shell', {
      count: 2,
      double(this: { count: number }) {
        return this.count * 2
      }
    })
    expect(shell.count).toBe(2)
    expect(shell.double()).toBe(4)
    shell.count = 5
    expect(shell.double()).toBe(10)
  })

  it('throws on any other member, read or called, and names it', () => {
    const shell = standIn('shell', { openOverlay: () => undefined }) as unknown as { closeOverlay(): void; overlayRequest: unknown }
    expect(() => shell.closeOverlay()).toThrow('shell.closeOverlay is not given to this stand-in')
    expect(() => shell.overlayRequest).toThrow('shell.overlayRequest is not given to this stand-in')
  })

  it('can be awaited, compared and printed without a member of its own being meant', async () => {
    const shell = standIn('shell', { id: 1 })
    await expect(Promise.resolve(shell)).resolves.toBe(shell)
    expect(shell).toEqual({ id: 1 })
    expect(JSON.stringify(shell)).toBe('{"id":1}')
    expect(String(Object.keys(shell))).toBe('id')
  })

  it('takes by name what a test does not look at: every member, call and loop of it does nothing', () => {
    const shell = standIn('shell', { win: nothing as { webContents: { send(...args: unknown[]): void }; views: Iterable<unknown> } })
    expect(() => shell.win.webContents.send('channel', 1)).not.toThrow()
    expect([...shell.win.views]).toEqual([])
  })
})
