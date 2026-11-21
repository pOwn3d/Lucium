import { describe, expect, it } from 'vitest'
import { TAB_REMINDER_LIMIT, type SidebarState, type TabReminder } from './model'
import { createInitialState, normalize, reduce, type Action, type Ctx } from './sidebar'
import { cleanTabReminders } from './state-clean'
import { dueReminders, nextReminderAt, reminderTime, tabReminderOutcome, withReminder } from './tab-reminder'

const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const NOW = local(2026, 11, 21, 10, 0)

function makeCtx(now = NOW): Ctx & { now: number } {
  let n = 0
  return { now, newId: () => `id${++n}` }
}

function stateWithTabs(urls: string[], ctx = makeCtx()): SidebarState {
  let state = createInitialState(ctx)
  for (const url of urls) state = reduce(state, { type: 'tab/open', url }, ctx)
  return state
}

const reminder = (n: number, over: Partial<TabReminder> = {}): TabReminder => ({ id: `r${n}`, url: `https://site${n}.example/`, title: `Page ${n}`, spaceId: '', dueAt: NOW + n * 1000, createdAt: NOW, ...over })
const DAY = local(2026, 11, 22, 10, 0) // a day after NOW

describe('the time of a preset', () => {
  it('"ce soir" is 18:00 today', () => expect(reminderTime('tonight', NOW)).toBe(local(2026, 11, 21, 18)))
  it('"ce soir" is not 18:00 once it is under an hour away or past: three hours from now', () => {
    for (const now of [local(2026, 11, 21, 17, 30), local(2026, 11, 21, 18, 5), local(2026, 11, 21, 23, 0)]) expect(reminderTime('tonight', now), String(now)).toBe(now + 3 * 3_600_000)
  })
  it('"demain matin" is 09:00 the next day, even late at night', () => {
    expect(reminderTime('tomorrow', NOW)).toBe(local(2026, 11, 22, 9))
    expect(reminderTime('tomorrow', local(2026, 11, 30, 23, 59))).toBe(local(2026, 12, 1, 9))
  })
  it('"dans une semaine" is 09:00 seven days on', () => expect(reminderTime('week', NOW)).toBe(local(2026, 11, 28, 9)))
})

describe('the list of reminders', () => {
  it('refuses a time that is not ahead, a page that is not on the web, and a full list', () => {
    const tab = { url: 'https://a.example/' }
    expect(tabReminderOutcome([], tab, NOW, NOW)).toBe('soon')
    expect(tabReminderOutcome([], tab, Number.NaN, NOW)).toBe('soon')
    expect(tabReminderOutcome([], { url: 'about:blank' }, DAY, NOW)).toBe('unsupported')
    const full = Array.from({ length: TAB_REMINDER_LIMIT }, (_, i) => reminder(i))
    expect(tabReminderOutcome(full, tab, DAY, NOW)).toBe('full')
    expect(tabReminderOutcome([], tab, DAY, NOW)).toBe('saved')
    expect(tabReminderOutcome([reminder(1, { url: tab.url })], tab, DAY, NOW)).toBe('updated')
  })

  it('keeps the soonest first and one entry per address (the later time replaces the earlier)', () => {
    const out = withReminder([reminder(5), reminder(2)], reminder(9, { url: reminder(5).url, dueAt: NOW + 1 }))
    expect(out.map((r) => r.id)).toEqual(['r9', 'r2'])
  })

  it('says which are due, and when to look next', () => {
    const l = [reminder(1, { dueAt: NOW - 1 }), reminder(2, { dueAt: NOW }), reminder(3, { dueAt: NOW + 1 })]
    expect(dueReminders(l, NOW).map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(nextReminderAt(l)).toBe(NOW - 1)
    expect(nextReminderAt([])).toBeNull()
  })
})

describe('reminder/add', () => {
  const ctx = makeCtx()
  const add = (state: SidebarState, tabId: string, dueAt = DAY): SidebarState => reduce(state, { type: 'reminder/add', tabId, dueAt }, ctx)

  it('puts the page away and closes the tab', () => {
    const state = stateWithTabs(['https://a.example/x', 'https://b.example/'], ctx)
    const tab = state.tabs[0]!
    const next = add(state, tab.id)
    expect(next.tabReminders).toHaveLength(1)
    expect(next.tabReminders[0]).toMatchObject({ url: 'https://a.example/x', dueAt: DAY, createdAt: NOW, spaceId: tab.spaceId })
    expect(next.tabs.map((t) => t.url)).toEqual(['https://b.example/'])
  })

  it('gives a tab with no title its host, so that the saved state reads back unchanged', () => {
    const state = stateWithTabs(['https://a.example/x'], ctx)
    const untitled = { ...state, tabs: state.tabs.map((t) => ({ ...t, title: '' })) }
    const next = add(untitled, state.tabs[0]!.id)
    expect(next.tabReminders[0]!.title).toBe('a.example')
    expect(normalize(JSON.parse(JSON.stringify(next))).tabReminders).toEqual(next.tabReminders)
  })

  it('keeps a pinned tab open', () => {
    const state = stateWithTabs(['https://a.example/'], ctx)
    const pinned = { ...state, tabs: state.tabs.map((t) => ({ ...t, pinned: true as const })) }
    const next = add(pinned, state.tabs[0]!.id)
    expect(next.tabReminders).toHaveLength(1)
    expect(next.tabs).toHaveLength(1)
  })

  it('moves the time of a page already waiting instead of adding it twice', () => {
    const state = stateWithTabs(['https://a.example/'], ctx)
    const once = add(state, state.tabs[0]!.id)
    const again = reduce(once, { type: 'tab/open', url: 'https://a.example/' }, ctx)
    const twice = add(again, again.tabs[0]!.id, DAY + 5000)
    expect(twice.tabReminders.map((r) => r.dueAt)).toEqual([DAY + 5000])
  })

  it('changes nothing for a time that is past, a private tab, an unknown tab or a page that is not on the web', () => {
    const state = stateWithTabs(['https://a.example/'], ctx)
    const id = state.tabs[0]!.id
    expect(add(state, id, NOW)).toBe(state)
    expect(add(state, id, Number.NaN)).toBe(state)
    expect(add(state, 'nope')).toBe(state)
    expect(add({ ...state, tabs: state.tabs.map((t) => ({ ...t, private: true as const })) }, id).tabReminders).toEqual([])
    expect(add({ ...state, tabs: state.tabs.map((t) => ({ ...t, url: 'about:blank' })) }, id).tabReminders).toEqual([])
  })

  it('does nothing with the setting off (the tab stays, nothing is kept)', () => {
    const state = stateWithTabs(['https://a.example/'], ctx)
    const off = { ...state, settings: { ...state.settings, tabReminders: false } }
    expect(add(off, off.tabs[0]!.id)).toBe(off)
  })

  it('refuses a new reminder when the list is full, and the tab stays', () => {
    const state = stateWithTabs(['https://a.example/'], ctx)
    const full = { ...state, tabReminders: Array.from({ length: TAB_REMINDER_LIMIT }, (_, i) => reminder(i)) }
    expect(add(full, full.tabs[0]!.id)).toBe(full)
  })
})

describe('reminder/cancel, reminder/open and reminder/fire', () => {
  it('cancels one reminder, and only a known one', () => {
    const state = { ...stateWithTabs([]), tabReminders: [reminder(1), reminder(2)] }
    expect(reduce(state, { type: 'reminder/cancel', id: 'r1' }, makeCtx()).tabReminders.map((r) => r.id)).toEqual(['r2'])
    expect(reduce(state, { type: 'reminder/cancel', id: 'zz' }, makeCtx())).toBe(state)
  })

  it('opens a reminder now as a tab of its space and forgets it', () => {
    const base = stateWithTabs([])
    const space = base.spaces[0]!
    const state = { ...base, tabReminders: [reminder(1, { spaceId: space.id })] }
    const next = reduce(state, { type: 'reminder/open', id: 'r1' }, makeCtx())
    expect(next.tabReminders).toEqual([])
    expect(next.tabs.map((t) => [t.url, t.spaceId])).toEqual([['https://site1.example/', space.id]])
  })

  it('brings back the due reminders only, each as one tab, and keeps the others', () => {
    const base = stateWithTabs([])
    const state = { ...base, tabReminders: [reminder(1, { dueAt: NOW - 5, spaceId: base.spaces[0]!.id }), reminder(2, { dueAt: NOW }), reminder(3, { dueAt: NOW + 1 })] }
    const next = reduce(state, { type: 'reminder/fire' }, makeCtx())
    expect(next.tabs.map((t) => t.url).sort()).toEqual(['https://site1.example/', 'https://site2.example/'])
    expect(next.tabReminders.map((r) => r.id)).toEqual(['r3'])
  })

  it('opens a tab in the space on screen when the space of the reminder is gone', () => {
    const base = stateWithTabs([])
    const next = reduce({ ...base, tabReminders: [reminder(1, { dueAt: NOW - 1, spaceId: 'gone' })] }, { type: 'reminder/fire' }, makeCtx())
    expect(next.tabs.map((t) => t.spaceId)).toEqual([base.activeSpaceId])
  })

  it('leaves everything while the setting is off, and returns the same state when nothing is due', () => {
    const base = stateWithTabs([])
    const waiting = { ...base, tabReminders: [reminder(1, { dueAt: NOW - 1 })] }
    const off = { ...waiting, settings: { ...waiting.settings, tabReminders: false } }
    expect(reduce(off, { type: 'reminder/fire' }, makeCtx())).toBe(off)
    expect(reduce(off, { type: 'reminder/open', id: 'r1' }, makeCtx())).toBe(off)
    const later = { ...base, tabReminders: [reminder(1, { dueAt: NOW + 9 })] }
    expect(reduce(later, { type: 'reminder/fire' }, makeCtx())).toBe(later)
  })

  it('refuses junk ids without throwing', () => {
    const state = { ...stateWithTabs([]), tabReminders: [reminder(1)] }
    for (const id of [undefined, null, 5, '__proto__', '']) {
      expect(reduce(state, { type: 'reminder/cancel', id } as unknown as Action, makeCtx())).toBe(state)
      expect(reduce(state, { type: 'reminder/open', id } as unknown as Action, makeCtx())).toBe(state)
    }
  })
})

describe('the reminders of a file', () => {
  const spaces = new Set(['s1'])
  it('keeps good entries soonest first, repairs the space and the title, drops what cannot be opened or timed', () => {
    const out = cleanTabReminders(
      [
        { id: 'b', url: 'https://b.example/', title: 'B', spaceId: 's1', dueAt: 20, createdAt: 1 },
        { id: 'a', url: 'https://a.example/', title: '', spaceId: 'gone', dueAt: 10 },
        { id: 'c', url: 'javascript:alert(1)', dueAt: 5 },
        { id: 'd', url: 'https://d.example/', dueAt: 'soon' },
        { id: 'e', url: 'https://e.example/', dueAt: Number.POSITIVE_INFINITY },
        { id: 'b', url: 'https://dup.example/', dueAt: 1 },
        'x',
        null
      ],
      spaces
    )
    expect(out.map((r) => [r.id, r.spaceId, r.dueAt])).toEqual([['a', '', 10], ['b', 's1', 20]])
    expect(out[0]!.title).toBe('a.example')
  })

  it('is empty for anything but a list, and bounded', () => {
    for (const raw of [undefined, null, 'x', 7, {}, true]) expect(cleanTabReminders(raw, spaces)).toEqual([])
    const many = Array.from({ length: TAB_REMINDER_LIMIT + 50 }, (_, i) => ({ id: `r${i}`, url: `https://s${i}.example/`, dueAt: i }))
    expect(cleanTabReminders(many, spaces)).toHaveLength(TAB_REMINDER_LIMIT)
  })

  it('survives a round trip through normalize', () => {
    const state = { ...stateWithTabs([]), tabReminders: [reminder(1)] }
    expect(normalize(JSON.parse(JSON.stringify(state))).tabReminders).toEqual([{ ...reminder(1), spaceId: '' }])
  })
})
