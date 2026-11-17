// @vitest-environment happy-dom
// The time of a notice with an action, as the components draw it (notice-hold.ts): eight seconds, and nothing runs while the pointer or the focus is on
// the notice. The rule itself (the clock, the two holds) is tested in shared/toast.test.ts; here, what the bindings do with it.

import { act, createElement, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { ListPanel, useUndoQueue } from './templates'
import { click, mount, pointerOut, pointerOver, type Mounted } from './dom.test-support'
import { useActionNotice, useNoticeHold } from './notice-hold'

let mounted: Mounted | null = null

beforeEach(() => {
  setLanguage('fr')
  vi.useFakeTimers()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
  document.body.replaceChildren()
})

const advance = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))
const bubble = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-notice]')

/** A component that owns a notice: `show` puts one on (a new object each time), the notice is its own element with its two buttons. */
let show: (text: string) => void = () => undefined
let expired = vi.fn()
function Owner() {
  const [notice, setNotice] = useState<{ text: string } | null>(null)
  show = (text) => setNotice({ text })
  const timing = useActionNotice(notice, () => {
    expired()
    setNotice(null)
  })
  return createElement(
    'div',
    null,
    notice ? createElement('div', { 'data-notice': '', role: 'status', ...timing.props }, notice.text, createElement('button', { id: 'one' }, 'Annuler'), createElement('button', { id: 'two' }, 'Autre')) : null,
    createElement('button', { id: 'outside' }, 'Dehors')
  )
}
const draw = (): void => {
  expired = vi.fn()
  mounted = mount(createElement(Owner))
}

describe('the notice a component owns', () => {
  it('goes after ACTION_NOTICE_MS, and not before', () => {
    draw()
    act(() => show('Fait'))
    advance(ACTION_NOTICE_MS - 1)
    expect(bubble()).not.toBeNull()
    advance(1)
    expect(bubble()).toBeNull()
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('waits while the pointer is on it, and goes on with what it had left', () => {
    draw()
    act(() => show('Fait'))
    advance(5000)
    pointerOver(bubble()!)
    advance(ACTION_NOTICE_MS * 5)
    expect(bubble()).not.toBeNull()
    pointerOut(bubble()!)
    advance(ACTION_NOTICE_MS - 5000 - 1)
    expect(bubble()).not.toBeNull()
    advance(1)
    expect(bubble()).toBeNull()
  })

  it('waits while the focus is on it, and moving between its two buttons is not leaving it', () => {
    draw()
    act(() => show('Fait'))
    act(() => document.getElementById('one')!.focus())
    act(() => document.getElementById('two')!.focus())
    advance(ACTION_NOTICE_MS * 5)
    expect(bubble()).not.toBeNull()
    act(() => document.getElementById('outside')!.focus())
    advance(ACTION_NOTICE_MS)
    expect(bubble()).toBeNull()
  })

  it('stays held while either still holds it: the pointer leaving does not let go of the focus, nor the focus leaving of the pointer', () => {
    draw()
    act(() => show('Fait'))
    pointerOver(bubble()!)
    act(() => document.getElementById('one')!.focus())
    pointerOut(bubble()!)
    advance(ACTION_NOTICE_MS * 3)
    expect(bubble()).not.toBeNull()
    pointerOver(bubble()!)
    act(() => document.getElementById('outside')!.focus())
    advance(ACTION_NOTICE_MS * 3)
    expect(bubble()).not.toBeNull()
    pointerOut(bubble()!)
    advance(ACTION_NOTICE_MS)
    expect(bubble()).toBeNull()
  })

  it('is held by a pointer that appears over it without crossing its edge: a move inside is enough', () => {
    draw()
    act(() => show('Fait'))
    act(() => void bubble()!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
    advance(ACTION_NOTICE_MS * 3)
    expect(bubble()).not.toBeNull()
  })

  it('gives a new notice all its time, and what held the one before does not hold it', () => {
    draw()
    act(() => show('Un'))
    advance(7000)
    pointerOver(bubble()!)
    act(() => show('Deux'))
    advance(ACTION_NOTICE_MS - 1)
    expect(bubble()).not.toBeNull()
    advance(1)
    expect(bubble()).toBeNull()
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('holds a new notice the pointer enters, though the pointer was on the one before when it was replaced', () => {
    draw()
    act(() => show('Un'))
    pointerOver(bubble()!)
    act(() => show('Deux'))
    advance(1000)
    pointerOver(bubble()!)
    advance(ACTION_NOTICE_MS * 3)
    expect(bubble()).not.toBeNull()
  })

  it('runs nothing once the component is gone', () => {
    draw()
    act(() => show('Fait'))
    mounted!.unmount()
    mounted = null
    advance(ACTION_NOTICE_MS * 2)
    expect(expired).not.toHaveBeenCalled()
  })
})

describe('a notice whose time is kept elsewhere', () => {
  let heard: boolean[] = []
  let present = true
  function Kept() {
    const props = useNoticeHold((held) => heard.push(held), present)
    return createElement('div', null, present ? createElement('div', { 'data-notice': '', ...props }, createElement('button', { id: 'one' }, 'Annuler'), createElement('button', { id: 'two' }, 'Autre')) : null)
  }
  const drawKept = (): void => {
    heard = []
    present = true
    mounted = mount(createElement(Kept))
  }

  it('hears the pointer and the focus come and go, once for both while either holds it', () => {
    drawKept()
    pointerOver(bubble()!)
    act(() => document.getElementById('one')!.focus())
    pointerOut(bubble()!)
    act(() => document.getElementById('one')!.blur())
    expect(heard).toEqual([true, false])
  })

  it('is not let go of while the focus moves from one control of the notice to another', () => {
    drawKept()
    act(() => document.getElementById('one')!.focus())
    act(() => document.getElementById('two')!.focus())
    expect(heard).toEqual([true])
  })

  it('lets go when the notice goes while it was held, and is not held for the next one', () => {
    drawKept()
    pointerOver(bubble()!)
    present = false
    mounted!.rerender(createElement(Kept))
    expect(heard).toEqual([true, false])
    present = true
    mounted!.rerender(createElement(Kept))
    pointerOver(bubble()!)
    expect(heard).toEqual([true, false, true])
  })

  it('lets go when its component leaves while the notice was held', () => {
    drawKept()
    pointerOver(bubble()!)
    mounted!.unmount()
    mounted = null
    expect(heard).toEqual([true, false])
  })
})

describe('the notice of a list panel', () => {
  it('tells whoever keeps the time when the pointer or the focus is on it and when it is let go', async () => {
    const onHold = vi.fn()
    mounted = mount(createElement(ListPanel, { title: 'Signets', icon: null, onDone: () => undefined, undo: { message: 'Signet supprimé', onUndo: () => undefined, onHold } }))
    const notice = document.querySelector<HTMLElement>('.lp-undo')!
    pointerOver(notice)
    expect(onHold).toHaveBeenLastCalledWith(true)
    pointerOut(notice)
    expect(onHold).toHaveBeenLastCalledWith(false)
    act(() => notice.querySelector('button')!.focus())
    expect(onHold).toHaveBeenLastCalledWith(true)
    // The notice goes while it has the focus (« Annuler » was pressed): the time is let go, not held for good.
    await click(notice.querySelector('button')!)
    mounted.rerender(createElement(ListPanel, { title: 'Signets', icon: null, onDone: () => undefined, undo: null }))
    expect(onHold).toHaveBeenLastCalledWith(false)
  })
})

describe('the deletions of a list panel (useUndoQueue and its notice)', () => {
  let commit = vi.fn()
  function Panel() {
    const undo = useUndoQueue()
    return createElement(
      ListPanel,
      { title: 'Signets', icon: null, onDone: () => undefined, undo: undo.panel },
      createElement('button', { id: 'delete', onClick: () => undo.remove('a', 'Signet supprimé', commit) }, 'Supprimer')
    )
  }
  const drawPanel = async (): Promise<void> => {
    commit = vi.fn()
    mounted = mount(createElement(Panel))
    await click(document.getElementById('delete')!)
  }
  const notice = (): HTMLElement => document.querySelector<HTMLElement>('.lp-undo')!

  it('waits while the pointer is on the notice, and goes on with what it had left', async () => {
    await drawPanel()
    advance(5000)
    pointerOver(notice())
    advance(ACTION_NOTICE_MS * 3)
    expect(commit).not.toHaveBeenCalled()
    pointerOut(notice())
    advance(ACTION_NOTICE_MS - 5000 - 1)
    expect(commit).not.toHaveBeenCalled()
    advance(1)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('waits while the focus is on « Annuler », and the deletion is made once the focus has left it', async () => {
    await drawPanel()
    act(() => notice().querySelector('button')!.focus())
    advance(ACTION_NOTICE_MS * 3)
    expect(commit).not.toHaveBeenCalled()
    act(() => document.getElementById('delete')!.focus())
    advance(ACTION_NOTICE_MS)
    expect(commit).toHaveBeenCalledTimes(1)
  })
})

describe('every list panel that has the notice of its deletions', () => {
  const sources = import.meta.glob('./**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

  it('hands it to the frame with its pause (`undo.panel`), never with only its button', () => {
    const asked = Object.entries(sources).filter(([, source]) => /\bundo=\{/.test(source))
    expect(asked.length).toBeGreaterThan(4)
    for (const [file, source] of asked) expect(source, file).not.toMatch(/onUndo: undo\.undo\b/)
  })
})
