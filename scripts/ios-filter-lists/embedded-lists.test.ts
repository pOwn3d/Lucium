import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { convertList, serializeRules, WEBKIT_RULE_LIMIT } from './abp-to-webkit'
import { buildEmbedded, EMBEDDED_LIST_IDS, fixtureFiles, REGISTRY_FILE, registryProblems, sourceVersionOf, type ListInput, type ListSource, type Registry } from './embedded-lists'
import { FILTER_LISTS } from '../../src/shared/filter-lists'

const ROOT = join(__dirname, '../..')

const source: ListSource = {
  id: 'sample',
  title: { en: 'Sample', fr: 'Exemple' },
  category: 'ads',
  author: { en: 'The authors', fr: 'Les auteurs' },
  license: { en: 'GPL-3.0', fr: 'GPL-3.0' },
  licenseUrl: 'https://example.org/licence',
  homepage: 'https://example.org/',
  sourceUrl: 'https://example.org/list.txt'
}

const sampleText = '! Version: 202611171200\n||ads.example^\n##.banner\n'
const input = (overrides: Partial<ListSource> = {}, text = sampleText): ListInput => ({ source: { ...source, ...overrides }, text, fetchedAt: '2026-11-17T20:00:00Z', converted: convertList(text) })
const GENERATED = '2026-11-17T20:05:00Z'

describe('buildEmbedded', () => {
  it('writes a file per kind of rules and a registry that says where the list comes from', () => {
    const { files, registry } = buildEmbedded([input()], GENERATED, WEBKIT_RULE_LIMIT)
    expect(Object.keys(files).sort()).toEqual([REGISTRY_FILE, 'sample.cosmetic.json', 'sample.network.json'])
    const [list] = registry.lists
    expect(list).toMatchObject({
      id: 'sample',
      title: { en: 'Sample', fr: 'Exemple' },
      author: { en: 'The authors', fr: 'Les auteurs' },
      license: { en: 'GPL-3.0', fr: 'GPL-3.0' },
      licenseUrl: 'https://example.org/licence',
      sourceUrl: 'https://example.org/list.txt',
      fetchedAt: '2026-11-17T20:00:00Z',
      sourceVersion: '202611171200',
      filters: 2
    })
    expect(list!.files.map((file) => [file.name, file.kind, file.rules])).toEqual([['sample.network.json', 'network', 2], ['sample.cosmetic.json', 'cosmetic', 1]])
    expect(JSON.parse(files[REGISTRY_FILE]!)).toEqual(registry)
    // The rules in the file are the converter's, byte for byte.
    expect(files['sample.network.json']).toBe(serializeRules(convertList(sampleText).network))
  })

  it('does not write a file that has no rule', () => {
    const { files, registry } = buildEmbedded([input({}, '##.banner\n')], GENERATED, WEBKIT_RULE_LIMIT)
    expect(Object.keys(files)).not.toContain('sample.network.json')
    expect(registry.lists[0]!.files.map((file) => file.kind)).toEqual(['network', 'cosmetic'].filter((kind) => kind !== 'network'))
  })

  it('names every sha256 after the content that is written', async () => {
    const { createHash } = await import('node:crypto')
    const { files, registry } = buildEmbedded([input()], GENERATED, WEBKIT_RULE_LIMIT)
    for (const file of registry.lists[0]!.files) expect(file.sha256).toBe(createHash('sha256').update(files[file.name]!).digest('hex'))
    expect(registry.lists[0]!.sourceSha256).toBe(createHash('sha256').update(sampleText).digest('hex'))
  })

  it('refuses a list that has no licence, no author, no title or no source, naming what is missing, and writes nothing', () => {
    expect(() => buildEmbedded([input({ license: { en: 'GPL-3.0', fr: '' } })], GENERATED, WEBKIT_RULE_LIMIT)).toThrow(/sample: no license in fr/)
    expect(() => buildEmbedded([input({ author: { en: ' ', fr: 'x' } })], GENERATED, WEBKIT_RULE_LIMIT)).toThrow(/sample: no author in en/)
    expect(() => buildEmbedded([input({ title: { en: '', fr: '' } })], GENERATED, WEBKIT_RULE_LIMIT)).toThrow(/sample: no title in en[\s\S]*sample: no title in fr/)
    expect(() => buildEmbedded([input({ sourceUrl: 'http://example.org/list.txt' })], GENERATED, WEBKIT_RULE_LIMIT)).toThrow(/sourceUrl is not an https address/)
    expect(() => buildEmbedded([input({ licenseUrl: '' })], GENERATED, WEBKIT_RULE_LIMIT)).toThrow(/licenseUrl is not an https address/)
    expect(() => buildEmbedded([input({ homepage: 'example.org' })], GENERATED, WEBKIT_RULE_LIMIT)).toThrow(/homepage is not an https address/)
  })

  it('refuses a list twice, a bad id, a list over the limit and a bad date', () => {
    expect(() => buildEmbedded([input(), input()], GENERATED, WEBKIT_RULE_LIMIT)).toThrow(/sample: twice/)
    expect(() => buildEmbedded([input({ id: 'Bad Id' })], GENERATED, WEBKIT_RULE_LIMIT)).toThrow(/the id is not a name/)
    expect(() => buildEmbedded([input()], GENERATED, 1)).toThrow(/sample.network.json has 2 rules, WebKit takes 1 to 1/)
    expect(() => buildEmbedded([input()], 'yesterday', WEBKIT_RULE_LIMIT)).toThrow(/generatedAt is not an ISO date/)
    expect(() => buildEmbedded([], GENERATED, WEBKIT_RULE_LIMIT)).toThrow(/no list/)
  })

  it('keeps what the conversion left out, so that a smaller list is visible', () => {
    const { registry } = buildEmbedded([input({}, '||a.example^\n||b.example^$redirect=x\n||c.example^$redirect=x\n')], GENERATED, WEBKIT_RULE_LIMIT)
    expect(registry.lists[0]!.dropped).toEqual({ 'option:redirect': 2 })
    expect(registry.lists[0]!.filters).toBe(3)
  })
})

describe('registryProblems', () => {
  const good = (): Registry => buildEmbedded([input()], GENERATED, WEBKIT_RULE_LIMIT).registry

  it('finds nothing in a complete registry', () => {
    expect(registryProblems(good(), WEBKIT_RULE_LIMIT)).toEqual([])
  })

  it('finds a file that is not named after its list and kind, a missing sha256 and a missing file', () => {
    const registry = good()
    registry.lists[0]!.files[0]!.name = 'other.json'
    registry.lists[0]!.files[1]!.sha256 = 'abc'
    expect(registryProblems(registry, WEBKIT_RULE_LIMIT).join('\n')).toMatch(/other.json is not named after its list and kind[\s\S]*has no SHA-256/)
    registry.lists[0]!.files = []
    expect(registryProblems(registry, WEBKIT_RULE_LIMIT)).toContain('list sample: no file')
  })

  it('finds a schema it does not know', () => {
    const registry = good() as unknown as { schema: number }
    registry.schema = 2
    expect(registryProblems(registry as unknown as Registry, WEBKIT_RULE_LIMIT)).toContain('schema 2 is not 1')
  })
})

describe('sourceVersionOf', () => {
  it('reads the version a list gives of itself', () => {
    expect(sourceVersionOf('! Title: x\n! Version: 202611171200\n')).toBe('202611171200')
    expect(sourceVersionOf('[Adblock Plus 2.0]\n! Last modified: 17 Nov 2026 12:00 UTC\n')).toBe('17 Nov 2026 12:00 UTC')
    expect(sourceVersionOf('! TimeUpdated: 2026-11-17T12:00:00Z\n')).toBe('2026-11-17T12:00:00Z')
    expect(sourceVersionOf('||a.example^\n')).toBeNull()
    expect(sourceVersionOf(`${'! x\n'.repeat(60)}! Version: 1`)).toBeNull()
  })
})

describe('the lists the application embeds', () => {
  it('are in the catalogue of the Mac, once each, with a licence and a source the application can show', () => {
    expect(new Set(EMBEDDED_LIST_IDS).size).toBe(EMBEDDED_LIST_IDS.length)
    for (const id of EMBEDDED_LIST_IDS) {
      const list = FILTER_LISTS.find((entry) => entry.id === id)
      expect(list, `${id} is not in src/shared/filter-lists.ts`).toBeDefined()
      expect(list!.license.trim(), id).not.toBe('')
      expect(list!.author.trim(), id).not.toBe('')
      expect(list!.licenseUrl, id).toMatch(/^https:\/\//)
      expect(list!.url, id).toMatch(/^https:\/\//)
    }
  })

  it('are the lists of the decision of 17 November 2026: EasyList, EasyPrivacy, the uBlock filters, and the cookie lists', () => {
    expect([...EMBEDDED_LIST_IDS].sort()).toEqual(['easylist', 'easylist-cookie', 'easyprivacy', 'ublock-badware', 'ublock-cookies', 'ublock-filters', 'ublock-privacy', 'ublock-quick-fixes', 'ublock-unbreak'])
  })
})

describe('the proof list', () => {
  const text = readFileSync(join(__dirname, 'fixtures/proof.txt'), 'utf8')

  it('has its converted files and its registry committed, equal to what the converter writes now (run: node scripts/ios-filter-lists.mjs --fixture)', () => {
    const converted = convertList(text)
    const files = fixtureFiles(converted, text, WEBKIT_RULE_LIMIT)
    expect(Object.keys(files).sort()).toEqual([REGISTRY_FILE, 'proof.cosmetic.json', 'proof.network.json'])
    for (const [name, content] of Object.entries(files)) {
      expect(readFileSync(join(ROOT, 'ios/LuciumTests/Fixtures', name), 'utf8'), name).toBe(content)
    }
    expect(converted.stats.dropped).toEqual({})
  })

  it('is a registry that is complete, like the real ones', () => {
    const registry = JSON.parse(readFileSync(join(ROOT, 'ios/LuciumTests/Fixtures', REGISTRY_FILE), 'utf8')) as Registry
    expect(registryProblems(registry, WEBKIT_RULE_LIMIT)).toEqual([])
    expect(registry.lists.map((list) => list.id)).toEqual(['proof'])
  })
})

describe('scripts/ios-filter-lists.mjs', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lucium-ios-lists-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/ios-filter-lists.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
  // ublock-quick-fixes is the smallest list of the catalogue: 200 rules are enough for the check the Mac makes of a copy.
  const quickFixes = `! Title: Sample\n${Array.from({ length: 250 }, (_, index) => `||ad${index}.example^`).join('\n')}\n`

  it('converts the lists it is given, writes them with their registry, and takes no list from the network when it is told where they are', () => {
    const from = join(scratch, 'from')
    mkdirSync(from)
    writeFileSync(join(from, 'ublock-quick-fixes.txt'), quickFixes)
    const out = join(scratch, 'out')
    const result = run('--from', from, '--out', out, '--only', 'ublock-quick-fixes')
    expect(result.status, result.stderr).toBe(0)
    expect(readdirSync(out).sort()).toEqual([REGISTRY_FILE, 'ublock-quick-fixes.network.json'])
    const registry = JSON.parse(readFileSync(join(out, REGISTRY_FILE), 'utf8')) as Registry
    expect(registryProblems(registry, WEBKIT_RULE_LIMIT)).toEqual([])
    expect(registry.lists[0]).toMatchObject({ id: 'ublock-quick-fixes', licenseUrl: expect.stringMatching(/^https:\/\//), license: { en: expect.any(String), fr: expect.any(String) } })
    expect(registry.lists[0]!.title.fr).not.toBe('')
    expect(result.stdout).toContain('1 lists written')
  })

  it('writes nothing, and leaves the previous folder as it was, when one list does not look like a list', () => {
    const from = join(scratch, 'from-bad')
    mkdirSync(from)
    writeFileSync(join(from, 'ublock-quick-fixes.txt'), '<!doctype html><html>captive portal</html>')
    const out = join(scratch, 'kept')
    mkdirSync(out)
    writeFileSync(join(out, 'previous.json'), '[]')
    const result = run('--from', from, '--out', out, '--only', 'ublock-quick-fixes')
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/nothing written, 1 list\(s\) failed/)
    expect(readdirSync(out)).toEqual(['previous.json'])
    expect(existsSync(`${out}.tmp-`)).toBe(false)
  })

  it('refuses a list that the catalogue of the Mac does not have', () => {
    const result = run('--only', 'no-such-list', '--out', join(scratch, 'none'))
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/not in the catalogue of the Mac: no-such-list/)
  })
})
