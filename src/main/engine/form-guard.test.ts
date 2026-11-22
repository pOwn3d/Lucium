import { describe, expect, it } from 'vitest'
import { judgeFormAsk } from './form-guard'

const main = { mainFrame: true, frameUrl: 'https://shop.example.com/cart' }

describe('the message of the form guard, judged by the engine', () => {
  it('asks, with the host, for a password going to a public http address', () => {
    expect(judgeFormAsk(main, { action: 'http://pay.example.net/in' })).toEqual({ kind: 'ask', host: 'pay.example.net' })
  })

  it('reads the address against the frame the browser holds, not against anything the page said', () => {
    expect(judgeFormAsk({ mainFrame: true, frameUrl: 'http://shop.example.com/cart' }, { action: '/in' })).toEqual({ kind: 'ask', host: 'shop.example.com' })
    expect(judgeFormAsk(main, { action: '/in' })).toEqual({ kind: 'allow' })
  })

  it('has nothing to ask about https, nor about the local network', () => {
    expect(judgeFormAsk(main, { action: 'https://pay.example.net/in' })).toEqual({ kind: 'allow' })
    expect(judgeFormAsk(main, { action: 'http://192.168.0.1/login' })).toEqual({ kind: 'allow' })
  })

  it('refuses a message from a frame that is not the main frame of the page', () => {
    expect(judgeFormAsk({ ...main, mainFrame: false }, { action: 'http://pay.example.net/in' })).toEqual({ kind: 'refuse', why: 'not-main-frame' })
  })

  it('refuses a message that is not exactly an address', () => {
    for (const raw of [undefined, 'http://pay.example.net/in', { action: '' }, { action: 'http://pay.example.net/in', password: 'x' }]) expect(judgeFormAsk(main, raw), JSON.stringify(raw)).toEqual({ kind: 'refuse', why: 'shape' })
  })
})
