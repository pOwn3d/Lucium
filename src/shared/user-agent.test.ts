import { describe, expect, it } from 'vitest'
import { chromeMajor, chromeUserAgent, withUserAgent } from './user-agent'

describe('chromeMajor', () => {
  it('reads the major version of a Chromium version', () => {
    expect(chromeMajor('156.0.8078.48')).toBe('156')
    expect(chromeMajor('156')).toBe('156')
    expect(chromeMajor('99.1')).toBe('99')
  })

  it('refuses what is not a version', () => {
    for (const version of ['', 'abc', '0.0.0.0', '156.', '.156', '156.x', '156.0.8078.48.1', '-3.0', ' 156.0', '156.0\n', 'v156', 156, null, undefined, {}]) expect(chromeMajor(version), String(version)).toBeNull()
  })
})

describe('chromeUserAgent', () => {
  it('is the user agent of a Chrome on macOS with the Chromium major, and nothing of Electron or of the application', () => {
    const agent = chromeUserAgent('156.0.8078.48', 'darwin')
    expect(agent).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36')
    expect(agent).not.toMatch(/electron|lucium/i)
  })

  it('follows the platform, with the same Chrome', () => {
    expect(chromeUserAgent('156.0.8078.48', 'win32')).toContain('(Windows NT 10.0; Win64; x64)')
    expect(chromeUserAgent('156.0.8078.48', 'linux')).toContain('(X11; Linux x86_64)')
    expect(chromeUserAgent('156.0.8078.48', 'freebsd')).toContain('(X11; Linux x86_64)')
  })

  it('answers null for a version it cannot read, so that the caller leaves the session alone', () => {
    expect(chromeUserAgent('not a version', 'darwin')).toBeNull()
    expect(chromeUserAgent(undefined, 'darwin')).toBeNull()
  })

  it('never lets a hostile version string into the header', () => {
    for (const version of ['156.0"\r\nX-Evil: 1', '156\u0000', '1'.repeat(200), '156.0.0.0; Electron/45']) expect(chromeUserAgent(version, 'darwin'), version).toBeNull()
  })
})

describe('withUserAgent', () => {
  it('replaces the user agent whatever the case of its name, and keeps the other headers', () => {
    const headers = { Accept: 'image/png', 'user-agent': 'Lucium/0.1 Electron/45', Cookie: 'a=1' }
    const out = withUserAgent(headers, 'Chrome-agent')
    expect(out).toEqual({ Accept: 'image/png', Cookie: 'a=1', 'User-Agent': 'Chrome-agent' })
    expect(headers['user-agent']).toBe('Lucium/0.1 Electron/45')
    expect(withUserAgent({}, 'x')).toEqual({ 'User-Agent': 'x' })
    expect(Object.keys(withUserAgent({ 'USER-AGENT': 'old' }, 'x'))).toEqual(['User-Agent'])
  })
})
