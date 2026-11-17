import { describe, expect, it } from 'vitest'
import { APP_ICONS, DEFAULT_APP_ICON, bundleIconStep, isAppIconId, normalizeAppIcon } from './icons'
import { setLanguage } from './i18n'
import { defaultSettings } from './model'

describe('application icons', () => {
  it('offers the eight colours of the fan logo, the default one (Clair) first, with distinct ids and labels', () => {
    expect(APP_ICONS).toHaveLength(8)
    expect(new Set(APP_ICONS.map((i) => i.id)).size).toBe(8)
    expect(new Set(APP_ICONS.map((i) => i.label)).size).toBe(8)
    expect(APP_ICONS[0]!.id).toBe(DEFAULT_APP_ICON)
    expect(DEFAULT_APP_ICON).toBe('clair')
  })

  it('labels Clair, and Boréal, which keeps the id `lucium` it had before the fan logo, in both languages', () => {
    const labels = () => Object.fromEntries(APP_ICONS.map((i) => [i.id, i.label]))
    setLanguage('fr')
    expect(labels()).toMatchObject({ clair: 'Clair', boreal: 'Boréal' })
    setLanguage('en')
    expect(labels()).toMatchObject({ clair: 'Light', boreal: 'Boreal' })
    setLanguage('fr')
  })

  it('starts a new profile on the default icon, and Boréal is chosen by the id `boreal`', () => {
    expect(defaultSettings().appIcon).toBe(DEFAULT_APP_ICON)
    expect(isAppIconId('boreal')).toBe(true)
    expect(normalizeAppIcon('boreal')).toBe('boreal')
  })

  it('knows its ids and nothing else', () => {
    expect(isAppIconId('cyber')).toBe(true)
    expect(isAppIconId('corail')).toBe(false)
    expect(isAppIconId('inconnu')).toBe(false)
    expect(isAppIconId(3)).toBe(false)
    expect(isAppIconId('__proto__')).toBe(false)
  })

  it('keeps a known id, and gives the nearest icon to an id of a former set of icons', () => {
    expect(normalizeAppIcon('abysse')).toBe('abysse')
    expect(normalizeAppIcon('sepia-or')).toBe('sepia-or')
    // The colours of the second set.
    expect(normalizeAppIcon('corail')).toBe('solaire')
    expect(normalizeAppIcon('ambre')).toBe('sepia-or')
    expect(normalizeAppIcon('menthe')).toBe(DEFAULT_APP_ICON)
    expect(normalizeAppIcon('ocean')).toBe('crepuscule')
    expect(normalizeAppIcon('orchidee')).toBe('nebula')
    expect(normalizeAppIcon('graphite')).toBe('cyber')
    // The names of the first one.
    expect(normalizeAppIcon('braise')).toBe('solaire')
    expect(normalizeAppIcon('nuit')).toBe('cyber')
    expect(normalizeAppIcon('bonbon')).toBe('nebula')
  })

  it('maps every id of a former set to an icon that exists, so that nothing a user chose is lost', () => {
    for (const former of ['corail', 'ambre', 'menthe', 'ocean', 'orchidee', 'graphite', 'braise', 'nuit', 'bonbon']) expect(isAppIconId(normalizeAppIcon(former)), former).toBe(true)
  })

  it('falls back to the default icon for anything it does not know, including names of Object.prototype', () => {
    for (const bad of ['papier', 'inconnu', '', 'toString', '__proto__', 'constructor', 3, null, undefined, {}]) expect(normalizeAppIcon(bad), String(bad)).toBe(DEFAULT_APP_ICON)
  })
})

describe('the custom icon of the application bundle', () => {
  it('puts a chosen icon other than the default one on the bundle, unless the bundle already carries that very icon', () => {
    expect(bundleIconStep('sepia-or', { custom: false, posed: null })).toBe('set')
    expect(bundleIconStep('sepia-or', { custom: true, posed: 'sepia-or' })).toBe('none')
    // Another icon was put, or it is not known which one the bundle carries (a copy moved, a record lost): put again.
    expect(bundleIconStep('sepia-or', { custom: true, posed: 'cyber' })).toBe('set')
    expect(bundleIconStep('sepia-or', { custom: true, posed: null })).toBe('set')
    // The record says it was put, but the bundle lost it (a new version replaced it): put again.
    expect(bundleIconStep('sepia-or', { custom: false, posed: 'sepia-or' })).toBe('set')
  })

  it('never puts the default icon on the bundle, which is its own, and takes off what is there when it is chosen', () => {
    expect(bundleIconStep(DEFAULT_APP_ICON, { custom: true, posed: 'cyber' })).toBe('clear')
    expect(bundleIconStep(DEFAULT_APP_ICON, { custom: true, posed: null })).toBe('clear')
    expect(bundleIconStep(DEFAULT_APP_ICON, { custom: false, posed: null })).toBe('none')
    expect(bundleIconStep(DEFAULT_APP_ICON, { custom: false, posed: 'cyber' })).toBe('none')
  })

  it('takes an id that is not one of the list for the default icon: nothing made of it is ever put on the bundle', () => {
    for (const bad of ['inconnu', '../../../../etc/passwd', '/tmp/picture', '', '__proto__']) {
      expect(bundleIconStep(bad, { custom: false, posed: null }), bad).toBe('none')
      expect(bundleIconStep(bad, { custom: true, posed: bad }), bad).toBe('clear')
    }
  })
})
