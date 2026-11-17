import { describe, expect, it } from 'vitest'
import { PDF_VIEWER_ORIGIN, isPdfViewerUrl } from './pdf-viewer'

describe('the frame of the PDF viewer', () => {
  it('is recognised by the origin of its extension, for any document it draws', () => {
    expect(isPdfViewerUrl(`${PDF_VIEWER_ORIGIN}index.html?src=https%3A%2F%2Fexample.org%2Fdownload%3Fid%3D3`)).toBe(true)
    expect(isPdfViewerUrl(PDF_VIEWER_ORIGIN)).toBe(true)
  })

  it('is not another extension, nor a page that only mentions the origin', () => {
    for (const url of ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/index.html', `https://example.org/?next=${PDF_VIEWER_ORIGIN}`, 'https://example.org/report.pdf', '', 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai']) {
      expect(isPdfViewerUrl(url), url).toBe(false)
    }
  })
})
