import { describe, expect, it, vi } from 'vitest'

// The lookup's own session, faked: what matters here is who may change how it checks certificates.
const setCertificateVerifyProc = vi.fn()
vi.mock('electron', () => ({ net: {}, session: { fromPartition: () => ({ setCertificateVerifyProc }) } }))

const { FaviconService } = await import('./favicon-service')

const service = () =>
  new FaviconService({
    store: { get: () => ({ settings: { resolveFavicons: true } }) as never, subscribe: () => () => undefined },
    views: () => [],
    hasPage: () => false,
    dispatch: () => undefined,
    blocked: () => false
  })

describe('the hosts the engine test lets the lookup trust', () => {
  it('are refused outside an engine test run: the certificates of the session stay checked', () => {
    setCertificateVerifyProc.mockClear()
    expect(() => service().allowHostsForTest(['127.0.0.1:8443'], ['/Applications/Lucium.app/Contents/MacOS/Lucium'])).toThrow(/engine test only/)
    expect(setCertificateVerifyProc).not.toHaveBeenCalled()
  })

  it('are taken in an engine test run', () => {
    setCertificateVerifyProc.mockClear()
    service().allowHostsForTest(['127.0.0.1:8443'], ['electron', '.', '--smoke'])
    expect(setCertificateVerifyProc).toHaveBeenCalledTimes(1)
  })
})
