// With Global Privacy Control on, the pages told every site the user refuses the sale of their data, and the requests Lucium makes for itself (the
// feed of the versions, the filter lists, the translation catalogue, the Chrome Web Store, the icons) went out without the header.

import { describe, expect, it } from 'vitest'
import { GPC_HEADER, ownRequestHeaders } from './own-requests'

describe('the headers of a request the application makes for itself', () => {
  it('carry Sec-GPC: 1 while the option is on, with everything the request already had', () => {
    expect(ownRequestHeaders({ Accept: 'application/json', 'User-Agent': 'Lucium' }, true)).toEqual({ Accept: 'application/json', 'User-Agent': 'Lucium', 'Sec-GPC': '1' })
    expect(GPC_HEADER).toEqual({ name: 'Sec-GPC', value: '1' })
  })

  it('carry it once, whatever case and value a caller gave it', () => {
    const headers = ownRequestHeaders({ 'sec-gpc': '0', 'SEC-GPC': '0', Accept: '*/*' }, true)
    expect(Object.entries(headers).filter(([name]) => name.toLowerCase() === 'sec-gpc')).toEqual([['Sec-GPC', '1']])
  })

  it('are left as they are while the option is off: nothing is added, and the same object comes back', () => {
    const headers = { Accept: '*/*' }
    expect(ownRequestHeaders(headers, false)).toBe(headers)
    expect(Object.keys(ownRequestHeaders({}, false))).toEqual([])
  })
})
