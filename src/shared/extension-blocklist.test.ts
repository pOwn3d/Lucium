import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { blockedDisabledMessage, blockedExtension, blockedInstallMessage, type BlockedExtension } from './extension-blocklist'
import { BLOCKED_EXTENSIONS } from './extension-blocklist-data'

const BAD = 'a'.repeat(32)
const list: BlockedExtension[] = [{ id: BAD, reason: 'spyware' }]

describe('blockedExtension', () => {
  it('finds a listed identifier and no other', () => {
    expect(blockedExtension(BAD, list)).toEqual({ id: BAD, reason: 'spyware' })
    expect(blockedExtension('b'.repeat(32), list)).toBeUndefined()
    expect(blockedExtension('', list)).toBeUndefined()
  })

  it('reads the embedded list by default, whose entries are well formed', () => {
    for (const entry of BLOCKED_EXTENSIONS) expect(entry.id).toMatch(/^[a-p]{32}$/)
    expect(new Set(BLOCKED_EXTENSIONS.map((entry) => entry.id)).size).toBe(BLOCKED_EXTENSIONS.length)
  })
})

describe('the messages', () => {
  it('name the extension and the reason, in both languages', () => {
    const entry = list[0]!
    setLanguage('en')
    try {
      expect(blockedInstallMessage(entry, 'Evil')).toBe('“Evil” is on Lucium’s block list (it spies on its users): it was not installed.')
      expect(blockedDisabledMessage(entry, 'Evil')).toContain('turned off')
    } finally {
      setLanguage('fr')
    }
    expect(blockedInstallMessage(entry, 'Evil')).toContain('espionne')
  })
})
