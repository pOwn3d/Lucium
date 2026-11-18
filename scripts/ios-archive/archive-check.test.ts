import { describe, expect, it } from 'vitest'
import { archiveProblems, plistString, type ArchiveFacts } from './archive-check'

const plist = (id: string, build: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>ApplicationProperties</key><dict>\n<key>CFBundleIdentifier</key>\n<string>${id}</string>\n<key>CFBundleVersion</key><string>${build}</string>\n</dict></dict></plist>`
const facts = (change: Partial<ArchiveFacts> = {}): ArchiveFacts => ({
  plistXml: plist('app.lucium.browser.ios', '465123'),
  appFiles: ['Lucium', 'filter-lists-registry.json', 'easylist.network.json', 'guard-runtime.js'],
  requiredFiles: ['filter-lists-registry.json', 'easylist.network.json', 'guard-runtime.js'],
  expect: { bundleId: 'app.lucium.browser.ios', build: '465123' },
  ...change
})

describe('archiveProblems: the archive is read back before it is exported', () => {
  it('accepts the build that was asked for, with what it must carry', () => {
    expect(archiveProblems(facts())).toEqual([])
  })

  it('refuses a build number that did not reach the application (the setting was ignored)', () => {
    expect(archiveProblems(facts({ plistXml: plist('app.lucium.browser.ios', '1') }))).toEqual(['the archive has the build number 1, not 465123: the setting did not reach the application'])
  })

  it('refuses another application', () => {
    expect(archiveProblems(facts({ plistXml: plist('app.example.other', '465123') }))).toEqual(['the archive holds app.example.other, not app.lucium.browser.ios'])
  })

  it('refuses a plist that says neither', () => {
    expect(archiveProblems(facts({ plistXml: '<plist version="1.0"><dict/></plist>' }))).toHaveLength(2)
  })

  it('refuses an application that does not carry the filter lists, each missing file named', () => {
    expect(archiveProblems(facts({ appFiles: ['Lucium', 'guard-runtime.js'] }))).toEqual([
      'the application in the archive does not carry filter-lists-registry.json',
      'the application in the archive does not carry easylist.network.json'
    ])
  })
})

describe('plistString', () => {
  it('reads the string under a key, across lines, and null when there is none', () => {
    expect(plistString(plist('a.b', '7'), 'CFBundleIdentifier')).toBe('a.b')
    expect(plistString(plist('a.b', '7'), 'Team')).toBeNull()
  })
})
