// HTTPS first and a certificate that is not valid: the page of the certificate shows, never a silent load in http; it offers the
// http address the user asked for, and only a click on it goes there. Run on a page without Electron (page-errors.test-support.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_SCHEME } from '@shared/error-pages'
import { FakeContents, FakeCover, fakeHost } from './page-errors.test-support'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('./page-cover', async () => ({ PageCover: (await import('./page-errors.test-support')).FakeCover }))

const { PageErrors } = await import('./error-pages')

const HTTP = 'http://exemple.fr/p'
const HTTPS = 'https://exemple.fr/p'
const certificate = { fingerprint: 'sha256/AAAA', subjectName: 'autre.example', issuerName: 'X', validStart: 1, validExpiry: 2 }

function page(upgrade: 'none' | 'fell-back' | 'refused') {
  const wc = new FakeContents()
  const host = fakeHost()
  host.upgradeFailed.mockImplementation(() => (upgrade === 'refused' ? { kind: 'refused', http: HTTP } : { kind: upgrade }))
  new PageErrors(wc as never, host as never)
  // Chromium refuses the certificate (nobody vouched for it), then reports the failed load and commits its error document.
  wc.emit('certificate-error', { preventDefault: vi.fn() }, HTTPS, 'net::ERR_CERT_AUTHORITY_INVALID', certificate, vi.fn(), true)
  wc.fail(HTTPS, -202, 'net::ERR_CERT_AUTHORITY_INVALID')
  const written = wc.scripts.at(-1) ?? ''
  return { wc, host, written }
}

beforeEach(() => {
  FakeCover.made = []
})

describe('the certificate page of an address HTTPS first upgraded', () => {
  it('tells the upgrade the failure is a certificate one, so that it does not go to http by itself', () => {
    const { host } = page('refused')
    expect(host.upgradeFailed).toHaveBeenCalledWith(HTTPS, -202, true)
  })

  it('shows the page of the certificate, with a button for the http address', () => {
    const { written } = page('refused')
    expect(written).toContain('Votre connexion n’est pas privée')
    expect(written).toContain(`${ERROR_SCHEME}http?n=`)
    expect(written).toContain('Ouvrir en HTTP (non sécurisé)')
  })

  it('goes to the http address on a click of that button, and only then', () => {
    const { wc, host } = page('refused')
    expect(host.continueOverHttp).not.toHaveBeenCalled()
    wc.click('http')
    expect(host.continueOverHttp).toHaveBeenCalledExactlyOnceWith(HTTP)
  })

  it('offers no http address for a certificate of an address that was asked for in https', () => {
    const { wc, host, written } = page('none')
    expect(written).toContain('Votre connexion n’est pas privée')
    expect(written).not.toContain(`${ERROR_SCHEME}http?n=`)
    wc.click('retry')
    expect(host.continueOverHttp).not.toHaveBeenCalled()
  })

  it('shows nothing when the upgrade went back to http for a site that did not answer', () => {
    const wc = new FakeContents()
    const host = fakeHost()
    host.upgradeFailed.mockImplementation(() => ({ kind: 'fell-back' }))
    new PageErrors(wc as never, host as never)
    wc.fail(HTTPS, -102, 'net::ERR_CONNECTION_REFUSED')
    expect(host.upgradeFailed).toHaveBeenCalledWith(HTTPS, -102, false)
    expect(wc.scripts).toEqual([])
  })
})
