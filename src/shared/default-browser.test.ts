import { describe, expect, it } from 'vitest'
import { WEB_SCHEMES, WINDOWS_DEFAULT_APPS_URL, WINDOWS_URL_PROGID, parseUserChoiceProgId, schemesToRegister, userChoiceKey, userChoiceKeys, userChoiceLatestKey, windowsChoiceIsLucium } from './default-browser'

describe('schemesToRegister', () => {
  it('lets the packaged application take the web links', () => {
    expect(schemesToRegister(true)).toEqual(['http', 'https'])
    expect(schemesToRegister(true)).toBe(WEB_SCHEMES)
  })

  it('keeps a development copy of Electron out of the default browser: its identifier is the generic one of every Electron application', () => {
    expect(schemesToRegister(false)).toEqual([])
  })
})

// What `reg query "<key>" /v ProgId` prints on Windows (an English and a French system print the same value line).
const QUERY = (progId: string): string => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n    ProgId    REG_SZ    ${progId}\r\n\r\n`

describe('the choice Windows keeps', () => {
  it('reads the ProgID out of what reg.exe prints', () => {
    expect(parseUserChoiceProgId(QUERY('MSEdgeHTM'))).toBe('MSEdgeHTM')
    expect(parseUserChoiceProgId(QUERY('LuciumURL'))).toBe('LuciumURL')
    expect(parseUserChoiceProgId(QUERY('AppX3jfmg4k6wbn1s27ewd1a9v2k5h8p3a5g'))).toBe('AppX3jfmg4k6wbn1s27ewd1a9v2k5h8p3a5g')
  })

  it('finds no ProgID in a failure or in an empty answer', () => {
    expect(parseUserChoiceProgId('')).toBeNull()
    expect(parseUserChoiceProgId('ERROR: The system was unable to find the specified registry key or value.')).toBeNull()
    expect(parseUserChoiceProgId('    Hash    REG_SZ    abc=')).toBeNull()
  })

  it('says Lucium is the default browser only when Windows holds its ProgID for both schemes', () => {
    expect(windowsChoiceIsLucium({ http: 'LuciumURL', https: 'LuciumURL' })).toBe(true)
    expect(windowsChoiceIsLucium({ http: 'luciumurl', https: 'LuciumURL' })).toBe(true)
  })

  it('says it is not while Windows keeps another browser, for one scheme or both, or no choice at all', () => {
    expect(windowsChoiceIsLucium({ http: 'MSEdgeHTM', https: 'MSEdgeHTM' })).toBe(false)
    expect(windowsChoiceIsLucium({ http: 'LuciumURL', https: 'MSEdgeHTM' })).toBe(false)
    expect(windowsChoiceIsLucium({ http: 'MSEdgeHTM', https: 'LuciumURL' })).toBe(false)
    expect(windowsChoiceIsLucium({ http: 'LuciumURL', https: null })).toBe(false)
    expect(windowsChoiceIsLucium({ http: null, https: null })).toBe(false)
    expect(windowsChoiceIsLucium({})).toBe(false)
  })

  it('names the key of each scheme and the ProgID the installer registers', () => {
    expect(userChoiceKey('https')).toBe('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice')
    expect(userChoiceLatestKey('http')).toBe('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoiceLatest\\ProgId')
    // The recent key first: it wins when both exist.
    expect(userChoiceKeys('https')).toEqual([userChoiceLatestKey('https'), userChoiceKey('https')])
    expect(WINDOWS_URL_PROGID).toBe('LuciumURL')
    expect(WINDOWS_DEFAULT_APPS_URL).toBe('ms-settings:defaultapps?registeredAppUser=Lucium')
  })
})
