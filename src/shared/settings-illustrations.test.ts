import { describe, expect, it } from 'vitest'
import { en } from './i18n-en'
import { fr } from './i18n-fr'
import { setLanguage } from './i18n'
import { ILLUSTRATIONS, illustrationOf, illustrationTip } from './settings-illustrations'
import { categoryOfKey, type SettingKey } from './settings-catalog'
import { placementOf } from './settings-placement'
import { frenchSpaces } from './french-typography'

/** The 16 settings estimated to be the most used, in their order. */
const R10_LIST = [
  'interfaceAppearance', 'uiScale', 'sidebarRight', 'compactMode', 'sleepAfterMinutes', 'autoArchiveHours', 'restoreWindows', 'searchSuggestions',
  'littleArcShortcut', 'blockAds', 'blockCookieBanners', 'downloadAskWhere', 'boostsEnabled', 'hoverCards', 'dragToSplit', 'peekWithShift'
]
/** The scenes drawn before that list and left out of it, kept in the code. */
const KEPT_OUTSIDE = ['tabTree', 'tabCycleRecent', 'readableMode', 'reduceFingerprint', 'tidyDownloads', 'mouseGestures']

describe('the animated cards', () => {
  it('are 22, each for a setting that has a row, once', () => {
    expect(ILLUSTRATIONS).toHaveLength(22)
    expect(new Set(ILLUSTRATIONS.map((illustration) => illustration.key)).size).toBe(22)
    for (const illustration of ILLUSTRATIONS) expect(categoryOfKey(illustration.key), illustration.key).not.toBeNull()
  })

  it('are the 16 of the list, in its order, then the six scenes it left out', () => {
    expect(ILLUSTRATIONS.map((illustration) => illustration.key)).toEqual([...R10_LIST, ...KEPT_OUTSIDE])
  })

  it('give each of the 16 its scene, and 13 of them are rows at the top of their page', () => {
    for (const key of R10_LIST) expect(illustrationOf(key)?.key, key).toBe(key)
    expect(R10_LIST.filter((key) => placementOf(key as SettingKey) === 'page')).toHaveLength(13)
    expect(R10_LIST.filter((key) => placementOf(key as SettingKey) === 'more')).toEqual(['hoverCards', 'dragToSplit', 'peekWithShift'])
  })

  it('say what they show in both languages, and keep a placeholder the same in both', () => {
    for (const illustration of ILLUSTRATIONS) {
      for (const key of [illustration.caption, ...(illustration.tip ? [illustration.tip.text] : [])]) {
        const french = (fr as Record<string, string>)[key]
        const english = (en as Record<string, string>)[key]
        expect(french, key).toBeTruthy()
        expect(english, key).toBeTruthy()
        expect(french!.match(/\{\w+\}/g) ?? [], key).toEqual(english!.match(/\{\w+\}/g) ?? [])
      }
    }
  })

  it('are found by the setting', () => {
    expect(illustrationOf('blockAds')?.caption).toBe('settings-illustrations.block-ads')
    expect(illustrationOf('autoUpdate')).toBeUndefined()
    expect(illustrationOf(undefined)).toBeUndefined()
  })

  it('name in their tip the shortcut the user has now, and no tip at all rather than a key that does nothing', () => {
    const archive = illustrationOf('autoArchiveHours')!
    setLanguage('fr')
    expect(illustrationTip(archive, {}, 'darwin')).toBe(frenchSpaces('Afficher l’archive : ⌥⌘A.'))
    expect(illustrationTip(archive, { archive: 'CmdOrCtrl+Shift+Y' }, 'darwin')).toBe(frenchSpaces('Afficher l’archive : ⇧⌘Y.'))
    expect(illustrationTip(archive, { archive: '' }, 'darwin')).toBeNull()
    expect(illustrationTip(illustrationOf('sleepAfterMinutes')!, {}, 'darwin')).toBe('Un clic sur l’onglet le recharge.')
    expect(illustrationTip(illustrationOf('blockAds')!, {}, 'darwin')).toBeNull()
    setLanguage('en')
    try {
      expect(illustrationTip(archive, {}, 'darwin')).toBe('Show the archive: ⌥⌘A.')
    } finally {
      setLanguage('fr')
    }
  })
})
