import { describe, expect, it } from 'vitest'
import { parseScriptletCall } from './scriptlets'
import { YOUTUBE_COSMETIC_CSS, YOUTUBE_SCRIPTLETS, isYouTubeAdRequest, isYouTubePage } from './youtube-rules'

describe('the YouTube rules apply to youtube.com and nothing else', () => {
  it('recognises the pages of youtube.com and its subdomains only', () => {
    expect(isYouTubePage('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(isYouTubePage('https://m.youtube.com/')).toBe(true)
    expect(isYouTubePage('https://youtube.com/')).toBe(true)
    expect(isYouTubePage('https://notyoutube.com/')).toBe(false)
    expect(isYouTubePage('https://youtube.com.example.test/')).toBe(false)
    expect(isYouTubePage('https://news.test/youtube.com')).toBe(false)
    expect(isYouTubePage(null)).toBe(false)
    expect(isYouTubePage('file:///Users/x/youtube.com.html')).toBe(false)
  })

  it('recognises the advertising paths of youtube.com, not the video or the quality statistics', () => {
    expect(isYouTubeAdRequest('https://www.youtube.com/pagead/viewthroughconversion/1')).toBe(true)
    expect(isYouTubeAdRequest('https://www.youtube.com/api/stats/ads?ver=2')).toBe(true)
    expect(isYouTubeAdRequest('https://www.youtube.com/api/stats/qoe?cpn=x')).toBe(false)
    expect(isYouTubeAdRequest('https://www.youtube.com/youtubei/v1/player')).toBe(false)
    expect(isYouTubeAdRequest('https://rr1.googlevideo.com/videoplayback?pagead=1')).toBe(false)
    expect(isYouTubeAdRequest('https://news.test/pagead/x')).toBe(false)
  })

  it('writes every scriptlet call in the grammar of the library, so the blocker accepts it', () => {
    for (const call of YOUTUBE_SCRIPTLETS) expect(parseScriptletCall(call.id, call.args).ok).toBe(true)
  })

  it('hides the advertising blocks with display none, and only that', () => {
    expect(YOUTUBE_COSMETIC_CSS).toContain('ytd-ad-slot-renderer')
    expect(YOUTUBE_COSMETIC_CSS).toMatch(/\{ display: none !important; \}$/)
  })
})
