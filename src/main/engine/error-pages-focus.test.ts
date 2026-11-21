// The block page of the focus mode (shared/focus-mode.ts) on a page without Electron (page-errors.test-support.ts): a main-frame load the request filter
// refused (ERR_BLOCKED_BY_CLIENT, -20) gets the focus page when the gate says the address is closed, and the ad blocker's page otherwise; « Faire une
// pause » pauses focus through the gate and reloads the address.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeContents, FakeCover, fakeHost } from './page-errors.test-support'
import { focusGate } from './focus-gate'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('./page-cover', async () => ({ PageCover: (await import('./page-errors.test-support')).FakeCover }))

const { PageErrors } = await import('./error-pages')

const BLOCKED = -20
const pause = vi.fn()

function page() {
  const wc = new FakeContents()
  const host = fakeHost()
  new PageErrors(wc as never, host as never)
  return { wc, host }
}
const written = (wc: FakeContents): string => wc.scripts.at(-1) ?? ''

beforeEach(() => {
  FakeCover.made = []
  pause.mockClear()
  focusGate.set({ block: (url) => (new URL(url).hostname === 'news.example.com' ? { until: Date.UTC(2026, 10, 23, 10, 0), slotEnd: null } : null), pause })
})
afterEach(() => focusGate.set(null))

describe('the block page of the focus mode', () => {
  it('shows the focus page, with the pause button, for a refused address the gate closes', () => {
    const { wc } = page()
    wc.fail('https://news.example.com/a', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(wc)).toContain('lucium-error:end-focus')
    expect(written(wc)).toContain('news.example.com')
    expect(written(wc)).not.toContain('lucium-error:toggle-blocker')
  })

  it('leaves the ordinary page of a refused load when the gate does not close the address, or when there is no gate', () => {
    const { wc } = page()
    wc.fail('https://ads.example/x', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(wc)).not.toContain('end-focus')
    expect(written(wc)).toContain('lucium-error:toggle-blocker')
    focusGate.set(null)
    wc.fail('https://news.example.com/a', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(wc)).not.toContain('end-focus')
  })

  it('does not take another error of a closed site for the focus page', () => {
    const { wc } = page()
    wc.fail('https://news.example.com/a', -105, 'ERR_NAME_NOT_RESOLVED')
    expect(written(wc)).not.toContain('end-focus')
  })

  it('pauses focus through the gate and reloads the address when the pause button is clicked', () => {
    const { wc, host } = page()
    wc.fail('https://news.example.com/a', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    wc.click('end-focus')
    expect(pause).toHaveBeenCalledTimes(1)
    expect(host.reload).toHaveBeenCalledTimes(1)
  })

  it('ignores the pause button of a page that is not the focus page', () => {
    const { wc, host } = page()
    wc.fail('https://absent.example/', -105, 'ERR_NAME_NOT_RESOLVED')
    wc.click('end-focus')
    expect(pause).not.toHaveBeenCalled()
    expect(host.reload).not.toHaveBeenCalled()
  })
})
