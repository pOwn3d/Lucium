// Which copy of the application may declare itself the system's default browser, and how Windows tells which application is.

export const WEB_SCHEMES = ['http', 'https'] as const

/**
 * What a request to make Lucium the default browser came to. `done`: the system took it (macOS asks for a confirmation of its own). `system-settings`: the
 * system does not let an application choose for the user (Windows), so Settings was opened on Lucium and the choice is the user's to make. `failed`: nothing happened.
 */
export type DefaultBrowserOutcome = 'done' | 'system-settings' | 'failed'

/**
 * The schemes the running application may register for. None from a development copy of Electron (`pnpm dev`, `pnpm start`): its generic identifier
 * `com.github.Electron` would become the default browser of the whole Mac, and every link opened from another application would start a bare Electron
 * window with no application to run.
 */
export const schemesToRegister = (built: boolean): readonly string[] => (built ? WEB_SCHEMES : [])

// ---- Windows ----
// On Windows 10 and 11 the browser is the one the USER chose in Settings › Apps › Default apps. Windows keeps that choice, per user and signed, under
// the `UserChoice` key of each scheme; nothing an application writes elsewhere changes it, and `app.isDefaultProtocolClient` reads another key
// (HKCU\Software\Classes\<scheme>\shell\open\command) that Windows ignores, so it says "yes" after Electron wrote it while Edge still opens the links.

/** The ProgID `build/installer.nsh` registers for web addresses: what `UserChoice` holds once the user has chosen Lucium for a scheme. */
export const WINDOWS_URL_PROGID = 'LuciumURL'

/**
 * The page of Windows Settings where the default apps are chosen, opened on Lucium's own entry (`registeredAppUser` is the name under
 * `Software\RegisteredApplications`, which `build/installer.nsh` writes from the product name).
 */
export const WINDOWS_DEFAULT_APPS_URL = 'ms-settings:defaultapps?registeredAppUser=Lucium'

/** The registry key where Windows records the user's choice for a scheme (read with `reg query`, which takes the abbreviated root). */
export const userChoiceKey = (scheme: string): string => `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`

/** The ProgID `reg query <key> /v ProgId` printed, or null when the text holds none. The value name and the type are not translated, only the messages are. */
export function parseUserChoiceProgId(output: string): string | null {
  return /^[ \t]*ProgId[ \t]+REG_SZ[ \t]+(\S.*?)[ \t]*$/im.exec(output)?.[1] ?? null
}

/** Whether the ProgIDs Windows holds for the web schemes are all Lucium's. A scheme with no recorded choice (null) is not. */
export function windowsChoiceIsLucium(progIds: Readonly<Record<string, string | null>>): boolean {
  return WEB_SCHEMES.every((scheme) => progIds[scheme]?.toLowerCase() === WINDOWS_URL_PROGID.toLowerCase())
}
