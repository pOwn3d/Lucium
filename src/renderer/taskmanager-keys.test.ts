// @vitest-environment happy-dom
// The list of the task manager is a grid: one stop of Tab (the selected row, or the first), the arrows from row to row. Each row was a stop
// of Tab, and the list is refreshed every two seconds with dozens of processes.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { ProcessRow } from '@shared/ipc'
import { mount, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ bridge: {} as Record<string, (...args: unknown[]) => unknown> }))
vi.mock('./root', () => ({ mountRoot: () => undefined }))
vi.mock('./api', () => ({ api: () => holder.bridge, useSnapshot: () => null }))

import { TaskManager } from './taskmanager'

const rows: ProcessRow[] = [
  { pid: 11, kind: 'tab', name: 'Une page', cpu: 3, memoryMb: 30, tabId: 't1' },
  { pid: 12, kind: 'tab', name: 'Une autre', cpu: 2, memoryMb: 20, tabId: 't2' },
  { pid: 13, kind: 'tab', name: 'La dernière', cpu: 1, memoryMb: 10, tabId: 't3' }
]

let mounted: Mounted | null = null
const stops = (): string[] => [...mounted!.container.querySelectorAll<HTMLElement>('tbody tr[data-pid]')].filter((row) => row.tabIndex === 0).map((row) => row.dataset['pid']!)
const row = (pid: number): HTMLElement => mounted!.container.querySelector<HTMLElement>(`tr[data-pid="${pid}"]`)!
const press = (target: HTMLElement, key: string): void => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))

beforeEach(async () => {
  setLanguage('fr')
  holder.bridge = { listProcesses: () => Promise.resolve(rows) }
  mounted = mount(createElement(TaskManager))
  await act(async () => {})
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the rows of the task manager', () => {
  it('are one stop of Tab: the first row while none is selected', () => {
    expect(stops()).toEqual(['11'])
  })

  it('move that stop with the selection, the arrows taking the focus along', () => {
    row(11).focus()
    press(row(11), 'ArrowDown')
    expect(stops()).toEqual(['12'])
    expect(document.activeElement).toBe(row(12))
    press(row(12), 'End')
    expect(stops()).toEqual(['13'])
  })
})
