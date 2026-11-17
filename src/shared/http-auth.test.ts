import { describe, expect, it } from 'vitest'
import { AUTH_FIELD_MAX, AUTH_REALM_MAX, authRequestOf, authText, credentialsOf, sameChallenge, type AuthChallenge } from './http-auth'
import { frenchSpaces } from './french-typography'

const challenge = (patch: Partial<AuthChallenge> = {}): AuthChallenge => ({ host: 'intranet.example', port: 443, scheme: 'basic', realm: 'Zone privée', isProxy: false, url: 'https://intranet.example/doc', ...patch })

describe('authRequestOf', () => {
  it('names the host alone when the port is the usual one of the scheme, with the port otherwise', () => {
    expect(authRequestOf('a1', challenge()).host).toBe('intranet.example')
    expect(authRequestOf('a1', challenge({ url: 'http://intranet.example/', port: 80 })).host).toBe('intranet.example')
    expect(authRequestOf('a1', challenge({ url: 'http://127.0.0.1:8123/', host: '127.0.0.1', port: 8123 })).host).toBe('127.0.0.1:8123')
    // An https server on port 80 is not the usual case either.
    expect(authRequestOf('a1', challenge({ port: 80 })).host).toBe('intranet.example:80')
  })

  it('lowers the scheme and bounds the realm, which is text the site chooses', () => {
    const request = authRequestOf('a1', challenge({ scheme: 'Digest', realm: ` ${'x'.repeat(500)} ` }))
    expect(request.scheme).toBe('digest')
    // Trimmed before it is cut: the spaces the site put around it take none of the room.
    expect(request.realm).toBe('x'.repeat(AUTH_REALM_MAX))
  })

  it('says whether the connection is encrypted: http is not, whatever the scheme (the answer of Digest can be read and attacked too)', () => {
    expect(authRequestOf('a', challenge()).secure).toBe(true)
    expect(authRequestOf('a', challenge({ scheme: 'digest' })).secure).toBe(true)
    expect(authRequestOf('a', challenge({ url: 'http://x.example/', port: 80 })).secure).toBe(false)
    expect(authRequestOf('a', challenge({ url: 'http://x.example/', port: 80, scheme: 'Digest' })).secure).toBe(false)
    expect(authRequestOf('a', challenge({ isProxy: true, host: 'proxy.example', port: 3128, scheme: 'digest' })).secure).toBe(false)
    // A proxy is reached in the clear unless it says otherwise, whatever the page uses.
    expect(authRequestOf('a', challenge({ isProxy: true, host: 'proxy.example', port: 3128 })).secure).toBe(false)
  })
})

describe('authText', () => {
  it('asks the user for a login in French, naming who asks and the realm', () => {
    const text = authText(authRequestOf('a', challenge()))
    expect(text.title).toBe('Connexion requise')
    expect(text.message).toBe(frenchSpaces('intranet.example demande un nom d’utilisateur et un mot de passe (« Zone privée »).'))
    expect(text.warning).toBeUndefined()
  })

  it('warns when the password is readable on the way, and says it is the proxy that asks', () => {
    const text = authText(authRequestOf('a', challenge({ isProxy: true, host: 'proxy.example', port: 3128, realm: '' })))
    expect(text.title).toBe('Connexion au proxy')
    expect(text.message).toBe('Le proxy proxy.example:3128 demande un nom d’utilisateur et un mot de passe.')
    expect(text.warning).toContain('pas chiffrée')
  })
})

describe('the warning of a connection that is not encrypted', () => {
  it('is shown with Digest too, in words of its own: the password is not sent as it is, but it is not safe', () => {
    const basic = authText(authRequestOf('a', challenge({ url: 'http://x.example/', port: 80 })))
    const digest = authText(authRequestOf('a', challenge({ url: 'http://x.example/', port: 80, scheme: 'digest' })))
    expect(basic.warning).toContain('peut être lu en chemin')
    expect(digest.warning).toContain('pas chiffrée')
    expect(digest.warning).toContain('n’est pas envoyé tel quel')
    expect(authText(authRequestOf('a', challenge({ scheme: 'digest' }))).warning).toBeUndefined()
  })
})

describe('sameChallenge', () => {
  it('is true for the same server, realm and scheme (one refusal answers them all), false otherwise', () => {
    const a = authRequestOf('a', challenge())
    expect(sameChallenge(a, authRequestOf('b', challenge()))).toBe(true)
    expect(sameChallenge(a, authRequestOf('b', challenge({ realm: 'Autre zone' })))).toBe(false)
    expect(sameChallenge(a, authRequestOf('b', challenge({ host: 'other.example' })))).toBe(false)
    expect(sameChallenge(a, authRequestOf('b', challenge({ scheme: 'digest' })))).toBe(false)
  })
})

describe('credentialsOf', () => {
  it('accepts two strings, even empty ones', () => {
    expect(credentialsOf({ username: 'ada', password: 's3cret' })).toEqual({ username: 'ada', password: 's3cret' })
    expect(credentialsOf({ username: '', password: 'token' })).toEqual({ username: '', password: 'token' })
  })

  it('refuses anything else, and fields that are too long to be a login', () => {
    expect(credentialsOf(null)).toBeNull()
    expect(credentialsOf({ username: 'ada' })).toBeNull()
    expect(credentialsOf({ username: 1, password: 'x' })).toBeNull()
    expect(credentialsOf({ username: 'a'.repeat(AUTH_FIELD_MAX + 1), password: 'x' })).toBeNull()
    // Each field has its own bound: a short name does not let an endless password through.
    expect(credentialsOf({ username: 'ada', password: 'x'.repeat(AUTH_FIELD_MAX + 1) })).toBeNull()
    expect(credentialsOf({ username: 'a'.repeat(AUTH_FIELD_MAX), password: 'x'.repeat(AUTH_FIELD_MAX) })).toEqual({ username: 'a'.repeat(AUTH_FIELD_MAX), password: 'x'.repeat(AUTH_FIELD_MAX) })
  })
})
