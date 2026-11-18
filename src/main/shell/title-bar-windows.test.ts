// Which windows draw their own title bar on Windows and which keep the system's (docs/plateformes.md §10). The decision of the project manager (18 Nov 2026,
// « une seule barre »): the main window, the other and private windows, and the windows of a site opened as an application lay the system's three buttons over the
// row of their toolbar or header (`titleBarOverlay`); the mini window and Réglages keep the title bar of the system. Where each window is made is read in its source,
// as the other wiring tests do: the windows themselves are checked on a Windows machine, not by a unit test.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const frameCalls = (text: string, name = 'windowFrame'): string[] => [...text.matchAll(new RegExp(`\\b${name}\\(([^\\n]*)\\)`, 'g'))].map((match) => match[1]!)

describe('the windows that draw their title bar on Windows', () => {
  it('give the buttons over the page to the main window and to the other, private and guest windows, from their own settings', () => {
    expect(frameCalls(source('../index.ts'))).toEqual(['TRAFFIC_LIGHTS, firstControlsOverlay(sharedStore.get().settings, { dark: nativeTheme.shouldUseDarkColors })'])
    expect(frameCalls(source('./windows-wiring.ts'))).toEqual(["TRAFFIC_LIGHTS, firstControlsOverlay(sharedStore.get().settings, { dark: nativeTheme.shouldUseDarkColors, privateBar: privateWindow && !guest })"])
  })

  it('give them to the windows of a site opened as an application, and keep them in the scheme of the system', () => {
    const wiring = source('./web-apps-wiring.ts')
    expect(frameCalls(wiring, 'webAppWindowFrame')).toEqual(['currentPlatform(), controls()'])
    // The header is dark or light with the system (little.css): the buttons follow when it changes, and the listener goes with the window.
    expect(wiring).toContain("nativeTheme.on('updated', follow)")
    expect(wiring).toContain("aw.once('closed', () => nativeTheme.removeListener('updated', follow))")
  })
})

describe('the windows that keep the title bar of the system on Windows', () => {
  it('are the mini window and Réglages: they ask for the traffic lights only, never for the buttons over the page', () => {
    expect(frameCalls(source('./own-windows-wiring.ts'))).toEqual(['{ x: 12, y: 16 }'])
    expect(frameCalls(source('./settings-window.ts'))).toEqual(['{ x: 9, y: 9 }'])
  })
})
