// The right-click menu of a page and the two web tools that add an entry to it: « Code QR de ce lien » (qr-code) on a link, « Lire la sélection à voix
// haute » (read-aloud) on selected text. Each is asked of the shell every time the menu opens (`events.menuOptions`), so the switch takes effect at once.
// A real ElectronPage over fakes (electron-page.test-support.ts), no window.

import { describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { itemLabelled, makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))

const LINK = 'https://exemple.fr/page'

describe('the entry « Code QR de ce lien » (qr-code)', () => {
  it('is on a web link while the switch is on, and gives the address of the link when chosen', async () => {
    const qrCode = vi.fn()
    const { wc } = await makePage({ events: { menuOptions: () => ({ qrCode: true, readAloud: false }), qrCode } })
    const entry = itemLabelled(wc.rightClick({ linkURL: LINK }), t('engine.code-qr-de-ce-lien'))
    expect(entry).toBeDefined()
    entry!.click!()
    expect(qrCode).toHaveBeenCalledWith(LINK)
  })

  it('is not there while the switch is off, nor for an address that is not a page to open', async () => {
    const off = await makePage({ events: { menuOptions: () => ({ qrCode: false, readAloud: false }) } })
    expect(itemLabelled(off.wc.rightClick({ linkURL: LINK }), t('engine.code-qr-de-ce-lien'))).toBeUndefined()
    const on = await makePage({ events: { menuOptions: () => ({ qrCode: true, readAloud: false }) } })
    expect(itemLabelled(on.wc.rightClick({ linkURL: 'javascript:alert(1)' }), t('engine.code-qr-de-ce-lien'))).toBeUndefined()
  })

  it('follows the switch from one menu to the next, without a new page', async () => {
    let qrCode = false
    const { wc } = await makePage({ events: { menuOptions: () => ({ qrCode, readAloud: false }) } })
    expect(itemLabelled(wc.rightClick({ linkURL: LINK }), t('engine.code-qr-de-ce-lien'))).toBeUndefined()
    qrCode = true
    expect(itemLabelled(wc.rightClick({ linkURL: LINK }), t('engine.code-qr-de-ce-lien'))).toBeDefined()
  })
})

describe('the entry « Lire la sélection à voix haute » (read-aloud)', () => {
  it('is on a selection while the switch is on, and is not there while it is off', async () => {
    const on = await makePage({ events: { menuOptions: () => ({ qrCode: false, readAloud: true }) } })
    expect(itemLabelled(on.wc.rightClick({ selectionText: 'Bonjour' }), t('engine.lire-la-selection-a-voix-haute'))).toBeDefined()
    const off = await makePage({ events: { menuOptions: () => ({ qrCode: false, readAloud: false }) } })
    expect(itemLabelled(off.wc.rightClick({ selectionText: 'Bonjour' }), t('engine.lire-la-selection-a-voix-haute'))).toBeUndefined()
  })

  it('is not offered when nothing is selected', async () => {
    const { wc } = await makePage({ events: { menuOptions: () => ({ qrCode: false, readAloud: true }) } })
    expect(itemLabelled(wc.rightClick({ selectionText: '   ' }), t('engine.lire-la-selection-a-voix-haute'))).toBeUndefined()
  })
})
