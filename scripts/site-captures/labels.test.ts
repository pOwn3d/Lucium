import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../src/shared/i18n-en'
import { fr } from '../../src/shared/i18n-fr'
import { frenchSpaces } from '../../src/shared/french-typography'
import { INTERNAL_ORIGIN } from '../../src/shared/internal-page'
import { COMMAND_GROUP, EXTENSIONS_PAGE, EXTENSIONS_SECTION, IMPORT_ROWS, NEWS_SHEET, PDF_VIEWER, READER_MENU, sameText } from './labels'

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

describe('the texts the script looks for on screen', () => {
  it('are the ones the catalogues give the rows of the import sheet', () => {
    expect(IMPORT_ROWS.html).toEqual({ fr: fr['import-sources.fichier-de-signets-html'], en: en['import-sources.fichier-de-signets-html'] })
    expect(IMPORT_ROWS.other).toEqual({ fr: fr['import-sources.autre-navigateur'], en: en['import-sources.autre-navigateur'] })
  })

  it('are the ones of the group of the commands of the command bar, in both languages', () => {
    expect(COMMAND_GROUP).toEqual({ fr: fr['cmd.groupe-commandes'], en: en['cmd.groupe-commandes'] })
  })

  it('are found on screen with the spaces French typography gives them, as the catalogue writes them', () => {
    // The command a card of the features page chooses in the command bar: drawn with a no-break space before its colon.
    const pick = fr['cmd.contraste-de-la-page-sombre-pour-ce-site']
    const shown = frenchSpaces(pick)
    expect(shown).not.toBe(pick)
    expect(sameText(shown, pick)).toBe(true)
    expect(sameText(frenchSpaces('Bloquer les publicités ?'), 'Bloquer les publicités ?')).toBe(true)
    expect(sameText(en['cmd.contraste-de-la-page-sombre-pour-ce-site'], en['cmd.contraste-de-la-page-sombre-pour-ce-site'])).toBe(true)
    // Another line is still another line.
    expect(sameText(frenchSpaces(fr['cmd.contraste-de-la-page-clair-pour-ce-site']), pick)).toBe(false)
  })

  it('know the sheet of the news: its list, the title of a point, and « Voir tout » apart from the two other buttons of its foot', () => {
    const sheet = source('src/renderer/WhatsNewSheet.tsx')
    const classes = (selector: string) => [...selector.replace(/:not\([^)]*\)/g, '').matchAll(/\.([\w-]+)/g)].map((match) => match[1] ?? '')
    for (const name of [...classes(NEWS_SHEET.list), ...classes(NEWS_SHEET.all)]) expect(sheet, name).toMatch(new RegExp(`className="(?:[^"]* )?${name}(?: [^"]*)?"`))
    expect(sheet).toContain(`<${NEWS_SHEET.title}>{point.title}</${NEWS_SHEET.title}>`)
    // « Voir tout » is the plain button; « Fermer » and « Ne plus montrer » carry the classes the selector leaves out.
    expect(sheet).toMatch(/className="button" onClick=\{\(\) => setAll\(true\)\}/)
    expect(sheet).toContain('className="button primary" onClick={onClose}')
    expect(sheet).toContain('className="button news-never" onClick={onNever}')
    expect(NEWS_SHEET.all).toContain(':not(.primary):not(.news-never)')
  })

  it('are the ones of the item of the menu that opens the reader mode, in both languages', () => {
    expect(READER_MENU).toEqual([fr['menu.mode-lecture'], en['menu.mode-lecture']])
  })

  it('are the ones of the section of the extensions of the site panel and of the Extensions page', () => {
    expect(EXTENSIONS_SECTION).toEqual({ fr: fr['settings.extensions'], en: en['settings.extensions'] })
    expect(source('src/shared/site-sections.ts')).toContain("return t('settings.extensions')")
    expect(EXTENSIONS_PAGE).toBe(`${INTERNAL_ORIGIN}/`)
  })

  it('know the address of the PDF viewer of the engine', () => {
    // The engine reads it from the one definition (shared/pdf-viewer.ts) it shares with the forced dark mode.
    expect(source('src/shared/pdf-viewer.ts')).toContain(PDF_VIEWER)
    expect(source('src/main/engine/electron-page-navigation.ts')).toContain('isPdfViewerUrl')
  })
})
