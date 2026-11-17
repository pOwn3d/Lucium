// The status of the downloads at the foot of the sidebar: when a bubble is called for, how long it stays, what the chip shows and says.

import { describe, expect, it } from 'vitest'
import type { DownloadInfo } from './model'
import { BUBBLE_MS, bubbleDelay, bubbleView, chipAnnouncement, chipLabel, chipView, dismiss, expire, holdBubble, initialStatus, noStatus, observe, releaseBubble, sameStatus, type StatusContext, type StatusState } from './download-status'
import { frenchSpaces } from './french-typography'

const T0 = 1_000_000
const file = (id: string, patch: Partial<DownloadInfo> = {}): DownloadInfo => ({ id, filename: `${id}.pdf`, url: `https://example.org/${id}`, path: `/tmp/${id}.pdf`, state: 'progressing', receivedBytes: 1_500_000, totalBytes: 2_400_000, startedAt: T0 + 10, ...patch })
const context = (patch: Partial<StatusContext> = {}): StatusContext => ({ now: T0 + 5_000, mountedAt: T0, cancelled: new Set(), ...patch })

describe('observe', () => {
  it('makes a bubble of 6 s when a download that was running is over', () => {
    const before = observe(noStatus(), [file('a')], context({ now: T0 + 100 }))
    expect(before.bubble).toBeNull()
    const after = observe(before, [file('a', { state: 'completed' })], context())
    expect(after.bubble).toEqual({ kind: 'done', id: 'a', until: T0 + 5_000 + BUBBLE_MS })
  })

  it('says nothing of a download that was already over when the chip appeared', () => {
    const rows = [file('old', { state: 'completed', startedAt: T0 - 60_000 }), file('failed', { state: 'interrupted', startedAt: T0 - 60_000 })]
    expect(observe(initialStatus(rows), rows, context()).bubble).toBeNull()
    // Nor of one that comes with the first list the chip sees, if it started before the chip did.
    expect(observe(noStatus(), rows, context()).bubble).toBeNull()
  })

  it('tells a small file that went from nothing to done between two snapshots', () => {
    const quick = file('q', { state: 'completed', startedAt: T0 + 50 })
    expect(observe(initialStatus([]), [quick], context()).bubble?.kind).toBe('done')
  })

  it('makes no bubble for a file opened without being kept', () => {
    const running = observe(noStatus(), [file('t', { temporary: true })], context({ now: T0 + 100 }))
    expect(observe(running, [file('t', { temporary: true, state: 'completed' })], context()).bubble).toBeNull()
  })

  it('keeps a failure until it is answered (no end time)', () => {
    const running = observe(noStatus(), [file('a')], context({ now: T0 + 100 }))
    const failed = observe(running, [file('a', { state: 'interrupted', resumable: true })], context())
    expect(failed.bubble).toEqual({ kind: 'fail', id: 'a', until: null })
    expect(expire(failed, T0 + 10 * BUBBLE_MS).bubble).not.toBeNull()
    expect(bubbleDelay(failed, T0)).toBeNull()
  })

  it('does not let the end of another download replace a failure nobody answered', () => {
    const running = observe(noStatus(), [file('a'), file('b')], context({ now: T0 + 100 }))
    const failed = observe(running, [file('a', { state: 'interrupted' }), file('b')], context())
    const next = observe(failed, [file('a', { state: 'interrupted' }), file('b', { state: 'completed' })], context({ now: T0 + 9_000 }))
    expect(next.bubble?.kind).toBe('fail')
    expect(next.bubble?.id).toBe('a')
  })

  it('takes the failure down when the download runs again (it was resumed) or leaves the list', () => {
    const failed: StatusState = { seen: { a: 'interrupted' }, bubble: { kind: 'fail', id: 'a', until: null } }
    expect(observe(failed, [file('a')], context()).bubble).toBeNull()
    expect(observe(failed, [], context()).bubble).toBeNull()
  })

  it('tells a cancellation only when the user asked for it from the chip', () => {
    const running = observe(noStatus(), [file('a')], context({ now: T0 + 100 }))
    const gone = [file('a', { state: 'cancelled' })]
    expect(observe(running, gone, context()).bubble).toBeNull()
    expect(observe(running, gone, context({ cancelled: new Set(['a']) })).bubble).toEqual({ kind: 'cancel', id: 'a', until: T0 + 5_000 + BUBBLE_MS })
  })
})

describe('the time of a bubble', () => {
  const done: StatusState = { seen: { a: 'completed' }, bubble: { kind: 'done', id: 'a', until: T0 + BUBBLE_MS } }

  it('goes by itself once its time is up, and not before', () => {
    expect(expire(done, T0 + BUBBLE_MS - 1).bubble).not.toBeNull()
    expect(expire(done, T0 + BUBBLE_MS).bubble).toBeNull()
    expect(bubbleDelay(done, T0 + 1_000)).toBe(BUBBLE_MS - 1_000)
    expect(bubbleDelay(noStatus(), T0)).toBeNull()
  })

  it('holds still while the pointer is on it and starts its 6 s again when the pointer leaves', () => {
    const held = holdBubble(done)
    expect(bubbleDelay(held, T0)).toBeNull()
    expect(expire(held, T0 + 10 * BUBBLE_MS).bubble).not.toBeNull()
    expect(releaseBubble(held, T0 + 20_000).bubble?.until).toBe(T0 + 20_000 + BUBBLE_MS)
  })

  it('is never given a time by the pointer leaving a failure: it waits for an answer', () => {
    const failed: StatusState = { seen: {}, bubble: { kind: 'fail', id: 'a', until: null } }
    expect(releaseBubble(failed, T0)).toBe(failed)
    expect(holdBubble(failed)).toBe(failed)
  })

  it('is put away by Escape, the cross or "Ignorer"', () => {
    expect(dismiss(done).bubble).toBeNull()
    expect(dismiss(noStatus())).toEqual(noStatus())
  })
})

describe('chipView', () => {
  it('is the plain icon with nothing to say', () => {
    expect(chipView([file('a', { state: 'completed' })], noStatus())).toEqual({ state: 'none', count: 0, subject: null, percent: null })
  })

  it('counts the running files and speaks of the newest one, with how far it is', () => {
    const view = chipView([file('old', { startedAt: T0 + 1, receivedBytes: 1, totalBytes: 100 }), file('new', { startedAt: T0 + 9, receivedBytes: 620, totalBytes: 1000 })], noStatus())
    expect(view).toMatchObject({ state: 'progress', count: 2, percent: 62 })
    expect(view.subject?.id).toBe('new')
  })

  it('turns the ring when the size is not known (no percent)', () => {
    expect(chipView([file('a', { totalBytes: 0 })], noStatus()).percent).toBeNull()
  })

  it('takes the colour of the bubble that is up once nothing runs: green for the end, red for a failure', () => {
    const rows = [file('a', { state: 'completed' })]
    expect(chipView(rows, { seen: {}, bubble: { kind: 'done', id: 'a', until: T0 } }).state).toBe('done')
    expect(chipView([file('a', { state: 'interrupted' })], { seen: {}, bubble: { kind: 'fail', id: 'a', until: null } }).state).toBe('fail')
    expect(chipView(rows, { seen: {}, bubble: { kind: 'cancel', id: 'a', until: T0 } }).state).toBe('none')
  })

  it('names the file and how far it is in the label, and keeps the plain name at rest', () => {
    expect(chipLabel(chipView([file('rapport', { filename: 'rapport-octobre.pdf', receivedBytes: 620, totalBytes: 1000 })], noStatus()))).toBe(frenchSpaces('rapport-octobre.pdf · 62 %'))
    expect(chipLabel(chipView([], noStatus()))).toBe('Téléchargements')
    // The caller knows the shortcut that opens the panel as it is set now: the label at rest carries it, the label of a file does not.
    expect(chipLabel(chipView([], noStatus()), 'Téléchargements · ⌥⌘L')).toBe('Téléchargements · ⌥⌘L')
    expect(chipLabel(chipView([file('rapport', { filename: 'rapport-octobre.pdf', receivedBytes: 620, totalBytes: 1000 })], noStatus()), 'Téléchargements · ⌥⌘L')).toBe(frenchSpaces('rapport-octobre.pdf · 62 %'))
  })
})

describe('chipAnnouncement', () => {
  const at = (percent: number) => chipAnnouncement(chipView([file('a', { filename: 'a.pdf', receivedBytes: percent, totalBytes: 100 })], noStatus()))

  it('speaks at each quarter, not at each percent: the same text all along a quarter, so it is read once', () => {
    expect(at(1)).toBe(at(24))
    expect(at(25)).toBe(at(49))
    expect(at(25)).not.toBe(at(24))
    expect(at(80)).toBe(at(99))
  })

  it('is silent at rest', () => {
    expect(chipAnnouncement(chipView([], noStatus()))).toBe('')
  })
})

describe('bubbleView', () => {
  it('says the size of a finished file, the status of a failed one, and that a cancelled one was', () => {
    expect(bubbleView({ kind: 'done', id: 'a', until: T0 }, file('a', { state: 'completed', totalBytes: 2_516_582 })).detail).toBe(frenchSpaces('Téléchargement terminé · 2,4 Mo'))
    expect(bubbleView({ kind: 'fail', id: 'a', until: null }, file('a', { state: 'interrupted', resumable: true })).detail).toBe('Échec du téléchargement · Interrompu · peut reprendre')
    expect(bubbleView({ kind: 'cancel', id: 'a', until: T0 }, file('a', { state: 'cancelled' })).detail).toBe('Téléchargement annulé')
  })

  it('goes by itself except a failure, whatever the pointer does to its time', () => {
    expect(bubbleView({ kind: 'done', id: 'a', until: null }, file('a', { state: 'completed' })).timed).toBe(true)
    expect(bubbleView({ kind: 'fail', id: 'a', until: null }, file('a', { state: 'interrupted' })).timed).toBe(false)
  })
})

describe('sameStatus', () => {
  it('is the same for a list that changed nothing worth saying, so nothing is drawn again', () => {
    const a = observe(noStatus(), [file('a')], context({ now: T0 + 100 }))
    expect(sameStatus(a, observe(a, [file('a', { receivedBytes: 2_000_000 })], context({ now: T0 + 200 })))).toBe(true)
    expect(sameStatus(a, observe(a, [file('a', { state: 'completed' })], context()))).toBe(false)
  })
})
