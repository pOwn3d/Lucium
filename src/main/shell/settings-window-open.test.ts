// The Settings window opened by a link to a group (« Réglages de l’effacement » of the sheet « Effacer les données du site »): the place it is opened at,
// the window already open that is taken there, and the way the anchor goes from the window that asks to the one that opens.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { settingsHash, showHashScript } from '@shared/settings-target'
import { SettingsWindow } from './settings-window'

/** A window with the few calls the controller makes on it. */
function fakeWindow() {
  const calls: string[] = []
  const win = {
    webContents: { id: 7, executeJavaScript: vi.fn(async (code: string) => (calls.push(`script ${code}`), undefined)), on: () => undefined },
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => void calls.push('restore'),
    show: () => void calls.push('show'),
    focus: () => void calls.push('focus'),
    close: () => undefined,
    once: () => undefined,
    on: () => undefined
  }
  return { win, calls }
}

function controller() {
  const made: Array<{ pane: string; anchor: string | undefined }> = []
  const { win, calls } = fakeWindow()
  const settings = new SettingsWindow({
    browser: { addSurface: () => undefined, removeSurface: () => undefined } as never,
    trusted: new Set<number>(),
    createWindow: (pane, anchor) => (made.push({ pane, anchor }), win as never)
  })
  return { settings, made, calls }
}

describe('the Settings window opened on a group', () => {
  it('is made at the category and the group asked for', () => {
    const { settings, made } = controller()
    settings.open('protection', 'sitedata')
    expect(made).toEqual([{ pane: 'protection', anchor: 'sitedata' }])
  })

  it('takes a window that is already open to the group, with the script that also works when it is already there, and brings it to the front', () => {
    const { settings, made, calls } = controller()
    settings.open('general')
    settings.open('protection', 'sitedata')
    expect(made).toHaveLength(1)
    expect(calls).toEqual([`script ${showHashScript('protection/sitedata')}`, 'show', 'focus'])
  })

  it('leaves out an anchor that belongs to another category, so that the category opens at its top', () => {
    const { settings, calls } = controller()
    settings.open('general')
    settings.open('appearance', 'sitedata')
    expect(calls[0]).toBe(`script ${showHashScript('appearance')}`)
  })
})

// index.ts starts the application and cannot be run here: what it hands to the windows is read in the text of the parts of it that make the
// window manager (windows-wiring.ts) and the windows of their own (own-windows-wiring.ts).
describe('the anchor from the window that asks to the Settings window', () => {
  const index = readFileSync(fileURLToPath(new URL('./windows-wiring.ts', import.meta.url)), 'utf8')
  const ownWindows = readFileSync(fileURLToPath(new URL('./own-windows-wiring.ts', import.meta.url)), 'utf8')
  const windows = readFileSync(fileURLToPath(new URL('./windows.ts', import.meta.url)), 'utf8')

  it('goes through for the main window', () => {
    expect(ownWindows).toContain('browser.setSettingsOpener((pane, anchor) => settings.open(pane, anchor))')
  })

  it('goes through for the other windows too (a second window, a private one): they open Settings through `openSettings` of the manager', () => {
    expect(index).toContain('openSettings: (pane, anchor) => settings.open(pane, anchor)')
    expect(windows).toContain('openSettings: (pane?: SettingsPane, anchor?: SettingsAnchor) => void')
    expect(windows).toContain('deps.openSettings)')
  })
})

/** A window that says its address and can be closed, as the controller sees one: `hash` is where the page went, `close` fires its events. */
function liveWindow(id: number) {
  const handlers = new Map<string, Array<() => void>>()
  let destroyed = false
  const state = { hash: '' }
  const win = {
    webContents: { id, getURL: () => `file:///Lucium.app/settings.html${state.hash}`, isDestroyed: () => destroyed, executeJavaScript: vi.fn(async () => undefined), on: () => undefined },
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore: () => undefined,
    show: () => undefined,
    focus: () => undefined,
    once: () => undefined,
    on: (name: string, run: () => void) => void handlers.set(name, [...(handlers.get(name) ?? []), run]),
    close: () => {
      for (const run of handlers.get('close') ?? []) run()
      destroyed = true
      for (const run of handlers.get('closed') ?? []) run()
    }
  }
  return { win, state }
}

/** A controller whose every window is a new `liveWindow`; `made` lists where each was made, `last` is the one made last. */
function session() {
  const made: Array<{ pane: string; anchor: string | undefined }> = []
  let last = liveWindow(0)
  const settings = new SettingsWindow({
    browser: { addSurface: () => undefined, removeSurface: () => undefined } as never,
    trusted: new Set<number>(),
    createWindow: (pane, anchor) => {
      made.push({ pane, anchor })
      last = liveWindow(made.length)
      last.state.hash = `#${settingsHash(pane, anchor)}`
      return last.win as never
    }
  })
  return { settings, made, last: () => last }
}

describe('the page the Settings window opens on when it is asked for none (Réglages…, ⌘,)', () => {
  it('is « Pour commencer » the first time in the session', () => {
    const { settings, made } = session()
    settings.open()
    expect(made).toEqual([{ pane: 'home', anchor: undefined }])
  })

  it('is the page it showed when it was closed', () => {
    const { settings, made, last } = session()
    settings.open()
    last().state.hash = '#tabs'
    last().win.close()
    settings.open()
    expect(made.at(-1)).toEqual({ pane: 'tabs', anchor: undefined })
  })

  it('is the subpage it showed, and only the page for a group a link took it to', () => {
    const { settings, made, last } = session()
    settings.open('protection')
    last().state.hash = '#protection/filterlists'
    last().win.close()
    settings.open()
    expect(made.at(-1)).toEqual({ pane: 'protection', anchor: 'filterlists' })
    last().state.hash = '#about/status'
    last().win.close()
    settings.open()
    expect(made.at(-1)).toEqual({ pane: 'about', anchor: undefined })
  })

  it('does not stand in the way of a place asked for: a menu, a link, an address open their own', () => {
    const { settings, made, last } = session()
    settings.open()
    last().state.hash = '#tabs'
    last().win.close()
    settings.open('about', 'status')
    expect(made.at(-1)).toEqual({ pane: 'about', anchor: 'status' })
    settings.open()
    // Already open: it stays where it is, brought to the front, and its page is not changed.
    expect(made).toHaveLength(2)
    expect(last().win.webContents.executeJavaScript).not.toHaveBeenCalled()
    settings.open('home')
    expect(last().win.webContents.executeJavaScript).toHaveBeenCalledWith(showHashScript('home'))
  })

  it('is kept in memory only: a new session (a new controller) opens on « Pour commencer »', () => {
    const first = session()
    first.settings.open('files')
    first.last().win.close()
    const next = session()
    next.settings.open()
    expect(next.made).toEqual([{ pane: 'home', anchor: undefined }])
    // Nothing is written: the controller reads no store and writes no file.
    const source = readFileSync(fileURLToPath(new URL('./settings-window.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/\b(writeFile|store|dispatch|settings\/update)\b/)
  })
})


describe('the Settings window and the synchronisation window', () => {
  /** A window that keeps its own listeners, so that the test can close it the way Electron does: `close`, then `closed`. */
  function closable() {
    const listeners = new Map<string, Array<() => void>>()
    const on = (event: string, listener: () => void) => void (listeners.set(event, [...(listeners.get(event) ?? []), listener]), undefined)
    const win = { webContents: { id: 9, isDestroyed: () => false, getURL: () => 'file:///settings.html#files/sync', executeJavaScript: async () => undefined, on: () => undefined }, isDestroyed: () => false, once: on, on, close: () => undefined }
    return { win, emit: (event: string) => (listeners.get(event) ?? []).forEach((run) => run()) }
  }

  it('tells that it has closed, once, so that the Mac stops listening for the iPhone (docs/synchronisation.md §6.1)', () => {
    const { win, emit } = closable()
    const onClosed = vi.fn()
    const trusted = new Set<number>()
    const settings = new SettingsWindow({ browser: { addSurface: () => undefined, removeSurface: () => undefined } as never, trusted, createWindow: () => win as never, onClosed })
    settings.open('files')
    expect(trusted.has(9)).toBe(true)
    expect(onClosed).not.toHaveBeenCalled()
    emit('close')
    expect(onClosed).not.toHaveBeenCalled()
    emit('closed')
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(trusted.has(9)).toBe(false)
    expect(settings.isOpen()).toBe(false)
  })

  it('has nothing to tell when nobody asked', () => {
    const { win, emit } = closable()
    const settings = new SettingsWindow({ browser: { addSurface: () => undefined, removeSurface: () => undefined } as never, trusted: new Set<number>(), createWindow: () => win as never })
    settings.open('files')
    expect(() => emit('closed')).not.toThrow()
  })
})
