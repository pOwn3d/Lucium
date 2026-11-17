import { describe, expect, it } from 'vitest'
import { RequestedDownloads, type RequestedDownload } from './requested-downloads'

const ses = { name: 'profile' }
const other = { name: 'other profile' }
const page = { id: 7 }

function request(url: string, given: string[], filename?: string): RequestedDownload<object> {
  return { ses, url, ...(filename !== undefined ? { filename } : {}), resolve: (id) => void given.push(id) }
}

describe('RequestedDownloads', () => {
  it('gives the download of the address the extension asked for to the extension, with its file name', () => {
    const given: string[] = []
    const requests = new RequestedDownloads<object>()
    requests.add(request('https://example.com/report.pdf', given, 'reports/june.pdf'))
    expect(requests.take(ses, null, ['https://example.com/report.pdf'], 'dl-1')?.filename).toBe('reports/june.pdf')
    expect(given).toEqual(['dl-1'])
    expect(requests.size).toBe(0)
  })

  it('leaves a download a page started to the user, even at the address an extension is waiting for', () => {
    const given: string[] = []
    const requests = new RequestedDownloads<object>()
    requests.add(request('https://example.com/report.pdf', given, 'reports/june.pdf'))
    // The user clicks a link to the same file in a tab while the extension's request waits: not the extension's, no id for it.
    expect(requests.take(ses, page, ['https://example.com/report.pdf'], 'dl-1')).toBeUndefined()
    expect(given).toEqual([])
    // The extension's own download, which no page started, still finds its request.
    expect(requests.take(ses, null, ['https://example.com/report.pdf'], 'dl-2')?.filename).toBe('reports/june.pdf')
    expect(given).toEqual(['dl-2'])
  })

  it('follows the redirections of the download, and keeps to the session that asked', () => {
    const given: string[] = []
    const requests = new RequestedDownloads<object>()
    requests.add(request('https://example.com/latest', given))
    expect(requests.take(other, null, ['https://cdn.example.com/v2.zip', 'https://example.com/latest'], 'dl-1')).toBeUndefined()
    expect(requests.take(ses, undefined, ['https://cdn.example.com/v2.zip', 'https://example.com/latest'], 'dl-2')).toBeDefined()
    expect(given).toEqual(['dl-2'])
  })

  it('answers two requests for one address in the order they were made, and forgets one that never started', () => {
    const given: string[] = []
    const requests = new RequestedDownloads<object>()
    const first = request('https://example.com/a', given, 'first')
    requests.add(first)
    requests.add(request('https://example.com/a', given, 'second'))
    requests.drop(first)
    expect(requests.take(ses, null, ['https://example.com/a'], 'dl-1')?.filename).toBe('second')
    expect(requests.take(ses, null, ['https://example.com/a'], 'dl-2')).toBeUndefined()
    expect(given).toEqual(['dl-1'])
  })
})
