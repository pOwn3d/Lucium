import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { defaultSettings, type Settings } from './model'
import { CHECK_AREAS, SENSITIVE_PERMISSIONS, checksToReview, securityCheck, securityCheckSummary, sitesAllowedSensitive, type SecurityFacts } from './security-check'

afterEach(() => setLanguage('fr'))

const facts = (over: Partial<Settings> = {}, rest: Partial<SecurityFacts> = {}): SecurityFacts => ({ settings: { ...defaultSettings(), ...over }, sitePermissions: {}, extensions: [], ...rest })
const row = (rows: ReturnType<typeof securityCheck>, id: string) => rows.find((r) => r.id === id)

describe('the lines of the security check', () => {
  it('files every line under one of the five areas, in the order the page shows them, and gives each a sentence', () => {
    const rows = securityCheck(facts({ passwordManager: true }, { engine: { name: 'Electron', version: '45.2.1' } }))
    for (const r of rows) {
      expect(CHECK_AREAS).toContain(r.area)
      expect(r.text.length).toBeGreaterThan(10)
    }
    expect(new Set(rows.map((r) => r.area))).toEqual(new Set(CHECK_AREAS))
  })

  it('says each protection as it stands: on is in order, off is worth a look', () => {
    const on = securityCheck(facts({ blockAds: true, httpsUpgrade: true, blockThirdPartyCookies: true, stripTrackingParams: true, sendGpc: true, reduceFingerprint: true, autoUpdate: true }))
    for (const id of ['prot-blocker', 'prot-https', 'prot-cookies', 'prot-params', 'prot-gpc', 'prot-fingerprint', 'upd-auto']) expect(row(on, id)?.status, id).toBe('good')
    const off = securityCheck(facts({ blockAds: false, blockTrackers: false, httpsUpgrade: false, blockThirdPartyCookies: false, stripTrackingParams: false, sendGpc: false, reduceFingerprint: false, autoUpdate: false }))
    for (const id of ['prot-blocker', 'prot-https', 'prot-cookies', 'prot-params', 'prot-gpc', 'prot-fingerprint', 'upd-auto']) expect(row(off, id)?.status, id).toBe('check')
    expect(checksToReview(off)).toBeGreaterThanOrEqual(7)
  })

  it('says the automatic check is on, and promises no frequency: a build with no feed address makes no request at all', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      const text = row(securityCheck(facts({ autoUpdate: true })), 'upd-auto')?.text ?? ''
      expect(text, language).not.toMatch(/chaque jour|every day|daily|quotidien/i)
    }
  })

  it('names the engine that runs, only when the interface knows it', () => {
    expect(row(securityCheck(facts()), 'upd-version')).toBeUndefined()
    expect(row(securityCheck(facts({}, { engine: { name: 'Electron', version: '45.2.1' } })), 'upd-version')?.text).toBe('Moteur du navigateur\u00a0: Electron 45.2.1.')
  })

  it('counts the extensions that are on once each, and flags a folder and a pending update', () => {
    expect(row(securityCheck(facts()), 'ext-none')?.status).toBe('good')
    const extensions: SecurityFacts['extensions'] = [
      { id: 'a', enabled: true, source: 'store' },
      // The same folder extension, loaded in two profiles: one extension.
      { id: 'b', enabled: true, source: 'unpacked' },
      { id: 'b', enabled: true, source: 'unpacked' },
      { id: 'c', enabled: false, source: 'unpacked' },
      { id: 'd', enabled: true, source: 'store', update: { version: '2.0' } }
    ]
    const rows = securityCheck(facts({}, { extensions }))
    expect(row(rows, 'ext-count')?.text).toBe('3 extensions sont actives.')
    expect(row(rows, 'ext-unpacked')?.text).toContain('1 extension vient d’un dossier')
    expect(row(rows, 'ext-update')?.text).toContain('1 extension attend votre accord')
    expect(row(rows, 'ext-none')).toBeUndefined()
  })

  it('counts the sites that keep an answer, and those allowed the camera, microphone, location or screen', () => {
    const sitePermissions = {
      'https://a.example': { media: 'allow', notifications: 'allow' },
      'https://b.example': { notifications: 'allow' },
      'https://c.example': { geolocation: 'deny' },
      '*': { notifications: 'allow' }
    } as const
    expect(sitesAllowedSensitive(sitePermissions)).toBe(1)
    const rows = securityCheck(facts({}, { sitePermissions }))
    expect(row(rows, 'perm-sites')?.text).toBe('3 sites ont une autorisation mémorisée.')
    expect(row(rows, 'perm-sensitive')?.status).toBe('check')
    expect(row(securityCheck(facts()), 'perm-none')?.status).toBe('good')
    expect(row(securityCheck(facts()), 'perm-sensitive')).toBeUndefined()
    for (const permission of ['media', 'camera', 'microphone', 'geolocation', 'display-capture']) expect(SENSITIVE_PERMISSIONS.has(permission)).toBe(true)
    expect(SENSITIVE_PERMISSIONS.has('notifications')).toBe(false)
  })

  it('says whether the permissions of an unvisited site are forgotten, with the delay', () => {
    expect(row(securityCheck(facts({ forgetUnusedPermissionsDays: 90 })), 'perm-forget')).toMatchObject({ status: 'good', text: 'Les autorisations d’un site non visité depuis 90 jours sont oubliées.' })
    expect(row(securityCheck(facts({ forgetUnusedPermissionsDays: 0 })), 'perm-forget')?.status).toBe('info')
  })

  it('speaks of the vault’s lock and fingerprint only while the password manager is on', () => {
    const off = securityCheck(facts({ passwordManager: false }))
    expect(row(off, 'vault-off')?.status).toBe('info')
    expect(row(off, 'vault-lock')).toBeUndefined()
    expect(row(off, 'vault-touch')).toBeUndefined()
    const on = securityCheck(facts({ passwordManager: true, lockEnabled: true, passwordTouchIdOnFill: true }))
    expect(row(on, 'vault-off')).toBeUndefined()
    expect(row(on, 'vault-lock')?.status).toBe('good')
    expect(row(on, 'vault-touch')?.status).toBe('good')
    const bare = securityCheck(facts({ passwordManager: true, lockEnabled: false, passwordTouchIdOnFill: false }))
    expect(row(bare, 'vault-lock')?.status).toBe('check')
    expect(row(bare, 'vault-touch')?.status).toBe('info')
  })

  it('says in both languages how many lines are worth a look', () => {
    const quiet = securityCheck(facts({ blockAds: true, httpsUpgrade: true, blockThirdPartyCookies: true, stripTrackingParams: true, sendGpc: true, reduceFingerprint: true, autoUpdate: true, passwordManager: false }))
    expect(securityCheckSummary(quiet)).toBe('Rien à relire')
    const loud = securityCheck(facts({ httpsUpgrade: false, sendGpc: false }))
    expect(securityCheckSummary(loud)).toMatch(/points? à relire/)
    setLanguage('en')
    expect(securityCheckSummary(quiet)).toBe('Nothing to look at')
    expect(securityCheckSummary(securityCheck(facts({ httpsUpgrade: false, blockAds: true, blockTrackers: true, blockThirdPartyCookies: true, stripTrackingParams: true, sendGpc: true, reduceFingerprint: true, autoUpdate: true, passwordManager: false })))).toBe('1 point worth a look')
  })

  it('writes nothing: the facts it reads are not changed', () => {
    const input = facts({ passwordManager: true })
    const before = JSON.stringify(input)
    securityCheck(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
