// The security check rendered to markup (no window): the lines it was given, area by area, with where each is set, and nothing on it that writes.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { defaultSettings } from '@shared/model'
import { SecurityCheck } from './SecurityCheck'

const snapshot = (settings: Partial<ReturnType<typeof defaultSettings>> = {}, extensions: UiSnapshot['extensions'] = []): UiSnapshot =>
  ({ state: { settings: { ...defaultSettings(), ...settings }, sitePermissions: { 'https://a.example': { media: 'allow' } } }, extensions, engine: { name: 'Electron', version: '45.2.1', chromium: '150.0' } }) as unknown as UiSnapshot

const render = (over: Parameters<typeof snapshot>[0] = {}, extensions: UiSnapshot['extensions'] = []): string => renderToStaticMarkup(createElement(SecurityCheck, { snapshot: snapshot(over, extensions) }))

beforeEach(() => vi.stubGlobal('window', { lucium: {} }))
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('the security check page', () => {
  it('draws the five areas in order, each with its lines and the status of each', () => {
    const html = render({ passwordManager: true }, [{ id: 'x', name: 'X', version: '1', profileId: 'default', source: 'unpacked', enabled: true }])
    const at = ['Extensions', 'Autorisations des sites', 'Protection', 'Mises à jour', 'Coffre de mots de passe'].map((title) => html.indexOf(`>${title}<`))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).toContain('1 extension vient d’un dossier')
    expect(html).toContain('1 site peut utiliser la caméra')
    expect(html).toContain('check-status check')
    expect(html).toContain('À relire')
    expect(html).toContain('Moteur du navigateur')
  })

  it('says where a line is set, with the path of the window', () => {
    expect(render({ httpsUpgrade: false })).toMatch(/Où le régler.{1,3}Réglages › Vie privée et sécurité</)
  })

  it('leaves out an area that has nothing to say (no vault line while the password manager is off is still a line: it says it is off)', () => {
    expect(render({ passwordManager: false })).toContain('Le gestionnaire de mots de passe est désactivé.')
  })

  it('is read-only: no switch, no button, no field', () => {
    const html = render({ passwordManager: true })
    expect(html).not.toMatch(/<(button|input|select|textarea)/)
  })

  it('speaks English in an English interface', () => {
    setLanguage('en')
    const html = render()
    expect(html).toContain('Site permissions')
    expect(html).toContain('Worth a look')
  })
})
