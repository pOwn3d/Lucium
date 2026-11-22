// The warning page of a typed address that looks like a site of the person (shared/typo-guard.ts), on a page without Electron (page-errors.test-support.ts):
// a main-frame load the request filter held (ERR_BLOCKED_BY_CLIENT, -20) gets the warning when the typo gate holds that address, and the ad blocker's page
// otherwise; « Continuer » lets the host through the gate and reloads, « Retour » goes back; neither answers a page that is not the warning.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeContents, FakeCover, fakeHost } from './page-errors.test-support'
import { typoGate } from './typo-gate'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('./page-cover', async () => ({ PageCover: (await import('./page-errors.test-support')).FakeCover }))

const { PageErrors } = await import('./error-pages')

const BLOCKED = -20

function page() {
  const wc = new FakeContents()
  const host = fakeHost()
  new PageErrors(wc as never, host as never)
  return { wc, host }
}
const written = (wc: FakeContents): string => wc.scripts.at(-1) ?? ''

/** The address was typed, and the request filter held its load: what the shell and the filter do before the page is asked for. */
function typed(url: string, similar: string): void {
  typoGate.expect(new URL(url).hostname, similar)
  typoGate.holds(url)
}

beforeEach(() => {
  FakeCover.made = []
})
afterEach(() => typoGate.forgetAll())

describe('the warning page of a lookalike address', () => {
  it('names the site it looks like and offers « Continuer », for a refused load the gate holds', () => {
    const { wc } = page()
    typed('https://gogle.com/', 'google.com')
    wc.fail('https://gogle.com/', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(wc)).toContain('lucium-error:typo-continue')
    expect(written(wc)).toContain('google.com')
    expect(written(wc)).not.toContain('lucium-error:toggle-blocker')
  })

  it('leaves the ordinary page of a refused load for an address the gate does not hold', () => {
    const { wc } = page()
    wc.fail('https://ads.example/x', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(wc)).not.toContain('typo-continue')
    expect(written(wc)).toContain('lucium-error:toggle-blocker')
  })

  it('does not take another error of a held address for the warning', () => {
    const { wc } = page()
    typed('https://gogle.com/', 'google.com')
    wc.fail('https://gogle.com/', -105, 'ERR_NAME_NOT_RESOLVED')
    expect(written(wc)).not.toContain('typo-continue')
  })

  it('lets the host through and reloads on « Continuer »', () => {
    const { wc, host } = page()
    typed('https://gogle.com/', 'google.com')
    wc.fail('https://gogle.com/', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    wc.click('typo-continue')
    expect(host.reload).toHaveBeenCalledTimes(1)
    expect(typoGate.warning('https://gogle.com/')).toBeNull()
    typoGate.expect('gogle.com', 'google.com')
    expect(typoGate.holds('https://gogle.com/')).toBe(false)
  })

  it('ignores « Continuer » on a page that is not the warning', () => {
    const { wc, host } = page()
    typed('https://gogle.com/', 'google.com')
    wc.fail('https://absent.example/', -105, 'ERR_NAME_NOT_RESOLVED')
    wc.click('typo-continue')
    expect(host.reload).not.toHaveBeenCalled()
    expect(typoGate.holds('https://gogle.com/')).toBe(false)
    expect(typoGate.warning('https://gogle.com/')).toEqual({ similar: 'google.com' })
  })

  it('offers « Retour » only when there is a page to go back to, and goes back on a click', () => {
    const { wc, host } = page()
    typed('https://gogle.com/', 'google.com')
    wc.fail('https://gogle.com/', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(wc)).not.toContain('lucium-error:back')
    const other = page()
    other.wc.canGoBack = true
    typed('https://gogle.com/', 'google.com')
    other.wc.fail('https://gogle.com/', BLOCKED, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(other.wc)).toContain('lucium-error:back')
    other.wc.click('back')
    expect(other.host.goBack).toHaveBeenCalledTimes(1)
    expect(host.goBack).not.toHaveBeenCalled()
  })
})
