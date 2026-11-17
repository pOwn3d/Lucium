// « Copier l'adresse » of the preview (Coup d'œil): the main process writes the clipboard, with the same cleaning as every other copied address
// (« Retirer les paramètres de suivi des liens copiés »), and says so when the copy failed. The real `peekAction` of the shell runs on a stand-in
// for the window (browser-fake.test-support.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { frenchSpaces } from '@shared/french-typography'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

const writeText = vi.fn(async (_text: string) => undefined)
vi.mock('electron', () => new Proxy({ clipboard: { writeText: (text: string) => writeText(text) } } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const TRACKED = 'https://boutique.example/produit?id=7&utm_source=lettre&fbclid=abc'
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function previewOf(stripCopiedLinks: boolean) {
  const state = { ...createInitialState({ now: 1, newId: () => 'x' }), settings: { ...defaultSettings(), stripCopiedLinks } }
  const toasts: string[] = []
  const fake = fakeBrowser({ store: { get: () => state }, peek: { url: TRACKED, page: {} }, copyable: shell['copyable'], showToast: (message: string) => void toasts.push(message) })
  return { fake, toasts, copy: () => shell['peekAction']!.call(fake.self, 'copy-address') }
}

beforeEach(() => {
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
})

describe('the address copied from the preview', () => {
  it('goes to the clipboard without its tracking parameters when the setting asks for it, and the preview stays open', () => {
    const w = previewOf(true)
    w.copy()
    expect(writeText.mock.calls).toEqual([['https://boutique.example/produit?id=7']])
    expect(w.fake.names()).not.toContain('closeOverlay')
    expect(w.fake.self['peek']).not.toBeNull()
  })

  it('goes whole when the setting is off', () => {
    const w = previewOf(false)
    w.copy()
    expect(writeText.mock.calls).toEqual([[TRACKED]])
  })

  it('is said not to be on the clipboard when the copy failed, and the log says why', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      writeText.mockRejectedValue(new Error('the clipboard is busy'))
      const w = previewOf(true)
      w.copy()
      await settle()
      expect(w.toasts).toEqual([frenchSpaces('L’adresse n’a pas pu être copiée.')])
      expect(errors.mock.calls.flat().map(String).join(' ')).toContain('the clipboard is busy')
    } finally {
      errors.mockRestore()
    }
  })

  it('is one of the actions the interface may ask for', async () => {
    expect((await import('@shared/ipc')).PEEK_ACTIONS).toContain('copy-address')
  })
})
