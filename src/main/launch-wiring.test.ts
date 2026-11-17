// The welcome and the news of a launch, "Quitter ce site ?" and the notices with an action, as the shell runs them: the real methods of the shell, of
// its IPC and of its menu, called on stand-ins (no window). The rules themselves are tested in unload-guard.test.ts, launch-sheets.test.ts,
// shared/toast.test.ts and shared/whats-new.test.ts, the sheets' markup in src/renderer/launch-sheets.test.ts.

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { Channel, type OverlayRequest } from '@shared/ipc'
import { t } from '@shared/i18n'
import { canOpenWhileLocked } from '@shared/lock'
import { canOpenInPrivate } from '@shared/private-window'
import { createInitialState } from '@shared/sidebar'
import { GUIDED_SETUP_REQUEST } from '@shared/settings-guide'
import { nothing, standIn } from './stand-in.test-support'

// Electron, as far as these need it: the IPC keeps its handlers, the menu hands its template back, every other name answers a stand-in that does nothing.
const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const quiet = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (quiet(prop) ? undefined : stub), apply: () => stub })
  const withStub = (target: Record<string, unknown>): unknown =>
    new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : quiet(prop) ? undefined : stub), has: (t, prop) => prop in t || !quiet(prop) })
  const record = (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void handlers.set(channel, handler)
  return {
    handlers,
    module: withStub({
      ipcMain: { on: record, handle: record },
      Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
      app: withStub({ getPath: () => '/nonexistent' })
    })
  }
})
vi.mock('electron', () => electron.module as Record<string, unknown>)

const { Browser } = await import('./shell/browser')
const { registerIpc, validOverlay } = await import('./shell/ipc')
const { buildMenu } = await import('./shell/menu')
type Method = (this: unknown, ...args: unknown[]) => unknown
const shellMethods = Browser.prototype as unknown as Record<string, Method>

/** A shell of which only `own` is real: its methods are the shell's own when they are named in `own`, and a member that is not given throws. */
const shell = <T extends Record<string, unknown>>(own: T): T => standIn('shell', own)
/** The same shell for `stop`, which lets go of everything a window holds (some forty members): what is not in `own` does nothing. Not for another method. */
const stoppable = <T extends Record<string, unknown>>(own: T): T => new Proxy(own, { get: (target, prop: string) => (prop in target ? target[prop] : nothing) })

/** A window waiting for "Quitter ce site ?" about the page `pageId`: the panel opens when `opens` is true. */
function leaving(opens: boolean, made: typeof shell = shell) {
  const self = made({
    overlayRequest: null as OverlayRequest | null,
    leaveCounter: 0,
    leaveAnswers: new Map<string, { pageId: string; resolve: (leave: boolean) => void }>(),
    ownerOf: () => undefined,
    openOverlay: vi.fn((request: OverlayRequest) => {
      if (opens) self.overlayRequest = request
    }),
    closeOverlay: shellMethods['closeOverlay'],
    answerLeave: shellMethods['answerLeave'],
    askLeave: shellMethods['askLeave'],
    permissionQueue: [],
    authQueue: [],
    dialogQueue: [],
    reviewQueue: [],
    passphraseQueue: [],
    // What closing a panel also touches, and these tests do not look at: the window and the layer it is shown in, the questions kept for later,
    // the guide that follows an import and the next publication of the state.
    win: nothing,
    overlay: nothing,
    parkOffScreenQuestions: nothing,
    openArcGuideAfterImport: nothing,
    publishQueue: nothing
  })
  return self
}
const ask = (self: ReturnType<typeof leaving>, pageId = 'p1'): Promise<boolean> => shellMethods['askLeave']!.call(self, pageId, 'exemple.fr') as Promise<boolean>
const idOf = (self: ReturnType<typeof leaving>): string => [...self.leaveAnswers.keys()][0]!

describe('"Quitter ce site ?"', () => {
  it('is a question of the window of the page; one that opens no panel is a "Rester", so that the engine never waits for good', async () => {
    const refused = leaving(false)
    await expect(ask(refused)).resolves.toBe(false)
    expect(refused.openOverlay).toHaveBeenCalledWith({ panel: 'leave', request: { id: 'leave-1', site: 'exemple.fr' } })
    expect(refused.leaveAnswers.size).toBe(0)
    // While another panel is open, nothing is stacked on it.
    const busy = leaving(true)
    busy.overlayRequest = { panel: 'downloads' }
    await expect(ask(busy)).resolves.toBe(false)
    expect(busy.openOverlay).not.toHaveBeenCalled()
  })

  it('leaves on the answer of the sheet, once', async () => {
    const self = leaving(true)
    const answer = ask(self)
    const id = idOf(self)
    shellMethods['answerLeave']!.call(self, id, true)
    shellMethods['answerLeave']!.call(self, id, false)
    await expect(answer).resolves.toBe(true)
    expect(self.leaveAnswers.size).toBe(0)
  })

  it('is a "Rester" when the panel is dismissed, when the page goes and when the window closes', async () => {
    const dismissed = leaving(true)
    const first = ask(dismissed)
    shellMethods['closeOverlay']!.call(dismissed)
    await expect(first).resolves.toBe(false)
    expect(dismissed.overlayRequest).toBeNull()

    const gone = leaving(true)
    const second = ask(gone, 'p2')
    shellMethods['cancelLeaveOf']!.call(gone, 'p1')
    expect(gone.leaveAnswers.size).toBe(1)
    shellMethods['cancelLeaveOf']!.call(gone, 'p2')
    await expect(second).resolves.toBe(false)

    const closed = leaving(true, stoppable)
    const third = ask(closed)
    shellMethods['stop']!.call(closed)
    await expect(third).resolves.toBe(false)
    expect(closed.leaveAnswers.size).toBe(0)
  })

  it('takes only an explicit true from the interface for a "Quitter"', () => {
    const answerLeave = vi.fn()
    const browser = new Proxy({ answerLeave } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => undefined) })
    const store = { get: () => ({ spaces: [], settings: {} }), subscribe: () => () => undefined }
    registerIpc(browser as never, store as never, {} as never, new Set([7]))
    const sender = { id: 7, mainFrame: {}, getURL: () => 'lucium://interface/' }
    const send = (...args: unknown[]) => electron.handlers.get(Channel.answerLeave)!({ sender, senderFrame: sender.mainFrame }, ...args)
    send('leave-1', true)
    send('leave-2', 'true')
    send('leave-3', 1)
    send(42, true)
    expect(answerLeave.mock.calls).toEqual([
      ['leave-1', true],
      ['leave-2', false],
      ['leave-3', false]
    ])
  })

  it('may open in a private window and over the lock screen like the other questions of a page', () => {
    expect(canOpenInPrivate('leave')).toBe(true)
    expect(canOpenWhileLocked('leave', true)).toBe(true)
  })

  // Contract: the overlay draws its panel in a window, which a unit test does not have; without this case the sheet would be an empty panel.
  it('is drawn by the overlay for the request', () => {
    const host = readFileSync(new URL('../renderer/OverlayHost.tsx', import.meta.url), 'utf8')
    expect(host).toMatch(/case 'leave':\s*return <LeaveSheet key=\{version\} request=\{request\.request\} \/>/)
  })
})

describe('the sheets of a launch', () => {
  // That the sheets open once the window is shown and the overlay has loaded, never in the engine test, and that the profile is new from the state file read at start-up:
  // main-wiring.test.ts, where main() is run.
  it('can be opened again from the Aide menu', () => {
    const leaves = (items: { label?: string; click?: () => void; submenu?: unknown[] }[]): { label?: string; click?: () => void }[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu as never) : [item]))
    const showWhatsNew = vi.fn()
    const showFirstLaunch = vi.fn()
    const browser = new Proxy({ menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => false) })
    const actions = new Proxy({ showWhatsNew, showFirstLaunch, windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
    const state = createInitialState({ now: 1, newId: () => 'home' })
    const items = leaves(buildMenu(browser as never, { get: () => state } as never, actions as never) as never)
    items.find((item) => item.label === t('menu.nouveautes'))!.click!()
    expect(showWhatsNew).toHaveBeenCalledTimes(1)
    items.find((item) => item.label === t('menu.premier-lancement'))!.click!()
    expect(showFirstLaunch).toHaveBeenCalledTimes(1)
  })

  it('the Aide menu also opens the complete configuration of the Settings (« Régler en quelques questions… »)', () => {
    const leaves = (items: { label?: string; click?: () => void; submenu?: unknown[] }[]): { label?: string; click?: () => void }[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu as never) : [item]))
    const openOverlay = vi.fn()
    const browser = new Proxy({ openOverlay, menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => false) })
    const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
    const state = createInitialState({ now: 1, newId: () => 'home' })
    const items = leaves(buildMenu(browser as never, { get: () => state } as never, actions as never) as never)
    items.find((item) => item.label === t('menu.configuration-rapide'))!.click!()
    expect(openOverlay).toHaveBeenCalledWith(GUIDED_SETUP_REQUEST)
  })

  it('are panels the interface cannot ask for', () => {
    const store = { get: () => createInitialState({ now: 1, newId: () => 'home' }) }
    for (const request of [{ panel: 'welcome' }, { panel: 'whatsnew', sheet: { version: '0.2.0', items: [] } }, { panel: 'leave', request: { id: 'leave-1', site: 'exemple.fr' } }]) {
      expect(validOverlay(request, store as never), request.panel).toBe(false)
    }
  })

  it('"Ne plus montrer" switches the function off only while the sheet is the open panel, and a notice offers to undo it', () => {
    const self = { overlayRequest: { panel: 'site' } as { panel: string }, closeOverlay: vi.fn(), dispatch: vi.fn(), showToast: vi.fn() }
    shellMethods['dismissWhatsNew']!.call(self)
    expect(self.dispatch).not.toHaveBeenCalled()
    expect(self.closeOverlay).not.toHaveBeenCalled()
    self.overlayRequest = { panel: 'whatsnew' }
    shellMethods['dismissWhatsNew']!.call(self)
    expect(self.closeOverlay).toHaveBeenCalledTimes(1)
    expect(self.dispatch).toHaveBeenCalledWith({ type: 'settings/update', patch: { whatsNewSheet: false } })
    const [, action] = self.showToast.mock.calls[0] as [string, { label: string; run: () => void }]
    expect(action.label).toBe(t('menu.annuler'))
    action.run()
    expect(self.dispatch).toHaveBeenLastCalledWith({ type: 'settings/update', patch: { whatsNewSheet: true } })
  })
})

// Contract: the notice with an action waits while the pointer or the focus is in it, and closes with its ✕ and Escape (WCAG 2.2.1). What the component does is
// tested mounted (renderer/sidebar-toast.test.ts); here, that the sidebar draws that component, one for each notice, and nothing of its own beside it.
describe('the notices with an action', () => {
  it('are drawn by the component that waits for the pointer and the focus, once for each notice', () => {
    const sidebar = readFileSync(new URL('../renderer/Sidebar.tsx', import.meta.url), 'utf8')
    expect(sidebar).toMatch(/\{toast && <SidebarToast key=\{toast\.id\} toast=\{toast\} act=\{act\} \/>\}/)
    expect(sidebar).not.toMatch(/onMouseEnter=\{\(\) => act\.toastHold/)
  })
})

// Contract: the entry point needs Electron, so its source is read (the part of it that wires the annotation, shell/annotate-wiring.ts). The setting of the keys
// of one letter of the page annotation reaches the annotation (each key reads it), and a change of the settings tells the open bar so that it stops naming the letters.
describe('the keys of one letter of the page annotation', () => {
  it('read the setting at each key, and tell the bar when it changes', () => {
    const entry = readFileSync(new URL('./shell/annotate-wiring.ts', import.meta.url), 'utf8')
    expect(entry).toMatch(/letterKeys: \(\) => sharedStore\.get\(\)\.settings\.annotateLetterKeys/)
    expect(entry).toMatch(/pageAnnotate\?\.refreshLetterKeys\(\)/)
  })
})

// Contract: the entry point needs Electron, so its source is read. The system's « Toujours afficher les barres de défilement » is read at launch (on macOS
// only) with its notification, read again each time the application becomes active, and let go at quit.
describe('the scroll bars setting of the system', () => {
  it('is started with the real source on macOS only, read again on activation, and stopped at quit', () => {
    const entry = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const block = /if \(process\.platform === 'darwin'\) \{\s*systemScrollBars\(\)\.start\(systemScrollBarsSource\(systemPreferences\)\)[\s\S]*?\n  \}/.exec(entry)?.[0] ?? ''
    expect(block).toContain("app.on('did-become-active', () => systemScrollBars().refresh())")
    expect(block).toContain("app.on('will-quit', () => systemScrollBars().stop())")
  })
})

describe('the copies of another browser’s history left by an import cut short', () => {
  // Contract: what the sweep removes, and that the launch's one waits a little, is tested in importers/sqlite.test.ts; here, that a launch asks for it
  // once the application is ready, not only the next import (the entry point needs Electron, so its source is read).
  it('are swept at launch, a while after it: the sweep reads the whole temporary folder, and the first window does not wait for it', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/await app\.whenReady\(\)[\s\S]*?\n\s*sweepStaleCopiesSoon\(tmpdir\(\)\)/)
    expect(source).not.toMatch(/\bsweepStaleCopies\(/)
  })
})

describe('the block-exception handlers of the tabs', () => {
  // Contract: what the follower does is tested in block-handlers.test.ts; here, that the entry point (which needs Electron, so its source is read) gives it
  // the list of the tabs itself, not a set built from it at every change of the state.
  it('follow the list of the tabs of the state', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(source).toContain('followBlockHandlers(store.get().tabs)')
    expect(source).not.toMatch(/new Set\(store\.get\(\)\.tabs/)
  })
})

describe('the hosts held to strict transport security, when the application quits', () => {
  // Contract: what the engine writes then is tested in engine/strict-transport-store.test.ts and local-file-wiring.test.ts, and the other ways out
  // (a quit of the system, « Installer et relancer », will-quit) in shell/; here, that the plain quit of the entry point asks for it (its source is read).
  it('are written on before-quit, with the state, the history and the records of the downloads', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/app\.on\('before-quit', \(\) => \{[^}]*engine\.flushDownloadResume\(\)[^}]*engine\.flushStrictTransport\(\)[^}]*\}\)/)
  })
})

describe('the check of the feed before a quit installs a downloaded update', () => {
  // Contract: what the check holds, drops and keeps is tested in shell/update-quit-check.test.ts; here, that the entry point (its source is read)
  // installs it after the quit flow, whose question and erasure it waits for, on the feed Squirrel installs from, and keeps a drop in the profile.
  it('is installed after the quit flow, reads the feed of the installer, and keeps what it dropped for the next launch', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/const systemQuit = installQuitFlow\(\{[\s\S]*?\n {2}installUpdateQuitCheck\(\{/)
    expect(source).toContain('allowed: () => store.get().settings.autoUpdate,')
    expect(source).toContain('withdrawn: () => withdrawnInFeed(currentUpdateSources(store.get().settings).install)')
    expect(source).toContain(`remember: (dropped) => store.dispatch({ type: 'settings/update', patch: { updateNotices: { ...cleanUpdateNotices(store.get().settings.updateNotices), dropped } } })`)
    expect(source).toContain('system: () => systemQuit.isActive()')
  })
})
