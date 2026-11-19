// The shared vectors of the synchronisation (ios/Contracts/sync-*.json), typed and read once, for the tests of src/main/sync/. The files are the contract with the
// iPhone: LuciumKit reads the same ones (SyncVectorTests.swift). A test here plays them against the real code of the Mac; the form of each vector is checked
// by src/shared/ios-sync-contract.test.ts and ios-sync-merge-contract.test.ts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const contracts = join(__dirname, '../../../ios/Contracts')
const read = <T>(name: string): T => JSON.parse(readFileSync(join(contracts, name), 'utf8')) as T

export type VectorVerdict = { ok: true } | { ok: false; code: string; at?: number }

export interface ProofInputsVector {
  secret: string
  fpMac: string
  fpPhone: string
  nonceMac: string
  noncePhone: string
  idMac: string
  idPhone: string
  requestTag: string
  acceptTag: string
}

export interface PairingVectors {
  constants: { secretBytes: number; nonceBytes: number; fingerprintBytes: number; windowMs: number; maxInvalidProofs: number; qrMaxChars: number; qrMaxHosts: number; comparisonCodeChars: number; commitBytes: number; codeNonceBytes: number }
  proof: (ProofInputsVector & { name: string })[]
  mutations: { of: string; cases: (Partial<ProofInputsVector> & { field: keyof ProofInputsVector; value?: string; valueHex?: string; requestTag: string; acceptTag: string; changesRequestTag: boolean; changesAcceptTag: boolean })[] }
  qr: { valid: { name: string; text: string; expect: { fingerprintHex: string; secretHex: string; port: number; hosts: string[] } }[]; invalid: { name: string; text: string; expect: { code: string } }[] }
  manualCode: { valid: { name: string; input: string; expect: { secretHex: string } }[]; invalid: { name: string; input: string; expect: { code: string } }[] }
  /** What the iPhone commits to before the Mac shows what its code is made of (§4.7): its fingerprint and a code nonce, hashed. */
  commitments: { name: string; fpPhone: string; nonceCodePhone: string; commit: string }[]
  /** The code both devices show once the Mac's proof is checked (§4.6): the same two fingerprints and the same two code nonces, the same six characters. */
  comparisonCode: { name: string; fpMac: string; fpPhone: string; nonceCodeMac: string; nonceCodePhone: string; code: string }[]
  secretLifecycle: { name: string; events: { atMs: number; event: 'request' | 'confirm' | 'close'; proof?: 'valid' | 'invalid'; decision?: 'refuse' | 'allow' }[]; expect: string[] }[]
  clientChecks: { name: string; mode: 'qr' | 'manualCode'; expectedFingerprintHex: string | null; presentedFingerprintHex: string; expect: string }[]
  addressPolicy: { host: string; allowed: boolean }[]
  certificate: { spkiHex: string; serialHex: string; tbsHex: string; certificateDerHex: string; fingerprintHex: string }
}

export interface MessageVector {
  name: string
  message?: Record<string, unknown>
  raw?: string
  fill?: { path: (string | number)[]; repeat?: string; copy?: unknown; times: number }
  expect: VectorVerdict
}

export interface MessageVectors {
  limits: Record<string, number>
  frames: { length: number; expect: VectorVerdict }[]
  snapshotBytes: { total: number; expect: VectorVerdict }[]
  sequences: { name: string; ns: number[]; expect: VectorVerdict }[]
  messages: MessageVector[]
  /** A JSON text, and whether an object of it names a key twice (the first wins in Swift, the last in JavaScript). Read by `hasDuplicateKey` and by LuciumKit's `SyncDuplicateKeys`. */
  duplicateKeys: { name: string; raw: string; duplicate: boolean }[]
  transitions: { name: string; receiver: 'mac' | 'ios'; phase: 'session' | 'pairing'; history: string[]; type: string; expect: VectorVerdict }[]
  stamps: { a: string; b: string; expect: -1 | 0 | 1 }[]
  canonical: { name: string; value: unknown; canonical: string; sha256Hex: string }[]
  fieldClasses: Record<string, { synced: string[]; seed: string[]; local: string[] }>
  /** The engines of search the Mac offers (`SEARCH_ENGINES`): the only templates a device may send as the setting `searchUrlTemplate`. */
  searchEngines: string[]
  settingsAllowed: string[]
  settingsNever: string[]
  neverKinds: string[]
  inboundTombstones: { name: string; tombstones: Record<string, Record<string, string>>; expect: { kept: Record<string, Record<string, string>>; refused: string[] } }[]
  inbound: { name: string; entity?: { kind: string; id: string; fields: Record<string, unknown>; stamps: Record<string, string> }; /** The entity as JSON text, for what a JSON file cannot hold as a value: a lone surrogate (LuciumKit could not read the file). */ entityRaw?: string; expect: { accepted: boolean; reason?: string; fields?: Record<string, unknown> } }[]
}

export const pairingVectors = read<PairingVectors>('sync-pairing-vectors.json')
export const messageVectors = read<MessageVectors>('sync-message-vectors.json')

/** The text of a message vector: its raw text, or its object (with the `fill` the vector asks for, a long string or a long list) written as JSON. */
export function textOfVector(vector: MessageVector): string {
  if (vector.raw !== undefined) return vector.raw
  const message = JSON.parse(JSON.stringify(vector.message)) as Record<string, unknown>
  const fill = vector.fill
  if (fill === undefined) return JSON.stringify(message)
  let holder: unknown = message
  for (const key of fill.path.slice(0, -1)) holder = (holder as Record<string | number, unknown>)[key]
  const last = fill.path[fill.path.length - 1] as string | number
  ;(holder as Record<string | number, unknown>)[last] = fill.repeat !== undefined ? fill.repeat.repeat(fill.times) : Array.from({ length: fill.times }, () => JSON.parse(JSON.stringify(fill.copy)) as unknown)
  return JSON.stringify(message)
}

/** The entity of an `inbound` vector, whichever way it is written. */
export const entityOfVector = (vector: MessageVectors['inbound'][number]): NonNullable<MessageVectors['inbound'][number]['entity']> =>
  vector.entity ?? (JSON.parse(vector.entityRaw as string) as NonNullable<MessageVectors['inbound'][number]['entity']>)
