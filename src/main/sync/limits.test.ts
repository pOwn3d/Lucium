// The limits of src/main/sync/limits.ts are the ones the vectors state (ios/Contracts/sync-*.json): one written on one side only would not fail at the join.
import { describe, expect, it } from 'vitest'
import * as limits from './limits'
import { COMPARISON_CODE_CHARS } from './pairing-compare'
import { messageVectors, pairingVectors } from './sync-vectors.test-support'

describe('the limits of the synchronisation', () => {
  it('are the figures of the pairing vectors', () => {
    const c = pairingVectors.constants
    expect({ secretBytes: limits.SECRET_BYTES, nonceBytes: limits.NONCE_BYTES, fingerprintBytes: limits.FINGERPRINT_BYTES, windowMs: limits.PAIRING_WINDOW_MS, maxInvalidProofs: limits.MAX_INVALID_PROOFS, qrMaxChars: limits.QR_MAX_CHARS, qrMaxHosts: limits.MAX_HOSTS, comparisonCodeChars: COMPARISON_CODE_CHARS, commitBytes: limits.COMMIT_BYTES, codeNonceBytes: limits.CODE_NONCE_BYTES }).toEqual(c)
  })

  it('are the figures of the message vectors', () => {
    const v = messageVectors.limits
    expect({
      maxFrameBytes: limits.MAX_FRAME_BYTES, maxSnapshotBytes: limits.MAX_SNAPSHOT_BYTES, maxEntities: limits.MAX_ENTITIES, maxTombstonesPerSnapshot: limits.MAX_TOMBSTONES_PER_SNAPSHOT, maxEntitiesPerPart: limits.MAX_ENTITIES_PER_PART, maxParts: limits.MAX_PARTS,
      maxJsonDepth: limits.MAX_JSON_DEPTH, maxStringBytes: limits.MAX_STRING_BYTES, maxDeviceNameChars: limits.MAX_DEVICE_NAME_CHARS, maxDeviceIdChars: limits.MAX_DEVICE_ID_CHARS, maxCategories: limits.MAX_CATEGORIES,
      maxHosts: limits.MAX_HOSTS, handshakeTimeoutMs: limits.HANDSHAKE_TIMEOUT_MS,
      idleTimeoutMs: limits.IDLE_TIMEOUT_MS, sessionMaxMs: limits.SESSION_MAX_MS, maxConnections: limits.MAX_CONNECTIONS, minAutoIntervalMs: limits.MIN_AUTO_INTERVAL_MS, failuresPerMinuteBeforeRefusal: limits.FAILURES_PER_MINUTE_BEFORE_REFUSAL,
      clockSkewWarnMs: limits.CLOCK_SKEW_WARN_MS, stampFutureRefuseMs: limits.STAMP_FUTURE_REFUSE_MS, tombstoneDays: limits.TOMBSTONE_DAYS, archivePerSpace: limits.ARCHIVE_PER_SPACE
    }).toEqual(v)
  })

  it('keep the pairing to two minutes (the listening itself has no deadline: it has conditions, §6.1)', () => {
    expect('WINDOW_MAX_MS' in limits).toBe(false)
    expect(limits.PAIRING_WINDOW_MS).toBe(2 * 60_000)
    expect(limits.CONFIRM_MS).toBe(60_000)
    expect(limits.ALPN).toBe('lucium-sync/1')
  })
})
