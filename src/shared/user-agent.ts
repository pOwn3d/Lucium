// What the pages of the browser say they are. Electron's own user agent carries the name of the application and an `Electron/x` token:
// Google, among others, takes that for an embedded browser and refuses or warns at sign-in. The pages of Lucium present themselves as a
// plain Chrome of the same major version as the Chromium inside (it is Chromium that answers, so the same major keeps every feature test
// of a site true). The pages of the interface and the requests the application makes for itself (filter lists, updates) keep their own, and so do the sign-in pages of
// Google, in the tabs that are on them (shared/google-sign-in.ts): Google refused some accounts a browser that says it is Chrome while its other signals are Electron's.

/** The major version of a Chromium version string (`156.0.8078.48` gives `156`), or null when it is not one. */
export function chromeMajor(version: unknown): string | null {
  if (typeof version !== 'string') return null
  const match = /^(\d{1,4})(?:\.\d{1,6}){0,3}$/.exec(version)
  return match && Number(match[1]) > 0 ? match[1]! : null
}

const SYSTEMS: Record<string, string> = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64'
}

/**
 * The user agent of a Chrome with this Chromium version, in the form Chrome itself sends since it reduced it (the minor parts are
 * zeros), or null when the version is not one: the caller then leaves the session as it is and says so.
 */
export function chromeUserAgent(chromiumVersion: unknown, platform: string): string | null {
  const major = chromeMajor(chromiumVersion)
  if (!major) return null
  const system = SYSTEMS[platform] ?? SYSTEMS['linux']!
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/** The headers of a request with `agent` as its user agent: the name of a header has no case, so every spelling of the old one goes. */
export function withUserAgent(headers: Record<string, string>, agent: string): Record<string, string> {
  const kept = Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'user-agent')
  return { ...Object.fromEntries(kept), 'User-Agent': agent }
}
