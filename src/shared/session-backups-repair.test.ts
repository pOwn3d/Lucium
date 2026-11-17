// A copy of the session whose repair fails: the reason given is the failure, not « no usable space ».

import { describe, expect, it, vi } from 'vitest'

const failure = new RangeError('repair went wrong')
vi.mock('./sidebar', async (original) => ({ ...(await original<typeof import('./sidebar')>()), readRestoredState: () => ({ ok: false, error: failure }) }))

const { COPY_FORMAT, COPY_VERSION, parseCopy } = await import('./session-backups')

describe('parseCopy when the repair of the state throws', () => {
  it('throws with the reason of the failure, and keeps the error itself as its cause', () => {
    const text = JSON.stringify({ format: COPY_FORMAT, version: COPY_VERSION, createdAt: 1, data: { spaces: [], tabs: [] } })
    let thrown: unknown
    try {
      parseCopy(text)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('the copy could not be repaired (repair went wrong)')
    expect((thrown as Error).cause).toBe(failure)
  })
})
