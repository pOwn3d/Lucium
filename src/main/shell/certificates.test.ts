import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { CERTIFICATE_NOTICES_MAX, CERTIFICATE_NOTICE_MS, clientCertificateNotice, refuseClientCertificates } from './certificates'

function request(host: EventEmitter) {
  const event = { preventDefault: vi.fn() }
  const callback = vi.fn()
  host.emit('select-client-certificate', event, {}, 'https://mtls.example/', [{ subjectName: 'the user' }, { subjectName: 'another' }], callback)
  return { event, callback }
}

describe('refuseClientCertificates', () => {
  it('stops Electron from presenting the first certificate of the keychain, and answers without one', () => {
    const host = new EventEmitter()
    refuseClientCertificates(host)
    const { event, callback } = request(host)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith()
  })

  it('answers every request, however many certificates there are', () => {
    const host = new EventEmitter()
    refuseClientCertificates(host)
    for (let i = 0; i < 3; i++) expect(request(host).callback).toHaveBeenCalledTimes(1)
  })

  it('answers without a certificate when the keychain is empty too', () => {
    const host = new EventEmitter()
    refuseClientCertificates(host)
    const callback = vi.fn()
    host.emit('select-client-certificate', { preventDefault: vi.fn() }, {}, 'https://mtls.example/', [], callback)
    expect(callback).toHaveBeenCalledWith()
  })
})

describe('what the user is told when a server asks for a certificate', () => {
  /** The web contents of the page that made the request, as Electron names it. */
  const PAGE = { id: 12 }
  const ask = (host: EventEmitter, url: string, contents: unknown = PAGE) => {
    const callback = vi.fn()
    host.emit('select-client-certificate', { preventDefault: vi.fn() }, contents, url, [{}], callback)
    return callback
  }
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  // It used to be a notice of the system that named no site: it stays in the notification centre, and the tab may be a private one.
  it('is said for the page that asked, with the host of the server and nothing else of the address', () => {
    quiet()
    const host = new EventEmitter()
    const tell = vi.fn(() => true)
    refuseClientCertificates(host, tell)
    expect(ask(host, 'https://intranet.example:8443/login?token=s3cr3t#compte')).toHaveBeenCalledWith()
    expect(tell).toHaveBeenCalledExactlyOnceWith(PAGE, 'intranet.example:8443')
    vi.restoreAllMocks()
  })

  it('is a sentence that names the site, says that none is presented and that the site may fail, in both languages', () => {
    setLanguage('fr')
    // The catalogue ties the colon to its word with a space that does not break: the sentence is compared with plain spaces.
    expect(clientCertificateNotice('intranet.example').replace(/[  ]/g, ' ')).toBe('intranet.example demande un certificat pour vous identifier. Lucium n’en présente aucun : la connexion à ce site peut échouer.')
    setLanguage('en')
    expect(clientCertificateNotice('intranet.example')).toBe('intranet.example is asking for a certificate to identify you. Lucium presents none: the connection to this site may fail.')
    setLanguage('fr')
    // Long enough to be read: it explains a page that failed.
    expect(CERTIFICATE_NOTICE_MS).toBeGreaterThanOrEqual(8000)
  })

  it('is said once for a server in a run, and again for another server; every request is still answered without a certificate', () => {
    quiet()
    const host = new EventEmitter()
    const tell = vi.fn(() => true)
    refuseClientCertificates(host, tell)
    for (const url of ['https://intranet.example/a', 'https://intranet.example/b', 'wss://intranet.example/socket']) expect(ask(host, url)).toHaveBeenCalledWith()
    expect(tell).toHaveBeenCalledTimes(1)
    ask(host, 'https://intranet.example:8443/')
    ask(host, 'https://other.example/')
    expect(tell).toHaveBeenCalledTimes(3)
    vi.restoreAllMocks()
  })

  it('stops after a number of servers: a page that asks under many names does not fill the window with notices', () => {
    quiet()
    const host = new EventEmitter()
    const tell = vi.fn(() => true)
    refuseClientCertificates(host, tell)
    for (let i = 0; i < CERTIFICATE_NOTICES_MAX + 20; i++) expect(ask(host, `https://h${i}.example/`)).toHaveBeenCalledWith()
    expect(tell).toHaveBeenCalledTimes(CERTIFICATE_NOTICES_MAX)
    vi.restoreAllMocks()
  })

  it('writes in the journal that the user could not be told when no window shows the page, and tells for the next page that asks', () => {
    quiet()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const host = new EventEmitter()
    const tell = vi.fn((contents: unknown) => contents === PAGE)
    refuseClientCertificates(host, tell)
    // A request no page of a tab made (the application's own, a hidden page).
    expect(ask(host, 'https://intranet.example/', null)).toHaveBeenCalledWith()
    expect(error).toHaveBeenCalledExactlyOnceWith('[certificates] could not tell the user that no client certificate was presented: no window shows the page that asked')
    // The server was not said: the tab that asks next is told.
    ask(host, 'https://intranet.example/')
    expect(tell).toHaveBeenLastCalledWith(PAGE, 'intranet.example')
    expect(tell).toHaveBeenCalledTimes(2)
    ask(host, 'https://intranet.example/again')
    expect(tell).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })

  it('still answers without a certificate when the notice itself fails, and the journal says why', () => {
    quiet()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const host = new EventEmitter()
    refuseClientCertificates(host, () => {
      throw new Error('the window is gone')
    })
    expect(ask(host, 'https://intranet.example/')).toHaveBeenCalledWith()
    expect(error).toHaveBeenCalledWith('[certificates] the notice of a refused client certificate failed:', 'the window is gone')
    vi.restoreAllMocks()
  })

  it('names nothing for an address that is not one: the journal alone says the refusal', () => {
    const warn = quiet()
    const host = new EventEmitter()
    const tell = vi.fn(() => true)
    refuseClientCertificates(host, tell)
    expect(ask(host, 'not an address')).toHaveBeenCalledWith()
    expect(tell).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })
})
