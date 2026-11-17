import { describe, expect, it } from 'vitest'
import { setLanguage, t } from '../../src/shared/i18n'
import { CATEGORY_LABELS, importSource, previewSummary } from '../../src/shared/import-sources'
import { OTHER_BROWSER_NAMES, browserNamesIn, namesShown } from './names'
import { LANGS } from './shots'

describe('the names of other browsers', () => {
  it('are found as whole words, whatever their case, each once', () => {
    expect(browserNamesIn('Reprendre de Safari : signets.')).toEqual(['Safari'])
    expect(browserNamesIn('Importer depuis ARC, puis depuis arc')).toEqual(['ARC', 'arc'])
    expect(browserNamesIn('Navigateur basé sur Chromium et Google Chrome')).toEqual(['Chromium', 'Google', 'Chrome'])
    expect(browserNamesIn('Tor Browser')).toEqual(['Tor Browser'])
  })

  it('are not found inside another word, nor in the generic labels of the application', () => {
    expect(browserNamesIn('Marché, arcade, Edgeworth, zénith, Diane, Chromiumesque')).toEqual([])
    // A name at the end of a longer word is not one either.
    expect(browserNamesIn('Monarc, Hedge, Kaizen, Médiadia')).toEqual([])
    expect(browserNamesIn('Navigateur de macOS · Fichier de signets (HTML) · Lucium · Mac')).toEqual([])
  })

  it('hold the browsers the import knows', () => {
    for (const name of ['Arc', 'Chrome', 'Safari', 'Firefox', 'Brave', 'Edge', 'Vivaldi', 'Chromium', 'Zen', 'LibreWolf', 'Waterfox', 'Floorp']) expect(OTHER_BROWSER_NAMES).toContain(name)
  })
})

describe('the names an image of the features page shows', () => {
  it('include the identifiers of the API of the extensions and the name of their store: the site shows neither', () => {
    expect(namesShown('Pour les extensions qui regroupent des onglets (chrome.tabGroups).')).toEqual(['chrome'])
    expect(namesShown('For extensions that declare a keyword (chrome.omnibox), in the Space shown.')).toEqual(['chrome'])
    expect(namesShown('Autoriser l’installation d’extensions depuis le Chrome Web Store')).toEqual(['Chrome'])
    expect(namesShown('Chromium décide seul ; Google Chrome')).toEqual(['Chromium', 'Google', 'Chrome'])
  })

  it('leave out the ordinary words in lower case, but not the same word written as a name, or as an address', () => {
    expect(namesShown('the bottom edge of the page, the window’s edges, un arc qui tourne, zen')).toEqual([])
    expect(namesShown('Import from Edge or Arc, then arc://extensions')).toEqual(['Edge', 'Arc', 'arc'])
  })
})

describe('the texts of the import the shots show', () => {
  it('name no browser: the bookmarks file, the browser of macOS under its generic label, what is brought and the preview', () => {
    for (const lang of LANGS) {
      setLanguage(lang)
      const html = importSource('html')!
      const macos = importSource('safari')!
      const texts = [
        t('import-sheet.importer-depuis-votre-ancien-navigateur'),
        t('import-sheet.intro'),
        html.name,
        html.blurb(html.name),
        // Without the name of its application (LUCIUM_IMPORT_APP_FOLDERS empty), the browser of macOS keeps its generic label.
        macos.name,
        macos.blurb(macos.name),
        CATEGORY_LABELS.bookmarks,
        CATEGORY_LABELS.history,
        previewSummary(html.name, { bookmarks: 12, folders: 3, history: 0, skipped: 0 }, ['bookmarks']),
        t('import.nouvel-espace-signets', { name: t('import.signets-importes') }),
        t('import-sheet.rien-n-est-encore-importe-confirmez-pour-l'),
        t('first-launch.etape-1-intro'),
        t('first-launch.commencer-vide'),
        t('first-launch.commencer-vide-aide')
      ]
      expect(browserNamesIn(texts.join('\n')), lang).toEqual([])
    }
    setLanguage('fr')
  })

  it('name a browser in the help of « Autre navigateur »: the reason why its row leaves the image of the import sheet', () => {
    for (const lang of LANGS) {
      setLanguage(lang)
      const other = importSource('other')!
      expect(browserNamesIn(other.blurb(other.name))).toContain('Chromium')
    }
    setLanguage('fr')
  })
})
