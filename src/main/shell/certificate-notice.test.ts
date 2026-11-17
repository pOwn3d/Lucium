// A server asked the page of a tab for a client certificate and got none (certificates.ts): the window of the tab says so in a notice of its
// own, which names the site. It used to be a notice of the system that named none. The real `pageEvents` of the shell runs on a stand-in for
// the window (browser-fake.test-support.ts).

import { describe, expect, it, vi } from 'vitest'
import type { PageEvents } from '../engine/types'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import { CERTIFICATE_NOTICE_MS, clientCertificateNotice } from './certificates'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

describe('a client certificate asked of the page of a tab', () => {
  it.each([false, true])('is said in a notice of the window of the tab, with the site (a private tab: %s)', (privateTab) => {
    const fake = fakeBrowser()
    const tab = { id: 'tab-1', url: 'https://intranet.example/', title: 'Intranet', ...(privateTab ? { private: true } : {}) }
    const events = shell['pageEvents']!.call(fake.self, tab) as PageEvents
    events.clientCertificateRefused!('intranet.example:8443')
    const notices = fake.calls.filter((call) => call.name === 'showToast')
    expect(notices).toHaveLength(1)
    // No button: there is nothing to do about it here. Longer than a plain notice: it explains a page that failed.
    expect(notices[0]!.args).toEqual([clientCertificateNotice('intranet.example:8443'), undefined, CERTIFICATE_NOTICE_MS])
    expect(String(notices[0]!.args[0])).toContain('intranet.example:8443')
  })
})
