import { describe, expect, it } from 'vitest'
import { NOTICE_LOG_MAX, NoticeLog } from './notice-log'

describe('the log of notices', () => {
  it('lists the notices, the latest first, with their time and second line', () => {
    const log = new NoticeLog()
    log.record(1, 1000, 'one')
    log.record(2, 2000, 'two', 'detail')
    expect(log.list()).toEqual([{ at: 2000, message: 'two', detail: 'detail' }, { at: 1000, message: 'one' }])
  })

  it('keeps the last 30 and drops the oldest', () => {
    const log = new NoticeLog()
    for (let i = 1; i <= NOTICE_LOG_MAX + 5; i += 1) log.record(i, i, `notice ${i}`)
    const list = log.list()
    expect(list).toHaveLength(NOTICE_LOG_MAX)
    expect(list[0]?.message).toBe(`notice ${NOTICE_LOG_MAX + 5}`)
    expect(list[list.length - 1]?.message).toBe('notice 6')
  })

  it('makes one entry of the same words twice in a row, with the latest time', () => {
    const log = new NoticeLog()
    log.record(1, 1000, 'same')
    log.record(2, 5000, 'same')
    log.record(3, 6000, 'other')
    log.record(4, 7000, 'same')
    expect(log.list().map((e) => [e.message, e.at])).toEqual([['same', 7000], ['other', 6000], ['same', 5000]])
  })

  it('writes the ending of a job that went by in steps: the progress of its notice replaces the words of its entry', () => {
    const log = new NoticeLog()
    log.record(7, 1000, '3 sur 12', 'about 1 min left')
    log.revise(7, '12 sur 12 actualisés')
    expect(log.list()).toEqual([{ at: 1000, message: '12 sur 12 actualisés' }])
  })

  it('leaves alone an entry whose notice was replaced before the revision came', () => {
    const log = new NoticeLog()
    log.record(7, 1000, 'first')
    log.record(8, 2000, 'second')
    log.revise(7, 'late words')
    expect(log.list().map((e) => e.message)).toEqual(['second', 'late words'])
  })

  it('gives the progress of a notice that came back to the entry it came back in, and to nothing else', () => {
    const log = new NoticeLog()
    log.record(1, 1000, 'same')
    log.record(2, 2000, 'same')
    // The entry is the second notice's now: the first one's progress, which arrives late, names no entry.
    log.revise(1, 'late words')
    expect(log.list()).toEqual([{ at: 2000, message: 'same' }])
    log.revise(2, 'done')
    expect(log.list()).toEqual([{ at: 2000, message: 'done' }])
  })

  it('ignores the progress of a notice that has left the log', () => {
    const log = new NoticeLog()
    for (let i = 1; i <= NOTICE_LOG_MAX + 1; i += 1) log.record(i, i, `notice ${i}`)
    log.revise(1, 'late words')
    expect(log.list().map((e) => e.message)).not.toContain('late words')
    expect(log.list()).toHaveLength(NOTICE_LOG_MAX)
  })
})
