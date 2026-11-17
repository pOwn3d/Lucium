// How the engine says the last load of a page ended (PageErrors.loadFailure in error-pages.ts), for the tabs whose site no longer answers
// (shared/dead-tabs.ts decides): run on a page without Electron, as status-page.test.ts does.

import { describe, expect, it, vi } from 'vitest'
import { FakeContents, fakeHost, settle } from './page-errors.test-support'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('./page-cover', async () => ({ PageCover: (await import('./page-errors.test-support')).FakeCover }))

const { PageErrors } = await import('./error-pages')

function page() {
  const wc = new FakeContents()
  const errors = new PageErrors(wc as never, fakeHost() as never)
  return { wc, errors }
}

describe('how the last load of a page ended', () => {
  it('is nothing for a page that loaded', () => {
    const { wc, errors } = page()
    wc.commit('https://site.example/', 200)
    expect(errors.loadFailure()).toBeNull()
  })

  it('is the network error of a load that failed, from the failure to the next page that loads', async () => {
    const { wc, errors } = page()
    wc.fail('https://gone.example/', -105, 'ERR_NAME_NOT_RESOLVED')
    expect(errors.loadFailure()).toEqual({ kind: 'network', name: 'ERR_NAME_NOT_RESOLVED' })
    await settle()
    expect(errors.loadFailure()).toEqual({ kind: 'network', name: 'ERR_NAME_NOT_RESOLVED' })
    wc.commit('https://gone.example/', 200)
    expect(errors.loadFailure()).toBeNull()
  })

  it('is the certificate refused, apart from the network errors', () => {
    const { wc, errors } = page()
    wc.fail('https://preprod.example/', -202, 'ERR_CERT_AUTHORITY_INVALID')
    expect(errors.loadFailure()).toEqual({ kind: 'certificate', name: 'ERR_CERT_AUTHORITY_INVALID' })
  })

  it('is the error status of the main document, even one that shows a page of its own, until another document answers', () => {
    const { wc, errors } = page()
    wc.facts = { textLength: 400, hasContent: true, hasScript: true }
    wc.commit('https://site.example/removed', 404)
    expect(errors.loadFailure()).toEqual({ kind: 'status', status: 404 })
    wc.commit('https://site.example/', 200)
    expect(errors.loadFailure()).toBeNull()
    // A document that is not on the web has no status to say.
    wc.commit('file:///tmp/absent.html', 404)
    expect(errors.loadFailure()).toBeNull()
  })
})
