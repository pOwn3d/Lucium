import { describe, expect, it } from 'vitest'
import { exportOptionsPlist } from './export-options'

const upload = { teamId: '9A9AUX9UHT', destination: 'upload', internalOnly: true } as const

/** The keys and values of the plist's dictionary, in order: `key → <string>…</string>` or `key → <true/>`. */
const entries = (xml: string): Record<string, string> => Object.fromEntries([...xml.matchAll(/<key>([^<]+)<\/key>\s*(<[^>]+>(?:[^<]*<\/string>)?)/g)].map((match) => [match[1]!, match[2]!]))

describe('exportOptionsPlist: what xcodebuild -exportArchive is told', () => {
  it('sends to App Store Connect with the team, signed automatically, and keeps the build number as it is', () => {
    expect(entries(exportOptionsPlist(upload))).toEqual({
      method: '<string>app-store-connect</string>',
      destination: '<string>upload</string>',
      teamID: '<string>9A9AUX9UHT</string>',
      signingStyle: '<string>automatic</string>',
      manageAppVersionAndBuildNumber: '<false/>',
      testFlightInternalTestingOnly: '<true/>'
    })
  })

  it('only exports when asked to: the destination is export, nothing is sent', () => {
    expect(entries(exportOptionsPlist({ ...upload, destination: 'export' })).destination).toBe('<string>export</string>')
  })

  it('keeps the build to internal testers unless external testers are allowed', () => {
    expect(entries(exportOptionsPlist(upload)).testFlightInternalTestingOnly).toBe('<true/>')
    expect(entries(exportOptionsPlist({ ...upload, internalOnly: false }))).not.toHaveProperty('testFlightInternalTestingOnly')
  })

  it('is a property list: XML header, plist and dict', () => {
    const xml = exportOptionsPlist(upload)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true)
    expect(xml).toMatch(/<plist version="1\.0">\n<dict>\n[\s\S]+<\/dict>\n<\/plist>\n$/)
  })

  it('refuses what is not a team identifier, and a destination that is neither of the two', () => {
    for (const teamId of ['', 'abc', '9a9aux9uht', '9A9AUX9UHT1', '9A9AUX9UH<']) expect(() => exportOptionsPlist({ ...upload, teamId })).toThrow(/not an Apple team identifier/)
    expect(() => exportOptionsPlist({ ...upload, destination: 'ad-hoc' as 'upload' })).toThrow(/neither upload nor export/)
  })
})
