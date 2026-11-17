import { describe, expect, it } from 'vitest'
import type { DownloadInfo } from './model'
import { LITTLE_BUBBLE, bubbleAfter, bubbleDownload, bubbleExtra } from './little-bubble'
import { LITTLE_TRAY, trayBounds } from './little-tray'

const download = (over: Partial<DownloadInfo> = {}): DownloadInfo => ({ id: 'd1', filename: 'rapport.pdf', url: 'https://x.example/rapport.pdf', path: '/tmp/rapport.pdf', state: 'completed', receivedBytes: 10, totalBytes: 10, startedAt: 1, ...over })

describe('bubbleAfter', () => {
  it('rises when a running download finishes, or when a finished one is seen for the first time', () => {
    expect(bubbleAfter(download({ state: 'progressing' }), download())).toBe(true)
    expect(bubbleAfter(undefined, download())).toBe(true)
  })

  it('does not rise twice for the same end (the engine may report a finished download again)', () => {
    expect(bubbleAfter(download(), download())).toBe(false)
  })

  it('does not rise for a download that is still running, failed or cancelled', () => {
    for (const state of ['progressing', 'cancelled', 'interrupted'] as const) expect(bubbleAfter(download({ state: 'progressing' }), download({ state }))).toBe(false)
  })

  it('does not rise for a file opened without being kept, nor for one with no file', () => {
    expect(bubbleAfter(undefined, download({ temporary: true }))).toBe(false)
    expect(bubbleAfter(undefined, download({ path: '' }))).toBe(false)
  })
})

describe('bubbleDownload', () => {
  it('finds the finished download the bubble is about', () => {
    expect(bubbleDownload([download({ id: 'a' }), download({ id: 'b' })], 'b')?.id).toBe('b')
  })

  it('is nothing for no bubble, for a download that left the tray, or one that is not finished', () => {
    expect(bubbleDownload([download()], undefined)).toBeUndefined()
    expect(bubbleDownload([download({ id: 'a' })], 'b')).toBeUndefined()
    expect(bubbleDownload([download({ state: 'progressing' })], 'd1')).toBeUndefined()
  })
})

describe('the room of the bubble', () => {
  it('adds its height and the gap to the tray, and nothing without it', () => {
    expect(bubbleExtra(false)).toBe(0)
    expect(bubbleExtra(true)).toBe(LITTLE_BUBBLE.height + LITTLE_BUBBLE.gap)
    const without = trayBounds({ width: 900, height: 650 }, 1)!
    const withBubble = trayBounds({ width: 900, height: 650 }, 1, bubbleExtra(true))!
    expect(withBubble.height).toBe(without.height + 50)
    // The tray keeps its 10 px from the bottom edge: it grows upwards.
    expect(withBubble.y + withBubble.height).toBe(without.y + without.height)
    expect(withBubble.y).toBe(650 - LITTLE_TRAY.margin - withBubble.height)
  })
})
