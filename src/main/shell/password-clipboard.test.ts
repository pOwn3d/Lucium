import { describe, expect, it } from 'vitest'
import { CONCEALED_TYPE, concealedWriter } from './password-clipboard'

describe('the concealed write of a password', () => {
  it('sends the text and the marker in one write, so that the text is never on the clipboard unmarked', async () => {
    const writes: Array<Array<Record<string, string>>> = []
    const write = concealedWriter({ write: async (items: Array<Record<string, string>>) => void writes.push(items) }, (entries) => entries)
    await write('the-text')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toHaveLength(1)
    expect(writes[0]![0]).toMatchObject({ 'text/plain': 'the-text', [`electron application/osclipboard;format="${CONCEALED_TYPE}"`]: expect.any(String) })
  })

  it('lets a refusal of the clipboard through, for the service to say and log', async () => {
    const write = concealedWriter({ write: async () => Promise.reject(new TypeError('refused')) }, (entries) => entries)
    await expect(write('x')).rejects.toThrow('refused')
  })
})
