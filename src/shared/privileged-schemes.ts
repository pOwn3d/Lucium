// The schemes of the application that have to be declared before it is ready, in the one call Electron takes them in (main/index.ts): a second
// call would replace the list. Declaring a scheme only names it: each is served, or not, by the session that needs it.

import { INTERNAL_PRIVILEGES, INTERNAL_SCHEME } from './internal-page'
import { STAND_IN_PRIVILEGES, STAND_IN_SCHEME } from './redirect-resources'
import { ICON_PRIVILEGES, ICON_SCHEME } from './site-icon'

export interface PrivilegedScheme {
  scheme: string
  privileges: { standard?: boolean; secure?: boolean }
}

/**
 * The stand-in resources of the blocker's extended rules (a redirect to `data:` is aborted by Chromium; `secure` so that a page on https may
 * load them), the copies of the icons of sites the interface draws (shared/site-icon.ts), and the Extensions page in a tab (shared/internal-page.ts: `standard`
 * and `secure` and nothing else, so no fetch, no CORS and no bypass of the policy of content come with it; each session of a tab serves it or refuses it).
 */
export const PRIVILEGED_SCHEMES: readonly PrivilegedScheme[] = [
  { scheme: STAND_IN_SCHEME, privileges: { ...STAND_IN_PRIVILEGES } },
  { scheme: ICON_SCHEME, privileges: { ...ICON_PRIVILEGES } },
  { scheme: INTERNAL_SCHEME, privileges: { ...INTERNAL_PRIVILEGES } }
]
