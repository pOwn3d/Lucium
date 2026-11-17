// The three Client Hints a Chromium sends, unasked, to every site it trusts: `Sec-CH-UA` (the brands), `Sec-CH-UA-Mobile` and
// `Sec-CH-UA-Platform`. Inside Electron, Chromium puts them on what a page asks for (an image, a script, the image of another site) and never
// on the navigations, the request of the page itself and of the frames in it: Electron gives Chromium nothing to decide the hints of a
// navigation with (measured on 13 November 2026 in a tab of a profile, a private window and a window of a second profile, smoke-client-hints.ts).
// A site that compares the request of its page with the requests that follow sees a browser no ordinary Chromium is. The engine adds the three
// to the navigations, with the values Chromium gives the rest: they are not worked out here but read from the engine itself, in a page of the
// interface (`navigator.userAgentData`, the same Chromium as the pages, engine/engine-client-hints.ts), and only written here in the form of the
// headers (structured fields of HTTP: a list of strings with a `v` parameter, a boolean, a string). Until they are read, nothing is added rather than
// a guess. Never the detailed hints a site asks for with `Accept-CH` (full version, version of the system, architecture, model): Chromium inside
// Electron sends none of them, on any request.

/** The three hints, by the names Chromium writes them with (in lower case, in the order it sends them on a navigation). */
export const DEFAULT_CLIENT_HINTS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'] as const
export type ClientHintHeaders = Readonly<Record<(typeof DEFAULT_CLIENT_HINTS)[number], string>>

/**
 * What the main process runs in a page of the interface to read the hints of the engine: the brands (as plain objects, which cross back to the
 * main process), the mobile flag and the system of `navigator.userAgentData`; null when the page has none.
 */
export const UA_DATA_SCRIPT = `(() => {
  const data = navigator.userAgentData
  if (!data) return null
  return { brands: Array.from(data.brands, (entry) => ({ brand: entry.brand, version: entry.version })), mobile: data.mobile, platform: data.platform }
})()`

/** Bounds on what a read may hold: Chromium gives two or three brands of a few characters. */
export const UA_DATA_LIMITS = { brands: 8, text: 64 } as const

/** A text a structured field can carry as a string: printable ASCII only (RFC 8941), within the bound. */
const isFieldText = (value: unknown): value is string => typeof value === 'string' && value.length <= UA_DATA_LIMITS.text && /^[\x20-\x7e]*$/.test(value)

/** A string of a structured field: in quotes, a quote or a backslash escaped by a backslash. */
const fieldString = (value: string): string => `"${value.replace(/[\\"]/g, (sign) => `\\${sign}`)}"`

/**
 * The three headers from what `UA_DATA_SCRIPT` read in a page of the engine: the brands in the order the engine gives them, `?1` or `?0`, the
 * system. Null for anything else (no `navigator.userAgentData`, no brand, a value that is not text a header can carry): nothing is added then.
 */
export function clientHintsOf(read: unknown): ClientHintHeaders | null {
  if (typeof read !== 'object' || read === null) return null
  const { brands, mobile, platform } = read as { brands?: unknown; mobile?: unknown; platform?: unknown }
  if (!Array.isArray(brands) || brands.length === 0 || brands.length > UA_DATA_LIMITS.brands) return null
  if (typeof mobile !== 'boolean' || !isFieldText(platform)) return null
  const list: string[] = []
  for (const entry of brands as unknown[]) {
    const { brand, version } = (typeof entry === 'object' && entry !== null ? entry : {}) as { brand?: unknown; version?: unknown }
    if (!isFieldText(brand) || brand === '' || !isFieldText(version)) return null
    list.push(`${fieldString(brand)};v=${fieldString(version)}`)
  }
  return { 'sec-ch-ua': list.join(', '), 'sec-ch-ua-mobile': mobile ? '?1' : '?0', 'sec-ch-ua-platform': fieldString(platform) }
}

/**
 * Whether Chromium trusts an address enough to send it Client Hints: https, or http to this very machine (`localhost`, a name under
 * `.localhost`, 127.0.0.0/8, `[::1]`). Plain http to any other host gets none, from Chromium as from Lucium.
 */
export function isTrustworthyWebUrl(url: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol, hostname } = new URL(url)
  if (protocol === 'https:') return true
  if (protocol !== 'http:') return false
  const host = hostname.replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** The requests the hints are added to: the navigation of a tab or of a frame in it (Electron's `mainFrame` and `subFrame`), to a trusted address. */
export function takesNavigationHints(request: { url: string; resourceType: string }): boolean {
  return (request.resourceType === 'mainFrame' || request.resourceType === 'subFrame') && isTrustworthyWebUrl(request.url)
}

/**
 * The headers of a request leaving a page, with the three hints when it is a navigation that takes them and carries none of them yet. A
 * request that already carries a `Sec-CH-UA…` header keeps exactly what it has: what put it there (a Chromium that sends them on its own one
 * day) decided. The hints go in front, where Chromium writes them on a navigation. The same object back when nothing is added.
 */
export function withNavigationHints(request: { url: string; resourceType: string }, headers: Record<string, string>, hints: ClientHintHeaders | null): Record<string, string> {
  if (hints === null || !takesNavigationHints(request)) return headers
  if (Object.keys(headers).some((name) => /^sec-ch-ua(?:-|$)/i.test(name))) return headers
  return { ...hints, ...headers }
}
