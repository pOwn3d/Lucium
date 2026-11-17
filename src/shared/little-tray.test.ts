import { describe, expect, it } from 'vitest'
import type { DownloadInfo } from './model'
import { LITTLE_TRAY, trayBounds, trayRows, withDownload } from './little-tray'

const download = (id: string, startedAt: number): DownloadInfo => ({ id, filename: `${id}.bin`, url: 'https://x.example/', path: `/tmp/${id}`, state: 'completed', receivedBytes: 1, totalBytes: 1, startedAt })

describe('trayRows', () => {
  it('lists the newest downloads first, three at most', () => {
    const rows = trayRows([download('a', 1), download('b', 4), download('c', 2), download('d', 3)])
    expect(rows.map((d) => d.id)).toEqual(['b', 'd', 'c'])
  })
})

describe('withDownload', () => {
  it('puts a download first, replaces an older state of the same file, and keeps the list bounded', () => {
    const first = withDownload([], download('a', 1))
    const updated = withDownload(first, { ...download('a', 1), receivedBytes: 5 })
    expect(updated).toHaveLength(1)
    expect(updated[0]!.receivedBytes).toBe(5)
    let many: DownloadInfo[] = []
    for (let i = 0; i < LITTLE_TRAY.kept + 10; i++) many = withDownload(many, download(`d${i}`, i))
    expect(many).toHaveLength(LITTLE_TRAY.kept)
    expect(many[0]!.id).toBe(`d${LITTLE_TRAY.kept + 9}`)
  })
})

describe('trayBounds', () => {
  it('sits 10 px from the left and the bottom of the window, 380 wide, a row of 54 px per file', () => {
    expect(trayBounds({ width: 900, height: 650 }, 1)).toEqual({ x: 10, y: 650 - 10 - 66, width: 380, height: 66 })
    expect(trayBounds({ width: 900, height: 650 }, 3)).toEqual({ x: 10, y: 650 - 10 - 174, width: 380, height: 174 })
  })

  it('does not grow past three rows, shrinks with a narrow window, and is nothing when there is nothing to show', () => {
    expect(trayBounds({ width: 900, height: 650 }, 9)!.height).toBe(174)
    expect(trayBounds({ width: 300, height: 650 }, 1)!.width).toBe(280)
    expect(trayBounds({ width: 900, height: 650 }, 0)).toBeNull()
  })
})
