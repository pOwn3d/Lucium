// @vitest-environment happy-dom
// The first-launch guide in the layer of the panels, mounted in a document, while its last button is being answered. The import runs in the main
// process: a sheet closed meanwhile (« Plus tard », Escape, a press outside) never shows what was brought in, nor its « Annuler l'import ». Also
// here: two presses that come together, and choices that could not be recorded.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { ImportReport, ImportSourceInfo } from '@shared/import-sources'
import type { LuciumApi, OverlayRequest, UiSnapshot } from '@shared/ipc'
import type { Action } from '@shared/sidebar'
import { createInitialState } from '@shared/sidebar'
import { OverlayHost } from './OverlayHost'
import { panelIsBusy } from './overlay-focus'
import { button, click, mount, settle, type Mounted } from './dom.test-support'

const CHROME: ImportSourceInfo = { id: 'chrome', name: 'Chrome', blurb: '', categories: ['bookmarks'], profiles: [], found: true }
const DONE: ImportReport = { ok: true, message: '12 signets importés.', bookmarks: 12, folders: 1, history: 0, skipped: 0, undoToken: 'aaaaaaaa-0000' }

let mounted: Mounted | null = null
let closeOverlay: ReturnType<typeof vi.fn<() => void>>
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>
let firstLaunchPreview: ReturnType<typeof vi.fn<() => Promise<ImportReport>>>
/** Ends the import that is under way. */
let imported: (report: ImportReport) => void = () => undefined

/** The guide in the layer, on its last step, with a browser chosen (its bookmarks ticked) and the dark appearance asked for. */
async function guide(): Promise<HTMLElement> {
  const snapshot = { state: createInitialState({ now: 1, newId: () => 'id' }), extensions: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
  let show: (request: OverlayRequest) => void = () => undefined
  const own: Partial<LuciumApi> = {
    getSnapshot: async () => snapshot,
    onShowOverlay: (listener) => {
      show = listener
      return () => undefined
    },
    closeOverlay,
    dispatch,
    importSources: async () => [CHROME],
    firstLaunchPreview: firstLaunchPreview as never,
    firstLaunchConfirm: async () => DONE
  }
  // Whatever else a panel listens to answers nothing: `on…` gives back the function that stops listening.
  ;(window as unknown as { lucium: unknown }).lucium = new Proxy(own, { get: (target, name: string) => (target as Record<string, unknown>)[name] ?? (name.startsWith('on') ? () => () => undefined : () => Promise.resolve(undefined)) })
  mounted = mount(createElement(OverlayHost))
  await settle(() => show({ panel: 'firstlaunch' }))
  await settle()
  const { container } = mounted
  await click(container.querySelector<HTMLInputElement>('input[name="first-launch-source"]')!)
  await click(button(container, t('first-launch.suivant')))
  const appearance = container.querySelector<HTMLSelectElement>('select.field')!
  act(() => {
    appearance.value = 'dark'
    appearance.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click(button(container, t('first-launch.suivant')))
  return container
}

const escape = (target: Element): void => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
const pressOutside = (container: Element): void => void container.querySelector('.backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

beforeEach(() => {
  setLanguage('fr')
  closeOverlay = vi.fn()
  dispatch = vi.fn(async () => undefined)
  firstLaunchPreview = vi.fn(() => new Promise<ImportReport>((resolve) => (imported = resolve)))
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('a panel that says a work is under way', () => {
  it('is known by `aria-busy` on its dialog, not by a busy button inside it', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div role="dialog"><button aria-busy="true"></button></div>'
    expect(panelIsBusy(root)).toBe(false)
    root.innerHTML = '<div role="dialog" aria-busy="false"></div>'
    expect(panelIsBusy(root)).toBe(false)
    root.innerHTML = '<div role="dialog" aria-busy="true"></div>'
    expect(panelIsBusy(root)).toBe(true)
  })
})

describe('the guide while the import runs', () => {
  it('cannot be closed: « Plus tard » is off, Escape and a press outside leave it open, and the answer is shown with its « Annuler l’import »', async () => {
    const container = await guide()
    await click(button(container, t('first-launch.importer-et-commencer')))
    expect(firstLaunchPreview).toHaveBeenCalledTimes(1)
    expect(button(container, t('first-launch.plus-tard')).disabled).toBe(true)
    await settle(() => escape(container.querySelector('[role="dialog"]')!))
    await settle(() => pressOutside(container))
    expect(closeOverlay).not.toHaveBeenCalled()

    await settle(() => imported(DONE))
    expect(container.textContent).toContain(DONE.message)
    expect(button(container, t('import-sheet.annuler-l-import')).disabled).toBe(false)
    // The answer read, the sheet closes as any other (the sheet and the layer both hear Escape).
    await settle(() => escape(container.querySelector('[role="dialog"]')!))
    expect(closeOverlay).toHaveBeenCalled()
  })

  it('is closed by Escape and by a press outside while nothing runs', async () => {
    const container = await guide()
    await settle(() => escape(container.querySelector('[role="dialog"]')!))
    await settle(() => pressOutside(container))
    expect(closeOverlay.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('runs one import for two presses that come together', async () => {
    const container = await guide()
    const last = button(container, t('first-launch.importer-et-commencer'))
    // Both presses in the same turn: the sheet has not been drawn again between them, so the button is not off yet.
    await settle(() => {
      last.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      last.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(firstLaunchPreview).toHaveBeenCalledTimes(1)
  })
})

describe('choices that could not be recorded', () => {
  it('are said in the sheet and in the console, nothing is imported, and the button works again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    dispatch.mockRejectedValueOnce(new Error('the store is closed'))
    const container = await guide()
    await click(button(container, t('first-launch.importer-et-commencer')))
    expect(container.querySelector('.first-launch-nav [role="alert"]')?.textContent).toBe(t('first-launch.choix-non-enregistres'))
    expect(warn).toHaveBeenCalledWith('[first-launch] the choices could not be recorded:', expect.any(Error))
    expect(firstLaunchPreview).not.toHaveBeenCalled()
    expect(closeOverlay).not.toHaveBeenCalled()

    await click(button(container, t('first-launch.importer-et-commencer')))
    expect(firstLaunchPreview).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.first-launch-nav [role="alert"]')).toBeNull()
  })
})

describe('choices that could not be recorded before « Choisir le fichier »', () => {
  it('are said on the report too, where that button is', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const container = await guide()
    await click(button(container, t('first-launch.importer-et-commencer')))
    await settle(() => imported({ ok: false, message: 'Le fichier est à choisir.', bookmarks: 0, folders: 0, history: 0, skipped: 0, canPick: true }))
    expect(container.querySelector('.first-launch-nav [role="alert"]')).toBeNull()
    dispatch.mockRejectedValueOnce(new Error('the store is closed'))
    await click(button(container, t('import-sheet.choisir-le-fichier')))
    expect(container.querySelector('.first-launch-nav [role="alert"]')?.textContent).toBe(t('first-launch.choix-non-enregistres'))
    expect(firstLaunchPreview).toHaveBeenCalledTimes(1)
  })
})

describe('the list of the browsers', () => {
  it('is a group of radios whose items are not announced as a list inside it', async () => {
    const container = await guide()
    await click(button(container, t('import-sheet.retour')))
    await click(button(container, t('import-sheet.retour')))
    const items = [...container.querySelectorAll('[role="radiogroup"] > li')]
    expect(items.length).toBe(2)
    expect(items.every((item) => item.getAttribute('role') === 'presentation')).toBe(true)
  })
})
