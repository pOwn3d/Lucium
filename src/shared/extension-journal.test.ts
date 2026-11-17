import { describe, expect, it } from 'vitest'
import { ExtensionJournal, JOURNAL_MAX, JOURNAL_MESSAGE_MAX, JOURNAL_PER_KEY_MAX, cleanJournalText, extensionIdOfUrl, journalRuns, pageLevel, whereOf, workerLevel, type JournalEntry } from './extension-journal'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

const entry = (over: Partial<Omit<JournalEntry, 'id'>> = {}): Omit<JournalEntry, 'id'> => ({ at: 1, level: 'error', source: 'worker', extensionId: A, profileId: 'default', message: 'boom', ...over })

describe('what an extension prints is cleaned before it is kept', () => {
  it('keeps the lines of a stack trace and drops every other control and invisible character', () => {
    expect(cleanJournalText('a\nb\tc\r\nd')).toBe('a\nb\tc\nd')
    expect(cleanJournalText('x\u0000y‮z​')).toBe('x y z ')
  })

  it('cuts a message at the limit, with a mark', () => {
    const long = cleanJournalText('x'.repeat(JOURNAL_MESSAGE_MAX + 50))
    expect(long.length).toBe(JOURNAL_MESSAGE_MAX + 1)
    expect(long.endsWith('…')).toBe(true)
  })

  it('answers an empty text for anything that is not text', () => {
    expect(cleanJournalText(42)).toBe('')
    expect(cleanJournalText(undefined)).toBe('')
  })
})

describe('where a message comes from', () => {
  it('reads the id of the extension in its address, and only in a well-formed one', () => {
    expect(extensionIdOfUrl(`chrome-extension://${A}/background.js`)).toBe(A)
    expect(extensionIdOfUrl(`chrome-extension://${A}`)).toBe(A)
    for (const url of ['https://example.com/sw.js', `chrome-extension://${A}x/a.js`, 'chrome-extension://short/a.js', `chrome-extension://${'z'.repeat(32)}/a.js`, '', 7, undefined]) expect(extensionIdOfUrl(url), String(url)).toBeUndefined()
  })

  it('shortens the file to its path inside the extension, with the line', () => {
    expect(whereOf(`chrome-extension://${A}/src/background.js`, 12)).toBe('src/background.js:12')
    expect(whereOf(`chrome-extension://${A}/background.js`, 0)).toBe('background.js')
    expect(whereOf('', 3)).toBeUndefined()
  })

  it('keeps the levels that say something, for a worker (a number) and for a page (a word)', () => {
    expect([0, 1, 2, 3, 4].map(workerLevel)).toEqual([null, 'info', 'warning', 'error', null])
    expect(['debug', 'info', 'warning', 'error', 'verbose'].map(pageLevel)).toEqual([null, 'info', 'warning', 'error', null])
  })
})

describe('the journal', () => {
  it('numbers the entries and gives back those after a number', () => {
    const journal = new ExtensionJournal()
    const first = journal.add(entry({ message: 'one' }))
    journal.add(entry({ message: 'two' }))
    expect(first.id).toBe(1)
    expect(journal.list({ since: 1 }).map((e) => e.message)).toEqual(['two'])
    expect(journal.lastId()).toBe(2)
    expect(journal.list({ since: 2 })).toEqual([])
  })

  it('keeps the most recent entries within the bound of the whole journal', () => {
    const journal = new ExtensionJournal()
    for (let i = 0; i < JOURNAL_MAX + 25; i++) journal.add(entry({ extensionId: `${'abcdefghijklmnop'[i % 16]}`.repeat(32), message: `m${i}` }))
    const kept = journal.list()
    expect(kept).toHaveLength(JOURNAL_MAX)
    expect(kept[0]!.message).toBe('m25')
    expect(kept.at(-1)!.message).toBe(`m${JOURNAL_MAX + 24}`)
  })

  it('does not let one chatty extension push the errors of another out', () => {
    const journal = new ExtensionJournal()
    journal.add(entry({ extensionId: B, message: 'the error that matters' }))
    for (let i = 0; i < JOURNAL_PER_KEY_MAX + 100; i++) journal.add(entry({ message: `noise ${i}` }))
    expect(journal.list({ extensionId: B }).map((e) => e.message)).toEqual(['the error that matters'])
    expect(journal.list({ extensionId: A })).toHaveLength(JOURNAL_PER_KEY_MAX)
  })

  it('says a failed load of a folder once, with the newest time, however many profiles tried it', () => {
    const journal = new ExtensionJournal()
    const load = { source: 'load' as const, where: '/work/ext', message: 'manifest.json is not valid' }
    journal.add(entry({ ...load, profileId: 'default', at: 1 }))
    journal.add(entry({ ...load, profileId: 'work', at: 2 }))
    journal.add(entry({ ...load, message: 'another problem', at: 3 }))
    expect(journal.list().map((e) => [e.message, e.at])).toEqual([
      ['manifest.json is not valid', 2],
      ['another problem', 3]
    ])
  })

  it('clears by extension and profile, or everything, and says how many went', () => {
    const journal = new ExtensionJournal()
    journal.add(entry())
    journal.add(entry({ profileId: 'work' }))
    journal.add(entry({ extensionId: B }))
    expect(journal.clear({ extensionId: A, profileId: 'work' })).toBe(1)
    expect(journal.list()).toHaveLength(2)
    expect(journal.clear({ extensionId: A })).toBe(1)
    expect(journal.list().map((e) => e.extensionId)).toEqual([B])
    expect(journal.clear()).toBe(1)
    expect(journal.list()).toEqual([])
  })

  it('forgets the entries it is given by their numbers, and no other', () => {
    const journal = new ExtensionJournal()
    const kept = journal.add({ at: 1, level: 'error', source: 'worker', profileId: 'default', extensionId: 'a'.repeat(32), message: 'kept' })
    const gone = journal.add({ at: 2, level: 'error', source: 'load', profileId: 'default', message: 'gone', where: '/work/dev' })
    journal.remove([gone.id, 999])
    expect(journal.list().map((entry) => entry.id)).toEqual([kept.id])
  })

  it('does not reuse a number after a clear: a reader that asks "since" never sees an entry twice', () => {
    const journal = new ExtensionJournal()
    journal.add(entry())
    journal.clear()
    expect(journal.add(entry()).id).toBe(2)
  })
})

describe('the lines of the journal as the page shows them', () => {
  const at = (id: number, over: Partial<Omit<JournalEntry, 'id'>> = {}): JournalEntry => ({ id, ...entry({ at: id, ...over }) })

  it('says one message sent twelve times once, with its count, at the time of its last occurrence', () => {
    const noise = Array.from({ length: 12 }, (_, i) => at(i + 1, { message: 'Receiving end does not exist', where: 'background.js' }))
    const runs = journalRuns(noise)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.count).toBe(12)
    expect(runs[0]!.entry.id).toBe(12)
  })

  it('keeps apart what is not the same message, level, place or extension, and puts the lines in the order of their last occurrence', () => {
    const runs = journalRuns([
      at(1, { message: 'a' }),
      at(2, { message: 'b' }),
      at(3, { message: 'a' }),
      at(4, { message: 'a', level: 'warning' }),
      at(5, { message: 'a', where: 'x.js:1' }),
      at(6, { message: 'a', extensionId: B })
    ])
    expect(runs.map((r) => [r.entry.id, r.count])).toEqual([[2, 1], [3, 2], [4, 1], [5, 1], [6, 1]])
  })

  it('gives nothing for an empty journal', () => {
    expect(journalRuns([])).toEqual([])
  })
})
