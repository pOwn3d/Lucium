// The warning page of safe browsing (shared/safe-browsing.ts) on a page without Electron: a main-frame load the request filter refused
// (ERR_BLOCKED_BY_CLIENT, -20) gets the warning when the gate lists the address, and the ad blocker's page otherwise; « Continuer quand même » lets the host
// through the gate and reloads.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeContents, FakeCover, fakeHost } from './page-errors.test-support'
import { safeGate } from './safe-gate'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('./page-cover', async () => ({ PageCover: (await import('./page-errors.test-support')).FakeCover }))

const { PageErrors } = await import('./error-pages')

const BLOCKED = -20
const allow = vi.fn()
const except = vi.fn()

function page() {
  const wc = new FakeContents()
  const host = fakeHost()
  new PageErrors(wc as never, host as never)
  return { wc, host }
}
const written = (wc: FakeContents): string => wc.scripts.at(-1) ?? ''

beforeEach(() => {
  FakeCover.made = []
  allow.mockClear()
  except.mockClear()
  safeGate.set({ verdict: (url) => (new URL(url).hostname === 'phish.example' ? { category: 'phishing', host: 'phish.example' } : null), allow, except })
})
afterEach(() => safeGate.set(null))

describe('the warning page of safe browsing', () => {
  it('shows the warning, with the way through, for a refused address the gate lists', () => {
    const { wc } = page()
    wc.fail('https://phish.example/login', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(wc)).toContain('lucium-error:unsafe-continue')
    expect(written(wc)).toContain('phish.example')
    expect(written(wc)).not.toContain('lucium-error:toggle-blocker')
  })

  it('leaves the ordinary page of a refused load when the gate does not list the address, or when there is no gate', () => {
    const { wc } = page()
    wc.fail('https://ads.example/x', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(wc)).not.toContain('unsafe-continue')
    expect(written(wc)).toContain('lucium-error:toggle-blocker')
    safeGate.set(null)
    wc.fail('https://phish.example/', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(wc)).not.toContain('unsafe-continue')
  })

  it('does not take another error of a listed site for the warning', () => {
    const { wc } = page()
    wc.fail('https://phish.example/', -105, 'ERR_NAME_NOT_RESOLVED')
    expect(written(wc)).not.toContain('unsafe-continue')
  })

  it('lets the address through the gate and reloads when « Continuer quand même » is clicked', () => {
    const { wc, host } = page()
    wc.fail('https://phish.example/login', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    wc.click('unsafe-continue')
    expect(allow).toHaveBeenCalledWith('https://phish.example/login')
    expect(host.reload).toHaveBeenCalledTimes(1)
  })

  it('adds the site to the lasting exceptions and reloads when « Ne plus prévenir pour ce site » is clicked, and lets nothing through for the run', () => {
    const { wc, host } = page()
    wc.fail('https://phish.example/login', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    wc.click('unsafe-except')
    expect(except).toHaveBeenCalledWith('https://phish.example/login')
    expect(allow).not.toHaveBeenCalled()
    expect(host.reload).toHaveBeenCalledTimes(1)
  })

  it('ignores the buttons of a page that is not the warning', () => {
    const { wc, host } = page()
    wc.fail('https://absent.example/', -105, 'ERR_NAME_NOT_RESOLVED')
    wc.click('unsafe-continue')
    wc.click('unsafe-except')
    expect(allow).not.toHaveBeenCalled()
    expect(except).not.toHaveBeenCalled()
    expect(host.reload).not.toHaveBeenCalled()
  })
})
