// Test support (nothing of the application imports it): the source of the start of the main process as one text. `main()` (index.ts) is cut
// into files by responsibility; the contract tests that read the wiring only a real Electron can run look into all of them, so that
// moving code between them breaks nothing.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAIN = fileURLToPath(new URL('.', import.meta.url))

/** The files `main()` is made of, relative to src/main, in this order. */
export const MAIN_FILES = [
  'index.ts',
  'shell/own-windows-wiring.ts',
  'shell/annotate-wiring.ts',
  'shell/windows-wiring.ts',
  'shell/password-wiring.ts',
  'shell/web-apps-wiring.ts',
  'shell/import-wiring.ts',
  'shell/dev-aids.ts',
  'shell/app-menu-wiring.ts',
  'shell/quit-flow.ts',
  'shell/external-links-wiring.ts'
] as const

export function mainSource(): string {
  return MAIN_FILES.map((name) => readFileSync(join(MAIN, name), 'utf8')).join('\n')
}
