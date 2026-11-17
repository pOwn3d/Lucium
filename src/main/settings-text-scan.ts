// A scan of the source of the Settings panes (`src/renderer/*Settings.tsx`, SettingsWindow.tsx, ...) for text that is written in the code instead of
// being looked up in the catalogues: a visible text in French that does not go through `t('…')` shows in French whatever the language chosen.
//
// Read by the census script (scripts/census-textes-reglages.mjs, which prints the list) and by the test that keeps the panes clean
// (settings-text-source.test.ts). The parser is the one Vite ships (`parseAst`, ESTree with JSX and TypeScript): comments are not in the tree,
// so they are never reported.

import { parseAst } from 'vite'

/** The files of `src/renderer` that draw the Settings window and its panes: `*Settings.tsx`, the window itself and its shared parts. */
export const isPaneFile = (name: string): boolean =>
  /Settings\.tsx$/.test(name) || ['SettingsWindow.tsx', 'SettingsCategories.tsx', 'SettingIllustration.tsx', 'settings-parts.tsx', 'SettingsShortcuts.tsx', 'SettingsProfiles.tsx'].includes(name)

/**
 * The files of the panes not converted yet, so not checked by the test: none since the Profiles pane and the Shortcuts one were. A file leaves this list when the census finds nothing in it.
 */
export const PENDING_PANE_FILES: readonly string[] = []

/** What a finding is: text between tags, a string given to a JSX attribute, or a string / template anywhere else in the code. */
export type FindingKind = 'jsx-text' | 'attribute' | 'string'

export interface Finding {
  file: string
  line: number
  column: number
  kind: FindingKind
  /** The attribute's name, for the findings of kind "attribute". */
  attribute?: string
  /** The text, with its runs of spaces collapsed. */
  text: string
  /** The text as the page shows it (JSX white space applied, nothing else touched: a no-break space stays one). */
  value: string
  /** Where the node is in the source (offsets), for a tool that rewrites it. */
  start: number
  end: number
  /** The string is the whole value of a JSX attribute (`title="…"`), so that `title={t(…)}` replaces it. */
  direct: boolean
  /** The string has `${…}` holes (its text then has "…" in their place). */
  templated: boolean
  /** The node is outside every function: evaluated once when the module loads, before the language is known. */
  atModuleLevel: boolean
  /** The text between tags has other children beside it (`Texte <code>x</code> suite`): it is a piece of a sentence. */
  mixed: boolean
  /** The text carries a mark of French: an accented letter, or a word that only French uses. */
  french: boolean
  /** The name of the top-level declaration that holds the node (`const FONTS = …`, `function notice() {…}`), when it has one: an exception can name it. */
  declaration?: string
}

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

/** Attributes whose value is read by someone (shown, announced or offered as a tooltip): a string given to them is a text of the interface. */
export const TEXT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'title',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-placeholder',
  'placeholder',
  'alt',
  'label',
  'hint',
  'info',
  'footnote',
  'summary',
  'text',
  'message',
  'caption',
  'description',
  'tooltip',
  'heading',
  'subtitle',
  'empty'
])

/** The elements that show code or a key, never a sentence: what is written between their tags is not translated. */
const CODE_ELEMENTS: ReadonlySet<string> = new Set(['code', 'kbd', 'samp', 'pre'])

/** The functions whose arguments are keys of the catalogues (or a language), not texts. */
const TRANSLATE_CALLEES: ReadonlySet<string> = new Set(['t', 'tp', 'tIn'])

/** The objects whose methods write to the developer's journal (`console.error('[x] …')`): what they are given is read by a developer, not by the person. */
const JOURNAL_CALLEES: ReadonlySet<string> = new Set(['console'])

const ACCENTED = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/

/**
 * Words of French that English does not use (nor a code identifier): found in a text, they say it is French even when it carries no accent.
 * Words both languages use ("a", "on", "me", "son") are left out on purpose; those that are in the list but common in the settings in English too are
 * in SHARED_WORDS below.
 */
const FRENCH_WORDS: ReadonlySet<string> = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'et', 'ou', 'où', 'pour', 'dans', 'avec', 'sans', 'sur', 'sous', 'par', 'est', 'sont', 'ce', 'cet', 'cette', 'ces',
  'vos', 'votre', 'vous', 'nous', 'notre', 'nos', 'leur', 'leurs', 'aucun', 'aucune', 'pas', 'plus', 'moins', 'qui', 'que', 'quand', 'si', 'mais', 'donc',
  'au', 'aux', 'ne', 'se', 'sa', 'ses', 'ils', 'elle', 'elles', 'chaque', 'tous', 'toutes', 'tout', 'toute', 'seul', 'seuls', 'seule', 'seules', 'afin', 'lors',
  'puis', 'ensuite', 'avant', 'après', 'depuis', 'jusqu', 'entre', 'vers', 'chez', 'comme', 'aussi', 'encore', 'déjà', 'jamais', 'toujours', 'souvent',
  'peut', 'peuvent', 'doit', 'doivent', 'fait', 'faire', 'être', 'avoir', 'ouvre', 'ouvrir', 'ferme', 'fermer', 'garde', 'demande', 'reste', 'restent',
  'ajouter', 'retirer', 'supprimer', 'annuler', 'enregistrer', 'appliquer', 'valider', 'choisir', 'choisissez', 'activer', 'désactiver', 'activé', 'désactivé',
  'rechercher', 'recherche', 'afficher', 'masquer', 'exporter', 'importer', 'effacer', 'vider', 'copier', 'coller', 'modifier', 'renommer', 'nouveau', 'nouvelle',
  'onglet', 'onglets', 'fenêtre', 'fenêtres', 'barre', 'espace', 'espaces', 'page', 'pages', 'site', 'sites', 'fichier', 'fichiers', 'dossier', 'dossiers',
  'mot', 'mots', 'passe', 'oui', 'non', 'défaut', 'réglage', 'réglages', 'paramètre', 'paramètres', 'navigateur', 'téléchargement', 'téléchargements',
  'extension', 'extensions', 'profil', 'profils', 'minutes', 'heure', 'heures', 'jour', 'jours', 'seconde', 'secondes', 'fois', 'rien', 'autre', 'autres',
  'même', 'très', 'bien', 'sinon', 'ainsi', 'cela', 'celui', 'celle', 'ceux', 'celles', 'ici', 'là', 'voici', 'voir', 'sombre', 'clair',
  // Short labels the words above missed (« Page suivante », « Motif trop long », « Nom de conteneur invalide. », « Signet · … »).
  'suivant', 'suivante', 'trop', 'motif', 'gros', 'connexion', 'couleur', 'couleurs', 'harmonie', 'apparence', 'casse', 'feuille', 'nom', 'conteneur',
  'invalide', 'valide', 'nettoyer', 'utilisateur', 'utilisateurs', 'signet', 'signets', 'historique', 'essai', 'commande', 'commandes',
  // Labels of one word with no accent, which nothing above saw: « Taille » stood in the code of a button for months.
  'taille', 'imprimer', 'quitter', 'partager', 'envoyer', 'recharger', 'actualiser', 'continuer', 'terminer', 'chercher', 'trier', 'lien', 'liens', 'adresse',
  'titre', 'texte', 'erreur', 'erreurs', 'introuvable', 'inconnu', 'inconnue', 'vide', 'largeur', 'hauteur', 'haut', 'bas', 'gauche', 'droite'
])

/** A word French and English both use in the settings ("extension", "page", "site", "profil" ...) says nothing alone: it needs a French word beside it. */
const SHARED_WORDS: ReadonlySet<string> = new Set(['extension', 'extensions', 'page', 'pages', 'site', 'sites', 'minutes', 'non', 'si', 'ici', 'tout', 'plus', 'pas', 'même', 'bien', 'voir', 'fait', 'garde', 'recherche', 'demande', 'reste', 'passe', 'espace', 'espaces'])

/** The words of a text, lower-cased (apostrophes of both kinds split "l'adresse" into "l" and "adresse"). */
function wordsOf(text: string): string[] {
  // `sans-serif` is the name of a family of CSS fonts, not the French « sans ».
  return (text.toLowerCase().replace(/\bsans-serif\b/g, ' ').match(/[a-zàâäçéèêëîïôöùûüÿœæ]+/g) ?? []).filter((word) => word.length > 0)
}

/** Whether a text is French: it has an accented letter, or a word of the French list (a lone word of the shared ones does not count). */
export function looksFrench(text: string): boolean {
  if (ACCENTED.test(text)) return true
  // French quotes, spaced the French way (« … »): English quotes with “ ”. A lone » is a glyph (the button of the extensions bar), not a quote.
  if (/«\s|\s»/.test(text)) return true
  const words = wordsOf(text)
  const french = words.filter((word) => FRENCH_WORDS.has(word))
  if (french.length === 0) return false
  if (words.length === 1) return !SHARED_WORDS.has(words[0]!)
  return french.some((word) => !SHARED_WORDS.has(word))
}

/**
 * Whether a string of the code reads as a label or a sentence (a capital, then lower-case letters): "Standard", "Changer", "Export impossible : …".
 * A string of the code that is only an identifier, a key name or a code (`NFKC`, `dialog-actions`) does not.
 */
export function looksLikeLabel(text: string): boolean {
  return /^[«"“(]?\p{Lu}\p{Ll}{2,}/u.test(text.trim())
}

/**
 * Whether a string is an identifier rather than a text: plain lower-case ASCII words joined by `.`, `-`, `_`, `:` or `/`, without a space
 * (`guide.mises-a-jour`, `la-row`, `le-soir`). A word with an accent (`mini-fenêtre`) or a capital is not one: a person may read it.
 */
export function isIdentifier(text: string): boolean {
  return /^[a-z0-9]+(?:[-._:/][a-z0-9]+)+$/.test(text)
}

/** Whether a text has a word a person would read (two letters in a row): not "·", "…", "⌘" or "1". */
function hasLetters(text: string): boolean {
  return /\p{L}{2,}/u.test(text)
}

/** The text of a JSX child as React shows it: lines trimmed, empty ones dropped, the rest joined by a space (only spaces and tabs are white space here). */
export function jsxTextValue(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/)
  const kept: string[] = []
  lines.forEach((line, index) => {
    let text = line.replace(/\t/g, ' ')
    if (index > 0) text = text.replace(/^ +/, '')
    if (index < lines.length - 1) text = text.replace(/ +$/, '')
    if (text !== '') kept.push(text)
  })
  return kept.join(' ')
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

function calleeName(node: Node): string | undefined {
  const callee = node.callee
  if (!isNode(callee)) return undefined
  if (callee.type === 'Identifier') return callee.name as string
  // t.plural(...) style or an object holding the translator.
  if (callee.type === 'MemberExpression' && isNode(callee.object) && callee.object.type === 'Identifier') return callee.object.name as string
  return undefined
}

function lineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
  return starts
}

function positionOf(starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= offset) low = middle
    else high = middle - 1
  }
  return { line: low + 1, column: offset - starts[low]! + 1 }
}

/** The TypeScript nodes that wrap an expression (the rest of the TS nodes are types). */
const EXPRESSION_WRAPPERS: ReadonlySet<string> = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression'])

/** The operators that compare with a literal: `event.key === 'Enter'` names a key, it does not say anything. */
const COMPARISONS: ReadonlySet<string> = new Set(['===', '!==', '==', '!=', 'in'])

/**
 * Every text of the source that is written in the code: the text between tags, the strings given to a JSX attribute, and the strings and
 * templates anywhere else that read as a text. The arguments of `t(…)`, `tp(…)` and `tIn(…)` are keys, not texts, and are left out; so is what a type
 * or an import names. A finding of kind "string" is only reported when it looks French or like a label (a code string such as 'button' is not a
 * text), unless `everything` is given (the census wants to read the others too).
 */
export function scanSource(file: string, source: string, options: { everything?: boolean } = {}): Finding[] {
  // A `.ts` file is read as TypeScript without JSX: `<T>(x: T) => x` is a generic there, not a tag.
  const program = parseAst(source, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }) as unknown as Node
  const starts = lineStarts(source)
  const found: Finding[] = []

  const report = (node: Node, kind: FindingKind, value: string, extra: { attribute?: string; direct?: boolean; templated?: boolean; compared?: boolean; mixed?: boolean } = {}): void => {
    const text = value.replace(/\s+/g, ' ').trim()
    if (!hasLetters(text)) return
    const french = looksFrench(text)
    // Between tags and in a text attribute any word is a text someone reads; elsewhere a string is only a text when it is French or reads as a label,
    // and never when it is an identifier (a key of the catalogues kept as data, `guide.le-soir`; a class, `la-row`; an id).
    if (kind === 'string' && !options.everything && (extra.compared || isIdentifier(text) || !(french || looksLikeLabel(text)))) return
    found.push({
      file,
      ...positionOf(starts, node.start),
      kind,
      ...(extra.attribute ? { attribute: extra.attribute } : {}),
      text,
      value,
      start: node.start,
      end: node.end,
      direct: extra.direct === true,
      templated: extra.templated === true,
      atModuleLevel: functionDepth === 0,
      mixed: extra.mixed === true,
      french,
      ...(declaration ? { declaration } : {})
    })
  }

  let declaration: string | undefined

  let functionDepth = 0
  const cooked = (node: Node): string => (node.quasis as Array<{ value: { cooked: string | null } }>).map((quasi) => quasi.value.cooked ?? '').join('…')

  const walk = (node: Node, parent: Node | undefined, key: string): void => {
    // `x as T`, `x!` and the like hold an expression: the text it may hold is read, the type is not.
    if (EXPRESSION_WRAPPERS.has(node.type)) {
      if (isNode(node.expression)) walk(node.expression, node, 'expression')
      return
    }
    // Types, imports and the keys of the catalogues are not texts.
    if (node.type.startsWith('TS') || node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') return
    if (node.type === 'ExportNamedDeclaration' && node.source) return
    if (node.type === 'CallExpression' && JOURNAL_CALLEES.has(calleeName(node) ?? '')) return
    if (node.type === 'CallExpression' && TRANSLATE_CALLEES.has(calleeName(node) ?? '')) {
      // The variables of a message may hold a text (`t('k', { name: 'Ajouter' })`): only the key (first argument) is skipped.
      for (const argument of (node.arguments as unknown[]).slice(1)) if (isNode(argument)) walk(argument, node, 'arguments')
      return
    }

    if (node.type === 'JSXText') {
      const opening = parent?.openingElement as Node | undefined
      const tag = isNode(opening?.name) && opening.name.type === 'JSXIdentifier' ? (opening.name.name as string) : ''
      if (CODE_ELEMENTS.has(tag)) return
      const siblings = (parent?.children as unknown[] | undefined) ?? []
      const mixed = siblings.some((sibling) => isNode(sibling) && sibling !== node && !(sibling.type === 'JSXText' && jsxTextValue(sibling.value as string).trim() === ''))
      report(node, 'jsx-text', jsxTextValue(node.value as string), { mixed })
      return
    }
    if (node.type === 'JSXAttribute') {
      const nameNode = node.name as Node
      const name = nameNode.type === 'JSXIdentifier' ? (nameNode.name as string) : String((nameNode.name as Node | undefined)?.name ?? '')
      const value = node.value
      if (isNode(value) && value.type === 'Literal' && typeof value.value === 'string') {
        if (TEXT_ATTRIBUTES.has(name)) report(value, 'attribute', value.value, { attribute: name, direct: true })
        else report(value, 'string', value.value, { direct: true })
        return
      }
      // A string given in braces to a text attribute (title={'...'}) is the same thing.
      if (isNode(value) && value.type === 'JSXExpressionContainer' && isNode(value.expression) && TEXT_ATTRIBUTES.has(name)) {
        const inner = value.expression
        if (inner.type === 'Literal' && typeof inner.value === 'string') {
          report(inner, 'attribute', inner.value, { attribute: name })
          return
        }
        if (inner.type === 'TemplateLiteral') {
          report(inner, 'attribute', cooked(inner), { attribute: name, templated: (inner.expressions as unknown[]).length > 0 })
          // The expressions of the template may hold texts too.
          for (const expression of inner.expressions as unknown[]) if (isNode(expression)) walk(expression, inner, 'expressions')
          return
        }
      }
    }
    if (node.type === 'Literal' && typeof node.value === 'string') {
      // A string used as a property key or a comparison operand is code, not a text.
      if (parent?.type === 'Property' && key === 'key') return
      const compared = (parent?.type === 'BinaryExpression' && COMPARISONS.has(parent.operator as string)) || (parent?.type === 'SwitchCase' && key === 'test')
      report(node, 'string', node.value, { compared })
      return
    }
    if (node.type === 'TemplateLiteral') {
      report(node, 'string', cooked(node), { templated: (node.expressions as unknown[]).length > 0 })
    }

    const isFunction = node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration'
    if (isFunction) functionDepth++
    for (const [childKey, child] of Object.entries(node)) {
      if (childKey === 'parent') continue
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) walk(item, node, childKey)
      } else if (isNode(child)) walk(child, node, childKey)
    }
    if (isFunction) functionDepth--
  }

  // Statement by statement, so that each finding knows the top-level declaration it is in.
  for (const statement of program.body as unknown[]) {
    if (!isNode(statement)) continue
    declaration = declarationName(statement)
    walk(statement, program, 'body')
  }
  return found
}

/** The name a top-level statement declares (`const A = …`, `export function b() {}`, `class C {}`), or undefined for any other statement. */
function declarationName(statement: Node): string | undefined {
  const inner = (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') && isNode(statement.declaration) ? statement.declaration : statement
  if (inner.type === 'VariableDeclaration') {
    const first = (inner.declarations as unknown[])[0]
    return isNode(first) && isNode(first.id) && first.id.type === 'Identifier' ? (first.id.name as string) : undefined
  }
  if ((inner.type === 'FunctionDeclaration' || inner.type === 'ClassDeclaration') && isNode(inner.id)) return inner.id.name as string
  return undefined
}

/** The `Arc` / `Brave` names in a text: another browser named in a text the person reads. */
export function namesOtherBrowser(text: string): boolean {
  return /\b(?:Arc|Brave)\b/.test(text)
}
