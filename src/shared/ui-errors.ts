// The errors of the interface's own pages (renderer/root.tsx) reach the log of the main process (Settings › Général › État de Lucium) through the
// console of the page: the page writes them as lines that begin with this mark, and main relays those lines only (shell/ui-error-relay.ts). No
// channel of IPC is added for it, and nothing else of the console of a page goes to the log.

export const UI_ERROR_PREFIX = '[ui]'

/** A line of the console is kept this long at most in the log of the main process. */
export const UI_ERROR_LINE_MAX = 2000

/** The line the log of the main process keeps of a message of the console of the interface page `page`, or null when it is no error of ours. */
export function uiErrorLine(details: { level?: unknown; message?: unknown }, page: string): string | null {
  if (details.level !== 'error' || typeof details.message !== 'string' || !details.message.startsWith(UI_ERROR_PREFIX)) return null
  const text = details.message.slice(UI_ERROR_PREFIX.length).trim()
  return `[ui:${page}] ${text.length > UI_ERROR_LINE_MAX ? `${text.slice(0, UI_ERROR_LINE_MAX)}…` : text}`
}
