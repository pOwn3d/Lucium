// The errors of an interface page (renderer/root.tsx: its root boundary, `error` and `unhandledrejection`) written to the log of the main process,
// which Settings › Général › État de Lucium shows. The page writes them to its console as `[ui]` lines (shared/ui-errors.ts); this listens to the
// console of the surfaces of the interface only (main/index.ts, `load`), never to a web page's.

import type { WebContents } from 'electron'
import { uiErrorLine } from '@shared/ui-errors'

const relayed = new WeakSet<object>()

/** What the relay listens to of a web contents. */
export interface ConsoleSource {
  on(event: 'console-message', listener: (details: { level?: unknown; message?: unknown }) => void): unknown
}

/** Relays the `[ui]` errors of `contents`, an interface page named `page` (once per web contents: a second call does nothing). */
export function relayUiErrors(contents: ConsoleSource | WebContents, page: string, log: (line: string) => void = (line) => console.error(line)): void {
  if (relayed.has(contents)) return
  relayed.add(contents)
  ;(contents as ConsoleSource).on('console-message', (details) => {
    const line = uiErrorLine(details, page)
    if (line !== null) log(line)
  })
}
