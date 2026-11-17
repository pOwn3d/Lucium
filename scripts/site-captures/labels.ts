// The texts and addresses of the application that scripts/site-captures.mjs looks for on screen, which it cannot read from the sources (Node's
// type stripping does not resolve the aliases of the application): labels.test.ts checks each one against the catalogues and the code it copies.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

import type { Localized } from './shots'

/** The rows of the import sheet the shots use (src/shared/i18n-*.ts, `import-sources.*`): the bookmarks file, and the row that leaves the image. */
export const IMPORT_ROWS: Readonly<Record<'html' | 'other', Localized<string>>> = {
  html: { fr: 'Fichier de signets (HTML)', en: 'Bookmarks file (HTML)' },
  other: { fr: 'Autre navigateur', en: 'Other browser' }
}

/** The group of the command bar that lists its commands (`cmd.groupe-commandes`): a scene of features.ts chooses its first line, not the web search. */
export const COMMAND_GROUP: Localized<string> = { fr: 'Commandes', en: 'Commands' }

/**
 * Whether a text on screen is the text of the catalogue looked for. The French catalogue is written with ordinary spaces, and the interface puts
 * the non-breaking ones of French typography where they belong when it reads it (src/shared/french-typography.ts: « Contraste de la page : … »
 * is drawn with a no-break space before the colon): both are compared with ordinary spaces.
 */
export const sameText = (shown: string, wanted: string): boolean => shown.replace(/[\u00a0\u202f]/g, ' ') === wanted.replace(/[\u00a0\u202f]/g, ' ')

/**
 * The sheet of the news (src/renderer/WhatsNewSheet.tsx): its list of points, the title of a point, and « Voir tout », the one button of its foot
 * that is neither the main one (« Fermer ») nor « Ne plus montrer ».
 */
export const NEWS_SHEET = {
  list: '.card.news .news-points',
  title: 'b',
  all: '.card.news .row.end .button:not(.primary):not(.news-never)'
} as const

/** The item of the menu Affichage that opens the reader mode (`menu.mode-lecture`), in both languages: the menu is in the language of the run. */
export const READER_MENU: readonly string[] = ['Mode lecture', 'Reader Mode']

/** The page of the PDF viewer of the engine, embedded in a tab that shows a PDF (src/main/engine/electron-page-navigation.ts). */
export const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'
