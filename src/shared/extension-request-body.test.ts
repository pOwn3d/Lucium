import { describe, expect, it } from 'vitest'
import { REQUEST_BODY_MAX, requestBodyOf } from './extension-request-body'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const text = (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer)

describe('requestBodyOf', () => {
  it('is nothing for a request with no body', () => {
    expect(requestBodyOf(undefined)).toBeUndefined()
    expect(requestBodyOf([])).toBeUndefined()
  })

  it('hands over the bytes, as copies the extension owns', () => {
    const original = bytes('a=1&b=2')
    const body = requestBodyOf([{ bytes: original }])!
    expect(body.raw).toHaveLength(1)
    expect(text(body.raw![0]!.bytes!)).toBe('a=1&b=2')
    original[0] = 0x7a
    expect(text(body.raw![0]!.bytes!)).toBe('a=1&b=2')
  })

  it('names a file by its own name, never by its path on this machine, and leaves out what it cannot read', () => {
    const body = requestBodyOf([{ file: '/Users/jane/Documents/secret.pdf' }, { blobUUID: 'x' }])!
    expect(body.raw).toEqual([{ file: 'secret.pdf' }])
  })

  it('is an error, and not the data, past the bound', () => {
    const body = requestBodyOf([{ bytes: new Uint8Array(REQUEST_BODY_MAX) }, { bytes: bytes('x') }])!
    expect(body).toEqual({ error: 'The body of the request is too large to be handed over.' })
    expect(requestBodyOf([{ bytes: new Uint8Array(REQUEST_BODY_MAX) }])!.raw).toHaveLength(1)
  })
})
