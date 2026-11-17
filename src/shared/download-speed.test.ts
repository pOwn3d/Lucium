// The speed of a download. Where it is shown (the tip of the status chip, the list of the downloads) is drawn in renderer/download-speed-shown.test.ts.
import { describe, expect, it } from 'vitest'
import type { DownloadInfo } from './model'
import { SPEED_WINDOW_MS, formatSpeed, nextSpeedBook, speedOf, trackSpeeds, withSpeed, type SpeedBook } from './download-speed'
import { frenchSpaces } from './french-typography'


const download = (patch: Partial<DownloadInfo> = {}): DownloadInfo => ({ id: 'd1', filename: 'a.pdf', url: 'https://exemple.fr/a.pdf', path: '/tmp/a.pdf', state: 'progressing', receivedBytes: 0, totalBytes: 10_000_000, startedAt: 0, ...patch })
const MB = 1024 ** 2

describe('the speed of a download', () => {
  it('is unknown at the first reading, then the bytes of the last window over its time', () => {
    const first = trackSpeeds({}, [download({ receivedBytes: 1 * MB })], 10_000)
    expect(speedOf(first, 'd1')).toBeNull()
    // Reports closer than the window do not move it.
    expect(trackSpeeds(first, [download({ receivedBytes: 1.2 * MB })], 10_000 + SPEED_WINDOW_MS - 1)).toBe(first)
    const second = trackSpeeds(first, [download({ receivedBytes: 2.5 * MB })], 10_000 + 2 * SPEED_WINDOW_MS)
    expect(speedOf(second, 'd1')).toBeCloseTo(0.75 * MB)
  })

  it('is measured, not averaged since the start: a download resumed from an earlier session starts from the bytes it already holds', () => {
    // Its start time is the first session's, a day ago, and 8 Mo are already on disk.
    const resumed = download({ startedAt: Date.now() - 86_400_000, receivedBytes: 8 * MB })
    const book = trackSpeeds(trackSpeeds({}, [resumed], 0), [{ ...resumed, receivedBytes: 9 * MB }], 2000)
    expect(speedOf(book, 'd1')).toBeCloseTo(0.5 * MB)
  })

  it('is kept for a download that runs only: a pause, an end or a download that starts over from fewer bytes leaves no old reading', () => {
    const book = trackSpeeds(trackSpeeds({}, [download({ receivedBytes: MB })], 0), [download({ receivedBytes: 2 * MB })], 1000)
    expect(speedOf(book, 'd1')).toBeCloseTo(MB)
    expect(trackSpeeds(book, [download({ receivedBytes: 3 * MB, paused: true })], 2000)).toEqual({})
    expect(trackSpeeds(book, [download({ state: 'completed' })], 2000)).toEqual({})
    expect(speedOf(trackSpeeds(book, [download({ receivedBytes: 100 })], 2000), 'd1')).toBeNull()
  })

  it('is measured only while the setting of the status chip is on: off, the book is emptied and no reading is kept', () => {
    const book = nextSpeedBook(nextSpeedBook({}, [download({ receivedBytes: MB })], true, 0), [download({ receivedBytes: 2 * MB })], true, 1000)
    expect(speedOf(book, 'd1')).toBeCloseTo(MB)
    expect(nextSpeedBook(book, [download({ receivedBytes: 3 * MB })], false, 2000)).toEqual({})
    expect(speedOf(nextSpeedBook({}, [download({ receivedBytes: MB })], false, 0), 'd1')).toBeNull()
  })

  it('gives back the same book when nothing changed, so that nothing is drawn again for it', () => {
    const empty: SpeedBook = {}
    expect(trackSpeeds(empty, [download({ state: 'completed' })], 5)).toBe(empty)
  })

  it('is written as the sizes of the list are, and added to a line only when there is one', () => {
    expect(formatSpeed(850)).toBe(frenchSpaces('850 o/s'))
    expect(formatSpeed(12 * 1024)).toBe(frenchSpaces('12 Ko/s'))
    expect(formatSpeed(1.25 * MB)).toBe(frenchSpaces('1,3 Mo/s'))
    expect(withSpeed(frenchSpaces('1,5 Mo sur 2,4 Mo'), 1.2 * MB)).toBe(frenchSpaces('1,5 Mo sur 2,4 Mo · 1,2 Mo/s'))
    expect(withSpeed(frenchSpaces('1,5 Mo sur 2,4 Mo'), null)).toBe(frenchSpaces('1,5 Mo sur 2,4 Mo'))
    expect(withSpeed(frenchSpaces('1,5 Mo sur 2,4 Mo'), 0)).toBe(frenchSpaces('1,5 Mo sur 2,4 Mo'))
  })
})
