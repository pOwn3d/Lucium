import { describe, expect, it, vi } from 'vitest'
import { APP_SCHEME_MAX, appLinkOf, isAppScheme, clickedFrameOpens, frameLinkClick, linkAsker, originOfFrame, EXTERNAL_LINK_MAX, externalLinkOf, GESTURE_WINDOW_MS, GestureLedger, isFreshGesture, isPageOpenUrl, isSavableImageUrl, OPEN_GESTURE_WINDOW_MS, schemeOf } from './external-links'

describe('externalLinkOf', () => {
  it('lets mail and telephone links through', () => {
    expect(externalLinkOf('mailto:ada@example.com')).toBe('mailto:ada@example.com')
    expect(externalLinkOf('mailto:ada@example.com?subject=Bonjour&body=Salut')).toBe('mailto:ada@example.com?subject=Bonjour&body=Salut')
    expect(externalLinkOf('tel:+33123456789')).toBe('tel:+33123456789')
    expect(externalLinkOf('MAILTO:ada@example.com')).toBe('mailto:ada@example.com')
  })

  it('refuses every other scheme: nothing but the list ever reaches the system', () => {
    for (const url of ['file:///etc/passwd', 'x-apple.systempreferences:com.apple.preference.security', 'ssh://host', 'smb://host/share', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'sms:+33123456789', 'facetime:ada@example.com', 'vnc://host', 'itms-services://?action=download', 'chrome://settings', 'https://example.com', 'zoommtg://zoom.us/join?confno=1']) {
      expect(externalLinkOf(url), url).toBeNull()
    }
  })

  it('refuses what is not a well-formed link', () => {
    expect(externalLinkOf('')).toBeNull()
    expect(externalLinkOf(undefined)).toBeNull()
    expect(externalLinkOf(42)).toBeNull()
    expect(externalLinkOf('mailto')).toBeNull()
    expect(externalLinkOf(' mailto:ada@example.com')).toBeNull()
    expect(externalLinkOf('mailto:ada@example.com\nBcc: x@y.z')).toBeNull()
    expect(externalLinkOf('mailto://evil.example/path')).toBeNull()
    expect(externalLinkOf(`mailto:${'a'.repeat(EXTERNAL_LINK_MAX)}`)).toBeNull()
  })

  it('takes a link up to its bound, and not one character more', () => {
    const mail = (length: number) => `mailto:${'a'.repeat(length - 'mailto:'.length)}`
    expect(externalLinkOf(mail(EXTERNAL_LINK_MAX))).toBe(mail(EXTERNAL_LINK_MAX))
    expect(externalLinkOf(mail(EXTERNAL_LINK_MAX + 1))).toBeNull()
    const app = (length: number) => `zoommtg://${'a'.repeat(length - 'zoommtg://'.length)}`
    expect(appLinkOf(app(EXTERNAL_LINK_MAX))).toBe(app(EXTERNAL_LINK_MAX))
    expect(appLinkOf(app(EXTERNAL_LINK_MAX + 1))).toBeNull()
  })
})

describe('isAppScheme', () => {
  it('is a scheme of another application, with its colon, and none that never leaves or needs no question', () => {
    for (const scheme of ['zoommtg:', 'msteams:', 'slack:', 'vscode:', 'spotify:', 'web+coffee:']) expect(isAppScheme(scheme), scheme).toBe(true)
    for (const scheme of ['mailto:', 'tel:', 'https:', 'file:', 'javascript:', 'smb:', 'x-apple.systempreferences:', 'zoommtg', 'Zoommtg:', 'zoommtg://x', '1abc:', '', `${'a'.repeat(APP_SCHEME_MAX)}:`]) expect(isAppScheme(scheme), scheme).toBe(false)
  })
})

describe('appLinkOf', () => {
  it('takes the link of a page to another application, whole', () => {
    for (const url of ['zoommtg://zoom.us/join?confno=1', 'msteams://teams.microsoft.com/l/meetup-join/1', 'slack://channel?team=T1&id=C1', 'vscode://file/tmp/x', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'discord://-/channels/1/2', 'figma://file/abc', 'sms:+33123456789', 'facetime:ada@example.com']) {
      expect(appLinkOf(url), url).toBe(new URL(url).href)
    }
  })

  it('leaves mail and telephone links to the path that needs no question', () => {
    expect(appLinkOf('mailto:ada@example.com')).toBeNull()
    expect(appLinkOf('tel:+33123456789')).toBeNull()
  })

  it('never takes what the browser reads itself, what opens a file, a volume, a remote session or the settings of the Mac', () => {
    const never = [
      ...['https://example.com/', 'http://example.com/', 'ws://example.com/', 'ftp://example.com/x', 'file:///etc/passwd', 'filesystem:https://example.com/temporary/x', 'blob:https://example.com/1', 'data:text/html,<b>x</b>', 'javascript:alert(1)', 'about:blank', 'view-source:https://example.com/'],
      ...['chrome://settings', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', 'devtools://devtools/bundled/inspector.html', 'lucium://open?url=https://example.com', 'lucium-error://retry/1', 'lucium-stand-in://x/y', 'lucium-ui://extensions/', 'LUCIUM-UI://EXTENSIONS/', 'lucium-ui://evil/'],
      ...['afp://host/share', 'smb://host/share', 'nfs://host/export', 'cifs://host/share', 'ssh://host', 'sftp://host/x', 'telnet://host', 'vnc://host', 'shell:startup', 'vbscript:x', 'ms-msdt:/id', 'search-ms:query=x', 'itms-services://?action=download-manifest', 'x-man-page://ls'],
      ...['x-apple.systempreferences:com.apple.preference.security', 'x-apple-reminderkit://x', 'X-APPLE.SYSTEMPREFERENCES:x', 'SMB://host/share']
    ]
    for (const url of never) expect(appLinkOf(url), url).toBeNull()
  })

  it('refuses what is not a well-formed link, and a scheme too long to be printed in a question', () => {
    expect(appLinkOf('')).toBeNull()
    expect(appLinkOf(undefined)).toBeNull()
    expect(appLinkOf('zoommtg')).toBeNull()
    expect(appLinkOf(' zoommtg://x')).toBeNull()
    expect(appLinkOf('zoommtg://x\nsecond')).toBeNull()
    expect(appLinkOf(`zoommtg://${'a'.repeat(EXTERNAL_LINK_MAX)}`)).toBeNull()
    expect(appLinkOf(`${'a'.repeat(APP_SCHEME_MAX)}:x`)).toBeNull()
    expect(appLinkOf(`${'a'.repeat(APP_SCHEME_MAX - 1)}:x`)).not.toBeNull()
  })
})

describe('isFreshGesture', () => {
  it('is true right after an input and false once the window is over, or when there was none', () => {
    expect(isFreshGesture(1000, 1000)).toBe(true)
    expect(isFreshGesture(1000, 1000 + GESTURE_WINDOW_MS)).toBe(true)
    expect(isFreshGesture(1000, 1001 + GESTURE_WINDOW_MS)).toBe(false)
    expect(isFreshGesture(null, 1000)).toBe(false)
    // A clock that went back is not a click.
    expect(isFreshGesture(5000, 1000)).toBe(false)
  })
})

describe('schemeOf', () => {
  it('names the scheme and nothing of the address', () => {
    expect(schemeOf('mailto:ada@example.com')).toBe('mailto:')
    expect(schemeOf('not a url')).toBe('unknown:')
  })
})

describe('isPageOpenUrl', () => {
  it('lets a page open a web address or a blank page', () => {
    expect(isPageOpenUrl('https://example.com/a?b=c#d')).toBe(true)
    expect(isPageOpenUrl('http://localhost:3000/')).toBe(true)
    expect(isPageOpenUrl('about:blank')).toBe(true)
  })

  it('refuses what is for the browser alone: the files of the user, extensions, the developer tools', () => {
    for (const url of ['file:///etc/hosts', 'file:///Users/x/.ssh/id_rsa', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', 'devtools://devtools/bundled/inspector.html', 'about:srcdoc', 'about:config', 'view-source:https://example.com/']) {
      expect(isPageOpenUrl(url), url).toBe(false)
    }
  })

  it('refuses code, inline documents and anything that is not an address', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<p>x</p>', 'blob:https://example.com/1', 'mailto:a@b.c', '', 'not a url', 42, null, undefined]) {
      expect(isPageOpenUrl(url), String(url)).toBe(false)
    }
  })
})

describe('isSavableImageUrl', () => {
  it('lets the menu of an image download the web, an inline image and an object of the page', () => {
    for (const url of ['https://example.com/a.png', 'http://localhost:3000/a.png', 'data:image/png;base64,AAAA', 'blob:https://example.com/3f2a-91', 'HTTPS://EXAMPLE.COM/A.PNG']) {
      expect(isSavableImageUrl(url), url).toBe(true)
    }
  })

  it('never fetches what only the browser or another application owns: the files of the user, extensions, devtools, app schemes, code', () => {
    for (const url of ['file:///etc/hosts', 'file:///Users/x/.ssh/id_rsa', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.png', 'devtools://devtools/bundled/inspector.html', 'javascript:alert(1)', 'myapp://open', 'ftp://example.com/a.png', 'view-source:https://example.com/', 'about:blank', ' https://example.com/a.png', '', 'a.png', 42, null, undefined]) {
      expect(isSavableImageUrl(url), String(url)).toBe(false)
    }
  })
})

describe('GestureLedger', () => {
  it('lets one thing happen per input, and only soon after it', () => {
    const ledger = new GestureLedger()
    expect(ledger.take(1000, OPEN_GESTURE_WINDOW_MS)).toBe(false)
    ledger.note(1000)
    expect(ledger.take(1000 + OPEN_GESTURE_WINDOW_MS, OPEN_GESTURE_WINDOW_MS)).toBe(true)
    // The click is used up: a burst of window.open from one click opens one window.
    expect(ledger.take(1001 + OPEN_GESTURE_WINDOW_MS, OPEN_GESTURE_WINDOW_MS)).toBe(false)
    expect(ledger.take(1000, OPEN_GESTURE_WINDOW_MS)).toBe(false)
  })

  it('tells whether an input is recent without using it up', () => {
    const ledger = new GestureLedger()
    expect(ledger.fresh(1000, OPEN_GESTURE_WINDOW_MS)).toBe(false)
    ledger.note(1000)
    expect(ledger.fresh(1000 + OPEN_GESTURE_WINDOW_MS, OPEN_GESTURE_WINDOW_MS)).toBe(true)
    expect(ledger.fresh(1000 + OPEN_GESTURE_WINDOW_MS, OPEN_GESTURE_WINDOW_MS)).toBe(true)
    expect(ledger.fresh(1001 + OPEN_GESTURE_WINDOW_MS, OPEN_GESTURE_WINDOW_MS)).toBe(false)
    // Looking does not spend it: the one thing the input allows is still allowed.
    expect(ledger.take(1000 + OPEN_GESTURE_WINDOW_MS, OPEN_GESTURE_WINDOW_MS)).toBe(true)
    expect(ledger.fresh(1000 + OPEN_GESTURE_WINDOW_MS, OPEN_GESTURE_WINDOW_MS)).toBe(false)
  })

  it('refuses an input that is too old, and keeps it for a caller with a longer window', () => {
    const ledger = new GestureLedger()
    ledger.note(1000)
    expect(ledger.take(1000 + GESTURE_WINDOW_MS + 1, GESTURE_WINDOW_MS)).toBe(false)
    expect(ledger.take(1000 + GESTURE_WINDOW_MS + 1, OPEN_GESTURE_WINDOW_MS)).toBe(true)
  })

  it('takes a new input after the old one was used', () => {
    const ledger = new GestureLedger()
    ledger.note(1000)
    expect(ledger.take(1100, OPEN_GESTURE_WINDOW_MS)).toBe(true)
    ledger.note(2000)
    expect(ledger.take(2100, OPEN_GESTURE_WINDOW_MS)).toBe(true)
  })
})

describe('clickedFrameOpens', () => {
  const frame = { origin: 'https://pay.example', top: false }

  it('is true when the document that asks for the window is of the site of the frame that was clicked', () => {
    expect(clickedFrameOpens('https://pay.example/button?session=1', frame)).toBe(true)
    // A referrer cut down to its origin (the default policy, for a window of another site) names the site as well.
    expect(clickedFrameOpens('https://pay.example/', frame)).toBe(true)
    expect(clickedFrameOpens('http://127.0.0.1:8080/inner', { origin: 'http://127.0.0.1:8080', top: false })).toBe(true)
  })

  it('is false for a document of another site, another port or another scheme than the frame that was clicked', () => {
    expect(clickedFrameOpens('https://ads.example/slot', frame)).toBe(false)
    expect(clickedFrameOpens('https://pay.example.evil.test/button', frame)).toBe(false)
    expect(clickedFrameOpens('https://pay.example:8443/button', frame)).toBe(false)
    expect(clickedFrameOpens('http://pay.example/button', frame)).toBe(false)
  })

  it('is false for a request that names no document, or one that is not of the web', () => {
    expect(clickedFrameOpens('', frame)).toBe(false)
    expect(clickedFrameOpens('pay.example/button', frame)).toBe(false)
    expect(clickedFrameOpens('about:blank', { origin: 'null', top: false })).toBe(false)
    expect(clickedFrameOpens('file:///Users/me/page.html', { origin: 'file://', top: false })).toBe(false)
  })

  it('is false when no frame has the focus, or when the top document has it: a click there is heard by the page itself', () => {
    expect(clickedFrameOpens('https://pay.example/button', null)).toBe(false)
    expect(clickedFrameOpens('https://pay.example/button', { origin: 'https://pay.example', top: true })).toBe(false)
  })
})

describe('frameLinkClick', () => {
  const page = 'https://shop.example'
  it('lets a frame of the page\'s own site use the click in the page', () => {
    expect(frameLinkClick(page, page, { origin: page, top: true })).toBe('page')
    expect(frameLinkClick(page, page, null)).toBe('page')
  })

  // An advertisement that sends to tel:+1900… after the user clicked something else in the page.
  it('gives a frame of another site only the click that was made in it', () => {
    expect(frameLinkClick('https://ads.example', page, { origin: page, top: true })).toBeNull()
    expect(frameLinkClick('https://ads.example', page, null)).toBeNull()
    expect(frameLinkClick('https://ads.example', page, { origin: 'https://other.example', top: false })).toBeNull()
    expect(frameLinkClick('https://ads.example', page, { origin: 'https://ads.example', top: false })).toBe('frame')
    // The same host on another port or scheme is another site.
    expect(frameLinkClick('http://shop.example', page, { origin: page, top: true })).toBeNull()
    expect(frameLinkClick('https://shop.example:8443', page, { origin: page, top: true })).toBeNull()
  })

  it('gives nothing to a frame or a page without a web origin', () => {
    for (const origin of [null, 'null', '', 'file://', 'about:blank']) {
      expect(frameLinkClick(origin, page, { origin: page, top: true }), String(origin)).toBeNull()
      expect(frameLinkClick(page, origin, { origin: page, top: true }), String(origin)).toBeNull()
    }
    expect(frameLinkClick('null', 'null', null)).toBeNull()
  })
})

describe('linkAsker', () => {
  const page = 'https://site.example'

  it('is the page for its own document and for a frame of its own site, whatever other frames it holds', () => {
    expect(linkAsker(page, page, false)).toEqual({ kind: 'page' })
    expect(linkAsker(page, page, true)).toEqual({ kind: 'page' })
  })

  // The decoy: an advertisement in a frame of the site where the user kept « Toujours ouvrir » for a type of link.
  it('names a frame of another site, so that nothing the user kept for the page answers for it', () => {
    expect(linkAsker('https://ads.example', page, true)).toEqual({ kind: 'frame', origin: 'https://ads.example' })
    expect(linkAsker('https://ads.example', page, false)).toEqual({ kind: 'frame', origin: 'https://ads.example' })
    // Another port, another scheme: another origin, another asker.
    expect(linkAsker('http://site.example', page, false)).toEqual({ kind: 'frame', origin: 'http://site.example' })
    expect(linkAsker('https://site.example:8443', page, false)).toEqual({ kind: 'frame', origin: 'https://site.example:8443' })
  })

  it('is unsure of a document without a web origin (a sandboxed frame), which cannot be named', () => {
    for (const origin of ['null', '', 'file://', 'about:blank']) expect(linkAsker(origin, page, false), origin).toEqual({ kind: 'unsure' })
  })

  // A `window.open` does not say which frame made it.
  it('takes the page for the asker when nobody is named only if the page holds no frame of another site', () => {
    expect(linkAsker(null, page, false)).toEqual({ kind: 'page' })
    expect(linkAsker(null, page, true)).toEqual({ kind: 'unsure' })
  })
})

describe('originOfFrame', () => {
  it('reads the origin of a frame, and null without one', () => {
    expect(originOfFrame({ origin: 'https://a.example' })).toBe('https://a.example')
    expect(originOfFrame(null)).toBeNull()
    expect(originOfFrame(undefined)).toBeNull()
  })

  it('answers null for a frame that cannot be read any more, and the log says why', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const gone = Object.defineProperty({}, 'origin', { get: () => { throw new Error('Render frame was disposed') } }) as { origin: string }
      expect(originOfFrame(gone)).toBeNull()
      expect(warn).toHaveBeenCalledExactlyOnceWith('[engine] cannot read the origin of a frame, so it is taken for a frame of another site:', 'Render frame was disposed')
    } finally {
      warn.mockRestore()
    }
  })
})

