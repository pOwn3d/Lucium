// The pictures the interface draws itself: the icon of a tab or a favourite is an <img> of the application's own session (the default session),
// loaded from the site or its CDN. That session belongs to no profile, and its cookie jar is emptied only when the data of a whole profile are erased: a host of icons that set a
// cookie there would get an identifier that outlives the erasure of a site and lasts across launches. So the requests of those
// pictures carry no cookie and their answers set none; with Global Privacy Control on they carry its header, as the pages do.

import { withUserAgent } from './user-agent'

const without = <T>(headers: Record<string, T>, names: readonly string[]): Record<string, T> =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name.toLowerCase())))

/** The headers of a picture the interface asks for: the user agent of the pages, no cookie, and `Sec-GPC: 1` while the option is on. */
export function interfaceImageRequestHeaders(headers: Record<string, string>, agent: string, globalPrivacyControl: boolean): Record<string, string> {
  const kept = without(withUserAgent(headers, agent), ['cookie', 'sec-gpc'])
  return globalPrivacyControl ? { ...kept, 'Sec-GPC': '1' } : kept
}

/** The headers of the answer to such a picture, without the cookies it would set. */
export function interfaceImageResponseHeaders(headers: Record<string, string[]> | undefined): Record<string, string[]> {
  return without(headers ?? {}, ['set-cookie'])
}
