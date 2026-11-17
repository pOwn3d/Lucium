import { describe, expect, it } from 'vitest'
import { UNREAD_HOLD_MS, nextUnread, readUnread, unreadCount } from './tab-messages'

describe('the unread count of a page title', () => {
  it('reads the count in front of the title, the usual form', () => {
    expect(unreadCount('(3) Gmail')).toBe(3)
    expect(unreadCount('(12) WhatsApp')).toBe(12)
  })

  it('reads a count written in words, anywhere in the title', () => {
    expect(unreadCount('Slack | Équipe | 3 new items')).toBe(3)
    expect(unreadCount('Inbox - 5 unread messages')).toBe(5)
    expect(unreadCount('Boîte de réception - 2 non lus')).toBe(2)
  })

  it('shows nothing for a title without a count, and for a count of zero', () => {
    expect(unreadCount('Notes de réunion')).toBeNull()
    expect(unreadCount('(0) Gmail')).toBeNull()
    expect(unreadCount('0 new items')).toBeNull()
  })

  it('does not take a year or a version for a count', () => {
    expect(unreadCount('Rapport 2026')).toBeNull()
    expect(unreadCount('Lucium 0.1.0')).toBeNull()
  })
})

describe('what a title says is unread', () => {
  it('reads a count wherever the title writes it, on any site', () => {
    expect(readUnread('(3) Twitch', 'https://www.twitch.tv/')).toEqual({ count: 3 })
    expect(readUnread('Loic - Équipe - 2 new items - Slack', 'https://app.slack.com/client/T1/D1')).toEqual({ count: 2 })
  })

  it('reads the mark Slack puts in front of a title that has no number: ! a mention or a direct message, * any unread message', () => {
    expect(readUnread('! Loic - Équipe - Slack', 'https://app.slack.com/client/T1/D1')).toEqual({ mark: '!' })
    expect(readUnread('* Loic - Équipe - Slack', 'https://app.slack.com/client/T1/D1')).toEqual({ mark: '*' })
    expect(readUnread('* Loic - Slack', 'https://equipe.slack.com/messages')).toEqual({ mark: '*' })
    expect(readUnread('  ! Loic - Slack', 'https://slack.com/')).toEqual({ mark: '!' })
  })

  it('says nothing for a title with neither a count nor a mark', () => {
    expect(readUnread('Loic - Équipe - Slack', 'https://app.slack.com/client/T1/D1')).toBeNull()
    expect(readUnread('Loic !', 'https://app.slack.com/client/T1/D1')).toBeNull()
    expect(readUnread('!important', 'https://app.slack.com/client/T1/D1')).toBeNull()
  })

  it('takes the count when a title has a count and a mark', () => {
    expect(readUnread('! Loic - 4 new items - Slack', 'https://app.slack.com/client/T1/D1')).toEqual({ count: 4 })
  })

  // THE GUARD of the mark: a `*` or a `!` in front of a title is a sign of unread only where the site is known to use it (an editor marks a document not saved with a `*`).
  it('does not take a mark for a sign of unread on any other site', () => {
    expect(readUnread('* notes.md - Editor', 'https://editor.example/')).toBeNull()
    expect(readUnread('! Alert', 'https://exemple.org/')).toBeNull()
    expect(readUnread('* Loic - Slack', 'https://notslack.com/')).toBeNull()
    expect(readUnread('* Loic - Slack', 'https://slack.com.evil.example/')).toBeNull()
    expect(readUnread('* Loic - Slack', '')).toBeNull()
  })
})

describe('what a tab keeps of its unread between two titles', () => {
  const count = { count: 3 }
  const memory = (at: number, held = false) => ({ reading: count, at, held })

  it('takes what a title says, and starts the hold again', () => {
    expect(nextUnread(undefined, count, 1000, false)).toEqual({ memory: memory(1000), recheckInMs: null })
    expect(nextUnread(memory(1000), { count: 5 }, 9000, false).memory).toEqual({ reading: { count: 5 }, at: 9000, held: false })
  })

  it('keeps the count a title said before when a later title only has the mark', () => {
    expect(nextUnread(memory(1000), { mark: '!' }, 2000, false).memory).toEqual({ reading: count, at: 2000, held: false })
    expect(nextUnread(undefined, { mark: '!' }, 2000, false).memory).toEqual({ reading: { mark: '!' }, at: 2000, held: false })
  })

  // THE GUARD of the hold: a title that says nothing does not take the badge away at once, or the badge blinks with the title.
  it('holds the badge through a title that says nothing, and says when to look again', () => {
    const step = nextUnread(memory(1000), null, 3000, false)
    expect(step.memory).toEqual({ reading: count, at: 1000, held: true })
    expect(step.recheckInMs).toBe(UNREAD_HOLD_MS - 2000)
  })

  it('lets the badge go once the title has been silent for the whole hold', () => {
    expect(nextUnread(memory(1000), null, 1000 + UNREAD_HOLD_MS - 1, false).memory).toBeDefined()
    expect(nextUnread(memory(1000), null, 1000 + UNREAD_HOLD_MS, false)).toEqual({ memory: undefined, recheckInMs: null })
  })

  // THE GUARD of the reading: someone looking at the tab has read it, and the badge goes the moment the site says so.
  it('takes the badge away at once when the tab is attended', () => {
    expect(nextUnread(memory(1000), null, 1500, true)).toEqual({ memory: undefined, recheckInMs: null })
  })

  it('has nothing to hold for a tab that showed nothing', () => {
    expect(nextUnread(undefined, null, 1000, false)).toEqual({ memory: undefined, recheckInMs: null })
  })
})
