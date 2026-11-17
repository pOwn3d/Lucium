// The signature of the update feed. The server that holds the feed is not the party that is believed: a feed is believed when a key built into the
// application signed it (update-feed-keys.ts). Without that, whoever can write on the server, or answer in its place, could offer a version,
// name a download page, or tell a copy that its version was withdrawn.
//
// Where the signature is, defined on the bytes of the file, not on what a JSON reader makes of them:
//
//   a signed feed  =  BODY  +  ',\n  "signatures": ["<s1>"(, "<sN>")*]\n}\n'        (1 to MAX_SIGNATURES signatures)
//   what is signed =  BODY  +  '\n}\n'                                               (the feed as it was before it was signed)
//
// Each <s> is the Ed25519 signature (node:crypto, 64 bytes, in base64 with its padding: 88 characters) of exactly those signed bytes. The file
// stays one JSON object, which Squirrel.Mac reads as before (it ignores the key). Lucium checks the signatures first and then reads ONLY the
// signed bytes: nothing outside them is ever parsed, so no second "signatures" key, no spacing and no reordering can make two readers disagree.
// One file, replaced in one rename on the server: there is no moment when a feed and its signature do not go together.
//
// Several signatures, because a key changes: a feed is signed by every private key the maintainer holds (the current one, the next one during a
// change, the previous one for the copies that only know that one), and a copy takes the feed when one signature is by one of its keys.
//
// This module imports nothing of the project: the scripts load it as it is (scripts/publish-update.mjs, scripts/feed-key.mjs).

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The key of the feed that carries its signatures. */
export const SIGNATURES_KEY = 'signatures'
/** How many public keys an application may carry: one, or two while the key is being changed. */
export const MAX_PUBLIC_KEYS = 2
/** How many signatures a feed may carry (the current key, the next one, the previous one, and one to spare). */
export const MAX_SIGNATURES = 4

/** The folder of the private keys, under the home folder: outside the repository, beside the file of the servers and the journal. */
export const FEED_KEY_FOLDER = ['Library', 'Application Support', 'lucium-secrets']
/** The private key every feed is signed with. Its public key is in update-feed-keys.ts. */
export const FEED_KEY_FILE = 'feed-key.pem'
/** The key that is taking over, during a change: its public key is in update-feed-keys.ts too. */
export const NEXT_FEED_KEY_FILE = 'feed-key-next.pem'
/** The key that was replaced: still signs, for the copies that carry only its public key, until it is deleted. */
export const PREVIOUS_FEED_KEY_FILE = 'feed-key-previous.pem'

/** The end of a feed before it is signed, and of every signed feed. */
const CLOSING = '\n}\n'
const ONE_SIGNATURE = '[A-Za-z0-9+/]{86}=='
/** The end of a signed feed. Anchored at the end of the file: what comes before it, plus `CLOSING`, is what was signed. */
const TRAILER = new RegExp(`,\\n {2}"${SIGNATURES_KEY}": \\[("${ONE_SIGNATURE}"(?:, "${ONE_SIGNATURE}"){0,${MAX_SIGNATURES - 1}})\\]\\n\\}\\n$`)
/** No trailer is longer than this (four signatures of 88 characters, their quotes and commas, the key). */
const TRAILER_MAX_BYTES = 512
/** The DER header of an Ed25519 public key (SubjectPublicKeyInfo); the 32 bytes of the key follow it. */
const SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex')
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/

function publicKeyObject(key: string): KeyObject | null {
  if (!PUBLIC_KEY.test(key)) return null
  const raw = Buffer.from(key, 'base64')
  if (raw.length !== 32) return null
  return createPublicKey({ key: Buffer.concat([SPKI_HEADER, raw]), format: 'der', type: 'spki' })
}

/**
 * What is wrong with the list of public keys an application is built with; empty when a build may carry it. An empty list is a problem: every
 * copy of such a build refuses every feed.
 */
export function publicKeyProblems(keys: readonly unknown[]): string[] {
  if (keys.length === 0) {
    return ['src/main/update-feed-keys.ts holds no public key: a copy of this build would refuse every update feed. Run `node scripts/feed-key.mjs` once, and put the public key it prints in UPDATE_FEED_PUBLIC_KEYS']
  }
  const problems: string[] = []
  if (keys.length > MAX_PUBLIC_KEYS) problems.push(`src/main/update-feed-keys.ts holds ${keys.length} public keys: ${MAX_PUBLIC_KEYS} at most, and two only while the key is being changed`)
  keys.forEach((key, at) => {
    if (typeof key !== 'string' || !publicKeyObject(key)) problems.push(`key ${at + 1} of src/main/update-feed-keys.ts is not an Ed25519 public key as scripts/feed-key.mjs prints it (32 bytes in base64, 44 characters)`)
    else if (keys.indexOf(key) !== at) problems.push(`key ${at + 1} of src/main/update-feed-keys.ts is there twice`)
  })
  return problems
}

/** A signed feed taken apart: the bytes that were signed, and its signatures. Null when the file does not end as a signed feed ends. */
export function splitSignedFeed(feed: Uint8Array): { signed: Buffer; signatures: string[] } | null {
  const bytes = Buffer.from(feed.buffer, feed.byteOffset, feed.byteLength)
  const tail = bytes.subarray(Math.max(0, bytes.length - TRAILER_MAX_BYTES)).toString('latin1')
  const found = TRAILER.exec(tail)
  if (!found) return null
  const body = bytes.subarray(0, bytes.length - (tail.length - found.index))
  return { signed: Buffer.concat([body, Buffer.from(CLOSING)]), signatures: (found[1] as string).split(', ').map((quoted) => quoted.slice(1, -1)) }
}

export type VerifiedFeed = { ok: true; signed: Uint8Array } | { ok: false; problem: string }

/**
 * The bytes of `feed` that one of `publicKeys` signed, which are the only ones to read; or why the feed is refused. No key at all refuses
 * everything: a build without a key believes no feed.
 */
export function verifyFeed(feed: Uint8Array, publicKeys: readonly string[]): VerifiedFeed {
  const keys = publicKeys.map(publicKeyObject).filter((key): key is KeyObject => key !== null)
  if (keys.length === 0) return { ok: false, problem: 'this build carries no public key for the update feed, so it believes none' }
  const split = splitSignedFeed(feed)
  if (!split) return { ok: false, problem: 'it carries no signature' }
  const signedBy = split.signatures.some((signature) => keys.some((key) => verify(null, split.signed, key, Buffer.from(signature, 'base64'))))
  return signedBy ? { ok: true, signed: split.signed } : { ok: false, problem: `none of its ${split.signatures.length} signature(s) is by a key of this build` }
}

/** The feed as it was before it was signed: the signed bytes of a signed feed, or the text itself when it ends with no signature. */
export function unsignedFeedText(text: string): string {
  return splitSignedFeed(Buffer.from(text, 'utf8'))?.signed.toString('utf8') ?? text
}

/** A new pair: the private key as a PEM text (PKCS#8), to write in a file nobody else reads, and the public key as the application carries it. */
export function newFeedKeyPair(): { privatePem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: publicKeyText(publicKey) }
}

const publicKeyText = (key: KeyObject): string => key.export({ format: 'der', type: 'spki' }).subarray(SPKI_HEADER.length).toString('base64')

/** The public key of a private key given as its PEM text. Throws when the text is not an Ed25519 private key; the message never holds the text. */
export function publicKeyOfPrivate(privatePem: string): string {
  return publicKeyText(createPublicKey(ed25519Private(privatePem)))
}

function ed25519Private(privatePem: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey({ key: privatePem, format: 'pem' })
  } catch (error) {
    // Only the code of the error: its message is OpenSSL's, and nothing of the file is to be printed.
    throw new Error(`not a private key in PEM (${(error as NodeJS.ErrnoException).code ?? 'unreadable'})`)
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`a key of the type ${key.asymmetricKeyType ?? 'unknown'}, not ed25519`)
  return key
}

/**
 * `unsigned` with one signature by each private key. `unsigned` must be the JSON object the publication writes (it ends with a closing brace on
 * its own line) and carry no "signatures" key yet: the result is that object with the key added at its end.
 */
export function signFeedText(unsigned: string, privatePems: readonly string[]): string {
  if (privatePems.length === 0 || privatePems.length > MAX_SIGNATURES) throw new Error(`a feed carries 1 to ${MAX_SIGNATURES} signatures, not ${privatePems.length}`)
  if (!unsigned.endsWith(CLOSING) || splitSignedFeed(Buffer.from(unsigned, 'utf8'))) throw new Error('the feed to sign is not an unsigned JSON object that ends with a closing brace on its own line')
  const parsed: unknown = JSON.parse(unsigned)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0 || SIGNATURES_KEY in parsed) {
    throw new Error(`the feed to sign is not a JSON object with keys and without "${SIGNATURES_KEY}"`)
  }
  const bytes = Buffer.from(unsigned, 'utf8')
  const signatures = privatePems.map((pem) => sign(null, bytes, ed25519Private(pem)).toString('base64'))
  return `${unsigned.slice(0, -CLOSING.length)},\n  "${SIGNATURES_KEY}": [${signatures.map((signature) => `"${signature}"`).join(', ')}]${CLOSING}`
}

/** What the publication asks of the keys (src/main/publish-update.ts, `PublishDeps.feedKeys`). */
export interface FeedKeys {
  /** Signs a feed with every private key of the folder; `keys` says how many. A problem instead when a key is missing, readable by others, or not one the builds carry. */
  sign: (unsigned: string) => { ok: true; text: string; keys: number } | { ok: false; problem: string }
  /** The signed part of a feed read from the server, when a key of the builds or of the folder signed it; null otherwise. */
  signedPart: (text: string) => string | null
}

/**
 * The keys of a publication: the private ones in `dir` (FEED_KEY_FILE, and NEXT_FEED_KEY_FILE and PREVIOUS_FEED_KEY_FILE when they are there), read
 * at the moment a feed is signed and never before, and `publicKeys`, the ones the builds carry. Nothing of a private key is ever returned or put in
 * a message. `posixModes`: whether the mode of a private key is read. Windows reports the mode 666 for every file and has no bit to read, so a check there would refuse
 * each key (and every publication that signs); the default is the system this runs on. The module imports nothing of the project, hence not the platform layer's fact.
 */
export function feedKeysIn(dir: string, publicKeys: readonly string[], posixModes: boolean = process.platform !== 'win32'): FeedKeys {
  /** The private keys of the folder with their public halves, or what is wrong. */
  const load = (): { ok: true; keys: { file: string; pem: string; publicKey: string }[] } | { ok: false; problem: string } => {
    const listed = publicKeyProblems(publicKeys)
    if (listed.length > 0) return { ok: false, problem: listed.join('\n    ') }
    const keys: { file: string; pem: string; publicKey: string }[] = []
    for (const file of [FEED_KEY_FILE, NEXT_FEED_KEY_FILE, PREVIOUS_FEED_KEY_FILE]) {
      const path = join(dir, file)
      const stat = lstatSync(path, { throwIfNoEntry: false })
      if (!stat) {
        if (file !== FEED_KEY_FILE) continue
        return { ok: false, problem: `${path} does not exist: it is the private key the feed is signed with. \`node scripts/feed-key.mjs\` makes it; a key made on another Mac is brought back from its backup` }
      }
      if (!stat.isFile()) return { ok: false, problem: `${path} is not a plain file (a link or a folder): a private key is a file of its own` }
      if (posixModes && (stat.mode & 0o077) !== 0) return { ok: false, problem: `${path} can be read by other accounts (mode ${(stat.mode & 0o777).toString(8)}): chmod 600, and consider the key leaked if the Mac is shared` }
      let pem: string
      let publicKey: string
      try {
        pem = readFileSync(path, 'utf8')
        publicKey = publicKeyOfPrivate(pem)
      } catch (error) {
        return { ok: false, problem: `${path} cannot be used: ${error instanceof Error ? error.message : String(error)}` }
      }
      // The previous key is the one the builds no longer carry: only the two others must be in the list.
      if (file !== PREVIOUS_FEED_KEY_FILE && !publicKeys.includes(publicKey)) {
        return { ok: false, problem: `the public key of ${path} (${publicKey}) is not in src/main/update-feed-keys.ts: the copies would refuse a feed it signs` }
      }
      keys.push({ file, pem, publicKey })
    }
    return { ok: true, keys }
  }
  return {
    sign: (unsigned) => {
      const loaded = load()
      if (!loaded.ok) return loaded
      let text: string
      try {
        text = signFeedText(unsigned, loaded.keys.map((key) => key.pem))
      } catch (error) {
        return { ok: false, problem: error instanceof Error ? error.message : String(error) }
      }
      // What a copy will do with it: a signature that does not check here would be refused everywhere.
      const checked = verifyFeed(Buffer.from(text, 'utf8'), publicKeys)
      if (!checked.ok || Buffer.from(checked.signed).toString('utf8') !== unsigned) return { ok: false, problem: 'the feed that was just signed does not check against the public keys of src/main/update-feed-keys.ts' }
      return { ok: true, text, keys: loaded.keys.length }
    },
    signedPart: (text) => {
      const loaded = load()
      // A feed signed by the previous key is still one of ours: its public half is derived from the file of the folder.
      const accepted = [...publicKeys, ...(loaded.ok ? loaded.keys.map((key) => key.publicKey) : [])]
      const checked = verifyFeed(Buffer.from(text, 'utf8'), [...new Set(accepted)])
      return checked.ok ? Buffer.from(checked.signed).toString('utf8') : null
    }
  }
}
