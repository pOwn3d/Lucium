// The scan of the code outside the panels of `src/renderer`: the main process (menus, dialogs, notifications, error messages it sends), the shared
// code (messages built for both processes, default names, tables of labels), the preload scripts and the folders of `src/renderer`. A text written
// there in French, instead of being looked up in the catalogues, shows in French whatever the language chosen.
//
// Read by the test that keeps the code clean (code-text-source.test.ts) and by the census (`pnpm census:textes --code`), so that both read the same
// files and leave the same things alone. The files of `src/renderer` itself are panel-text-source.test.ts' and settings-text-source.test.ts'.
//
// What counts: in a `.ts` file, a string or a template that reads as French (an accent, or a word only French uses: settings-text-scan.ts); in a
// `.tsx` file, any text between tags or given to an attribute someone reads, whatever its language, and the French strings. A message for the
// journal (`console.*`) is the developer's, not the person's, and the scan does not read it. What remains is either converted (`t('zone.texte')`)
// or one of the exceptions below, each with its reason.
//
// What the scan does not see, so that a green test is not read as more than it says:
//   - in a `.ts` file, a text that does not read as French: an English label ("Cancel"), or a French word that has no accent and is not in the list of
//     settings-text-scan.ts (the list grows when one is found: « Taille » was one);
//   - a string that is compared, a key of an object, an argument of `console.*`;
//   - the message of an `Error` written in English: it is the developer's, but a caller that shows `error.message` to the person shows it as it is;
//   - the files and declarations listed below, and what is outside `src/`: the Swift helpers of `native/` (the words of the Touch ID prompt are compared
//     to the languages by vault-keychain-native.test.ts), the scripts, `electron-builder.yml` (the reason macOS shows when it asks for the local network
//     is written there, in French only) and the stylesheets.
// A folder added to `src/renderer` is not read until it is in `CODE_ROOTS`: code-text-source.test.ts fails until then.

// Only types are imported from the scanner: the census loads this file with Node's own type stripping, which resolves no import without its extension.
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Finding } from './settings-text-scan'

/** The folders the scan reads, from the root of the repository. */
export const CODE_ROOTS: readonly string[] = ['src/main', 'src/shared', 'src/preload', 'src/renderer/components', 'src/renderer/templates']

/** Whole files no person reads a word of, with the reason. A string names one file; a pattern names a family of them. */
export const SKIPPED_FILES: ReadonlyArray<readonly [file: string | RegExp, why: string]> = [
  ['src/shared/i18n-fr.ts', 'the French catalogue: where the texts go'],
  ['src/shared/i18n-en.ts', 'the English catalogue: where the texts go'],
  ['src/main/settings-text-scan.ts', 'the French words the scan looks for'],
  ['src/main/code-text-scan.ts', 'this list: its reasons quote the French they leave alone'],
  [/^src\/main\/smoke[\w-]*\.ts$/, 'the engine tests (pnpm test:engine): their pages, titles and texts are fixtures'],
  ['src/main/electron-watch.ts', 'the report of scripts/electron-watch.mjs, read by the maintainer in a terminal'],
  ['src/main/ecs-checksum.ts', 'the refusals of the step ecs of scripts/electron-upgrade.mjs, read by the maintainer in a terminal'],
  ['src/main/passkey-probe.ts', 'the page of scripts/passkey-probe.mjs, a measuring tool the maintainer opens in a build and reads in French: it is not part of the application'],
  ['src/main/chromium-watch-issue.ts', 'the GitHub issue of scripts/chromium-watch-issue.mjs and its errors, read by the maintainer on GitHub and in the log of the workflow'],
  ['src/shared/perf-core.ts', 'the report of pnpm perf (scripts/perf.mjs), read by the maintainer in a terminal'],
  ['src/shared/perf-features.ts', 'the features the measure of pnpm perf switches (smoke-perf.ts)'],
  ['src/shared/bench-core.ts', 'the report of the comparison bench (scripts/compare-browsers.mjs)'],
  ['src/shared/bench-pages.ts', 'the pages the comparison bench serves to the browsers it measures'],
  ['src/shared/fake-fill.ts', 'the fake identities « Remplir avec de fausses données » writes into a form: data typed into a page, not words of the interface'],
  ['src/renderer/templates/TemplatesDemo.tsx', 'the sample of the templates, drawn by templates.test.ts only']
]

/** Top-level declarations whose strings are not texts, with the reason: `[file, name of the const / function / class, why]`. */
export const KEPT_DECLARATIONS: ReadonlyArray<readonly [file: string, declaration: string, why: string]> = [
  ['src/main/helper-signature.ts', 'helperRequirement', 'a code requirement in the language of codesign, checked by macOS'],
  ['src/main/shell/menu-icons-data.ts', 'MENU_ICON_PNG', 'the pictures of the menu icons, in base64'],
  ['src/shared/features.ts', 'NOT_OPTIONAL_SETTINGS', 'why a boolean setting is not a feature: read by the developer in a failure of features.test.ts'],
  ['src/main/public-export.ts', 'INTERNAL_PATHS', 'paths of the repository that stay out of the public tree: names of folders, not texts of the interface'],
  ['src/main/public-export.ts', 'INVENTED_HOMES', 'the home folders the tests invent, some with a French name: read by a rule, never shown'],
  ['src/main/public-export.ts', 'FORMER_NAME', 'a part of the pattern that finds the former name of the project, with its accented spelling'],
  ['src/shared/settings-catalog.ts', 'NO_CONTROL_KEYS', 'why a setting has no row, for the developer (it names the rows in French, as the code does)'],
  ['src/shared/settings-catalog.ts', 'KEPT_ON_RESET', 'why a setting survives « Tout réinitialiser », for the developer'],
  ['src/shared/settings-guide.ts', 'GUIDE_QUESTIONS', 'the identifiers of the answers (`oui`, `rien`, `jamais`): every text of a question is a key of the catalogue, by its type'],
  ['src/shared/settings-presets.ts', 'PRESETS', 'the identifiers of the presets, of the questions and of the answers they are made of (`liens`, `rien`): every text is a key of the catalogue, by its type'],
  ['src/shared/space-emoji.ts', 'ROWS', 'the words an emoji is found by, in English and in French on purpose: a search in either language finds it'],
  ['src/shared/space-emoji.ts', 'FLAG_REGIONS', 'the codes of the regions that have a flag'],
  ['src/shared/space-emoji.ts', 'SINGLE', 'the source of a regular expression'],
  ['src/shared/translate-local.ts', 'STOP_WORDS', 'the common words a language is recognised by, in that language'],
  ['src/shared/settings-search.ts', 'STOP_WORDS', 'the common words of French and English that the search of the Settings leaves out of a query: compared with what is typed, never shown'],
  ['src/shared/discover.ts', 'DISCOVER_ENTRIES', 'the words a card of « Découvrir Lucium » is found by, in French and in English on purpose (folded, no accent): compared with what is typed, never shown; the name, the line and the place of a card are keys of the catalogue, by their type'],
  ['src/shared/discover.ts', 'DISCOVER_EXTRAS', 'the same words for the cards of the functions that have no switch: compared with what is typed, never shown'],
  ['src/shared/settings-answers.ts', 'SETTINGS_ANSWERS', 'the words that name an answer of the search of the Settings, folded, in French and in English: compared with what is typed, never shown (each sentence is a key of the catalogues)'],
  ['src/shared/shortcut-view.ts', 'SEARCH_EXAMPLES', 'the example of the shortcut search, written once per language (each names a shortcut that exists in that language)'],
  ['src/main/drm-fuse-trial.ts', 'fuseTrial', 'the product and data names of a trial build the maintainer makes to test one fuse of the DRM variant'],
  ['src/shared/tab-grouping.ts', 'COUNTRY_SECOND_LEVEL', 'second-level domains (`ne`, `co`): parts of addresses'],
  ['src/shared/boost.ts', 'BOOST_FONTS', 'font families and their names (Gill Sans, Comic Sans MS): names of typefaces, the same in every language'],
  ['src/shared/reader-pill.ts', 'READER_PILL_STYLE', 'a stylesheet'],
  ['src/shared/i18n.ts', 'LANGUAGE_NAMES', 'each language named in its own words, as the choice of a language must show it'],
  ['src/shared/little-name.ts', 'LITTLE_NAME', 'the noun of the small window, one entry per language: the two catalogues build every sentence that names it from these words (littleForms)'],
  [
    'src/shared/summary-prompt.ts',
    'summaryPrompt',
    'the instruction sent to the summary model, never shown: one per language of the interface, so that the summary is written in that language'
  ],
  ['src/shared/summary-prompt.ts', 'LENGTH_INSTRUCTION', 'the part of that instruction that says how long the summary is, in each language of the interface'],
  ['src/shared/blank-tabs.ts', 'openedBlankTabsToClose', 'the reason of a closing, written to the journal by blank-tab-watch.ts'],
  ['src/shared/profiles.ts', 'newProfileId', 'the identifier given to a profile whose name has no letter'],
  ['src/shared/containers.ts', 'newContainerId', 'the identifier given to a container whose name has no letter'],
  ['src/shared/model-defaults.ts', 'DEFAULT_SITE_SEARCHES', '« Wikipédia » is the name of the service the keyword searches (fr.wikipedia.org)'],
  ['src/main/blocking/index.ts', 'offline', 'the failure of every download of a filter list during the engine test (--smoke) and the end-to-end tests (LUCIUM_E2E=1), which must never reach the Internet: only those tests see it'],
  ['src/main/verify-app.ts', 'OFFICIAL_TEAM_ID', 'the identifier Apple gives the developer team that signs the official builds: ten letters and digits, not a word of the interface'],
  ['src/shared/userscript.ts', 'SENSITIVE_SEGMENTS','segments of addresses that name a sign-in page (`/connexion` on French sites): words of URLs, not of the interface']
]

/** Single texts that are not words of the interface, with the reason: `[file, text or pattern, why]`. */
export const KEPT_TEXTS: ReadonlyArray<readonly [file: string, text: string | RegExp, why: string]> = [
  ['src/main/shell/blank-tab-watch.ts', 'création, vide', 'the reason of a closing, written to the journal'],
  ['src/main/shell/quit-flow.ts', '(délai dépassé)', 'what stands for the sites not erased when the erasure at quit outlasts its delay: only written to the journal'],
  ['src/main/shell/password-ipc.ts', /^lucium-mots-de-passe\./, 'the name of the file the export proposes'],
  ['src/main/persist.ts', /^….avant-restauration-…$/, 'the name of the copy of the data kept before a restore'],
  ['src/shared/icons.ts', 'clair', 'the id of the default application icon, also the name of its file (resources/app-icons/clair.png): its label is the catalogue’s (`icons.clair`)'],
  ['src/shared/model-defaults.ts', 'clair', 'the id of the default application icon, the value `appIcon` starts with (a test keeps it equal to DEFAULT_APP_ICON of icons.ts)'],
  ['src/shared/file-names.ts', 'téléchargement', 'the name of a downloaded file when the address gives none'],
  ['src/shared/reader-pill.ts', 'sans', 'the identifier of the sans-serif face of the reader'],
  ['src/shared/theme-presets.ts', /^(Catppuccin Frappé|Rosé Pine( Moon| Dawn)?)$/, 'names of palettes: proper names, the same in every language']
]

/**
 * The files not converted yet, with the reason. A file leaves this list when the scan finds nothing in it (code-text-source.test.ts fails for a file
 * of the list that is clean, so that the list does not outlive its work).
 */
export const PENDING_CODE_FILES: Readonly<Record<string, string>> = {}

const isScanned = (name: string): boolean => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')

export const isSkipped = (file: string): boolean => SKIPPED_FILES.some(([match]) => (typeof match === 'string' ? match === file : match.test(file)))

/** Every file the scan reads, from the root of the repository, with `/` as separator, sorted. The skipped files are left out. */
export function codeFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (isScanned(entry.name)) files.push(relative(root, path).split('\\').join('/'))
    }
  }
  for (const folder of CODE_ROOTS) walk(join(root, folder))
  return files.filter((file) => !isSkipped(file)).sort()
}

/** Whether a finding counts: in a `.tsx` file any text between tags or in a read attribute; anywhere, a string that reads as French. */
export const counts = (finding: Finding): boolean => finding.french || (finding.file.endsWith('.tsx') && finding.kind !== 'string')

const matches = (match: string | RegExp, text: string): boolean => (typeof match === 'string' ? match === text : match.test(text))

/** The exception that leaves a finding alone, if any. */
export function exceptionOf(finding: Finding): readonly [file: string, what: string | RegExp, why: string] | undefined {
  return (
    KEPT_DECLARATIONS.find(([file, declaration]) => file === finding.file && declaration === finding.declaration) ??
    KEPT_TEXTS.find(([file, text]) => file === finding.file && matches(text, finding.text))
  )
}
