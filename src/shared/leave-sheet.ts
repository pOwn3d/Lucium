// "Quitter ce site ?": the question a page asks when it holds the navigation (`beforeunload`), as a sheet of Lucium. The engine side is
// main/engine/unload-guard.ts (the page stays until the user answers, then the navigation starts again); this is what travels to the sheet.

/** What the sheet shows. `site` is the host of the page as the main process knows it, never text the page sent. */
export interface LeaveRequest {
  id: string
  site: string
}

/** The longest site name the sheet shows (a host name is at most 253 characters). */
export const LEAVE_SITE_MAX = 253

/** The request for a page: the name is bounded so that nothing a page controls grows the sheet. */
export function leaveRequestOf(id: string, site: string): LeaveRequest {
  return { id, site: site.length > LEAVE_SITE_MAX ? `${site.slice(0, LEAVE_SITE_MAX - 1)}…` : site }
}
