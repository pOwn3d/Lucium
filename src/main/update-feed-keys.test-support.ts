// The keys of the tests that publish, withdraw or read a feed: a pair made when the file is loaded, its private half in a folder of the system's
// temporary files that is removed when the tests end. Never the maintainer's key, which no test reads.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FEED_KEY_FILE, feedKeysIn, newFeedKeyPair, signFeedText, type FeedKeys } from './update-feed-signature'

export const TEST_FEED_PAIR = newFeedKeyPair()

const folder = mkdtempSync(join(tmpdir(), 'lucium-test-feed-key-'))
writeFileSync(join(folder, FEED_KEY_FILE), TEST_FEED_PAIR.privatePem, { mode: 0o600 })
process.on('exit', () => rmSync(folder, { recursive: true, force: true }))

/** The keys a publication of the tests signs with, read from their folder as the real ones are. */
export const TEST_FEED_KEYS: FeedKeys = feedKeysIn(folder, [TEST_FEED_PAIR.publicKey])

/** A feed as scripts/make-update-feed.mjs prints it: two spaces, a closing brace on its own line. */
export const writtenFeed = (feed: unknown): string => `${JSON.stringify(feed, null, 2)}\n`

/** `unsigned` (a feed as `writtenFeed` gives it) signed with the key of the tests: what the server holds after a publication. */
export const signedFeed = (unsigned: string): string => signFeedText(unsigned, [TEST_FEED_PAIR.privatePem])
