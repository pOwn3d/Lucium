// @vitest-environment happy-dom
// The footer of the task manager offers « Annuler » after a tab was put to sleep: as long as every notice with an action (eight seconds), and not while
// the pointer or the focus is on it (it used to go after five, whatever the person was doing).

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { ProcessRow } from '@shared/ipc'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { button, click, mount, pointerOut, pointerOver, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ bridge: {} as Record<string, (...args: unknown[]) => unknown> }))
vi.mock('./root', () => ({ mountRoot: () => undefined }))
vi.mock('./api', () => ({ api: () => holder.bridge, useSnapshot: () => null }))

import { TaskManager } from './taskmanager'

const ROWS: ProcessRow[] = [{ pid: 11, kind: 'tab', name: 'Une page', cpu: 3, memoryMb: 30, tabId: 't1' }]

let mounted: Mounted | null = null
const footer = (): HTMLElement => mounted!.container.querySelector<HTMLElement>('.task-total [role="status"]')!
const advance = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))

beforeEach(async () => {
  setLanguage('fr')
  vi.useFakeTimers()
  holder.bridge = { listProcesses: () => Promise.resolve(ROWS), sleepTab: vi.fn(), dispatch: vi.fn(() => Promise.resolve()) }
  mounted = mount(createElement(TaskManager))
  await act(async () => {})
  await click(mounted.container.querySelector('tr[data-pid="11"]')!)
  await click(button(mounted.container, t('taskmanager.mettre-en-veille')))
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

describe('« Annuler » in the footer of the task manager', () => {
  it('is offered for as long as every notice with an action, then the footer says what it said before', () => {
    expect(footer().textContent).toContain(t('taskmanager.onglet-mis-en-veille'))
    advance(ACTION_NOTICE_MS - 1)
    expect(mounted!.container.querySelector('.task-total [role="status"]')).not.toBeNull()
    advance(1)
    expect(mounted!.container.querySelector('.task-total [role="status"]')).toBeNull()
  })

  it('waits while the pointer or the focus is on it, and goes on with what it had left', () => {
    advance(5000)
    pointerOver(footer())
    advance(ACTION_NOTICE_MS * 3)
    expect(mounted!.container.querySelector('.task-total [role="status"]')).not.toBeNull()
    act(() => button(footer(), t('menu.annuler')).focus())
    pointerOut(footer())
    advance(ACTION_NOTICE_MS * 3)
    expect(mounted!.container.querySelector('.task-total [role="status"]')).not.toBeNull()
    act(() => mounted!.container.querySelector<HTMLElement>('tr[data-pid="11"]')!.focus())
    advance(ACTION_NOTICE_MS - 5000 - 1)
    expect(mounted!.container.querySelector('.task-total [role="status"]')).not.toBeNull()
    advance(1)
    expect(mounted!.container.querySelector('.task-total [role="status"]')).toBeNull()
  })
})
