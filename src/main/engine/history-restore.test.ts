import { describe, expect, it } from 'vitest'
import { restorableHistory } from './history-restore'

const web = (url: string) => /^https?:\/\//.test(url)
const page = (url: string) => ({ title: `T ${url}`, url })

describe('the history a rebuilt page inherits', () => {
  it('keeps every page that can be loaded again, in order, at the same index', () => {
    const history = { entries: [page('https://a.example/'), page('https://b.example/'), page('https://c.example/')], index: 1 }
    expect(restorableHistory(history, web)).toEqual(history)
  })

  it('drops an error page or a foreign scheme and moves the index with it', () => {
    const history = { entries: [page('https://a.example/'), page('chrome-error://chromewebdata/'), page('https://b.example/'), page('data:text/html,x'), page('https://c.example/')], index: 4 }
    expect(restorableHistory(history, web)).toEqual({ entries: [page('https://a.example/'), page('https://b.example/'), page('https://c.example/')], index: 2 })
  })

  it('lands on the last page kept before the one the tab was on when that one cannot be loaded again', () => {
    const history = { entries: [page('https://a.example/'), page('https://b.example/'), page('chrome-error://chromewebdata/')], index: 2 }
    expect(restorableHistory(history, web)).toEqual({ entries: [page('https://a.example/'), page('https://b.example/')], index: 1 })
  })

  it('has nothing to restore when no page can be loaded again, or when there is no history', () => {
    expect(restorableHistory({ entries: [page('chrome-error://chromewebdata/')], index: 0 }, web)).toBeNull()
    expect(restorableHistory({ entries: [], index: -1 }, web)).toBeNull()
  })

  it('reads a hostile or damaged entry as a page that cannot be loaded', () => {
    const odd = { entries: [{ title: 5, url: 'https://a.example/' }, { title: 'x', url: 42 }, null] as never, index: 0 }
    expect(restorableHistory(odd, web)).toEqual({ entries: [{ title: '', url: 'https://a.example/' }], index: 0 })
  })
})
