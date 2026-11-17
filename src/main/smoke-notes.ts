// Engine checks for what the notes panel shows (File › Notes…), in a real Electron: three notes written in the file of the throw-away profile (one
// tied to a local page, one to the space on screen, one to another page), a tab on that page, the panel opened as the menu opens it, driven with real
// clicks and keys. What is checked: the choice it opens on (« Cette page » when the page has notes, « Toutes » otherwise), the arrows of the group of
// choices and the count of the header that follows them, a note of another page opened in the editor while the tab stays where it is, and the note
// « Nouvelle note » opens that makes way for the list when « Toutes » is chosen. The private window and the locked space are the main process's
// refusals (shell/notes-ipc.test.ts): no note reaches the panel there. `LUCIUM_SMOKE_ONLY=notes` runs this file alone.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { notePageAddress, type NoteLink } from '@shared/notes'
import { activeTab } from '@shared/sidebar'
import type { SmokeContext } from './smoke'
import { getLockService } from './lock-service'
import { notesFile } from './notes-store'
import { noteCheck, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

const waitFor = waiterOf(8000, 60)

/** What the panel shows: the choice checked under its header, the count of the header, the titles of its rows, whether the editor is open. */
interface Look {
  panel: boolean
  checked: string | null
  choices: string[]
  count: string | null
  titles: string[]
  editor: boolean
  linkedTo: string | null
}

const LOOK = `(() => {
  const panel = document.querySelector('.notes-panel')
  if (!panel) return { panel: false, checked: null, choices: [], count: null, titles: [], editor: false, linkedTo: null }
  return {
    panel: true,
    checked: panel.querySelector('[role="radiogroup"] [role="radio"][aria-checked="true"]')?.textContent ?? null,
    choices: [...panel.querySelectorAll('[role="radiogroup"] [role="radio"]')].map((el) => el.textContent ?? ''),
    count: panel.querySelector('.lp-count')?.textContent ?? null,
    titles: [...panel.querySelectorAll('.lp-body .lp-title')].map((el) => el.textContent ?? ''),
    editor: panel.querySelector('form.notes-editor') !== null,
    linkedTo: panel.querySelector('.notes-choice input:checked + span')?.textContent ?? null
  }
})()`

export async function smokeNotes(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, overlayView } = ctx
  const ui = overlayView.webContents
  const state = () => store.get()
  const run = <T>(script: string) => ui.executeJavaScript(script) as Promise<T>
  const look = () => run<Look>(LOOK)
  const file = notesFile()
  if (!file) throw new Error('the notes file is not configured')
  const wasOn = state().settings.notes
  if (!wasOn) browser.dispatch({ type: 'settings/update', patch: { notes: true } })

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<title>notes ${req.url ?? '/'}</title><body>${req.url ?? '/'}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const page = notePageAddress(`${base}/article`)!
  const made: string[] = []

  /** The notes the window is given: the file's, but those of a locked space. */
  const visible = () => {
    const locked = new Set(getLockService()?.lockedSpaces() ?? [])
    return file.read().filter((note) => !(note.link?.kind === 'space' && locked.has(note.link.spaceId)))
  }
  /** Opens a tab on `url` and waits until it is the tab on screen. */
  const openTab = async (url: string): Promise<boolean> => {
    browser.dispatch({ type: 'tab/open', url })
    return waitFor(() => activeTab(state())?.url === url)
  }
  /** Opens the panel afresh (closed first, so that nothing of the last opening is read), and waits for its choices. */
  const openNotes = async (compose: boolean): Promise<boolean> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.closeOverlay()
      await waitFor(async () => !(await look()).panel, 2500)
      browser.openOverlay(compose ? { panel: 'notes', compose: true } : { panel: 'notes' })
      if (await waitFor(async () => browser.currentPanel() === 'notes' && (await look()).choices.length > 0, 2500)) return true
    }
    return false
  }
  /** A real click in the middle of the first element of the panel that matches `selector` and holds `text`. */
  const clickOn = async (selector: string, text: string): Promise<boolean> => {
    const at = await run<{ x: number; y: number } | null>(
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(`.notes-panel ${selector}`)})].find((e) => (e.textContent ?? '').includes(${JSON.stringify(text)})); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })()`
    )
    if (!at) return false
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) ui.sendInputEvent({ type, x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 })
    return true
  }
  const key = (keyCode: string) => {
    ui.sendInputEvent({ type: 'keyDown', keyCode })
    ui.sendInputEvent({ type: 'keyUp', keyCode })
  }

  try {
    const space = state().activeSpaceId
    const notes: Array<[string, NoteLink]> = [
      ['Contrôle notes : la page', { kind: 'page', url: page }],
      ['Contrôle notes : l’espace', { kind: 'space', spaceId: space }],
      ['Contrôle notes : ailleurs', { kind: 'page', url: notePageAddress(`${base}/ailleurs`)! }]
    ]
    for (const [text, link] of notes) {
      const outcome = file.create(text, link)
      if (outcome.ok && outcome.id) made.push(outcome.id)
    }
    check('notes: the three notes of the check are in the file', made.length === 3, JSON.stringify(made))

    check('notes: a tab on the page of the first note is on screen', await openTab(page), JSON.stringify(activeTab(state())?.url))
    const onPage = await openNotes(false)
    let seen = await look()
    check('notes: the panel opens on « Cette page » when the page has notes, the header counting them, only its note in the list', onPage && seen.checked === 'Cette page' && seen.count === '1' && JSON.stringify(seen.titles) === JSON.stringify(['Contrôle notes : la page']), JSON.stringify(seen))
    check('notes: the choices are « Cette page », « Cet espace », « Toutes », in a named group of radios', JSON.stringify(seen.choices) === JSON.stringify(['Cette page', 'Cet espace', 'Toutes']) && (await run<string | null>(`document.querySelector('.notes-panel [role="radiogroup"]')?.getAttribute('aria-label') ?? null`)) === 'Notes affichées', JSON.stringify(seen.choices))

    // The arrows, from the choice the click put the focus on: → the space, → every note.
    const inSpace = String(visible().filter((note) => note.link?.kind === 'space' && note.link.spaceId === space).length)
    const all = String(visible().length)
    await clickOn('[role="radio"]', 'Cette page')
    const focused = await waitFor(() => run<boolean>(`document.activeElement?.getAttribute('role') === 'radio'`))
    key('Right')
    const toSpace = await waitFor(async () => (await look()).checked === 'Cet espace')
    seen = await look()
    check('notes: → moves to « Cet espace », and the header counts the notes of the space', focused && toSpace && seen.count === inSpace && seen.titles.includes('Contrôle notes : l’espace') && !seen.titles.includes('Contrôle notes : la page'), JSON.stringify({ focused, seen, inSpace }))
    key('Right')
    const toAll = await waitFor(async () => (await look()).checked === 'Toutes')
    seen = await look()
    check('notes: → again moves to « Toutes »: every note the window may see, counted in the header', toAll && seen.count === all && ['Contrôle notes : la page', 'Contrôle notes : l’espace', 'Contrôle notes : ailleurs'].every((title) => seen.titles.includes(title)), JSON.stringify({ seen, all }))

    // A note of another page, opened from « Toutes »: in the editor, tied to its own page; the tab on screen and the tabs stay as they were.
    const tabsBefore = state().tabs.length
    await clickOn('.lp-main', 'Contrôle notes : ailleurs')
    const opened = await waitFor(async () => (await look()).editor)
    seen = await look()
    check('notes: a click on a note of another page opens it in the editor, tied to that page, and the tab does not change', opened && /127\.0\.0\.1/.test(seen.linkedTo ?? '') && activeTab(state())?.url === page && state().tabs.length === tabsBefore && browser.currentPanel() === 'notes', JSON.stringify({ seen, active: activeTab(state())?.url, tabs: state().tabs.length, tabsBefore }))

    // « Nouvelle note » on the page: the empty note makes way for the list when « Toutes » is chosen; the panel stays.
    const composing = await openNotes(true)
    const quick = (await look()).editor
    await clickOn('[role="radio"]', 'Toutes')
    const away = await waitFor(async () => {
      const now = await look()
      return now.checked === 'Toutes' && !now.editor
    })
    seen = await look()
    check('notes: « Nouvelle note » then « Toutes »: the empty note goes, the list of every note is in view, the panel stays', composing && quick && away && browser.currentPanel() === 'notes' && seen.titles.includes('Contrôle notes : ailleurs'), JSON.stringify({ composing, quick, seen }))

    // A page with no note: the panel opens on every note rather than on an empty list.
    const empty = notePageAddress(`${base}/vide`)!
    const onEmpty = (await openTab(empty)) && (await openNotes(false))
    seen = await look()
    check('notes: on a page without notes the panel opens on « Toutes »', onEmpty && seen.checked === 'Toutes' && seen.count === String(visible().length), JSON.stringify(seen))
  } finally {
    browser.closeOverlay()
    for (const id of made) file.remove(id)
    for (const tab of [...state().tabs]) if (tab.url.startsWith(base)) browser.dispatch({ type: 'tab/close', id: tab.id })
    if (!wasOn) browser.dispatch({ type: 'settings/update', patch: { notes: false } })
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** `LUCIUM_SMOKE_ONLY=notes`, and its place in the chain: these checks with their own report. */
export async function runNotesSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.overlayView.webContents.on('console-message', (event) => {
    if (event.level === 'error') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    await smokeNotes(ctx, (name, ok, detail) => noteCheck(checks, name, ok, detail))
  } catch (error) {
    noteCheck(checks, 'smokeNotes ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_NOTES ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
