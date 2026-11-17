// Which copy of the application may declare itself the system's default browser.

export const WEB_SCHEMES = ['http', 'https'] as const

/**
 * The schemes the running application may register for. None from a development copy of Electron (`pnpm dev`, `pnpm start`): its generic identifier
 * `com.github.Electron` would become the default browser of the whole Mac, and every link opened from another application would start a bare Electron
 * window with no application to run.
 */
export const schemesToRegister = (built: boolean): readonly string[] => (built ? WEB_SCHEMES : [])
