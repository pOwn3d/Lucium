// A page names itself after its load has ended: the history entry takes the title the page ended with, once, for the visit being made.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryStore, RETITLE_WINDOW_MS } from './history'
import { takePersistenceNotices } from './persistence-notices'
import { tempDir } from './temp-dir'

afterEach(() => {
  vi.useRealTimers()
  takePersistenceNotices()
})

const store = (options: ConstructorParameters<typeof HistoryStore>[1] = {}): { history: HistoryStore; path: string } => {
  const path = join(tempDir('lucium-history-retitle-'), 'h.json')
  return { history: new HistoryStore(path, options), path }
}

describe('HistoryStore.retitle', () => {
  it('gives the page just recorded the title it ended up with, without counting a visit', () => {
    const { history } = store()
    // A single-page site: its address changed, its title follows a moment later (the load ended with the title of the page before).
    history.record('https://app.example/video/2', 'Video 1', 1_000)
    expect(history.retitle('https://app.example/video/2', 'Video 2', 1_500)).toBe(true)
    expect(history.get('https://app.example/video/2')).toEqual({ url: 'https://app.example/video/2', title: 'Video 2', visitCount: 1, lastVisitAt: 1_000 })
  })

  it('does nothing for a page that is not in the history, an empty title or the same title', () => {
    const { history } = store()
    history.record('https://a.fr/', 'A', 1_000)
    expect(history.retitle('https://elsewhere.fr/', 'X', 1_100)).toBe(false)
    expect(history.retitle('https://a.fr/', '', 1_100)).toBe(false)
    expect(history.retitle('https://a.fr/', 'A', 1_100)).toBe(false)
    expect(history.size()).toBe(1)
    expect(history.isDirty()).toBe(true)
  })

  it('leaves a page that is not being visited alone: a title that changes all day (an unread count, a timer) does not rewrite the file', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { history, path } = store()
    history.record('https://mail.example/', 'Inbox', 1_000)
    expect(history.flush()).toBe(true)
    const before = readFileSync(path, 'utf8')
    expect(history.retitle('https://mail.example/', 'Inbox (3)', 1_000 + RETITLE_WINDOW_MS + 1)).toBe(false)
    expect(history.isDirty()).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(history.get('https://mail.example/')?.title).toBe('Inbox')
    // Within the window it is still the visit of that page.
    expect(history.retitle('https://mail.example/', 'Inbox (3)', 1_000 + RETITLE_WINDOW_MS)).toBe(true)
    expect(history.isDirty()).toBe(true)
  })

  it('keeps nothing new while visits are not kept (« Garder l’historique des pages visitées » off): what is there stays as it was', () => {
    let recording = true
    const { history } = store({ recording: () => recording })
    history.record('https://a.fr/', 'A', 1_000)
    recording = false
    expect(history.retitle('https://a.fr/', 'A2', 1_100)).toBe(false)
    expect(history.get('https://a.fr/')?.title).toBe('A')
  })

  it('is written with the rest', () => {
    const { history, path } = store()
    history.record('https://a.fr/', 'Old', 1_000)
    history.retitle('https://a.fr/', 'New', 1_100)
    expect(history.flush()).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([{ url: 'https://a.fr/', title: 'New', visitCount: 1, lastVisitAt: 1_000 }])
  })
})
