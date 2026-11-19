// The iOS application (ios/) re-implements in Swift the lists of sites of the blocker, the level of protection the settings add up to, and what choosing
// a level writes. The two sides are held together by shared vectors: this suite runs ios/Contracts/blocker-vectors.json against the Mac's code, the Swift
// tests of LuciumKit (BlockerContractTests) run the same file against BlockHost, SiteHostEntry and PrivacySettings.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanBlockExceptions, isBlockingExempt, normalizeBlockHost } from './blocker'
import { defaultSettings, type Settings } from './model'
import { PRESETS, presetOf } from './settings-presets'
import { questionById } from './settings-guide'
import { cleanClearOnClose } from './site-clear'
import { parseSiteHost } from './site-data'

interface Vectors {
  normalizeBlockHost: { input: string; expect: string | null }[]
  isBlockingExempt: { url: string; hosts: string[]; expect: boolean }[]
  cleanBlockExceptions: { input: unknown; expect: string[] }[]
  parseSiteHost: { input: string; expect: string | null }[]
  cleanClearOnClose: { input: unknown; expect: string[] }[]
  protectionLevel: { name: string; settings: Partial<Settings>; expect: string | null }[]
  chooseLevel: { level: string; option: string; patch: Record<string, unknown> }[]
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/blocker-vectors.json'), 'utf8')) as Vectors

describe('iOS contract: blocker vectors', () => {
  it('has vectors to run (an empty file would pass for nothing)', () => {
    expect(vectors.normalizeBlockHost.length).toBeGreaterThan(12)
    expect(vectors.isBlockingExempt.length).toBeGreaterThan(6)
    expect(vectors.parseSiteHost.length).toBeGreaterThan(18)
    expect(vectors.protectionLevel.length).toBeGreaterThan(8)
    expect(vectors.chooseLevel.length).toBe(3)
  })

  it.each(vectors.normalizeBlockHost)('normalizeBlockHost($input)', ({ input, expect: expected }) => {
    expect(normalizeBlockHost(input)).toBe(expected)
  })

  it.each(vectors.isBlockingExempt)('isBlockingExempt($url, $hosts)', ({ url, hosts, expect: expected }) => {
    expect(isBlockingExempt(url, hosts)).toBe(expected)
  })

  it.each(vectors.cleanBlockExceptions)('cleanBlockExceptions($input)', ({ input, expect: expected }) => {
    expect(cleanBlockExceptions(input)).toEqual(expected)
  })

  it.each(vectors.parseSiteHost)('parseSiteHost($input)', ({ input, expect: expected }) => {
    expect(parseSiteHost(input)?.host ?? null).toBe(expected)
  })

  it.each(vectors.cleanClearOnClose)('cleanClearOnClose($input)', ({ input, expect: expected }) => {
    expect(cleanClearOnClose(input)).toEqual(expected)
  })

  it.each(vectors.protectionLevel)('the level of $name', ({ settings, expect: expected }) => {
    expect(presetOf(PRESETS.protection, { ...defaultSettings(), ...settings })).toBe(expected)
  })

  // What choosing a level writes: the patch of each answer of the guide, over settings that are the opposite, so that every key is written.
  it.each(vectors.chooseLevel)('choosing $option writes $patch', ({ option, patch }) => {
    const chosen = PRESETS.protection.options.find((candidate) => candidate.id === option)!
    const written: Record<string, unknown> = {}
    for (const question of PRESETS.protection.questions) {
      const answer = questionById(question)!.answers.find((candidate) => candidate.id === chosen.answers[question])!
      Object.assign(written, answer.patch)
    }
    delete written.reduceFingerprint // the one setting the iPhone does not have
    expect(written).toEqual(patch)
  })
})
