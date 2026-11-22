// The erasure of a profile's session (« Effacer les données de navigation », « Tout effacer »), typed against the few methods of Electron's session it
// uses so that the rule of the spared sites is tested without Electron. With no spared site it is the plain `clearData()` it always was; with some, the
// storage of their origins survives and so do their cookies (kept by the cookie manager's rule: the engine's origin filter does not follow cookie domains).

import { CLEAR_ALL_STORAGE_TYPES, keptOrigins, spareKept } from '@shared/clear-all'
import { tp } from '@shared/i18n'
import { listCookies, removeCookies, type CookieJarSession } from './cookie-book'

export interface ClearableSession extends CookieJarSession {
  clearData(options: { excludeOrigins?: string[]; dataTypes?: Array<(typeof CLEAR_ALL_STORAGE_TYPES)[number]> }): Promise<void>
}

export interface ClearProfileOptions {
  /** Origins the erasure never touches (the extensions loaded in the profile: wiping their storage would break them). */
  extensionOrigins: readonly string[]
  /** The sites « Tout effacer » spares (shared/clear-all.ts); empty for every other erasure. */
  keepHosts: readonly string[]
}

/** Erases what the session holds. Throws when a cookie of a site that was to go could not be removed: the caller never says « erased » for it. */
export async function clearProfileSession(ses: ClearableSession, { extensionOrigins, keepHosts }: ClearProfileOptions): Promise<void> {
  if (keepHosts.length === 0) {
    await ses.clearData(extensionOrigins.length > 0 ? { excludeOrigins: [...extensionOrigins] } : {})
    return
  }
  await ses.clearData({ excludeOrigins: [...extensionOrigins, ...keptOrigins(keepHosts)], dataTypes: [...CLEAR_ALL_STORAGE_TYPES] })
  const doomed = spareKept(await listCookies(ses), keepHosts)
  const { failed } = await removeCookies(ses, doomed)
  if (failed > 0) throw new Error(tp('clear-all.cookies-non-effaces', failed))
}
