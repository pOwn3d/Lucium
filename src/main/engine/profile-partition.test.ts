import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { profilePartition } from './profile-partition'

let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('profilePartition', () => {
  it('names the partition of a plain profile id', () => {
    for (const id of ['default', 'travail', 'work-2', 'A_b-9', 'x'.repeat(32)]) expect(profilePartition(id, 'a page'), id).toBe(`persist:profile-${id}`)
    expect(errors).not.toHaveBeenCalled()
  })

  it('refuses an id that would name another folder or another context, and says what it refused and for what (this fails if the id is not checked)', () => {
    for (const bad of ['x/../../y', '../y', '..', 'a/b', 'a\\b', 'ephemeral:1', 'container:abc', 'private window', '', '__proto__', 'x'.repeat(33), 'é', 'a\u0000b', 5, null, undefined, {}, ['a']]) {
      errors.mockClear()
      expect(() => profilePartition(bad, 'a page'), String(bad)).toThrow(/not a plain id/)
      expect(errors).toHaveBeenCalledTimes(1)
      const line = String(errors.mock.calls[0]![0])
      expect(line).toContain('refused a page')
    }
  })

  it('bounds what it writes to the journal', () => {
    expect(() => profilePartition('x/'.repeat(10_000), 'a profile session')).toThrow()
    expect(String(errors.mock.calls[0]![0]).length).toBeLessThan(200)
  })
})
