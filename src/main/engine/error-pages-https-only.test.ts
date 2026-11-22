// The page of « HTTPS seul » on a page without Electron (page-errors.test-support.ts): a load the mode refused or that failed over https shows the warning
// with « Continuer en HTTP », which goes to the address through the memory of the upgrades, on a click only; a certificate error keeps its own page.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeContents, FakeCover, fakeHost } from './page-errors.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('./page-cover', async () => ({ PageCover: (await import('./page-errors.test-support')).FakeCover }))

const { PageErrors } = await import('./error-pages')

const HTTP = 'http://exemple.fr:8080/a'
const refused = { kind: 'refused', http: HTTP, only: true } as const

function page(upgrade: ReturnType<ReturnType<typeof fakeHost>['upgradeFailed']> = refused) {
  const wc = new FakeContents()
  const host = fakeHost()
  host.upgradeFailed.mockReturnValue(upgrade)
  new PageErrors(wc as never, host as never)
  return { wc, host }
}
const written = (wc: FakeContents): string => wc.scripts.at(-1) ?? ''

beforeEach(() => {
  FakeCover.made = []
})

describe('the page of « HTTPS seul »', () => {
  it('shows the warning, with the click on http, for an address the mode refused', () => {
    const { wc } = page()
    wc.fail(HTTP, -20, 'ERR_BLOCKED_BY_CLIENT')
    expect(written(wc)).toContain('lucium-error:http')
    expect(written(wc)).toContain('exemple.fr')
    expect(written(wc)).not.toContain('lucium-error:toggle-blocker')
  })

  it('shows it for the https address that did not answer, and goes to the http address on the click, and only then', () => {
    const { wc, host } = page()
    wc.fail('https://exemple.fr/a', -118, 'ERR_CONNECTION_TIMED_OUT')
    expect(written(wc)).toContain('lucium-error:http')
    expect(host.continueOverHttp).not.toHaveBeenCalled()
    wc.click('http')
    expect(host.continueOverHttp).toHaveBeenCalledWith(HTTP)
  })

  it('keeps the page of the certificate, with its click on http, when the https address was refused a certificate', () => {
    const { wc } = page()
    wc.fail('https://exemple.fr/a', -202, 'ERR_CERT_AUTHORITY_INVALID')
    expect(written(wc)).toContain('lucium-error:http')
    expect(written(wc)).toContain('ERR_CERT_AUTHORITY_INVALID')
  })

  it('does not take the page of a failure of HTTPS first for it, and ignores the click on a page that is not the warning', () => {
    const { wc, host } = page({ kind: 'none' })
    wc.fail('https://exemple.fr/a', -105, 'ERR_NAME_NOT_RESOLVED')
    expect(written(wc)).not.toContain('lucium-error:http')
    wc.click('http')
    expect(host.continueOverHttp).not.toHaveBeenCalled()
  })

  it('goes back from the warning when there is a page to go back to', () => {
    const { wc, host } = page()
    wc.canGoBack = true
    wc.fail(HTTP, -20, 'ERR_BLOCKED_BY_CLIENT')
    wc.click('back')
    expect(host.goBack).toHaveBeenCalledTimes(1)
  })
})
