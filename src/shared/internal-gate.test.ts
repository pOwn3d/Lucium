import { describe, expect, it } from 'vitest'
import { internalSenderRefusal, type InternalSenderFacts } from './internal-gate'

const good: InternalSenderFacts = {
  frameOrigin: 'lucium-ui://extensions',
  frameUrl: `lucium-ui://extensions/?id=${'a'.repeat(32)}`,
  topFrame: true,
  tab: { url: 'lucium-ui://extensions/', private: false, container: false },
  privateWindow: false,
  profileSession: true,
  appLocked: false
}

const refused = (change: Partial<InternalSenderFacts>): string | null => internalSenderRefusal({ ...good, ...change })

describe('the sender of a message of the Extensions page', () => {
  it('is answered when every fact is the page’s', () => {
    expect(internalSenderRefusal(good)).toBeNull()
    expect(refused({ frameUrl: 'lucium-ui://extensions/shortcuts', tab: { url: 'lucium-ui://extensions/shortcuts', private: false, container: false } })).toBeNull()
  })

  it('is refused without a frame', () => {
    expect(refused({ frameOrigin: undefined })).toMatch(/no sender frame/)
    expect(refused({ frameOrigin: null })).toMatch(/no sender frame/)
  })

  it('is refused from any other origin, a prefix of the page’s included', () => {
    for (const origin of ['https://example.org', 'lucium-ui://extensions.evil.com', 'lucium-ui://extensions@evil', 'lucium-ui://extensions/', 'LUCIUM-UI://EXTENSIONS', 'null', '', 'chrome://extensions', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'lucium-ui://evil', 3]) {
      expect(refused({ frameOrigin: origin }), String(origin)).toMatch(/origin .* is not the Extensions page/)
    }
  })

  it('says the origin it refuses by its scheme and host alone: nothing a page put after them reaches the log', () => {
    expect(refused({ frameOrigin: 'https://secret.example/path?token=abc' })).toBe('origin https://secret.example is not the Extensions page')
    expect(refused({ frameOrigin: 'null' })).toBe('origin (not an address) is not the Extensions page')
  })

  it('is refused from a frame that is not the top one', () => {
    expect(refused({ topFrame: false })).toMatch(/top frame/)
  })

  it('is refused when the document of the frame is not an address of the page', () => {
    for (const url of ['https://example.org/', 'lucium-ui://extensions/assets/a.js', 'lucium-ui://extensions@evil/', '', undefined, null, 'about:blank']) {
      expect(refused({ frameUrl: url }), String(url)).toMatch(/not an address of the Extensions page/)
    }
  })

  it('is refused when it is no tab of a window of the application', () => {
    expect(refused({ tab: null })).toMatch(/not a tab/)
  })

  it('is refused when the state says the tab is elsewhere (it was sent away, whatever its frame says)', () => {
    for (const url of ['https://example.org/', 'about:blank', `chrome-extension://${'a'.repeat(32)}/a.html`, 'lucium-ui://evil/', '']) {
      expect(refused({ tab: { url, private: false, container: false } }), url).toMatch(/no longer on the Extensions page/)
    }
  })

  it('is refused from a private tab and from a tab in a container', () => {
    expect(refused({ tab: { url: 'lucium-ui://extensions/', private: true, container: false } })).toMatch(/private tab/)
    expect(refused({ tab: { url: 'lucium-ui://extensions/', private: false, container: true } })).toMatch(/container/)
  })

  it('is refused in a private or guest window, outside the session of a profile, and while the application is locked', () => {
    expect(refused({ privateWindow: true })).toMatch(/private or guest window/)
    expect(refused({ profileSession: false })).toMatch(/session of a profile/)
    expect(refused({ appLocked: true })).toMatch(/locked/)
  })
})
