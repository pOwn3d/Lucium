// « Reprendre où vous en étiez ? » (shared/session-restore.ts) wired in the main process: a panel the interface cannot ask for (only the launch that follows an abnormal
// exit opens it), not in a private window, not over the lock screen, and drawn by the overlay.

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { canOpenWhileLocked } from '@shared/lock'
import { canOpenInPrivate } from '@shared/private-window'
import { defaultSettings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { overlayHost, showedPanel, methodsOf } from './browser-fake.test-support'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))

const { validOverlay } = await import('./ipc')
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

describe('the restore sheet', () => {
  const store = { get: () => ({ ...createInitialState({ now: 0, newId: () => 'x' }), settings: defaultSettings() }) }

  it('cannot be asked for by the interface: only the launch after an abnormal exit opens it', () => {
    expect(validOverlay({ panel: 'restore' }, store)).toBe(false)
  })

  it('is opened in a window, and not in a private window nor over the lock screen', () => {
    const fake = overlayHost()
    shell['openOverlay']!.call(fake.self, { panel: 'restore' })
    expect(showedPanel(fake, 'restore')).toBe(true)
    expect(canOpenInPrivate('restore')).toBe(false)
    const privateWindow = overlayHost({}, { isPrivate: () => true })
    shell['openOverlay']!.call(privateWindow.self, { panel: 'restore' })
    expect(showedPanel(privateWindow, 'restore')).toBe(false)
    expect(canOpenWhileLocked('restore', true)).toBe(false)
  })
})

// Contract: the overlay draws its panel in a window, which a unit test does not have; without this case the sheet would be an empty panel, and without its place in the
// modal set a click outside would not close it.
describe('the sheet in the overlay', () => {
  const host = readFileSync(new URL('../../renderer/OverlayHost.tsx', import.meta.url), 'utf8')

  it('is a modal panel and draws RestoreSheet for its request', () => {
    expect(host).toMatch(/const MODAL = new Set<OverlayRequest\['panel'\]>\(\[[^\]]*'restore'[^\]]*\]\)/)
    expect(host).toMatch(/case 'restore':\s*return <RestoreSheet key=\{version\} \/>/)
  })
})
