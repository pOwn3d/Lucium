// Where the speed of a download is shown: the tip of the status chip and the list of the downloads, drawn to markup with the real components (no window).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { DownloadInfo } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { chipLabel, chipView, noStatus } from '@shared/download-status'
import { downloadStatus } from '@shared/downloads-view'
import { withSpeed } from '@shared/download-speed'

/** What the list of the downloads reads: its snapshot, and the book its hook of the speeds gives back (with the flag it was asked with). */
const holder = vi.hoisted(() => ({ snapshot: null as unknown, book: {} as Record<string, unknown>, asked: [] as boolean[] }))
vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => holder.snapshot }))
vi.mock('./DownloadStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./DownloadStatus')>()),
  useDownloadSpeeds: (_downloads: unknown, enabled: boolean) => (holder.asked.push(enabled), holder.book)
}))

import { DownloadChip } from './DownloadStatus'
import { DownloadsPanel } from './Panels'
import { frenchSpaces } from '@shared/french-typography'

const download = (patch: Partial<DownloadInfo> = {}): DownloadInfo => ({ id: 'd1', filename: 'a.pdf', url: 'https://exemple.fr/a.pdf', path: '/tmp/a.pdf', state: 'progressing', receivedBytes: 0, totalBytes: 10_000_000, startedAt: 0, ...patch })
const MB = 1024 ** 2

describe('where the speed is shown', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined })
    setLanguage('fr')
    holder.asked.length = 0
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    holder.book = {}
  })

  const coming = download({ receivedBytes: 4 * MB, startedAt: 5 })
  const tipOf = (markup: string): string => /class="footer-side footer-downloads[^"]*"[^>]*data-tip="([^"]*)"/.exec(markup)?.[1] ?? ''

  it('is in the tip of the chip while a file comes, and nowhere else on it', () => {
    const view = chipView([coming], noStatus())
    const markup = renderToStaticMarkup(createElement(DownloadChip, { view, speed: 1.2 * MB, onOpenPanel: () => undefined, onCancel: () => undefined }))
    expect(tipOf(markup)).toBe(withSpeed(chipLabel(view), 1.2 * MB))
    expect(tipOf(markup)).toContain(frenchSpaces('· 1,2 Mo/s'))
    expect(markup.match(/Mo\/s/g)).toHaveLength(1)
    // Once the file has come, the tip says so without a speed.
    const done = chipView([download({ state: 'completed', receivedBytes: 10_000_000 })], { seen: {}, bubble: { kind: 'done', id: 'd1', until: null } })
    expect(done.state).toBe('done')
    const after = renderToStaticMarkup(createElement(DownloadChip, { view: done, speed: 1.2 * MB, onOpenPanel: () => undefined, onCancel: () => undefined }))
    expect(after).not.toContain('Mo/s')
  })

  it('is in the list under the size, measured only while the status chip is on: off, the list keeps its default rows', () => {
    for (const chip of [true, false]) {
      const state = createInitialState({ now: 1, newId: () => 'id' })
      holder.snapshot = { state: { ...state, settings: { ...state.settings, downloadStatusChip: chip } }, downloads: [coming] }
      // The hook gives the book it measured: here a reading of 1,2 Mo/s for the file.
      holder.book = { d1: { at: 0, bytes: 0, speed: 1.2 * MB } }
      const markup = renderToStaticMarkup(createElement(DownloadsPanel))
      expect(holder.asked).toEqual([chip])
      holder.asked.length = 0
      expect(markup).toContain(`<div class="dlpop-status">${withSpeed(downloadStatus(coming), 1.2 * MB)}</div>`)
    }
  })
})
