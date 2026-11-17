// HTTP authentication (a 401 with Basic or Digest, or a 407 from a proxy): what the page asks for, the text of the sign-in panel, and
// the rules that keep the credentials where they belong. Pure: the engine reports the challenge, the panel answers it, nothing here
// reads or writes a file.

/** What the engine knows of a challenge (Electron's `login` event: the request and the `authInfo`). */
import { quoted, t } from './i18n'

export interface AuthChallenge {
  /** Host of the server (or of the proxy) that asks. */
  host: string
  port: number
  /** Chromium's name of the scheme: "basic", "digest", "ntlm", "negotiate". */
  scheme: string
  /** The realm the server announces: free text of the site. */
  realm: string
  isProxy: boolean
  /** The address of the request that was refused. */
  url: string
}

/** What the panel shows. `id` ties the answer to the question. */
export interface AuthRequest {
  id: string
  /** "example.com", or "example.com:8080" when the port is not the usual one of the scheme. */
  host: string
  realm: string
  scheme: string
  isProxy: boolean
  /** False when the connection is not encrypted (http, or a proxy that does not say): what is sent can be read on the way, whatever the scheme. */
  secure: boolean
}

export interface Credentials {
  username: string
  password: string
}

/** No field of the panel takes more than this: a longer answer is not a login. */
export const AUTH_FIELD_MAX = 512
/** A realm is text the site chooses: it is shown cut, never in full. */
export const AUTH_REALM_MAX = 120

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

/** The request of the panel for a challenge: the host with its port when unusual, the scheme in lower case, the realm bounded. */
export function authRequestOf(id: string, challenge: AuthChallenge): AuthRequest {
  const protocol = URL.canParse(challenge.url) ? new URL(challenge.url).protocol : ''
  const usual = !challenge.isProxy && DEFAULT_PORTS[protocol] === challenge.port
  const host = usual || !challenge.port ? challenge.host : `${challenge.host}:${challenge.port}`
  return {
    id,
    host,
    realm: challenge.realm.trim().slice(0, AUTH_REALM_MAX),
    scheme: challenge.scheme.toLowerCase(),
    isProxy: challenge.isProxy,
    // Digest does not send the password itself, but its answer can be read on the way and tried against a list of passwords at leisure: only an
    // encrypted connection is secure.
    secure: protocol === 'https:' && !challenge.isProxy
  }
}

/** The same server asking for the same realm: one refusal answers them all. */
export function sameChallenge(a: AuthRequest, b: AuthRequest): boolean {
  return a.host === b.host && a.realm === b.realm && a.scheme === b.scheme && a.isProxy === b.isProxy
}

export interface AuthText {
  title: string
  message: string
  /** Shown under the fields when the password would be readable on the way. */
  warning?: string
}

export function authText(request: AuthRequest): AuthText {
  const who = request.isProxy ? t('http-auth.le-proxy-host', { host: request.host }) : request.host
  const realm = request.realm ? ` (${quoted(request.realm)})` : ''
  return {
    title: request.isProxy ? t('http-auth.connexion-au-proxy') : t('http-auth.connexion-requise'),
    message: t('http-auth.who-demande-un-nom-d-utilisateur-et-un-mot-de', { who, realm }),
    ...(request.secure ? {} : { warning: request.scheme === 'digest' ? t('http-auth.cette-connexion-n-est-pas-chiffree-digest') : t('http-auth.cette-connexion-n-est-pas-chiffree-le-mot-de-passe') })
  }
}

/** Credentials the engine may hand to the page's request: two strings of a sane length (empty is allowed: some servers ask for a token as the password alone). */
export function credentialsOf(value: unknown): Credentials | null {
  const v = value as Partial<Credentials> | null
  if (!v || typeof v.username !== 'string' || typeof v.password !== 'string') return null
  if (v.username.length > AUTH_FIELD_MAX || v.password.length > AUTH_FIELD_MAX) return null
  return { username: v.username, password: v.password }
}
