import { chmodSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { backupId, copyDataOf, serializeCopy, type SessionCopyData } from '@shared/session-backups'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { BackupFiles } from '../backup-store'
import { takePersistenceNotices } from '../persistence-notices'
import { SessionBackups, type BackupDeps } from './backups'
import { tempDir } from '../temp-dir'
import { frenchSpaces } from '@shared/french-typography'

const MINUTE = 60_000
const START = new Date(2026, 9, 24, 10, 0, 0).getTime()

let n = 0
const ctx = () => ({ now: Date.now(), newId: () => `id${++n}` })

/** The service over real files in a throw-away folder, a state it can be changed through, and the effects recorded. */
function setup(settings: Partial<SidebarState['settings']> = {}, extra: Partial<BackupDeps> = {}) {
  const dir = join(tempDir('lucium-service-'), 'copies')
  const files = new BackupFiles(dir)
  let state: SidebarState = { ...createInitialState(ctx()), settings: { ...createInitialState(ctx()).settings, ...settings } }
  const listeners = new Set<() => void>()
  const applied: SessionCopyData[] = []
  const toasts: Array<{ message: string; action?: { label: string; run: () => void } }> = []
  const service = new SessionBackups({
    files,
    state: () => state,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    apply: (copy) => {
      applied.push(copy)
      state = reduce(state, { type: 'backup/restore', copy }, ctx())
      listeners.forEach((l) => l())
    },
    toast: (message, action) => toasts.push({ message, action }),
    ...extra
  })
  const dispatch = (...actions: Action[]) => {
    for (const action of actions) state = reduce(state, action, ctx())
    listeners.forEach((l) => l())
  }
  const open = (url: string) => dispatch({ type: 'tab/open', url, background: true })
  return { dir, files, service, dispatch, open, applied, toasts, listeners, state: () => state }
}

let errors: unknown[][]
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  takePersistenceNotices()
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the schedule', () => {
  it('is not worked out again at a change of the state that leaves the settings as they were, and is at once when a setting changes', () => {
    const t = setup()
    let stateReads = 0
    let settingsWorkedOut = 0
    // Settings that count each time the schedule is worked out from them (it reads `autoBackup`).
    const counted = (minutes: number): SidebarState['settings'] =>
      Object.defineProperty({ ...t.state().settings, autoBackupMinutes: minutes }, 'autoBackup', { get: () => (settingsWorkedOut++, true), enumerable: true })
    let settings = counted(30)
    const service = new SessionBackups({
      files: t.files,
      state: () => (stateReads++, t.state()),
      settings: () => settings,
      subscribe: (l) => (t.listeners.add(l), () => t.listeners.delete(l)),
      apply: () => undefined,
      toast: () => undefined
    })
    service.start()
    const atStart = settingsWorkedOut
    expect(atStart).toBeGreaterThan(0)
    stateReads = 0
    // Fifty tabs opened: fifty changes of the state, none of the settings. Neither the whole state nor the schedule is worked out again.
    for (let i = 0; i < 50; i++) t.open(`https://site${i}.example/`)
    expect(settingsWorkedOut).toBe(atStart)
    expect(stateReads).toBe(0)
    // A setting that changes is followed at once: the new delay is the one the next copy waits for.
    settings = counted(5)
    t.listeners.forEach((l) => l())
    expect(settingsWorkedOut).toBe(atStart * 2)
    vi.advanceTimersByTime(5 * MINUTE)
    expect(readdirSync(t.dir)).toHaveLength(1)
    service.stop()
  })

  it('makes a copy every half hour by default, and only when something changed since the last one', () => {
    const t = setup()
    t.open('https://a.example/')
    t.service.start()
    vi.advanceTimersByTime(30 * MINUTE)
    expect(t.files.ids()).toHaveLength(1)
    vi.advanceTimersByTime(30 * MINUTE)
    expect(t.files.ids()).toHaveLength(1)
    t.open('https://b.example/')
    vi.advanceTimersByTime(30 * MINUTE)
    expect(t.files.ids()).toHaveLength(2)
    expect(t.files.read(t.files.ids()[0]!).data.tabs).toHaveLength(2)
    t.service.stop()
  })

  it('does not count a page that changed its title, or a tab that was used, as a change', () => {
    const t = setup()
    t.open('https://a.example/')
    t.dispatch({ type: 'tab/select', id: t.state().tabs[0]!.id })
    t.service.start()
    vi.advanceTimersByTime(30 * MINUTE)
    expect(t.files.ids()).toHaveLength(1)
    const tab = t.state().tabs[0]!
    t.dispatch({ type: 'tab/update', id: tab.id, patch: { title: 'Another title' } }, { type: 'tab/select', id: tab.id })
    vi.advanceTimersByTime(60 * MINUTE)
    expect(t.files.ids()).toHaveLength(1)
    // …while an address that changed is one.
    t.dispatch({ type: 'tab/update', id: tab.id, patch: { url: 'https://elsewhere.example/' } })
    vi.advanceTimersByTime(30 * MINUTE)
    expect(t.files.ids()).toHaveLength(2)
    t.service.stop()
  })

  it('follows the delay of the settings, and the change takes effect at once', () => {
    const t = setup({ autoBackupMinutes: 5 })
    t.open('https://a.example/')
    t.service.start()
    vi.advanceTimersByTime(5 * MINUTE)
    expect(t.files.ids()).toHaveLength(1)
    t.dispatch({ type: 'settings/update', patch: { autoBackupMinutes: 60 } })
    t.open('https://b.example/')
    vi.advanceTimersByTime(30 * MINUTE)
    expect(t.files.ids()).toHaveLength(1)
    vi.advanceTimersByTime(30 * MINUTE)
    expect(t.files.ids()).toHaveLength(2)
    t.service.stop()
  })

  it('makes no copy while the copies are off, and starts with one when they are switched on', () => {
    const t = setup({ autoBackup: false })
    t.open('https://a.example/')
    t.service.start()
    vi.advanceTimersByTime(24 * 60 * MINUTE)
    expect(t.files.ids()).toEqual([])
    expect(t.service.backUp('quit')).toEqual({ ok: true, id: null })
    t.dispatch({ type: 'settings/update', patch: { autoBackup: true } })
    expect(t.files.ids()).toHaveLength(1)
    t.dispatch({ type: 'settings/update', patch: { autoBackup: false } })
    t.open('https://b.example/')
    vi.advanceTimersByTime(24 * 60 * MINUTE)
    expect(t.files.ids()).toHaveLength(1)
    t.service.stop()
  })

  it('keeps the number of copies the settings say, and prunes at once when the number is lowered', () => {
    const t = setup({ autoBackupKeep: 10, autoBackupMinutes: 5 })
    t.service.start()
    for (let i = 0; i < 6; i++) {
      t.open(`https://a${i}.example/`)
      vi.advanceTimersByTime(5 * MINUTE)
    }
    expect(t.files.ids()).toHaveLength(6)
    t.dispatch({ type: 'settings/update', patch: { autoBackupKeep: 3 } })
    expect(t.files.ids()).toHaveLength(3)
    for (let i = 6; i < 12; i++) {
      t.open(`https://a${i}.example/`)
      vi.advanceTimersByTime(5 * MINUTE)
    }
    expect(t.files.ids()).toHaveLength(3)
    expect(t.files.read(t.files.ids()[0]!).data.tabs).toHaveLength(12)
    t.service.stop()
  })

  it('stops for good when stopped: no timer is left to keep the application alive or to write later', () => {
    const t = setup()
    t.open('https://a.example/')
    t.service.start()
    t.service.stop()
    vi.advanceTimersByTime(24 * 60 * MINUTE)
    expect(t.files.ids()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not keep the process alive: its timer is unreferenced', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const t = setup()
    t.service.start()
    const handle = spy.mock.results[0]!.value as NodeJS.Timeout
    expect(handle.hasRef()).toBe(false)
    t.service.stop()
    spy.mockRestore()
  })
})

describe('what is worth a copy', () => {
  it('makes none for a browser with nothing in it (no tab, no folder, no archive, one space), so that it never pushes a useful copy out', () => {
    const t = setup({ autoBackupKeep: 2 })
    t.open('https://a.example/')
    expect(t.service.backUp('manual').ok).toBe(true)
    const before = t.files.ids()
    t.dispatch({ type: 'tab/close', id: t.state().tabs[0]!.id })
    expect(t.state().tabs).toHaveLength(0)
    expect(t.state().archive).toHaveLength(0)
    for (const reason of ['auto', 'quit', 'manual', 'before-restore'] as const) expect(t.service.backUp(reason)).toEqual({ ok: true, id: null })
    expect(t.files.ids()).toEqual(before)
  })

  it('makes a copy asked for, or before a restoration, of a session with no open tab that still holds an archive, a folder or a second space; a scheduled one still waits for a tab', () => {
    const t = setup({ autoBackupKeep: 5 })
    t.open('https://a.example/')
    t.dispatch({ type: 'tab/archive', id: t.state().tabs[0]!.id })
    expect(t.state().tabs).toHaveLength(0)
    expect(t.state().archive.length).toBeGreaterThan(0)
    for (const reason of ['auto', 'quit'] as const) expect(t.service.backUp(reason)).toEqual({ ok: true, id: null })
    expect(t.files.ids()).toEqual([])
    expect(t.service.backUp('before-restore')).toMatchObject({ ok: true, id: expect.any(String) })
    vi.advanceTimersByTime(1000)
    expect(t.service.backUp('manual')).toMatchObject({ ok: true, id: expect.any(String) })
    expect(t.files.ids()).toHaveLength(2)
    const folders = setup()
    folders.dispatch({ type: 'folder/create', name: 'Dossier' })
    expect(folders.state().folders.length).toBeGreaterThan(0)
    expect(folders.service.backUp('manual')).toMatchObject({ ok: true, id: expect.any(String) })
    const spaces = setup()
    spaces.dispatch({ type: 'space/create', name: 'Deux', emoji: '2', hue: 10 })
    expect(spaces.state().spaces).toHaveLength(2)
    expect(spaces.service.backUp('before-restore')).toMatchObject({ ok: true, id: expect.any(String) })
  })

  it('makes one when the application quits, if the session changed since the last one', () => {
    const t = setup()
    t.open('https://a.example/')
    t.service.start()
    expect(t.service.backUp('quit').ok).toBe(true)
    expect(t.files.ids()).toHaveLength(1)
    expect(t.files.read(t.files.ids()[0]!).reason).toBe('quit')
    expect(t.service.backUp('quit')).toEqual({ ok: true, id: null })
    t.open('https://b.example/')
    expect(t.service.backUp('quit')).toMatchObject({ ok: true, id: expect.any(String) })
    expect(t.files.ids()).toHaveLength(2)
    t.service.stop()
  })

  it('does not copy again, after a restart, a session the newest copy on disk already holds', () => {
    const t = setup()
    t.open('https://a.example/')
    t.service.backUp('auto')
    const again = new SessionBackups({ files: t.files, state: t.state.bind(t), subscribe: () => () => {}, apply: () => {}, toast: () => {} })
    expect(again.backUp('quit')).toEqual({ ok: true, id: null })
    expect(t.files.ids()).toHaveLength(1)
  })

  it('makes a manual copy whenever it is asked, even of a session already copied', () => {
    const t = setup()
    t.open('https://a.example/')
    t.service.backUp('auto')
    vi.advanceTimersByTime(1000)
    expect(t.service.backUp('manual')).toMatchObject({ ok: true, id: expect.any(String) })
    expect(t.files.ids()).toHaveLength(2)
  })
})

describe('a copy that cannot be written', () => {
  it('is logged with its reason, reported once to the user however many times it fails, and retried at the next copy', () => {
    const t = setup({ autoBackupMinutes: 5 })
    t.open('https://a.example/')
    t.service.start()
    t.service.backUp('manual')
    chmodSync(t.dir, 0o500)
    try {
      t.open('https://b.example/')
      vi.advanceTimersByTime(5 * MINUTE)
      t.open('https://c.example/')
      vi.advanceTimersByTime(5 * MINUTE)
    } finally {
      chmodSync(t.dir, 0o700)
    }
    expect(errors.filter((e) => String(e[0]).includes('cannot write a copy'))).toHaveLength(2)
    const notices = takePersistenceNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ kind: 'backup-failed' })
    expect(t.files.ids()).toHaveLength(1)
    t.open('https://d.example/')
    vi.advanceTimersByTime(5 * MINUTE)
    expect(t.files.ids()).toHaveLength(2)
    expect(errors.map((e) => String(e[0])).join()).toContain('can be written again')
    // The next failure is told again.
    chmodSync(t.dir, 0o500)
    try {
      t.open('https://e.example/')
      vi.advanceTimersByTime(5 * MINUTE)
    } finally {
      chmodSync(t.dir, 0o700)
    }
    expect(takePersistenceNotices()).toHaveLength(1)
    t.service.stop()
  })
})

describe('restoring a copy', () => {
  function twoStates() {
    const t = setup()
    t.open('https://old.example/')
    t.service.backUp('manual')
    const oldId = t.files.ids()[0]!
    vi.advanceTimersByTime(MINUTE)
    t.open('https://new.example/')
    t.dispatch({ type: 'favorite/add', url: 'https://fav.example/', title: 'F' })
    return { ...t, oldId }
  }

  it('makes a copy of the session it replaces first, then replaces it, and says so with a way back', () => {
    const t = twoStates()
    const result = t.service.restore(t.oldId)
    expect(result).toEqual({ ok: true, tabs: 1, spaces: 1 })
    expect(t.state().tabs.map((x) => x.url)).toEqual(['https://old.example/'])
    const before = t.files.ids().map((id) => t.files.read(id)).find((c) => c.reason === 'before-restore')!
    expect(before.data.tabs.map((x) => x.url)).toEqual(['https://old.example/', 'https://new.example/'])
    expect(t.toasts).toHaveLength(1)
    expect(t.toasts[0]!.message).toBe(frenchSpaces('Copie restaurée : 1 onglet, 1 espace'))
    expect(t.toasts[0]!.action!.label).toBe('Annuler')
    // What is not the session stays.
    expect(t.state().favorites).toHaveLength(1)
  })

  it('copies first, and offers the way back, when the session it replaces has no open tab but holds an archive, folders or spaces', () => {
    const t = setup()
    t.open('https://old.example/')
    t.service.backUp('manual')
    const oldId = t.files.ids()[0]!
    vi.advanceTimersByTime(MINUTE)
    t.open('https://gone.example/')
    t.dispatch({ type: 'tab/archive', id: t.state().tabs.at(-1)!.id }, { type: 'tab/close', id: t.state().tabs[0]!.id })
    t.dispatch({ type: 'folder/create', name: 'Dossier' })
    expect(t.state().tabs).toHaveLength(0)
    expect(t.state().archive.length + t.state().folders.length).toBeGreaterThan(0)
    expect(t.service.restore(oldId)).toMatchObject({ ok: true })
    const before = t.files.ids().map((id) => t.files.read(id)).find((c) => c.reason === 'before-restore')
    expect(before?.data.folders.map((f) => f.name)).toEqual(['Dossier'])
    expect(t.toasts[0]!.action?.label).toBe('Annuler')
    t.toasts[0]!.action!.run()
    expect(t.state().folders.map((f) => f.name)).toEqual(['Dossier'])
    expect(t.state().tabs).toHaveLength(0)
  })

  it('goes back with the notice’s button: the session before the restoration is put back, and the one it replaced is kept in turn', () => {
    const t = twoStates()
    t.service.restore(t.oldId)
    t.toasts[0]!.action!.run()
    expect(t.state().tabs.map((x) => x.url)).toEqual(['https://old.example/', 'https://new.example/'])
    expect(t.toasts).toHaveLength(2)
    t.toasts[1]!.action!.run()
    expect(t.state().tabs.map((x) => x.url)).toEqual(['https://old.example/'])
  })

  it('restores nothing when the copy of the current session cannot be made, and tells why: the data about to go would exist nowhere else', () => {
    const t = twoStates()
    chmodSync(t.dir, 0o500)
    let result
    try {
      result = t.service.restore(t.oldId)
    } finally {
      chmodSync(t.dir, 0o700)
    }
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('rien n’a été restauré') })
    expect(t.applied).toEqual([])
    expect(t.state().tabs).toHaveLength(2)
    expect(t.toasts).toEqual([])
  })

  it('restores nothing from a copy that cannot be read, says so, and logs it', () => {
    const t = twoStates()
    const broken = backupId(Date.now() + 5000)
    writeFileSync(join(t.dir, `${broken}.json`), '{ truncated')
    expect(t.service.restore(broken)).toMatchObject({ ok: false, message: expect.stringContaining('illisible') })
    expect(t.applied).toEqual([])
    expect(t.state().tabs).toHaveLength(2)
    expect(errors.map((e) => String(e[0])).join()).toContain(broken)
    // No copy of the current session was made for a restoration that did not happen.
    expect(t.files.ids().map((id) => id).filter((id) => id !== broken && id !== t.oldId)).toEqual([])
  })

  it('refuses an id that is not a copy’s, a copy that does not exist, and anything that is not a string', () => {
    const t = twoStates()
    for (const hostile of ['../x', 'copie-1', null, undefined, 5, {}, [], '/etc/passwd']) {
      expect(t.service.restore(hostile), String(hostile)).toEqual({ ok: false, message: 'Cette copie n’existe pas.' })
    }
    for (const missing of ['copie-1700000000000', backupId(1)]) {
      expect(t.service.restore(missing), missing).toMatchObject({ ok: false, message: expect.stringContaining('illisible') })
    }
    expect(t.applied).toEqual([])
    expect(t.state().tabs).toHaveLength(2)
  })

  it('applies the copy as it was read, repaired: a copy edited by hand cannot bring in a script address', () => {
    const t = twoStates()
    const forged = JSON.parse(serializeCopy({ createdAt: Date.now() + 9000, reason: 'auto', data: copyDataOf(t.state()) })) as { data: { tabs: Array<Record<string, unknown>> } }
    forged.data.tabs.push({ ...forged.data.tabs[0]!, id: 'evil', url: 'javascript:alert(1)' })
    const id = backupId(Date.now() + 9000)
    writeFileSync(join(t.dir, `${id}.json`), JSON.stringify(forged))
    expect(t.service.restore(id)).toMatchObject({ ok: true })
    expect(t.state().tabs.map((x) => x.id)).not.toContain('evil')
  })

  it('lists what the panel shows: newest first, with whether the copies are on', () => {
    const t = twoStates()
    t.service.restore(t.oldId)
    const listing = t.service.list()
    expect(listing.enabled).toBe(true)
    expect(listing.unreadable).toBe(0)
    expect(listing.entries.map((e) => e.reason)).toEqual(['before-restore', 'manual'])
    t.dispatch({ type: 'settings/update', patch: { autoBackup: false } })
    expect(t.service.list().enabled).toBe(false)
    expect(readdirSync(t.dir)).toHaveLength(2)
  })
})

describe('putting a copy back while a space is locked', () => {
  it('is refused with the reason, before any copy of the present session is made, and is allowed again once unlocked', () => {
    let locked = true
    const sentence = 'Déverrouillez vos espaces verrouillés avant de restaurer.'
    const t = setup({}, { refusal: () => (locked ? sentence : null) })
    t.open('https://old.example/')
    t.service.backUp('manual')
    const oldId = t.files.ids()[0]!
    vi.advanceTimersByTime(MINUTE)
    t.open('https://new.example/')
    expect(t.service.restore(oldId)).toEqual({ ok: false, message: sentence })
    expect(t.applied).toEqual([])
    expect(t.toasts).toEqual([])
    expect(t.state().tabs.map((x) => x.url)).toEqual(['https://old.example/', 'https://new.example/'])
    expect(t.files.ids()).toEqual([oldId])
    locked = false
    expect(t.service.restore(oldId)).toMatchObject({ ok: true })
    expect(t.state().tabs.map((x) => x.url)).toEqual(['https://old.example/'])
  })
})
