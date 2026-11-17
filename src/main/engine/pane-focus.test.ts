// What the engine tells of the pane of a split view the user is in (see shell/split-pane-focus.test.ts for the shell): whether a page has the keyboard
// (`Page.hasFocus`, which the commands of the page ask), and the presses that make a page the focused pane (`PageEvents.focused`). The page of the engine
// only exists in a running Electron: its covers run here on a stand-in for Electron's view, the page's own wiring is pinned in its source.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// Electron's view, as far as a cover uses it: a web contents that emits its events and says whether it has the keyboard.
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    focused = false
    destroyed = false
    isFocused(): boolean {
      return this.focused
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    setWindowOpenHandler(): void {}
    close(): void {
      this.destroyed = true
    }
  }
  class WebContentsView {
    webContents = new Contents()
    setBorderRadius(): void {}
  }
  return new Proxy({ WebContentsView } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) })
})
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: class { static fromSession() { return undefined } }, setSessionPartitionResolver() {} }))

const { PageCover } = await import('./page-cover')
const { ElectronPage } = await import('./electron-page')

type FakeContents = { focused: boolean; destroyed: boolean; emit(event: string, ...args: unknown[]): boolean }
const win = { isDestroyed: () => true } as unknown as Electron.BrowserWindow
const coverWith = (pressed?: () => void) => {
  const cover = new PageCover(win, {} as Electron.Session, 8, pressed)
  return { cover, contents: cover.webContents as unknown as FakeContents }
}

describe('a cover of ours laid over a page (the reader, the page of a crash)', () => {
  // Guard: a click or a key in the reader of a pane is a press in that pane (it used to tell the shell nothing: the reader is a web contents of its own).
  it('tells the clicks and the keys of the user, and nothing else', () => {
    const pressed = vi.fn()
    const { contents } = coverWith(pressed)
    contents.emit('input-event', {}, { type: 'mouseMove' })
    contents.emit('input-event', {}, { type: 'mouseUp' })
    contents.emit('input-event', {}, { type: 'char' })
    expect(pressed).not.toHaveBeenCalled()
    contents.emit('input-event', {}, { type: 'mouseDown' })
    contents.emit('input-event', {}, { type: 'rawKeyDown' })
    expect(pressed).toHaveBeenCalledTimes(2)
  })

  it('listens to nothing when nobody asked to be told (a popup’s page of a crash)', () => {
    const { contents } = coverWith()
    expect((contents as unknown as { listenerCount(event: string): number }).listenerCount('input-event')).toBe(0)
  })

  it('says it has the keyboard only while it is there and has it', () => {
    const { cover, contents } = coverWith()
    expect(cover.hasFocus()).toBe(false)
    contents.focused = true
    expect(cover.hasFocus()).toBe(true)
    cover.dispose()
    expect(cover.hasFocus()).toBe(false)
  })
})

describe('whether a page has the keyboard', () => {
  /** The page of the engine on stand-ins: its web contents, its reader and its error pages. */
  const pageWith = (where: { page?: boolean; reader?: boolean; errors?: boolean; gone?: boolean }) =>
    Object.assign(Object.create(ElectronPage.prototype) as object, {
      closing: where.gone === true,
      view: { webContents: { isDestroyed: () => false, isFocused: () => where.page === true } },
      reader: { hasFocus: () => where.reader === true },
      errors: { hasFocus: () => where.errors === true }
    }) as unknown as InstanceType<typeof ElectronPage>

  it('is its web contents having it (whichever frame holds it), or a cover of ours over it', () => {
    expect(pageWith({ page: true }).hasFocus()).toBe(true)
    expect(pageWith({ reader: true }).hasFocus()).toBe(true)
    expect(pageWith({ errors: true }).hasFocus()).toBe(true)
    expect(pageWith({}).hasFocus()).toBe(false)
  })

  it('is false for a page that is going', () => {
    expect(pageWith({ page: true, gone: true }).hasFocus()).toBe(false)
  })
})

describe('the presses that make a page the focused pane', () => {
  const engine = readFileSync(fileURLToPath(new URL('./electron-page.ts', import.meta.url)), 'utf8')

  it('are a click the page draws, and a key whichever frame of the page has it, before the menu hears it', () => {
    expect(engine).toMatch(/wc\.on\('input-event', \(_e, input\) => \{[^}]*if \(input\.type === 'mouseDown'\) events\.focused\(\)/)
    // Guard: a key in a frame of another site (a click in it is not told), before the menu runs ⌘+, ⌘F or ⌘P on the selected tab.
    expect(engine).toMatch(/wc\.on\('before-input-event', \(_e, input\) => \{\s*if \(input\.type === 'keyDown'\) events\.focused\(\)\s*\}\)/)
  })

  it('include a press in the reader and in the page of a crash', () => {
    const errors = engine.slice(engine.indexOf('this.errors = new PageErrors('), engine.indexOf('this.reader = new ReaderMode('))
    expect(errors).toContain('focused: () => events.focused()')
    const reader = engine.slice(engine.indexOf('this.reader = new ReaderMode('), engine.indexOf('this.markdown = new MarkdownPicker('))
    expect(reader).toContain('focused: () => events.focused()')
    for (const file of ['./reader-mode.ts', './error-pages.ts']) {
      expect(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'), file).toMatch(/new PageCover\(this\.host\.win, this\.wc\.session, this\.radius, this\.host\.focused\)/)
    }
  })
})
