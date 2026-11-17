// What a page reads of a permission nobody answered yet. Electron answers a permission check by yes or no: a site that was never asked reads
// "denied" (`Notification.permission`, `navigator.permissions.query`), takes it for a refusal of the user and never offers its notifications.
// The page is told the difference (src/preload/permission-state.ts asks the main process on the channel below): never answered reads "default"
// and "prompt", as in any browser; allowed and refused read what Chromium says.

export const PERMISSION_STATE = { undecided: 'lucium-permission-undecided' } as const

/** The names a page may ask about (those of the Permissions API), and the permission each one is for Electron. */
const QUERIED: Readonly<Record<string, string>> = { notifications: 'notifications', geolocation: 'geolocation', camera: 'media', microphone: 'media' }

/** The names above, for the script of the page: it asks about no other. */
export const QUERIED_NAMES: readonly string[] = Object.keys(QUERIED)

/** Electron's permission behind a name sent by a page, or null for anything that is not one of the names above. */
export function queriedPermission(raw: unknown): string | null {
  return typeof raw === 'string' && Object.hasOwn(QUERIED, raw) ? QUERIED[raw]! : null
}
