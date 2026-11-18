// The numbers of the synchronisation with the iPhone, written once (docs/synchronisation.md §4.5, §6.1, §7.5, §9.3, §11.5). The vectors of
// ios/Contracts/sync-message-vectors.json and sync-pairing-vectors.json state the same figures and the tests compare them: a limit changed here alone fails there.

/** The protocol version this build speaks, negotiated by ALPN (§7.2) and written in the `v` of every message (§7.1). */
export const PROTOCOL_VERSION = 1

/** The ALPN identifier the Mac offers. A client that offers none of ours fails the handshake. */
export const ALPN = 'lucium-sync/1'

/** The prefix of a QR text, and the version of the code (§4.2). */
export const QR_PREFIX = 'lucium-sync:'
export const QR_VERSION = 1

/** Sizes of what is drawn at random, in bytes (§3.2, §4.1, §4.4). */
export const SECRET_BYTES = 16
export const NONCE_BYTES = 16
export const FINGERPRINT_BYTES = 32
export const DEVICE_ID_BYTES = 16

/** The pairing window: how long a secret lives and how many wrong proofs lock it (§4.5). */
export const PAIRING_WINDOW_MS = 120_000
export const MAX_INVALID_PROOFS = 5
/** How long the person has to answer « Autoriser / Refuser » (§4.1 step 7): no answer is a refusal. */
export const CONFIRM_MS = 60_000
/**
 * How long a connection that took the only place of a pairing is safe from a newcomer while it has not yet sent its `pair.request` (§4.5, §6.1): the iPhone sends it as
 * soon as it has the challenge, so a connection still silent after this has no business being there. Past it, the next stranger takes the place and the silent one is cut
 * and counted; before it, the newcomer is told `busy`. Without this a neighbour holds the place with one idle connection for the sixty seconds of the silence timer, again
 * and again, for the whole window.
 */
export const PAIRING_REQUEST_GRACE_MS = 3_000

/** The synchronisation window the person opens by hand: the only time the Mac listens (§6.1, [Q5]). */
export const WINDOW_MAX_MS = 600_000

/** A QR text is at most this long and names at most this many hosts (§4.2). */
export const QR_MAX_CHARS = 300
export const MAX_HOSTS = 4

/** Frames and what a session may carry (§7.1, §7.5). */
export const MAX_FRAME_BYTES = 1_048_576
export const MAX_SNAPSHOT_BYTES = 33_554_432
export const MAX_ENTITIES = 100_000
export const MAX_ENTITIES_PER_PART = 500
export const MAX_PARTS = 4096
export const MAX_JSON_DEPTH = 32
export const MAX_STRING_BYTES = 65_536
export const MAX_DEVICE_NAME_CHARS = 80
export const MAX_DEVICE_ID_CHARS = 64
export const MAX_CATEGORIES = 8
export const MAX_OPEN_TABS = 200
export const MAX_OPEN_TAB_URL_BYTES = 4096
export const MAX_OPEN_TAB_TITLE_BYTES = 300

/** Connections, time and rate (§6.1, §7.5). */
export const MAX_CONNECTIONS = 4
/** One more connection is allowed for a pairing, beside the four of the sessions. */
export const MAX_PAIRING_CONNECTIONS = 1
export const HANDSHAKE_TIMEOUT_MS = 10_000
export const IDLE_TIMEOUT_MS = 60_000
export const SESSION_MAX_MS = 600_000
export const MIN_AUTO_INTERVAL_MS = 15_000
/** From one address, this many refused connections in a minute close the door on that address for a minute (table of at most `MAX_TRACKED_ADDRESSES`). */
export const FAILURES_PER_MINUTE_BEFORE_REFUSAL = 10
export const FAILURE_WINDOW_MS = 60_000
export const REFUSAL_MS = 60_000
export const MAX_TRACKED_ADDRESSES = 256

/** Clocks (§9.3) and deletions (§11.5). */
export const CLOCK_SKEW_WARN_MS = 300_000
export const STAMP_FUTURE_REFUSE_MS = 604_800_000
export const TOMBSTONE_DAYS = 30
export const ARCHIVE_PER_SPACE = 500
