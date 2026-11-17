import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionLedger } from './extension-ledger'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-ledger-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ExtensionLedger', () => {
  it('knows nothing of an extension that was never recorded', () => {
    expect(new ExtensionLedger(join(dir, 'ledger.json')).versionOf('default', 'ext')).toBeUndefined()
  })

  it('remembers a version per profile and extension, across launches', () => {
    const path = join(dir, 'sub', 'ledger.json')
    const first = new ExtensionLedger(path)
    first.record('default', 'ext', '1.0.0')
    first.record('work', 'ext', '2.0.0')
    const second = new ExtensionLedger(path)
    expect(second.versionOf('default', 'ext')).toBe('1.0.0')
    expect(second.versionOf('work', 'ext')).toBe('2.0.0')
    expect(second.versionOf('work', 'other')).toBeUndefined()
  })

  it('replaces the version when the extension is updated', () => {
    const path = join(dir, 'ledger.json')
    const ledger = new ExtensionLedger(path)
    ledger.record('default', 'ext', '1.0.0')
    ledger.record('default', 'ext', '1.1.0')
    expect(new ExtensionLedger(path).versionOf('default', 'ext')).toBe('1.1.0')
  })

  it('starts afresh from a file that is not a ledger, and says so', () => {
    const path = join(dir, 'ledger.json')
    writeFileSync(path, '[1, 2')
    const ledger = new ExtensionLedger(path)
    expect(ledger.versionOf('default', 'ext')).toBeUndefined()
    ledger.record('default', 'ext', '1.0.0')
    expect(new ExtensionLedger(path).versionOf('default', 'ext')).toBe('1.0.0')
  })

  it('forgets an extension that was removed, so that coming back is an install', () => {
    const path = join(dir, 'ledger.json')
    const ledger = new ExtensionLedger(path)
    ledger.record('default', 'ext', '1.0.0')
    ledger.record('work', 'ext', '1.0.0')
    ledger.forget('default', 'ext')
    ledger.forget('default', 'never-there')
    const reread = new ExtensionLedger(path)
    expect(reread.versionOf('default', 'ext')).toBeUndefined()
    expect(reread.versionOf('work', 'ext')).toBe('1.0.0')
  })

  it('remembers the id of an unpacked extension by its folder, and when the store extensions last looked for updates', () => {
    const path = join(dir, 'ledger.json')
    const ledger = new ExtensionLedger(path)
    expect(ledger.idOfPath('/ext/a')).toBeUndefined()
    expect(ledger.lastUpdateCheck()).toBeUndefined()
    ledger.rememberPath('/ext/a', 'a'.repeat(32))
    ledger.recordUpdateCheck(1_700_000_000_123.6)
    const reread = new ExtensionLedger(path)
    expect(reread.idOfPath('/ext/a')).toBe('a'.repeat(32))
    expect(reread.idOfPath('/ext/b')).toBeUndefined()
    expect(reread.lastUpdateCheck()).toBe(1_700_000_000_124)
    // A path can never be taken for a profile's version, nor the other way round.
    expect(reread.versionOf('path', '/ext/a')).toBe('a'.repeat(32))
  })

  it('keeps what an extension chose of its static rulesets, per profile, apart from its version, and forgets it when asked', () => {
    const path = join(dir, 'ledger.json')
    const first = new ExtensionLedger(path)
    first.record('default', 'ext', '1.0.0')
    first.keepNetChoices('default', 'ext', '{"enabled":["extra"]}')
    const second = new ExtensionLedger(path)
    expect(second.netChoices('default', 'ext')).toBe('{"enabled":["extra"]}')
    expect(second.netChoices('work', 'ext')).toBeUndefined()
    expect(second.versionOf('default', 'ext')).toBe('1.0.0')
    second.keepNetChoices('default', 'ext', undefined)
    expect(new ExtensionLedger(path).netChoices('default', 'ext')).toBeUndefined()
  })

  it('keeps what the person granted an extension on its request, per profile, and forgets it when asked', () => {
    const path = join(dir, 'ledger.json')
    const first = new ExtensionLedger(path)
    first.keepOptionalGrant('default', 'ext', '{"permissions":["history"],"origins":[]}')
    first.keepNetChoices('default', 'ext', '{"enabled":[]}')
    const second = new ExtensionLedger(path)
    expect(second.optionalGrant('default', 'ext')).toBe('{"permissions":["history"],"origins":[]}')
    expect(second.optionalGrant('work', 'ext')).toBeUndefined()
    // Apart from what the extension chose of its rulesets.
    expect(second.netChoices('default', 'ext')).toBe('{"enabled":[]}')
    second.keepOptionalGrant('default', 'ext', undefined)
    expect(new ExtensionLedger(path).optionalGrant('default', 'ext')).toBeUndefined()
  })

  it('ignores a check date that is not a date', () => {
    const path = join(dir, 'ledger.json')
    writeFileSync(path, JSON.stringify({ '#update-check': 'hier', 'default:ext': '1.0.0' }))
    expect(new ExtensionLedger(path).lastUpdateCheck()).toBeUndefined()
  })
})
