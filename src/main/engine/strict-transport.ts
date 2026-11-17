// The hosts that asked for strict transport security (HSTS): on those, a certificate that is not valid is never clicked through, as in the other
// browsers. Electron's `certificate-error` event does not say whether Chromium holds the host as strict, so what can be known is kept here:
//  - the top-level domains whose every name is in the preloaded list of Chromium (`.app`, `.dev`, `.bank`…), which never changes for a name;
//  - the hosts a session saw send `Strict-Transport-Security` over a connection whose certificate was valid (`note`), for the time they asked:
//    the hook of the answers of every session of pages tells them (`noteStrictTransportAnswer`, called by electron-engine-network.ts).
// A session that keeps its data on disk (a profile, a container) keeps these hosts too, and reads them back at the next launch
// (strict-transport-store.ts): without that, right after a start, a site known as strict would offer « Continuer quand même » again until it
// was visited once. A private window writes nothing: its record goes with it.

import { createHash } from 'node:crypto'
import { isRecord } from '@shared/record'

/**
 * Top-level domains preloaded as a whole (with their subdomains) in the HSTS list of Chromium: the registry requires HTTPS for every name. A subset
 * that is certain, not the list of Chromium: single names preloaded there (a bank, a mail service) are known only once they sent the header.
 */
const PRELOADED_TLDS = new Set([
  'android', 'app', 'bank', 'boo', 'channel', 'chrome', 'dad', 'day', 'dev', 'eat', 'esq', 'fly', 'foo', 'gle', 'gmail', 'google', 'hangout',
  'ing', 'insurance', 'meet', 'meme', 'mov', 'new', 'nexus', 'page', 'phd', 'play', 'prof', 'rsvp', 'search', 'youtube', 'zip'
])

/** The longest time a header is believed (a year, the usual value): a bound for a header that asks for centuries. */
const MAX_AGE_SECONDS = 366 * 24 * 60 * 60
/** Hosts kept per session: far more than a session meets, a bound against a page that makes thousands of names answer. */
export const STRICT_HOSTS_MAX = 5000

export interface StrictTransportPolicy {
  /** Seconds the host asks to be held strict. 0 withdraws what it asked before. */
  maxAge: number
  includeSubDomains: boolean
}

/** What a `Strict-Transport-Security` header asks (RFC 6797), null when it is not one: no `max-age`, a directive given twice. */
export function parseStrictTransport(value: string): StrictTransportPolicy | null {
  let maxAge: number | null = null
  let includeSubDomains = false
  const seen = new Set<string>()
  for (const part of value.split(';')) {
    const directive = part.trim()
    if (!directive) continue
    const [rawName = '', ...rest] = directive.split('=')
    const name = rawName.trim().toLowerCase()
    if (seen.has(name)) return null
    seen.add(name)
    if (name === 'max-age') {
      const digits = rest.join('=').trim().replace(/^"(.*)"$/, '$1')
      if (!/^\d+$/.test(digits)) return null
      maxAge = Math.min(Number(digits), MAX_AGE_SECONDS)
    } else if (name === 'includesubdomains') {
      if (rest.length > 0) return null
      includeSubDomains = true
    }
  }
  return maxAge === null ? null : { maxAge, includeSubDomains }
}

/** A host name HSTS applies to: a name, never an IP address (RFC 6797, 8.3.4). */
function hostOfPolicy(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return ''
  return host
}

/** Whether every name under the last label of `hostname` is preloaded as strict in Chromium. */
export function isPreloadedStrictHost(hostname: string): boolean {
  const host = hostOfPolicy(hostname)
  return host !== '' && PRELOADED_TLDS.has(host.slice(host.lastIndexOf('.') + 1))
}

interface Entry {
  /** ms since the epoch. */
  until: number
  includeSubDomains: boolean
}

/** A host held as strict, as it is kept from one run to the next: its name is never written, only its SHA-256 (hexadecimal), as Chromium does in its own record. */
export interface StrictHostRecord {
  host: string
  /** ms since the epoch. */
  until: number
  includeSubDomains: boolean
}

/** A change of the end date smaller than this is not worth writing again: a site sends the same header with every document. */
const WORTH_WRITING_MS = 60 * 60 * 1000

const keyOf = (host: string): string => createHash('sha256').update(host).digest('hex')

export class StrictTransportHosts {
  /** By session, then by the SHA-256 of the host name: the names themselves are not kept, so that what is written to disk lists no site. */
  private readonly bySession = new WeakMap<object, Map<string, Entry>>()
  private changed: (session: object) => void = () => {}

  constructor(private readonly now: () => number = Date.now) {}

  /** Who is told that what a session holds is no longer what was last handed out by `records` (strict-transport-store.ts writes it then). */
  onChange(listener: (session: object) => void): void {
    this.changed = listener
  }

  /**
   * A response of `url` carried this `Strict-Transport-Security` header. Only an https address counts, and the caller only tells it of a
   * connection whose certificate was valid: a header that came over a certificate let through proves nothing (the one who intercepts could
   * send it, or withdraw it with `max-age=0`).
   */
  note(session: object, url: string, header: string): void {
    if (!URL.canParse(url)) return
    const parsed = new URL(url)
    const host = hostOfPolicy(parsed.hostname)
    if (!/^(https|wss):$/.test(parsed.protocol) || !host) return
    const policy = parseStrictTransport(header)
    if (!policy) return
    const key = keyOf(host)
    let hosts = this.bySession.get(session)
    if (policy.maxAge === 0) {
      if (hosts?.delete(key)) this.changed(session)
      return
    }
    if (!hosts) this.bySession.set(session, (hosts = new Map()))
    const before = hosts.get(key)
    const until = this.now() + policy.maxAge * 1000
    // The oldest goes first once the bound is reached (a Map keeps the order of insertion).
    hosts.delete(key)
    if (hosts.size >= STRICT_HOSTS_MAX) hosts.delete(hosts.keys().next().value as string)
    hosts.set(key, { until, includeSubDomains: policy.includeSubDomains })
    if (!before || before.includeSubDomains !== policy.includeSubDomains || Math.abs(until - before.until) >= WORTH_WRITING_MS) this.changed(session)
  }

  /** Whether a certificate error on `hostname` may not be clicked through in this session: the name is preloaded, or it (or a parent that covers its subdomains) asked for it. */
  isStrict(session: object, hostname: string): boolean {
    const host = hostOfPolicy(hostname)
    if (!host) return false
    if (isPreloadedStrictHost(host)) return true
    const hosts = this.bySession.get(session)
    if (!hosts) return false
    const labels = host.split('.')
    for (let i = 0; i < labels.length; i++) {
      const key = keyOf(labels.slice(i).join('.'))
      const entry = hosts.get(key)
      if (!entry) continue
      if (entry.until <= this.now()) {
        hosts.delete(key)
        continue
      }
      if (i === 0 || entry.includeSubDomains) return true
    }
    return false
  }

  /** What the session holds now, for the next run: the hosts whose time is not over. */
  records(session: object): StrictHostRecord[] {
    const now = this.now()
    return [...(this.bySession.get(session) ?? [])].flatMap(([host, entry]) => (entry.until > now ? [{ host, until: entry.until, includeSubDomains: entry.includeSubDomains }] : []))
  }

  /**
   * What an earlier run held for this session (`records`), read back at its launch. Anything that is not a record is left out, and so is a host
   * whose time is over; an end date further than a header may ask is brought back to that bound. What the session learnt in this run is kept.
   * Answers how many hosts were taken.
   */
  restore(session: object, records: unknown): number {
    if (!Array.isArray(records)) return 0
    const now = this.now()
    let hosts = this.bySession.get(session)
    let taken = 0
    for (const record of records) {
      if (!isRecord(record)) continue
      const { host, until, includeSubDomains } = record
      if (typeof host !== 'string' || !/^[0-9a-f]{64}$/.test(host) || typeof until !== 'number' || !Number.isFinite(until) || until <= now || typeof includeSubDomains !== 'boolean') continue
      if (!hosts) this.bySession.set(session, (hosts = new Map()))
      if (hosts.has(host) || hosts.size >= STRICT_HOSTS_MAX) continue
      hosts.set(host, { until: Math.min(until, now + MAX_AGE_SECONDS * 1000), includeSubDomains })
      taken++
    }
    return taken
  }

  /** The data of the session is erased: the hosts it held as strict go with it. */
  forget(session: object): void {
    this.bySession.delete(session)
  }
}

/** The `Strict-Transport-Security` header among the headers of an answer, as Electron hands them (a name in any case, a list of values). The first one counts (RFC 6797, 8.1). */
export function strictTransportHeader(headers: Readonly<Record<string, string | readonly string[]>> | undefined): string | null {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'strict-transport-security') continue
    const first = typeof value === 'string' ? value : value[0]
    if (typeof first === 'string') return first
  }
  return null
}

/**
 * An answer came in a session: when it carries the header and the certificate of its host was valid, the host is held as strict from now on.
 * `letThrough` says whether an invalid certificate was let through for a host in this session (a choice of the user, Developer Mode): the header of
 * such a host is not read, in either direction.
 */
export function noteStrictTransportAnswer(
  hosts: Pick<StrictTransportHosts, 'note'>,
  letThrough: (host: string) => boolean,
  session: object,
  answer: { url: string; responseHeaders?: Readonly<Record<string, string | readonly string[]>> | undefined }
): void {
  const header = strictTransportHeader(answer.responseHeaders)
  if (header === null || !URL.canParse(answer.url)) return
  if (letThrough(new URL(answer.url).hostname.toLowerCase())) return
  hosts.note(session, answer.url, header)
}

/** The record of the application: one per session, read by the certificate errors of its pages. */
export const strictTransportHosts = new StrictTransportHosts()
