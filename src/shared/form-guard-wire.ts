// The one message of the form guard (src/preload/form-guard.ts): a page is about to send a form that holds a password to an `http:` address, and the
// preload asks the main process whether it may. No imports: the preload is built whole and every document it runs in compiles it.

export const FORM_GUARD = { ask: 'lucium-insecure-form-ask' } as const

/** The address a form sends to, at most this long (the longest an address is kept anywhere in Lucium). */
export const FORM_ACTION_MAX = 2048

/** The page's message, or null when it is anything but exactly `{ action }` with an address in it. The preload sends what the DOM resolved; the main process judges it again. */
export function parseFormAsk(raw: unknown): { action: string } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'action') return null
  const action = (raw as { action: unknown }).action
  return typeof action === 'string' && action.length > 0 && action.length <= FORM_ACTION_MAX ? { action } : null
}
