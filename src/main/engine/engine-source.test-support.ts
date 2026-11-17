// Test support (nothing of the application imports it): the source of the Electron engine as one text. The engine is cut into files by
// responsibility (electron-engine.ts, the page it makes, the private contexts it keeps, and the parts moved out of the class);
// the contract tests that read the wiring only Electron can run look into all of them, so that moving code between them breaks nothing.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE = fileURLToPath(new URL('.', import.meta.url))

/** The files the class ElectronEngine (its layers, from the base to electron-engine.ts) and its page (its layers too, from the base to electron-page.ts) are made of, in this order. */
export const ENGINE_FILES = [
  'electron-engine-base.ts',
  'electron-engine-bridge.ts',
  'electron-engine-preloads.ts',
  'electron-engine-network.ts',
  'electron-engine-extensions.ts',
  'electron-engine-profile.ts',
  'electron-engine-permissions.ts',
  'electron-engine-downloads.ts',
  'electron-engine.ts',
  'electron-page-scripts.ts',
  'electron-page-base.ts',
  'electron-page-navigation.ts',
  'electron-page-content.ts',
  'electron-page-media.ts',
  'electron-page-lifecycle.ts',
  'electron-page.ts',
  'ephemeral-scope.ts'
] as const

export function engineSource(): string {
  return ENGINE_FILES.map((name) => readFileSync(join(ENGINE, name), 'utf8')).join('\n')
}
