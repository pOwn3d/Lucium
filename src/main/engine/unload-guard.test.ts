import { afterEach, describe, expect, it, vi } from 'vitest'

const showMessageBoxSync = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBoxSync: (...args: unknown[]) => showMessageBoxSync(...args) } }))

import type { BrowserWindow } from 'electron'
import { GRANT_WINDOW_MS, INTENT_WINDOW_MS, LeaveGate, askWithSheet, mayLeave, setLeaveAsker } from './unload-guard'
import { frenchSpaces } from '@shared/french-typography'

const window = (destroyed = false): BrowserWindow => ({ isDestroyed: () => destroyed }) as unknown as BrowserWindow

afterEach(() => {
  setLeaveAsker(null)
  showMessageBoxSync.mockReset()
})

describe('a page whose beforeunload handler asks to stay', () => {
  it('is asked of the user when the page is on screen, and leaves only when the user says "Quitter"', () => {
    const asked: string[] = []
    setLeaveAsker((_win, site) => (asked.push(site), false))
    expect(mayLeave({ win: window(), site: 'example.com' })).toBe(false)
    expect(asked).toEqual(['example.com'])
    setLeaveAsker(() => true)
    expect(mayLeave({ win: window(), site: 'example.com' })).toBe(true)
  })

  it('stays without a question when no one is looking: what a page out of sight guards is not lost; a window that is gone takes it', () => {
    const ask = vi.fn(() => true)
    setLeaveAsker(ask)
    expect(mayLeave({ win: null, site: 'example.com' })).toBe(false)
    expect(mayLeave({ win: window(true), site: 'example.com' })).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('puts the sheet back when the replacement is taken away', () => {
    setLeaveAsker(() => true)
    setLeaveAsker(null)
    showMessageBoxSync.mockReturnValue(1)
    expect(mayLeave({ win: window(), site: 'example.com' })).toBe(false)
    expect(showMessageBoxSync).toHaveBeenCalledTimes(1)
  })
})

describe('the sheet', () => {
  it('offers "Quitter" and "Rester", keeps the page on Return or Escape, and names the site', () => {
    showMessageBoxSync.mockReturnValue(1)
    expect(askWithSheet(window(), 'example.com')).toBe(false)
    const [, options] = showMessageBoxSync.mock.calls[0] as [unknown, { buttons: string[]; defaultId: number; cancelId: number; detail: string; message: string }]
    expect(options.buttons).toEqual(['Quitter', 'Rester'])
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
    expect(options.message).toBe(frenchSpaces('Quitter ce site ?'))
    expect(options.detail).toContain('example.com')
  })

  it('lets the page go only on the first button', () => {
    showMessageBoxSync.mockReturnValueOnce(0)
    expect(askWithSheet(window(), 'example.com')).toBe(true)
    showMessageBoxSync.mockReturnValueOnce(1)
    expect(askWithSheet(window(), 'example.com')).toBe(false)
  })
})

describe('the sheet of Lucium', () => {
  /** A gate on a page on screen, whose sheet is answered by hand; the clock is ours. */
  function gate(options: { shown?: boolean; withSheet?: boolean } = {}) {
    let now = 1000
    const answers: Array<(leave: boolean) => void> = []
    const asked: string[] = []
    const g = new LeaveGate({
      win: () => (options.shown === false ? null : window()),
      site: () => 'example.com',
      now: () => now,
      ...(options.withSheet === false ? {} : { ask: (site: string) => (asked.push(site), new Promise<boolean>((resolve) => answers.push(resolve))) })
    })
    const event = () => ({ prevented: false, preventDefault() { this.prevented = true } })
    return { g, answers, asked, event, tick: (ms: number) => (now += ms) }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('leaves the page where it is while the sheet is open, and starts the navigation again on "Quitter"', async () => {
    const { g, answers, asked, event } = gate()
    const redo = vi.fn()
    g.intend(redo)
    const first = event()
    g.onPrevent(first)
    // Not prevented: the page keeps the navigation; the question is asked once, whatever the page does meanwhile.
    expect(first.prevented).toBe(false)
    g.onPrevent(event())
    expect(asked).toEqual(['example.com'])
    answers[0]!(true)
    await settle()
    expect(redo).toHaveBeenCalledTimes(1)
    // The navigation started again meets the same handler: this one goes through.
    const second = event()
    g.onPrevent(second)
    expect(second.prevented).toBe(true)
  })

  it('does nothing on "Rester", and the next refusal is asked again', async () => {
    const { g, answers, asked, event } = gate()
    const redo = vi.fn()
    g.intend(redo)
    g.onPrevent(event())
    answers[0]!(false)
    await settle()
    expect(redo).not.toHaveBeenCalled()
    g.intend(redo)
    const again = event()
    g.onPrevent(again)
    expect(again.prevented).toBe(false)
    expect(asked).toHaveLength(2)
  })

  it('lets the page go when the question cannot be asked: a page never holds the user', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let now = 1000
    const redo = vi.fn()
    const g = new LeaveGate({ win: () => window(), site: () => 'example.com', now: () => now, ask: () => Promise.reject(new Error('no overlay')) })
    g.intend(redo)
    g.onPrevent({ preventDefault: () => undefined })
    await settle()
    expect(redo).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot ask whether to leave'), 'no overlay')
    error.mockRestore()
    expect(now).toBe(1000)
  })

  it('answers with the system box when the shell did not start the navigation (a link of the page), or started it too long ago', () => {
    const { g, asked, event, tick } = gate()
    setLeaveAsker(() => false)
    const link = event()
    g.onPrevent(link)
    expect(link.prevented).toBe(false)
    g.intend(vi.fn())
    tick(INTENT_WINDOW_MS + 1)
    g.onPrevent(event())
    expect(asked).toEqual([])
    // The user clicks in the page again (a link): the page may ask again, and this time the user lets it go.
    g.noteInput()
    setLeaveAsker(() => true)
    const leaves = event()
    g.onPrevent(leaves)
    expect(leaves.prevented).toBe(true)
  })

  // Guard: the navigation the shell started ends when a document commits. A page that reloads itself right after it was opened from the address bar
  // is asked with the system box, and its "Quitter" is not taken for the address bar's navigation, started again.
  it('gives a refusal that comes after the shell\'s navigation committed to the page itself: the system box, not the sheet', () => {
    const { g, asked, event } = gate()
    const boxes: string[] = []
    setLeaveAsker((_win, site) => (boxes.push(site), false))
    const redo = vi.fn()
    g.intend(redo)
    g.committed()
    const reload = event()
    g.onPrevent(reload)
    expect(asked).toEqual([])
    expect(boxes).toEqual(['example.com'])
    expect(reload.prevented).toBe(false)
    expect(redo).not.toHaveBeenCalled()
    // A navigation the shell starts after that one is its own again: the sheet.
    g.intend(vi.fn())
    g.onPrevent(event())
    expect(asked).toEqual(['example.com'])
  })

  it('does not bring the system box back for a page that navigates again by itself after "Rester": it waits for a click or a key in the page', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { g, event } = gate()
    const answers: boolean[] = []
    setLeaveAsker(() => (answers.push(false), false))
    // A link: the system box, the user stays.
    g.onPrevent(event())
    expect(answers).toHaveLength(1)
    // The page reloads itself from its own handler, again and again: no box, and the page stays where it is.
    for (let i = 0; i < 5; i++) {
      const again = event()
      g.onPrevent(again)
      expect(again.prevented).toBe(false)
    }
    expect(answers).toHaveLength(1)
    // Said once in the log for the whole series.
    expect(warn.mock.calls.filter(([line]) => String(line).startsWith('[unload]'))).toHaveLength(1)
    // A key or a click of the user in the page: its next refusal is asked again.
    g.noteInput()
    g.onPrevent(event())
    expect(answers).toHaveLength(2)
    warn.mockRestore()
  })

  it('still asks for a navigation the shell starts after "Rester" (the address bar, reload): that one is the user\'s', async () => {
    const { g, answers, asked, event } = gate()
    setLeaveAsker(() => false)
    g.onPrevent(event())
    g.intend(vi.fn())
    g.onPrevent(event())
    expect(asked).toEqual(['example.com'])
    answers[0]!(false)
    await settle()
  })

  it('asks again after "Quitter", and a page out of sight answers nothing that would hold its next question', () => {
    const asked: boolean[] = []
    let shown = true
    const g = new LeaveGate({ win: () => (shown ? window() : null), site: () => 'example.com' })
    const event = () => ({ prevented: false, preventDefault() { this.prevented = true } })
    setLeaveAsker(() => (asked.push(true), true))
    g.onPrevent(event())
    g.onPrevent(event())
    expect(asked).toHaveLength(2)
    // Behind: nobody is asked, the page stays; on screen again, it is asked as before.
    shown = false
    g.onPrevent(event())
    shown = true
    g.onPrevent(event())
    expect(asked).toHaveLength(3)
  })

  it('keeps a page nobody looks at where it is without a question, and forgets the grant after a while', async () => {
    const hidden = gate({ shown: false })
    hidden.g.intend(vi.fn())
    const behind = hidden.event()
    hidden.g.onPrevent(behind)
    expect(behind.prevented).toBe(false)
    expect(hidden.asked).toEqual([])

    const { g, answers, event, tick } = gate()
    g.intend(vi.fn())
    g.onPrevent(event())
    answers[0]!(true)
    await settle()
    tick(GRANT_WINDOW_MS + 1)
    setLeaveAsker(() => false)
    const late = event()
    g.onPrevent(late)
    expect(late.prevented).toBe(false)
  })
})
