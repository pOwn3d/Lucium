// The places where a test puts something of its own in place of a piece of the application: a dialog nobody could click, the file chooser, the
// notifications of the system. Nothing in the application calls them. They refuse outside a test run, so that a call added to the application by
// mistake fails at once instead of quietly taking the user's dialogs away.

import { isSmokeRun } from './runtime'

/**
 * Whether this run may replace a piece of the application: the unit tests (Vitest, which runs no Electron) and the engine test (`--smoke`, which the
 * built application refuses to start with, see runtime.ts). `built` is for the tests of this rule; the application asks Electron.
 */
export function mayReplaceForTests(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env, built?: boolean): boolean {
  if (env['VITEST'] === 'true') return true
  return built === undefined ? isSmokeRun(argv) : isSmokeRun(argv, built)
}

/** Throws unless this run is a test (`mayReplaceForTests`): `seam` names the replacement that was asked for. */
export function assertTestRun(seam: string): void {
  if (!mayReplaceForTests()) throw new Error(`${seam} is for the tests only`)
}
