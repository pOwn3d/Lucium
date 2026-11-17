import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { expectedEcsSum, readPinnedEcsSums, sumFromChecksumsJson, sumFromShasums, type EcsSumInput } from './ecs-checksum'

const TAG = 'v45.2.1+wvcus'
const ZIP = 'electron-v45.2.1+wvcus-darwin-arm64.zip'
const SUM = '93e1976a66d58004bf25e5b777c979cc3c03513868d5faf294bcd6f58e63bd24'
const OTHER = 'f'.repeat(64)

const input = (over: Partial<EcsSumInput> = {}): EcsSumInput => ({
  tag: TAG,
  zipName: ZIP,
  shasums: `${OTHER} *electron-v45.2.1+wvcus-darwin-x64.zip\n${SUM} *${ZIP}\n`,
  checksumsJson: JSON.stringify({ 'electron-api.json': OTHER, [ZIP]: SUM }),
  pinned: {},
  ...over,
})

describe('the sum a castLabs archive must have', () => {
  it('is the one SHASUMS256.txt and checksums.json agree on', () => {
    expect(expectedEcsSum(input())).toEqual({ ok: true, sum: SUM, recorded: false })
  })

  it('is refused when checksums.json of the tag gives another sum than the release (an attachment replaced alone)', () => {
    const check = expectedEcsSum(input({ checksumsJson: JSON.stringify({ [ZIP]: OTHER }) }))
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('diffèrent')
  })

  it('is refused when checksums.json gives no sum for the archive, or a sum that is not a SHA-256', () => {
    expect(expectedEcsSum(input({ checksumsJson: JSON.stringify({ 'electron-api.json': OTHER }) })).ok).toBe(false)
    expect(expectedEcsSum(input({ checksumsJson: JSON.stringify({ [ZIP]: 'abc' }) })).ok).toBe(false)
  })

  it('says why when checksums.json cannot be read, and refuses', () => {
    const check = expectedEcsSum(input({ checksumsJson: '<html>rate limited</html>' }))
    expect(check).toMatchObject({ ok: false })
    expect(check.ok === false && check.reason).toMatch(/checksums\.json de v45\.2\.1\+wvcus est illisible \(.+\)/)
    expect(expectedEcsSum(input({ checksumsJson: '[1]' }))).toMatchObject({ ok: false })
  })

  it('is refused when SHASUMS256.txt names another archive only', () => {
    expect(expectedEcsSum(input({ shasums: `${SUM} *electron-v45.2.1+wvcus-darwin-x64.zip\n` }))).toMatchObject({ ok: false })
  })

  it('is refused when castLabs now publishes another sum than the one this repository recorded for the version', () => {
    const changed = `${OTHER} *${ZIP}\n`
    const check = expectedEcsSum(input({ shasums: changed, checksumsJson: JSON.stringify({ [ZIP]: OTHER }), pinned: { [TAG]: { [ZIP]: SUM } } }))
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('scripts/ecs-checksums.json')
  })

  it('says when the sum is the recorded one', () => {
    expect(expectedEcsSum(input({ pinned: { [TAG]: { [ZIP]: SUM } } }))).toEqual({ ok: true, sum: SUM, recorded: true })
  })
})

describe('the readers', () => {
  it('read SHASUMS256.txt with the binary mark or two spaces, and nothing for a near name', () => {
    expect(sumFromShasums(`${SUM}  ${ZIP}`, ZIP)).toBe(SUM)
    expect(sumFromShasums(`${SUM.toUpperCase()} *${ZIP}\r`, ZIP)).toBe(SUM)
    expect(sumFromShasums(`${SUM} *${ZIP}.bak`, ZIP)).toBeNull()
  })

  it('never read an inherited key of checksums.json as an entry', () => {
    expect(sumFromChecksumsJson('{}', 'constructor')).toEqual({ sum: null })
  })
})

describe('scripts/ecs-checksums.json', () => {
  const text = readFileSync(fileURLToPath(new URL('../../scripts/ecs-checksums.json', import.meta.url)), 'utf8')
  const pinned = readPinnedEcsSums(text)

  it('records the archive of the castLabs build of the Electron package.json pins', () => {
    const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { devDependencies: Record<string, string> }
    const version = packageJson.devDependencies.electron
    expect(pinned[`v${version}+wvcus`]?.[`electron-v${version}+wvcus-darwin-arm64.zip`]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses an entry that would weaken the check: a sum that is not a lower-case SHA-256, or a tag that is not castLabs\'', () => {
    expect(() => readPinnedEcsSums(JSON.stringify({ [TAG]: { [ZIP]: SUM.toUpperCase() } }))).toThrow(/not a lower-case SHA-256/)
    expect(() => readPinnedEcsSums(JSON.stringify({ [TAG]: { [ZIP]: '' } }))).toThrow(/not a lower-case SHA-256/)
    expect(() => readPinnedEcsSums(JSON.stringify({ 'v45.2.1': { [ZIP]: SUM } }))).toThrow(/not a castLabs tag/)
  })
})
