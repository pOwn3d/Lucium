// @vitest-environment happy-dom
// The import sheet while an import is being written. Leaving the sheet then would stop nothing (the import goes to its end) and would take away
// the report, with the only button that takes the import back: the button that closes is greyed, Escape does nothing, and the layer is held so
// that a click outside does not close it either (OverlayHost reads the hold: overlay-host.test.ts). Before and after, the sheet closes as usual.

import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { LuciumApi } from '@shared/ipc'
import type { ImportReport, ImportSourceInfo } from '@shared/import-sources'
import { ImportSheet } from './ImportSheet'
import { overlayHeld } from './overlay-hold'
import { button, click, mount, settle, type Mounted } from './dom.test-support'

const CHROME: ImportSourceInfo = { id: 'chrome', name: 'Chrome', blurb: '', categories: ['bookmarks'], profiles: [], found: true }
const PREVIEW: ImportReport = { ok: true, message: '3 favoris', bookmarks: 3, folders: 0, history: 0, skipped: 0, token: 'preview-1' }
const DONE: ImportReport = { ok: true, message: '3 favoris importés', bookmarks: 3, folders: 0, history: 0, skipped: 0 }

let mounted: Mounted | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

/** The sheet with a preview on screen, waiting for « Confirmer l’import »; the import ends when the test says. */
async function sheetWithPreview() {
  let finish: (report: ImportReport) => void = () => undefined
  const closeOverlay = vi.fn<() => void>()
  const importCommit = vi.fn(() => new Promise<ImportReport>((resolve) => (finish = resolve)))
  const bridge: Partial<LuciumApi> = { importSources: async () => [CHROME], importPreview: async () => PREVIEW, importCommit, closeOverlay }
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = bridge
  mounted = mount(createElement(ImportSheet))
  await settle()
  const container = mounted.container
  await click(container.querySelector('input[type="radio"]')!)
  await click(button(container, t('import-sheet.importer')))
  await settle()
  const escape = (): void => act(() => void container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  return { container, closeOverlay, importCommit, finish: (report: ImportReport) => settle(() => finish(report)), escape }
}

describe('the import sheet while the import is being written', () => {
  it('cannot be left: its closing button is greyed, Escape does nothing, and the layer is held', async () => {
    const sheet = await sheetWithPreview()
    expect(overlayHeld()).toBe(false)
    await click(button(sheet.container, t('import-sheet.confirmer-l-import')))
    expect(sheet.importCommit).toHaveBeenCalledWith('preview-1')

    expect(overlayHeld()).toBe(true)
    expect(button(sheet.container, t('import-sheet.annuler')).disabled).toBe(true)
    sheet.escape()
    expect(sheet.closeOverlay).not.toHaveBeenCalled()

    await sheet.finish(DONE)
    expect(overlayHeld()).toBe(false)
    const done = button(sheet.container, t('settings.termine'))
    expect(done.disabled).toBe(false)
    await click(done)
    expect(sheet.closeOverlay).toHaveBeenCalledTimes(1)
  })

  it('lets go of the layer when the sheet goes away while it writes (the main process closed it)', async () => {
    const sheet = await sheetWithPreview()
    await click(button(sheet.container, t('import-sheet.confirmer-l-import')))
    expect(overlayHeld()).toBe(true)
    mounted?.unmount()
    mounted = null
    expect(overlayHeld()).toBe(false)
  })

  it('closes as usual while nothing is being written: the preview is only a reading', async () => {
    const sheet = await sheetWithPreview()
    expect(button(sheet.container, t('import-sheet.annuler')).disabled).toBe(false)
    sheet.escape()
    expect(sheet.closeOverlay).toHaveBeenCalledTimes(1)
  })
})
