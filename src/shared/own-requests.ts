// The requests the application makes for itself: the feed of the versions, the filter lists, the translation catalogue, the Chrome Web Store,
// the search suggestions, the lookup of a site's icon, a live folder. No page is behind them, so the hook that signs the requests of the pages
// never saw them: with Global Privacy Control on, the user told every site they refuse the sale of their data, and the servers Lucium itself
// asks were the only ones not told. They carry the header too; nothing else of them changes.

/** The name and the value of the header, as the pages send it. */
export const GPC_HEADER = { name: 'Sec-GPC', value: '1' } as const

/**
 * The headers of a request of the application: `Sec-GPC: 1` while the option is on, once, whatever case a caller wrote the name in. With the
 * option off the headers are handed back as they are (the same object: the caller can tell nothing was changed).
 */
export function ownRequestHeaders(headers: Record<string, string>, globalPrivacyControl: boolean): Record<string, string> {
  if (!globalPrivacyControl) return headers
  return { ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'sec-gpc')), [GPC_HEADER.name]: GPC_HEADER.value }
}
