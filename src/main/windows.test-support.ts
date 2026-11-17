// Helpers of the tests that run on Windows too (.github/workflows/windows.yml). A test that cannot pass there for a reason of substance is skipped with
// `describe.skipIf(onWindows)` / `it.skipIf(onWindows)` and the reason is written next to it: never left out, never hidden behind a retry.
// Not part of the application (electron-builder.yml leaves `*test-support*` out of the package).

import { statSync } from 'node:fs'
import { sep } from 'node:path'
import { expect } from 'vitest'

/** Tests run on a Windows runner. */
export const onWindows = process.platform === 'win32'

/**
 * Asserts the permission bits of a file or a folder (0o600, 0o700…). Windows has no POSIX bits: it reports 0o666 for a file and 0o777 for a folder
 * whatever its access list, and `chmod` only changes the read-only flag. The assertion is therefore made on macOS and Linux only; what keeps a file
 * private on Windows is the access list of the user's profile folder, which these tests cannot read.
 */
export function expectMode(path: string, mode: number): void {
  if (onWindows) return
  expect(statSync(path).mode & 0o777).toBe(mode)
}

/** The bits for the group and for the others (0o077), for the tests that only ask for "nobody else can read it". Same rule as `expectMode`. */
export function expectNoOtherAccess(path: string): void {
  if (onWindows) return
  expect(statSync(path).mode & 0o077).toBe(0)
}

/** A path written with `/` whatever the system: for the tests that compare a path with a text written in the test. */
export const posix = (path: string): string => path.split(sep).join('/')
