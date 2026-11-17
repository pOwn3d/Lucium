import { describe, expect, it } from 'vitest'
import { judgeSubmission, type BridgeSender } from './password-bridge'

const sender: BridgeSender = { mainFrame: true, frameUrl: 'https://example.com/login', isTab: true }
const body = { username: 'ana', password: 'pw' }

describe('a message of the page bridge', () => {
  it('is heard from the main frame of a tab on a page that may hold a password', () => {
    expect(judgeSubmission(sender, body)).toEqual({ ok: true, frameUrl: 'https://example.com/login', submission: body })
    expect(judgeSubmission({ ...sender, frameUrl: 'http://localhost:3000/' }, body).ok).toBe(true)
  })

  it('is refused from a frame, from a page that is not a tab (a preview, a panel, a mini window), and from an address that cannot hold a password', () => {
    expect(judgeSubmission({ ...sender, mainFrame: false }, body)).toEqual({ ok: false, why: 'not-main-frame' })
    expect(judgeSubmission({ ...sender, isTab: false }, body)).toEqual({ ok: false, why: 'not-a-tab' })
    for (const frameUrl of ['', 'http://example.com/', 'file:///x', 'about:blank', 'chrome-extension://abc/page.html']) expect(judgeSubmission({ ...sender, frameUrl }, body), frameUrl).toEqual({ ok: false, why: 'not-eligible' })
  })

  it('is refused unless it is exactly a username and a password: the page does not name its origin', () => {
    for (const raw of [null, 'x', [], {}, { username: 'a' }, { ...body, origin: 'https://bank.example' }, { username: 'a', password: '' }, { username: 'a\n', password: 'p' }]) expect(judgeSubmission(sender, raw), JSON.stringify(raw)).toEqual({ ok: false, why: 'shape' })
  })

  it('looks at the sender before the text', () => {
    expect(judgeSubmission({ ...sender, mainFrame: false }, null)).toEqual({ ok: false, why: 'not-main-frame' })
  })
})
