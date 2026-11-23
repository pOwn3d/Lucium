// The files of the disk that Lucium opens in a tab: the ones the Finder hands it (double-click, « Ouvrir avec », the icon of the Dock) and the ones
// dropped on a window. The interface sends paths, the main process checks them again with the same rules: this is where they are.

/**
 * What a tab shows: pages, documents, pictures, text, sound and video. Any other file would be downloaded by a tab, not shown: it is refused here, so that
 * a drop of an application or of an archive does nothing (and says so) instead of copying it into the Downloads folder.
 */
const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'html', 'htm', 'xhtml', 'xht',
  'pdf', 'svg',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif',
  'txt', 'md', 'markdown', 'json', 'xml',
  'mp4', 'm4v', 'webm', 'mov', 'mp3', 'm4a', 'wav', 'ogg'
])

/** How many tabs one drop opens at most: a folder dragged by mistake must not open hundreds. */
export const LOCAL_FILES_MAX = 10

/** The longest path kept (`PATH_MAX` of macOS). */
export const LOCAL_PATH_MAX = 1024

/**
 * The `file:` address of the path of a file Lucium opens, or `null` when it is not one: not a text, not absolute, too long, with a NUL, or of a type a tab
 * does not show. The path is written again by segments, so that a `#` or a `?` in a name stays in the name.
 */
export function localFileUrl(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > LOCAL_PATH_MAX) return null
  if (path.includes('\0')) return null
  // A Windows path (`C:\a\b.html`, as the command line of Lucium.exe gives it) is a drive and segments; the drive's colon stays in the address.
  const drive = /^([A-Za-z]):[\\/]/.exec(path)
  if (!drive && !path.startsWith('/')) return null
  const parts = (drive ? path.slice(2).replaceAll('\\', '/') : path).split('/')
  const name = parts[parts.length - 1] ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || !OPENABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) return null
  const url = `file://${drive ? `/${drive[1]}:` : ''}${parts.map(encodeURIComponent).join('/')}`
  return URL.canParse(url) ? new URL(url).href : null
}

/**
 * The addresses to open for the paths a window sends, at most `LOCAL_FILES_MAX`, and how many paths were left out (a type that is not shown, a path
 * that is not one, or one past the ceiling). The interface is not trusted: whatever is not a list of texts opens nothing.
 */
export function localFileUrls(raw: unknown): { urls: string[]; refused: number } {
  if (!Array.isArray(raw)) return { urls: [], refused: 0 }
  const urls: string[] = []
  let refused = raw.length
  // The work is bounded too: a list of a million entries is looked at as far as it could be opened, not further.
  for (const path of raw.slice(0, LOCAL_FILES_MAX * 5)) {
    const url = localFileUrl(path)
    if (url === null || urls.length >= LOCAL_FILES_MAX) continue
    urls.push(url)
    refused--
  }
  return { urls, refused }
}
