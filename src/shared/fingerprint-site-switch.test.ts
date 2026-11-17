import { describe, expect, it } from 'vitest'
import { fingerprintConfigFor, isFingerprintProtected, webRtcPolicyFor } from './fingerprint'
import { defaultSettings, type Settings } from './model'

// A site the fingerprint protection breaks (a canvas editor, a photo tool) must be recoverable from the switch of the site panel, as one a list breaks is.
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaultSettings(), reduceFingerprint: true, ...patch })
const seed = () => 7

describe('the switch of the site panel and the fingerprint protection', () => {
  it('protects a site until the panel turns the blocking off for it, then leaves it alone (the document, its configuration and its WebRTC policy)', () => {
    const url = 'https://editor.example/app'
    expect(isFingerprintProtected(settings(), url)).toBe(true)
    expect(fingerprintConfigFor(settings(), url, seed)).not.toBeNull()
    expect(webRtcPolicyFor(settings(), url)).toBe('default_public_interface_only')
    const off = settings({ blockExceptions: ['editor.example'] })
    expect(isFingerprintProtected(off, url)).toBe(false)
    expect(fingerprintConfigFor(off, url, seed)).toBeNull()
    expect(webRtcPolicyFor(off, url)).toBeNull()
  })

  it('covers the subdomains like the blocking does, and protects the other sites as before', () => {
    const off = settings({ blockExceptions: ['editor.example'] })
    expect(isFingerprintProtected(off, 'https://www.editor.example/')).toBe(false)
    expect(isFingerprintProtected(off, 'https://app.editor.example/x')).toBe(false)
    expect(isFingerprintProtected(off, 'https://other.example/')).toBe(true)
  })

  it('keeps its own list of sites, apart from the switch', () => {
    expect(isFingerprintProtected(settings({ fingerprintExceptions: ['editor.example'] }), 'https://editor.example/')).toBe(false)
    expect(isFingerprintProtected(settings({ reduceFingerprint: false }), 'https://editor.example/')).toBe(false)
  })
})
