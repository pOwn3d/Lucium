// @vitest-environment happy-dom
// The views of a mini window draw what the main process sends them (`littleState`). It sends the state as their page loads, which can come before
// React listens on a busy machine: the header of the mini window then stayed without its title and its address until the page changed. Each
// view now asks again once it listens (`ready`), and the window answers with its state (main/shell/little.ts, web-apps.ts).

import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LittleState } from '@shared/ipc'
import { mount, type Mounted } from './dom.test-support'

/** The main process as the views see it: the state it holds, the listeners of the page, and the commands it got. */
const main = vi.hoisted(() => ({ page: null as unknown, state: null as unknown, listeners: new Set<(state: unknown) => void>(), commands: [] as Array<[string, string]> }))
vi.mock('./root', () => ({ mountRoot: (node: unknown) => void (main.page = node) }))
vi.mock('./api', () => ({
  api: () => ({
    getSnapshot: () => Promise.resolve(null),
    onLittleState: (listener: (state: unknown) => void) => {
      main.listeners.add(listener)
      return () => void main.listeners.delete(listener)
    },
    // The window answers `ready` with its state, to whoever listens then (what main does). It sent nothing else: what it sent as the page loaded is lost.
    littleAction: (id: string, command: string) => {
      main.commands.push([id, command])
      if (command === 'ready') for (const listener of [...main.listeners]) listener(main.state)
    },
    downloadAction: () => undefined
  }),
  useSnapshot: () => null
}))

const STATE: LittleState = { id: 'little-1', url: 'https://notes.example/page', title: 'Notes du jour', canGoBack: false, canGoForward: false, bar: false, downloads: [], kept: false, spaces: [] }

let mounted: Mounted | null = null

/** The page of the mini window loaded on this address, as the main process loads it, once its first requests have been answered. */
async function page(search: string): Promise<HTMLElement> {
  vi.resetModules()
  history.replaceState(null, '', `/${search}`)
  main.page = null
  await import('./littlearc')
  mounted = mount(main.page as ReactNode as never)
  await act(async () => {})
  return mounted.container
}

beforeEach(() => {
  main.listeners.clear()
  main.commands = []
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('a view of the mini window that listens after its state was sent', () => {
  it('the header asks for it again, and shows the title of the page and its address', async () => {
    main.state = STATE
    const container = await page('?id=little-1')
    expect(main.commands).toContainEqual(['little-1', 'ready'])
    expect(container.querySelector('.la-title')?.textContent).toBe('Notes du jour')
    expect(container.querySelector('.la-host')?.textContent).toBe('notes.example')
  })

  it('the header of a site opened as an application asks for it again, and shows the name of the site', async () => {
    main.state = { ...STATE, id: 'w1', app: { name: 'Agenda' } }
    const container = await page('?id=w1&app=1')
    expect(main.commands).toContainEqual(['w1', 'ready'])
    expect(container.querySelector('.wa-name')?.textContent).toBe('Agenda')
  })

  it('the tray of downloads asks for it again, and lists the files', async () => {
    main.state = { ...STATE, downloads: [{ id: 'd1', filename: 'rapport.pdf', url: 'https://notes.example/rapport.pdf', path: '/tmp/rapport.pdf', state: 'completed', receivedBytes: 10, totalBytes: 10, startedAt: 1 }] }
    const container = await page('?id=little-1&tray=1')
    expect(main.commands).toContainEqual(['little-1', 'ready'])
    expect(container.textContent).toContain('rapport.pdf')
  })
})
