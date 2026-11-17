// A valid record and the clock it is valid at, for the tests of the resumption of downloads.

import { RESUME_MIN_BYTES, type ResumeRecord } from './download-resume'

export const NOW = Date.parse('2026-10-24T12:00:00Z')
/** A token as an address may carry: it must never reach a log, a message, a row of the popover, the state or an export. */
export const TOKEN = 'tok_9f8e7d6c5b4a' // gitleaks:allow (invented for the tests, the secret of no service)

export const record = (patch: Partial<ResumeRecord> = {}): ResumeRecord => ({
  id: 'rs-0123456789ab',
  profileId: 'default',
  url: `https://files.example.org/get/archive.zip?token=${TOKEN}`,
  path: '/Users/moi/Downloads/archive.zip',
  offset: 5 * RESUME_MIN_BYTES,
  length: 40 * RESUME_MIN_BYTES,
  etag: '"v1-abc"',
  lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
  startTime: NOW / 1000 - 600,
  savedAt: NOW - 1000,
  head: 'a'.repeat(64),
  tail: 'b'.repeat(64),
  ...patch
})
