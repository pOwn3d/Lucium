// @vitest-environment happy-dom
// A request to the main process that fails must leave the screen in a state that says so: the task manager with an empty list and no word, the
// sheet of a new space on « Création… » with its button held, « Définir par défaut » greyed for good, a replacement that did nothing in silence.
// Each component is mounted for real over a bridge whose request is refused.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { ProcessRow } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { click, mount, type, type Mounted } from './dom.test-support'

type Bridge = Record<string, (...args: unknown[]) => unknown>
const holder = vi.hoisted(() => ({ snapshot: null as unknown, bridge: {} as Record<string, (...args: unknown[]) => unknown> }))
vi.mock('./root', () => ({ mountRoot: () => undefined }))
vi.mock('./api', () => ({ api: () => holder.bridge, useSnapshot: () => holder.snapshot }))

import { FindReplace } from './FindReplace'
import { SpaceCreate } from './SpaceCreate'
import { TaskManager } from './taskmanager'
import { WelcomeSheet } from './WelcomeSheet'

const refused = (): Promise<never> => Promise.reject(new Error("Error invoking remote method 'x': Error: le processus principal ne répond pas"))
const state = createInitialState({ now: 1, newId: () => 'id' })

let mounted: Mounted | null = null
async function shown(node: ReturnType<typeof createElement>, bridge: Bridge, snapshot: unknown = { state, runtime: { tabs: {} }, extensions: [], platform: 'darwin' }): Promise<HTMLElement> {
  holder.bridge = bridge
  holder.snapshot = snapshot
  mounted = mount(node)
  await act(async () => {})
  return mounted.container
}
const alertOf = (container: HTMLElement): string | undefined => container.querySelector('[role="alert"]')?.textContent ?? undefined
const key = (target: EventTarget, init: KeyboardEventInit): Promise<void> => act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))

beforeEach(() => {
  setLanguage('fr')
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('the task manager', () => {
  const row: ProcessRow = { pid: 5, kind: 'tab', name: 'Une page', cpu: 1, memoryMb: 10, tabId: 't1' }

  it('says why its list is empty when the processes cannot be read, and writes it to the log', async () => {
    const container = await shown(createElement(TaskManager), { listProcesses: refused })
    expect(alertOf(container)).toContain('Les processus n’ont pas pu être lus')
    expect(alertOf(container)).toContain('le processus principal ne répond pas')
    expect(alertOf(container)).not.toContain('Error invoking')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('the processes could not be listed'), expect.any(Error))
  })

  it('says that a process could not be ended', async () => {
    const container = await shown(createElement(TaskManager), { listProcesses: () => Promise.resolve([row]), killProcess: refused })
    expect(alertOf(container)).toBeUndefined()
    await click(container.querySelector('[data-pid="5"]')!)
    await click([...container.querySelectorAll('.task-actions button')].at(-1)!)
    expect(alertOf(container)).toContain('Le processus n’a pas pu être arrêté')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('the process 5 could not be ended'), expect.any(Error))
  })
})

describe('the sheet of a new space', () => {
  it('leaves « Création… » and frees its button when the request fails', async () => {
    const container = await shown(createElement(SpaceCreate), { dispatch: refused, getSnapshot: refused, closeOverlay: () => undefined, openOverlay: () => undefined })
    type(container.querySelector<HTMLInputElement>('input[data-autofocus]')!, 'Voyages')
    const primary = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(primary().disabled).toBe(false)
    await key(window, { key: 'Enter', metaKey: true })
    expect(alertOf(container)).toBeDefined()
    expect(primary().textContent).not.toContain('Création')
    expect(primary().disabled).toBe(false)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('the new space could not be created'), expect.any(Error))
  })
})

describe('« Définir comme navigateur par défaut » of the welcome', () => {
  it('is offered again when the question asked after the change fails', async () => {
    let asked = 0
    const container = await shown(createElement(WelcomeSheet), {
      importSources: () => Promise.resolve([]),
      defaultBrowser: () => (asked++ === 0 ? Promise.resolve(false) : refused()),
      setDefaultBrowser: () => Promise.resolve(),
      openOverlay: () => undefined,
      closeOverlay: () => undefined,
      dispatch: () => Promise.resolve()
    })
    const button = (): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>('button')].find((each) => each.textContent === 'Définir comme navigateur par défaut')!
    expect(button().disabled).toBe(false)
    await click(button())
    expect(asked).toBe(2)
    expect(button().disabled).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cannot make Lucium the default browser'), expect.any(Error))
  })
})

describe('find and replace', () => {
  it('says that the replacement could not be made, and does not search again as if it had been', async () => {
    const found: unknown[] = []
    const container = await shown(createElement(FindReplace), { find: (...args: unknown[]) => void found.push(args), findReplace: refused, closeOverlay: () => undefined }, { state, find: { text: 'ancien', matches: 2, ordinal: 1 } })
    expect(alertOf(container)).toBeUndefined()
    await key(container.querySelector('.fr-replacement')!, { key: 'Enter' })
    expect(alertOf(container)).toBe('Remplacement impossible')
    expect(found).toEqual([])
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('the replacement could not be made'), expect.any(Error))
  })
})
