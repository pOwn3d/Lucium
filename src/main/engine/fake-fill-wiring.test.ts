// "Remplir avec de fausses données": the rules are tested in shared/fake-fill.test.ts. Here the page of the engine runs over a fake web contents
// (electron-page.test-support.ts), and the shell's step (`Browser.fillFakeForm`) on a stand-in: the class reaches Electron only when a method runs.

import { describe, expect, it, vi } from 'vitest'
import { fakeFillScript, type FormFieldHint } from '@shared/fake-fill'
import { t } from '@shared/i18n'
import { itemLabelled, makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))

const { Browser } = await import('../shell/browser')
const shellMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const FIELD: FormFieldHint = { index: 0, tag: 'input', type: 'email', name: 'email', id: 'email', autocomplete: 'email', placeholder: '', label: 'E-mail', usable: true }

describe('the wiring of the fake-data fill', () => {
  it('offers the entry only on an editable field of the main frame of a normal page', async () => {
    const fakeFill = vi.fn()
    const { wc } = await makePage({ events: { fakeFill } })
    const entry = itemLabelled(wc.rightClick({ isEditable: true, x: 30, y: 40 }), t('fake-fill.menu'))
    expect(entry).toBeDefined()
    entry!.click!()
    expect(fakeFill).toHaveBeenCalledWith(30, 40)

    // Not on a field of a frame (the coordinates would be the frame's), not on what is not a field, not on a page that is not on the web.
    expect(itemLabelled(wc.rightClick({ isEditable: true, frame: { name: 'frame' } }), t('fake-fill.menu'))).toBeUndefined()
    expect(itemLabelled(wc.rightClick({ isEditable: false }), t('fake-fill.menu'))).toBeUndefined()
    wc.url = 'file:///Users/moi/formulaire.html'
    expect(itemLabelled(wc.rightClick({ isEditable: true }), t('fake-fill.menu'))).toBeUndefined()
  })

  it('is not offered when the shell does not fill (the switch is off)', async () => {
    const { wc } = await makePage()
    expect(itemLabelled(wc.rightClick({ isEditable: true }), t('fake-fill.menu'))).toBeUndefined()
  })

  it('plans the fill with the address of the tab, so that an internal page gets an empty plan', async () => {
    const fill = async (url: string): Promise<unknown> => {
      const fillFormFields = vi.fn(async (_values: unknown) => 1)
      const readFormFields = vi.fn(async (_x: number, _y: number) => [FIELD])
      const shell = { pages: new Map([['t', { readFormFields, fillFormFields }]]), store: { get: () => ({ tabs: [{ id: 't', url }] }) } }
      await shellMethods['fillFakeForm']!.call(shell, 't', 5, 6)
      expect(readFormFields).toHaveBeenCalledWith(5, 6)
      return fillFormFields.mock.calls[0]![0]
    }
    expect(await fill('https://boutique.example/inscription')).toEqual([{ index: 0, value: expect.stringContaining('@') }])
    // Still called with an empty plan: the fill step removes the marks the read step left.
    expect(await fill('lucium://settings')).toEqual([])
  })

  it('writes the values with the script of shared/fake-fill, which never submits', async () => {
    const { page, wc } = await makePage()
    wc.executeJavaScript.mockResolvedValueOnce(1)
    const values = [{ index: 0, value: 'jeanne@example.org' }]
    expect(await page.fillFormFields(values)).toBe(1)
    expect(wc.executeJavaScript).toHaveBeenCalledWith(fakeFillScript(values))
  })
})
