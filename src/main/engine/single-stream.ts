// Downloads in a single stream, for the resumption of downloads after a restart.
//
// Chromium can fetch a big file with several requests at once (the feature `ParallelDownloading`), each writing its own part of the file.
// The number of bytes it then counts is the sum of the parts, not the length of the beginning that is complete, and the file has holes:
// carrying on from "the bytes received" would glue a hole into the file without any error. A resumption needs the file to grow from its
// first byte to its last, so that what is on the disk up to the recorded offset is all there.
//
// A Chromium feature is decided when the process starts, long before the settings are read. The file of the resume records (made when the
// setting was turned on, removed when it was turned off) is therefore the sign: one look at whether it exists, before Chromium reads its
// features. When it does, the feature is disabled for the whole launch and the engine records downloads; when it was made during this
// launch, nothing is recorded until the next one (the setting asks for a restart).

import { join } from 'node:path'
import { RESUME_FILE } from '@shared/download-resume'

export const PARALLEL_DOWNLOADS = 'ParallelDownloading'

/** The part of `app.commandLine` this needs. */
export interface CommandLineSwitches {
  getSwitchValue(name: string): string
  appendSwitch(name: string, value?: string): void
}

let active = false

/**
 * Disables parallel downloads for this launch when the file of records exists (or when `force` says so: the engine test). Returns whether
 * downloads will be in a single stream. Called once, before the application is ready.
 */
export function applySingleStream(options: { userDataDir: string; exists(path: string): boolean; commandLine: CommandLineSwitches; force?: boolean }): boolean {
  active = false
  if (options.force !== true && !options.exists(join(options.userDataDir, RESUME_FILE))) return false
  const disabled = options.commandLine.getSwitchValue('disable-features').split(',').filter((name) => name !== '')
  if (!disabled.includes(PARALLEL_DOWNLOADS)) options.commandLine.appendSwitch('disable-features', [...disabled, PARALLEL_DOWNLOADS].join(','))
  active = true
  return true
}

/** Whether this launch downloads in a single stream (see above). */
export const singleStreamActive = (): boolean => active
