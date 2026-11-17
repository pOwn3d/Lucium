import { describe, expect, it } from 'vitest'
import { BACKUP_KEEP_CHOICES, BACKUP_MINUTES_CHOICES, backupPlan, cleanBackupSettings, minutesLabel } from './backup-settings'
import { STATE_REVISION, defaultSettings, type SidebarState } from './model'
import { setLanguage } from './i18n'
import {
  ASKED_COPIES_KEPT,
  COPY_BYTES_MAX,
  COPY_FORMAT,
  COPY_HEAD_BYTES,
  COPY_REASONS,
  COPY_VERSION,
  backupId,
  copiesToPrune,
  copyDataOf,
  copyFingerprint,
  copyWhen,
  entryOf,
  hasSessionContent,
  holdsRestorableContent,
  isBackupId,
  newestFirst,
  nextStamp,
  parseCopy,
  reasonLabel,
  reasonOfCopyHead,
  serializeCopy,
  stampOfBackupId,
  toPrune,
  type SessionCopy
} from './session-backups'
import { createInitialState, normalize, reduce, type Action, type Ctx } from './sidebar'

function makeCtx(now = 1_700_000_000_000): Ctx {
  let n = 0
  return { now, newId: () => `id${++n}` }
}
const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

function session() {
  const ctx = makeCtx()
  let s = createInitialState(ctx)
  const home = s.activeSpaceId
  s = run(ctx, s, { type: 'tab/open', url: 'https://a.example/', background: true }, { type: 'tab/open', url: 'https://b.example/', background: true })
  const [a, b] = s.tabs
  s = run(ctx, s, { type: 'tab/pin', id: a!.id }, { type: 'folder/create-with', tabIds: [a!.id], name: 'Docs' })
  s = run(ctx, s, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 })
  const work = s.activeSpaceId
  s = run(ctx, s, { type: 'tab/open', url: 'https://c.example/' }, { type: 'tab/archive', id: b!.id })
  return { ctx, state: s, home, work }
}

const copyOf = (state: SidebarState, createdAt = 1_700_000_000_000, reason: SessionCopy['reason'] = 'auto'): SessionCopy => ({ createdAt, reason, data: copyDataOf(state) })

describe('what a copy holds', () => {
  it('is the spaces, tabs, folders, split views, archive and what is on screen, and nothing else', () => {
    const { state } = session()
    expect(Object.keys(copyDataOf(state)).sort()).toEqual(['activeSpaceId', 'activeTabBySpace', 'archive', 'folders', 'spaces', 'splits', 'tabs'])
  })

  it('keeps an icon only as an address, so that no copy swells with pictures', () => {
    const { state } = session()
    const heavy = { ...state, tabs: state.tabs.map((t, i) => ({ ...t, faviconUrl: i === 0 ? `data:image/png;base64,${'A'.repeat(20_000)}` : 'https://x.example/i.ico' })) }
    const data = copyDataOf(heavy)
    expect(data.tabs[0]).not.toHaveProperty('faviconUrl')
    expect(data.tabs.slice(1).every((t) => t.faviconUrl === 'https://x.example/i.ico')).toBe(true)
  })

  it('is worth making only when there is a tab: an empty browser must not push a useful copy out', () => {
    const { state } = session()
    expect(hasSessionContent(state)).toBe(true)
    expect(hasSessionContent({ ...state, tabs: [] })).toBe(false)
  })

  it('is worth keeping before a restoration, or when asked, as soon as the session holds anything the restoration replaces', () => {
    const { state } = session()
    const bare = { ...state, tabs: [], folders: [], archive: [], spaces: state.spaces.slice(0, 1) }
    expect(holdsRestorableContent(bare)).toBe(false)
    expect(holdsRestorableContent({ ...bare, tabs: state.tabs })).toBe(true)
    expect(holdsRestorableContent({ ...bare, folders: [{ id: 'f', spaceId: bare.spaces[0]!.id, name: 'F', collapsed: false }] as SidebarState['folders'] })).toBe(true)
    expect(holdsRestorableContent({ ...bare, archive: [{ id: 'a', url: 'https://a.example/', title: 'A', archivedAt: 1 }] as SidebarState['archive'] })).toBe(true)
    expect(holdsRestorableContent({ ...bare, spaces: state.spaces.length > 1 ? state.spaces : [...bare.spaces, { ...bare.spaces[0]!, id: 'second' }] })).toBe(true)
  })
})

describe('the fingerprint of a session', () => {
  const { state, work } = session()
  const print = (s: SidebarState) => copyFingerprint(copyDataOf(s))

  it('is the same for the same session, however long ago a tab was used and whatever a page calls itself', () => {
    const touched = { ...state, tabs: state.tabs.map((t) => ({ ...t, lastActiveAt: t.lastActiveAt + 99_999, title: `${t.title} (2)` })) }
    expect(print(touched)).toBe(print(state))
  })

  it('changes with an address, a new or closed tab, a pin, a folder, a space, a theme, the tab on screen or the archive', () => {
    const first = state.tabs[0]!
    const changes: SidebarState[] = [
      { ...state, tabs: state.tabs.map((t) => (t.id === first.id ? { ...t, url: 'https://elsewhere.example/' } : t)) },
      { ...state, tabs: [...state.tabs, { ...first, id: 'extra' }] },
      { ...state, tabs: state.tabs.slice(1) },
      { ...state, tabs: state.tabs.map((t) => (t.id === first.id ? { ...t, pinned: !t.pinned } : t)) },
      { ...state, folders: [] },
      { ...state, spaces: state.spaces.slice(1) },
      { ...state, spaces: state.spaces.map((s) => (s.id === work ? { ...s, name: 'Autre' } : s)) },
      { ...state, spaces: state.spaces.map((s) => (s.id === work ? { ...s, theme: { ...s.theme, intensity: 0.5 } } : s)) },
      { ...state, activeTabBySpace: { ...state.activeTabBySpace, [work]: null } },
      { ...state, archive: [] }
    ]
    for (const [i, changed] of changes.entries()) expect(print(changed), `change ${i}`).not.toBe(print(state))
  })
})

describe('writing a copy and reading it back', () => {
  it('gives back what was written, whatever the state holds', () => {
    const { state } = session()
    const copy = copyOf(state, 1_700_000_000_123, 'manual')
    expect(parseCopy(serializeCopy(copy))).toStrictEqual(copy)
  })

  it('marks the file with its format and version, and nests the data so that it cannot be taken for a state file', () => {
    const { state } = session()
    const raw = JSON.parse(serializeCopy(copyOf(state))) as Record<string, unknown>
    expect(raw).toMatchObject({ format: COPY_FORMAT, version: COPY_VERSION })
    // The revision of the state format its tabs and spaces were written under: what a later migration of their shape goes by.
    expect(raw['revision']).toBe(STATE_REVISION)
    expect(raw).not.toHaveProperty('spaces')
    expect(raw).toHaveProperty('data.spaces')
  })

  it('reads a file an editor saved with a byte-order mark', () => {
    const { state } = session()
    expect(parseCopy(`﻿${serializeCopy(copyOf(state))}`).data.spaces).toHaveLength(2)
  })

  it('repairs what is wrong inside, like the state file: an address the engine cannot load goes, a tab of an unknown space goes', () => {
    const { state } = session()
    const raw = JSON.parse(serializeCopy(copyOf(state))) as { data: { tabs: Array<Record<string, unknown>> } }
    raw.data.tabs.push({ ...raw.data.tabs[0]!, id: 'evil', url: 'javascript:alert(1)' }, { ...raw.data.tabs[0]!, id: 'lost', spaceId: 'nowhere' })
    const copy = parseCopy(JSON.stringify(raw))
    expect(copy.data.tabs.map((t) => t.id)).not.toContain('evil')
    expect(copy.data.tabs.map((t) => t.id)).not.toContain('lost')
    expect(copy.data.tabs).toHaveLength(state.tabs.length)
  })

  it('takes an unknown reason for an automatic copy', () => {
    const { state } = session()
    const raw = JSON.parse(serializeCopy(copyOf(state))) as Record<string, unknown>
    expect(parseCopy(JSON.stringify({ ...raw, reason: 'whatever' })).reason).toBe('auto')
  })

  it('refuses a file that is not a copy, with a reason, instead of guessing', () => {
    const { state } = session()
    const good = JSON.parse(serializeCopy(copyOf(state))) as Record<string, unknown>
    const bad: Array<[string, string]> = [
      ['empty', ''],
      ['not json', '{ broken'],
      ['a number', '3'],
      ['null', 'null'],
      ['a list', '[]'],
      ['another format', JSON.stringify({ ...good, format: 'something-else' })],
      ['no format', JSON.stringify({ ...good, format: undefined })],
      ['a later version', JSON.stringify({ ...good, version: COPY_VERSION + 1 })],
      ['no date', JSON.stringify({ ...good, createdAt: undefined })],
      ['a date that is not a number', JSON.stringify({ ...good, createdAt: '2026' })],
      ['a negative date', JSON.stringify({ ...good, createdAt: -1 })],
      ['no data', JSON.stringify({ ...good, data: undefined })],
      ['data that is a list', JSON.stringify({ ...good, data: [] })],
      ['no space', JSON.stringify({ ...good, data: { ...(good['data'] as object), spaces: [] } })],
      ['spaces that are not objects', JSON.stringify({ ...good, data: { ...(good['data'] as object), spaces: [null, 5] } })],
      ['a tab that is not an object', JSON.stringify({ ...good, data: { ...(good['data'] as object), tabs: [null, ...(good['data'] as { tabs: unknown[] }).tabs] } })],
      ['a state file', JSON.stringify(state)]
    ]
    for (const [name, text] of bad) expect(() => parseCopy(text), name).toThrow()
  })

  it('refuses a file bigger than any copy can be', () => {
    expect(() => parseCopy(' '.repeat(COPY_BYTES_MAX + 1))).toThrow(/too big/)
  })
})

describe('the names of the copies', () => {
  it('are made of the time and sort by it, with a counter for two in the same millisecond', () => {
    expect(backupId(1_700_000_000_000)).toBe('copie-1700000000000')
    expect(backupId(1_700_000_000_000, 2)).toBe('copie-1700000000000-2')
    expect(stampOfBackupId('copie-1700000000000-2')).toBe(1_700_000_000_000)
    expect(newestFirst(['copie-1700000000000', 'copie-1700000000000-2', 'copie-1699999999999', 'copie-1700000000000-1', 'copie-1700000000001'])).toEqual([
      'copie-1700000000001',
      'copie-1700000000000-2',
      'copie-1700000000000-1',
      'copie-1700000000000',
      'copie-1699999999999'
    ])
  })

  it('accept nothing a file name could use to leave the folder', () => {
    for (const hostile of ['../copie-1700000000000', 'copie-1700000000000/../x', 'copie-1700000000000.json', 'copie-170000000000', 'copie-17000000000000', 'copie-1700000000000-', 'copie-1700000000000-1234', '', 'state', 'copie-1700000000000\n', 5, null, undefined, ['copie-1700000000000']]) {
      expect(isBackupId(hostile), String(hostile)).toBe(false)
    }
    expect(isBackupId(backupId(Date.now()))).toBe(true)
  })

  it('keep the newest when the clock went back: the copy just made is never the one rotation throws away', () => {
    expect(nextStamp(1000, undefined)).toBe(1000)
    expect(nextStamp(1000, 500)).toBe(1000)
    expect(nextStamp(1000, 1000)).toBe(1001)
    expect(nextStamp(1000, 9000)).toBe(9001)
  })

  it('are pruned from the oldest, down to the number kept, never to nothing', () => {
    const ids = [1, 2, 3, 4, 5, 6].map((n) => backupId(1_700_000_000_000 + n))
    expect(toPrune(ids, 4)).toEqual([ids[1], ids[0]])
    expect(toPrune([...ids].reverse(), 4)).toEqual([ids[1], ids[0]])
    expect(toPrune(ids, 6)).toEqual([])
    expect(toPrune(ids, 10)).toEqual([])
    expect(toPrune(ids, 0)).toEqual(ids.slice(0, 5).reverse())
    expect(toPrune(ids, -3)).toEqual(ids.slice(0, 5).reverse())
  })

  it('rotate apart: a copy made by hand or before a restoration is not pushed out by the automatic ones, and has a bound of its own', () => {
    const at = (n: number) => backupId(1_700_000_000_000 + n)
    const copies = [
      { id: at(1), reason: 'manual' as const },
      { id: at(2), reason: 'before-restore' as const },
      ...[3, 4, 5, 6].map((n) => ({ id: at(n), reason: 'auto' as const })),
      { id: at(7), reason: 'quit' as const },
      // A copy whose file does not say why it was made rotates with the automatic ones.
      { id: at(8), reason: null }
    ]
    expect(copiesToPrune(copies, 3)).toEqual([at(5), at(4), at(3)])
    expect(copiesToPrune(copies, 10)).toEqual([])
    const many = Array.from({ length: ASKED_COPIES_KEPT + 2 }, (_, n) => ({ id: at(100 + n), reason: n % 2 ? ('manual' as const) : ('before-restore' as const) }))
    expect(copiesToPrune([...copies, ...many], 10)).toEqual([at(101), at(100), at(2), at(1)])
  })

  it('keep apart the automatic copies made before a state file was set aside: those of the fresh state do not push them out', () => {
    const at = (n: number) => backupId(1_700_000_000_000 + n)
    const copies = [1, 2, 3, 11, 12, 13, 14].map((n) => ({ id: at(n), reason: 'auto' as const }))
    // Set aside between the third and the fourth: three copies of the lost session, four of the new one.
    expect(copiesToPrune(copies, 3, 1_700_000_000_010)).toEqual([at(11)])
    expect(copiesToPrune(copies, 2, 1_700_000_000_010)).toEqual([at(12), at(11), at(1)])
    // Nothing set aside: one rotation.
    expect(copiesToPrune(copies, 3)).toEqual([at(11), at(3), at(2), at(1)])
  })

  it('read why a copy was made from the start of its file, and nothing from a start that does not say', () => {
    const data = copyDataOf(session().state)
    for (const reason of COPY_REASONS) expect(reasonOfCopyHead(serializeCopy({ createdAt: 1_700_000_000_000, reason, data }).slice(0, COPY_HEAD_BYTES)), reason).toBe(reason)
    // A copy written before copies said their revision, and one saved with a byte-order mark.
    expect(reasonOfCopyHead('{"format":"lucium-session-copy","version":1,"createdAt":1700000000000,"reason":"manual","data":{')).toBe('manual')
    expect(reasonOfCopyHead('\uFEFF{"format":"x","version":1,"revision":4,"createdAt":1700000000000.5,"reason":"quit","data":{')).toBe('quit')
    for (const head of ['', 'not json', '{"format":"x","version":1,"createdAt":1,"reason":"unknown","data":{', '{"data":{"reason":"manual"}}']) expect(reasonOfCopyHead(head), head).toBeNull()
  })
})

describe('what the panel shows of a copy', () => {
  it('counts the tabs, the pinned ones and the spaces', () => {
    const { state } = session()
    expect(entryOf('copie-1700000000000', copyOf(state))).toEqual({ id: 'copie-1700000000000', createdAt: 1_700_000_000_000, reason: 'auto', tabs: state.tabs.length, pinned: 1, spaces: 2 })
  })

  it('gives the date in words for today and yesterday, then as a date, with the year only when it is not this one', () => {
    const now = new Date(2026, 9, 24, 15, 0).getTime()
    expect(copyWhen(new Date(2026, 9, 24, 14, 32).getTime(), now)).toBe('Aujourd’hui à 14:32')
    expect(copyWhen(new Date(2026, 9, 23, 9, 5).getTime(), now)).toBe('Hier à 09:05')
    expect(copyWhen(new Date(2026, 9, 20, 8, 0).getTime(), now)).toMatch(/^20 oct\.? à 08:00$/)
    expect(copyWhen(new Date(2025, 11, 31, 23, 59).getTime(), now)).toMatch(/^31 déc\.? 2025 à 23:59$/)
  })

  it('writes the date and its words in English with English chosen', () => {
    const now = new Date(2026, 9, 24, 15, 0).getTime()
    setLanguage('en')
    try {
      expect(copyWhen(new Date(2026, 9, 23, 9, 5).getTime(), now)).toBe('Yesterday at 09:05')
      expect(copyWhen(new Date(2026, 9, 20, 8, 0).getTime(), now)).toMatch(/^20 Oct\.? at 08:00$/)
      expect(copyWhen(new Date(2025, 11, 31, 23, 59).getTime(), now)).toMatch(/^31 Dec\.? 2025 at 23:59$/)
      expect(reasonLabel('before-restore')).toBe('Before a restore')
    } finally {
      setLanguage('fr')
    }
  })

  it('says why a copy was made', () => {
    expect(['auto', 'quit', 'manual', 'before-restore'].map((r) => reasonLabel(r as SessionCopy['reason']))).toEqual(['Copie automatique', 'À la fermeture', 'Copie manuelle', 'Avant une restauration'])
  })
})

describe('backup/restore', () => {
  it('replaces the spaces, tabs, folders, archive and what is on screen with the copy’s, and nothing else', () => {
    const { ctx, state, home } = session()
    const before = copyOf(state)
    // Later: a tab closed, a favourite added, a Tweak saved, a session kept, a setting changed, a space deleted.
    let later = run(ctx, state, { type: 'favorite/add', url: 'https://fav.example/', title: 'F' }, { type: 'session/save', name: 'S' }, { type: 'settings/update', patch: { blockAds: true } }, { type: 'space/delete', id: state.spaces[1]!.id })
    later = run(ctx, later, { type: 'tab/open', url: 'https://new.example/' })
    const restored = reduce(later, { type: 'backup/restore', copy: before.data }, ctx)
    expect(restored.spaces).toEqual(state.spaces)
    expect(restored.tabs).toEqual(state.tabs)
    expect(restored.folders).toEqual(state.folders)
    expect(restored.archive).toEqual(state.archive)
    expect(restored.activeSpaceId).toBe(state.activeSpaceId)
    expect(restored.activeTabBySpace).toEqual(state.activeTabBySpace)
    expect(restored.favorites).toEqual(later.favorites)
    expect(restored.sessions).toEqual(later.sessions)
    expect(restored.settings).toEqual(later.settings)
    expect(restored.spaces.map((s) => s.id)).toContain(home)
  })

  it('goes back and forth without loss: restoring the copy made just before it brings back what it replaced', () => {
    const { ctx, state } = session()
    const older = copyOf(state).data
    const newer = run(ctx, state, { type: 'tab/open', url: 'https://more.example/' }, { type: 'space/delete', id: state.spaces[1]!.id })
    const undo = copyDataOf(newer)
    const back = reduce(newer, { type: 'backup/restore', copy: older }, ctx)
    expect(back.tabs).toEqual(state.tabs)
    expect(reduce(back, { type: 'backup/restore', copy: undo }, ctx).tabs).toEqual(newer.tabs)
  })

  it('refuses a copy with no usable space instead of replacing the browser with an empty one', () => {
    const { ctx, state } = session()
    const empty = { ...copyOf(state).data, spaces: [] }
    expect(reduce(state, { type: 'backup/restore', copy: empty }, ctx)).toBe(state)
    expect(reduce(state, { type: 'backup/restore', copy: { ...empty, spaces: [null] as never } }, ctx)).toBe(state)
  })

  it('repairs a copy handed to it: the state it leaves is one the loader would accept as it is', () => {
    const { ctx, state } = session()
    const data = copyOf(state).data
    const odd = { ...data, activeSpaceId: 'nowhere', activeTabBySpace: { ...data.activeTabBySpace, [data.spaces[0]!.id]: 'no-such-tab' } }
    const restored = reduce(state, { type: 'backup/restore', copy: odd }, ctx)
    expect(restored.activeSpaceId).toBe(data.spaces[0]!.id)
    expect(restored.activeTabBySpace[data.spaces[0]!.id]).toBeNull()
    expect(normalize(restored)).toStrictEqual(restored)
  })
})

describe('the settings of the copies', () => {
  const d = defaultSettings()

  it('are on by default, five copies, one every half hour', () => {
    expect([d.autoBackup, d.autoBackupKeep, d.autoBackupMinutes]).toEqual([true, 5, 30])
    expect(BACKUP_KEEP_CHOICES).toContain(d.autoBackupKeep)
    expect(BACKUP_MINUTES_CHOICES).toContain(d.autoBackupMinutes)
  })

  it('bring a number to the nearest choice, so that a file can neither keep thousands of copies nor write one a second', () => {
    expect(cleanBackupSettings({ autoBackupKeep: 5000, autoBackupMinutes: 0.001 })).toMatchObject({ autoBackupKeep: 20, autoBackupMinutes: 5 })
    expect(cleanBackupSettings({ autoBackupKeep: -4, autoBackupMinutes: 1e9 })).toMatchObject({ autoBackupKeep: 2, autoBackupMinutes: 360 })
    expect(cleanBackupSettings({ autoBackupKeep: 4, autoBackupMinutes: 40 })).toMatchObject({ autoBackupKeep: 3, autoBackupMinutes: 30 })
    expect(cleanBackupSettings({ autoBackupKeep: 10, autoBackupMinutes: 60 })).toMatchObject({ autoBackupKeep: 10, autoBackupMinutes: 60 })
  })

  it('give the default to anything that is not of the right kind', () => {
    for (const bad of [null, undefined, 'oui', [], {}, Number.NaN, Infinity]) {
      const clean = cleanBackupSettings({ autoBackup: bad, autoBackupKeep: bad, autoBackupMinutes: bad })
      expect([clean.autoBackup, clean.autoBackupKeep, clean.autoBackupMinutes], String(bad)).toEqual([true, 5, 30])
    }
    expect(cleanBackupSettings({ autoBackup: false }).autoBackup).toBe(false)
  })

  it('make the plan the service follows: nothing when off, the number to keep, the time between two copies', () => {
    expect(backupPlan({ autoBackup: false })).toMatchObject({ enabled: false })
    expect(backupPlan({ autoBackup: true, autoBackupKeep: 10, autoBackupMinutes: 15 })).toEqual({ enabled: true, keep: 10, everyMs: 900_000 })
  })

  it('reach the state through the reducer’s own cleaning', () => {
    const { ctx, state } = session()
    const set = reduce(state, { type: 'settings/update', patch: { autoBackupKeep: 7, autoBackupMinutes: 1, autoBackup: false } }, ctx)
    expect(set.settings).toMatchObject({ autoBackupKeep: 5, autoBackupMinutes: 5, autoBackup: false })
  })

  it('are written in words for the settings window', () => {
    expect(BACKUP_MINUTES_CHOICES.map(minutesLabel)).toEqual(['5 minutes', '15 minutes', '30 minutes', '1 heure', '2 heures', '6 heures'])
  })
})
