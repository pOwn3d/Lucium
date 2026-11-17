import { afterEach, describe, expect, it } from 'vitest'
import { FULLSCREEN_NOTICE_MS, NO_FULLSCREEN_NOTICE, NOTICE_HOST_MAX, fullscreenNoticeAt, fullscreenNoticeLines, noticeHost } from './fullscreen-notice'
import { setLanguage } from './i18n'

describe('when the notice of a page in full screen shows', () => {
  it('shows as soon as a page takes the window, for its time, and then goes by itself', () => {
    const start = fullscreenNoticeAt(NO_FULLSCREEN_NOTICE, 'a', 1000)
    expect(start).toEqual({ state: { tab: 'a', until: 1000 + FULLSCREEN_NOTICE_MS }, shown: true })
    expect(fullscreenNoticeAt(start.state, 'a', 1000 + FULLSCREEN_NOTICE_MS - 1).shown).toBe(true)
    expect(fullscreenNoticeAt(start.state, 'a', 1000 + FULLSCREEN_NOTICE_MS).shown).toBe(false)
  })

  it('does not come back while the same page keeps the window: the layout asks again at every change, and a video is not covered again', () => {
    const start = fullscreenNoticeAt(NO_FULLSCREEN_NOTICE, 'a', 0).state
    const later = fullscreenNoticeAt(start, 'a', FULLSCREEN_NOTICE_MS * 10)
    expect(later).toEqual({ state: start, shown: false })
  })

  it('is announced again when a page leaves full screen and takes it again: a page cannot come back over the window unannounced', () => {
    const first = fullscreenNoticeAt(NO_FULLSCREEN_NOTICE, 'a', 0).state
    const left = fullscreenNoticeAt(first, null, FULLSCREEN_NOTICE_MS * 2)
    expect(left).toEqual({ state: NO_FULLSCREEN_NOTICE, shown: false })
    const back = fullscreenNoticeAt(left.state, 'a', FULLSCREEN_NOTICE_MS * 2 + 10)
    expect(back).toEqual({ state: { tab: 'a', until: FULLSCREEN_NOTICE_MS * 3 + 10 }, shown: true })
  })

  it('starts again for another tab that takes the window from the first', () => {
    const first = fullscreenNoticeAt(NO_FULLSCREEN_NOTICE, 'a', 0).state
    expect(fullscreenNoticeAt(first, 'b', 100)).toEqual({ state: { tab: 'b', until: 100 + FULLSCREEN_NOTICE_MS }, shown: true })
  })

  it('never shows while no page holds the window', () => {
    expect(fullscreenNoticeAt(NO_FULLSCREEN_NOTICE, null, 0)).toEqual({ state: NO_FULLSCREEN_NOTICE, shown: false })
  })
})

describe('what the notice says', () => {
  afterEach(() => setLanguage('fr'))

  it('names the host of the page as the address bar would, and the key that leaves full screen, in the language of the interface', () => {
    setLanguage('fr')
    expect(fullscreenNoticeLines('https://www.video.example/watch?v=1')).toEqual({ site: 'video.example est en plein écran', exit: 'Appuyez sur Échap pour quitter le plein écran' })
    setLanguage('en')
    expect(fullscreenNoticeLines('https://video.example:8443/')).toEqual({ site: 'video.example:8443 is in full screen', exit: 'Press Esc to leave full screen' })
  })

  it('says « this page » for a page without a host, never a text the page chose', () => {
    setLanguage('fr')
    expect(fullscreenNoticeLines('file:///Users/x/film.html').site).toBe('Cette page est en plein écran')
    expect(fullscreenNoticeLines('about:blank').site).toBe('Cette page est en plein écran')
  })

  it('writes an internationalised host in the form that cannot pass for another one', () => {
    expect(noticeHost('https://аррӏе.example/')).toBe('xn--80ak6aa92e.example')
  })

  it('cuts a long host by its start, so that the domain that says whose site it is always shows', () => {
    const host = `${'accounts.example.com.session-check.'.repeat(4)}evil.example`
    const shown = noticeHost(`https://${host}/login`)
    expect(shown.length).toBe(NOTICE_HOST_MAX)
    expect(shown.startsWith('…')).toBe(true)
    expect(shown.endsWith('.evil.example')).toBe(true)
    expect(noticeHost('https://short.example/')).toBe('short.example')
  })
})
