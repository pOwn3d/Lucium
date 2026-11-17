// A control whose name is written on it needs no tooltip that says it again: the tooltip opens under the pointer and covers some 30 px, so on a header,
// a row or a labelled button it only hides the line under it (« Replier la section Blocage » over « Blocage »). This test reads the interface's code
// and refuses a control (button, link, label, summary, or an element with the role of one) whose tooltip (`title`, `data-tip` or `tipProps`) says its
// visible label again, or that label after « Replier », « Déplier », « Ouvrir » or « Fermer » (with « la section », « le dossier »…).
//
// What it sees, and what it does not:
// - the JSX of the files of src/renderer, element by element: a label drawn by a child component or handed down as `children` is not read, and a
//   `title` a component sets from its props is checked only where the element is written;
// - the French catalogue, with the variables kept as the code that fills them (`{ name: title }` and `{title}` match);
// - the same words only: a paraphrase (« Notifications récentes » on « Notifications ») is a judgement this test does not make.
// A tooltip that says more (a shortcut, what a click does, a reason, a full address) is never the same text, so it stays allowed.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fr } from '@shared/i18n-fr'

const CATALOGUE = fr as Record<string, string>

/** Elements that are controls by their tag, and the roles that make another element one. */
const CONTROL_TAGS = new Set(['button', 'a', 'label', 'summary'])
const CONTROL_ROLES = new Set(['button', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'link'])
/** The words that, before the label, still say nothing the label does not: the action of a header that folds, or of a line that opens. */
const REPEATING_PREFIX = /^(replier|déplier|ouvrir|fermer)(\s+(la section|le dossier|la liste|le menu|la|le|les|l[’']))?\s*/i
/** More texts than this for one expression (ternaries in templates) and it is read as code, not as texts. */
const MAX_TEXTS = 16

// ---- Reading JSX without a compiler: strings, braces, comments, tags. ----

function skipString(s: string, i: number): number {
  const quote = s[i]
  for (i++; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (quote === '`' && s[i] === '$' && s[i + 1] === '{') i = skipBraces(s, i + 1) - 1
    else if (s[i] === quote) return i + 1
  }
  return i
}

/** From an opening brace, the index after the one that closes it. */
function skipBraces(s: string, i: number): number {
  let depth = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(s, i)
      continue
    }
    if (c === '/' && s[i + 1] === '/') {
      i = s.indexOf('\n', i) < 0 ? s.length : s.indexOf('\n', i)
      continue
    }
    if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2) + 2
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i + 1
    i++
  }
  return i
}

type Tag = { attributes: Record<string, string | true>; spreads: string[]; end: number; selfClosing: boolean }

/** The attributes of an opening tag, read from just after its name. */
function parseTag(s: string, i: number): Tag {
  const attributes: Record<string, string | true> = {}
  const spreads: string[] = []
  while (i < s.length) {
    const c = s[i]!
    if (/\s/.test(c)) i++
    else if (c === '/' && s[i + 1] === '>') return { attributes, spreads, end: i + 2, selfClosing: true }
    else if (c === '>') return { attributes, spreads, end: i + 1, selfClosing: false }
    else if (c === '/' && s[i + 1] === '/') i = s.indexOf('\n', i)
    else if (c === '/' && s[i + 1] === '*') i = s.indexOf('*/', i) + 2
    else if (c === '{') {
      const end = skipBraces(s, i)
      spreads.push(s.slice(i + 1, end - 1).trim())
      i = end
    } else {
      const name = /^[A-Za-z_][\w:-]*/.exec(s.slice(i, i + 80))?.[0]
      if (!name) {
        i++
        continue
      }
      i += name.length
      if (s[i] !== '=') attributes[name] = true
      else if (s[i + 1] === '{') {
        const end = skipBraces(s, i + 1)
        attributes[name] = s.slice(i + 2, end - 1).trim()
        i = end
      } else {
        const end = skipString(s, i + 1)
        attributes[name] = s.slice(i + 1, end)
        i = end
      }
    }
  }
  return { attributes, spreads, end: i, selfClosing: false }
}

/** What is between an opening tag ending at `from` and the tag that closes it. */
function childrenOf(s: string, tag: string, from: number): string {
  const open = new RegExp(`<${tag}(?=[\\s>/])`, 'g')
  const close = new RegExp(`</${tag}\\s*>`, 'g')
  let depth = 1
  let i = from
  for (;;) {
    open.lastIndex = i
    close.lastIndex = i
    const opened = open.exec(s)
    const closed = close.exec(s)
    if (!closed) return ''
    if (opened && opened.index < closed.index) {
      const inner = parseTag(s, opened.index + tag.length + 1)
      if (!inner.selfClosing) depth++
      i = inner.end
    } else {
      i = closed.index + closed[0].length
      if (--depth === 0) return s.slice(from, closed.index)
    }
  }
}

/** The pieces of `s` separated by `separator` at the top level (outside strings, parentheses, brackets and braces). */
function topLevelSplit(s: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '"' || c === "'" || c === '`') i = skipString(s, i) - 1
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (depth === 0 && s.startsWith(separator, i)) {
      parts.push(s.slice(start, i))
      start = i + separator.length
      i += separator.length - 1
    }
  }
  parts.push(s.slice(start))
  return parts.map((part) => part.trim())
}

/** The branches of a top-level `a ? b : c`, or null. */
function ternary(s: string): [string, string] | null {
  let depth = 0
  let question = -1
  let pending = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '"' || c === "'" || c === '`') i = skipString(s, i) - 1
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (depth === 0 && c === '?' && s[i + 1] !== '.' && s[i + 1] !== '?' && s[i - 1] !== '?') {
      if (question < 0) question = i
      pending++
    } else if (depth === 0 && c === ':' && question >= 0 && --pending === 0) return [s.slice(question + 1, i).trim(), s.slice(i + 1).trim()]
  }
  return null
}

// ---- What an expression can say: texts of the catalogue, with the code that fills them kept as ⟨code⟩. ----

const placeholder = (code: string): string => `⟨${code.replace(/\s+/g, '')}⟩`

/** The texts an expression of the code can show, in French. */
function textsOf(expression: string): string[] {
  const s = expression.trim()
  if (s === '' || s === 'undefined' || s === 'null') return []
  if (s.startsWith('(') && s.endsWith(')') && skipBraces(s.replace(/^\(/, '{').replace(/\)$/, '}'), 0) === s.length) return textsOf(s.slice(1, -1))
  const branches = ternary(s)
  if (branches) return [...textsOf(branches[0]), ...textsOf(branches[1])].slice(0, MAX_TEXTS)
  const either = topLevelSplit(s, '??')
  if (either.length > 1) return either.flatMap(textsOf).slice(0, MAX_TEXTS)
  if (/^(['"])[^'"]*\1$/.test(s)) return [s.slice(1, -1)]
  if (s.startsWith('`') && skipString(s, 0) === s.length) return templateTexts(s.slice(1, -1))
  const call = /^t\(\s*'([^']+)'\s*(?:,\s*([\s\S]*))?\)$/.exec(s)
  if (call && CATALOGUE[call[1]!] !== undefined) return catalogueTexts(CATALOGUE[call[1]!]!, call[2])
  return [placeholder(s)]
}

/** The text of a key with its variables filled by what the code gives them. */
function catalogueTexts(text: string, args: string | undefined): string[] {
  const values = new Map<string, string>()
  const object = args?.trim().replace(/^\{/, '').replace(/\}$/, '') ?? ''
  for (const entry of topLevelSplit(object, ',')) {
    if (!entry) continue
    const [name, value] = topLevelSplit(entry, ':')
    values.set(name!, value ?? name!)
  }
  let texts = [text]
  for (const [name, value] of values) {
    const fills = textsOf(value)
    texts = texts.flatMap((one) => fills.map((fill) => one.split(`{${name}}`).join(fill))).slice(0, MAX_TEXTS)
  }
  return texts
}

function templateTexts(body: string): string[] {
  let texts = ['']
  let i = 0
  while (i < body.length) {
    const start = body.indexOf('${', i)
    if (start < 0) {
      texts = texts.map((one) => one + body.slice(i))
      break
    }
    const end = skipBraces(body, start + 1)
    const fills = textsOf(body.slice(start + 2, end - 1))
    const literal = body.slice(i, start)
    texts = texts.flatMap((one) => (fills.length > 0 ? fills : ['']).map((fill) => one + literal + fill)).slice(0, MAX_TEXTS)
    i = end
  }
  return texts
}

/** The labels a person reads on a control: each piece of its content, and all of them in a row. Hidden text (`sr-only`) and drawings are not read. */
function visibleLabels(children: string): string[] {
  const read = children
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<(\w+)[^>]*className="[^"]*\bsr-only\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g, '')
  const pieces: string[][] = []
  let i = 0
  let text = ''
  const flush = () => {
    const words = text.replace(/<[^>]*>/g, ' ').trim()
    if (words) pieces.push([words])
    text = ''
  }
  while (i < read.length) {
    if (read[i] === '{') {
      flush()
      const end = skipBraces(read, i)
      const code = read.slice(i + 1, end - 1)
      // An expression that draws elements is not a label (`{open && <span>…</span>}`).
      if (!/<[A-Za-z]/.test(code)) {
        const texts = textsOf(code)
        if (texts.length > 0) pieces.push(texts)
      }
      i = end
    } else if (read[i] === '<') {
      // A tag of an element inside: its own text is read as a piece of the label; its attributes are not.
      flush()
      const end = read[i + 1] === '/' ? read.indexOf('>', i) + 1 : parseTag(read, i + 1 + (/^\w+/.exec(read.slice(i + 1))?.[0].length ?? 0)).end
      i = end > i ? end : i + 1
    } else text += read[i++]
  }
  flush()
  const whole = pieces.reduce<string[]>((all, piece) => all.flatMap((one) => piece.map((next) => `${one} ${next}`)).slice(0, MAX_TEXTS), [''])
  return [...pieces.flat(), ...(pieces.length > 1 ? whole : [])]
}

/** A text reduced to its words, so that case, accents, punctuation, spaces and the keycaps written around them do not tell two texts apart. */
function words(text: string): string {
  return text
    .split(/(⟨[^⟩]*⟩)/)
    .map((part) => (part.startsWith('⟨') ? part : part.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '')))
    .join('')
}

export type Repeat = { at: string; tooltip: string; label: string }

/** The controls of a file of the interface whose tooltip says their visible label again. */
export function repeatsIn(source: string, file: string): Repeat[] {
  const found: Repeat[] = []
  for (const match of source.matchAll(/<([a-z][a-z0-9]*)(?=[\s>/])/g)) {
    if (match.index > 0 && /[\w$.]/.test(source[match.index - 1]!)) continue
    const tag = match[1]!
    const parsed = parseTag(source, match.index + match[0].length)
    const role = typeof parsed.attributes['role'] === 'string' ? parsed.attributes['role'].replace(/^['"]|['"]$/g, '') : ''
    if (!CONTROL_TAGS.has(tag) && !CONTROL_ROLES.has(role)) continue
    const tooltips = [parsed.attributes['title'], parsed.attributes['data-tip'], ...parsed.spreads.filter((spread) => spread.startsWith('...tipProps(')).map((spread) => topLevelSplit(spread.slice('...tipProps('.length, -1), ',')[0])]
    const said = tooltips.filter((one): one is string => typeof one === 'string').flatMap((one) => (/^['"]/.test(one) ? [one.slice(1, -1)] : textsOf(one)))
    if (said.length === 0 || parsed.selfClosing) continue
    const labels = visibleLabels(childrenOf(source, tag, parsed.end)).map((label) => ({ label, key: words(label) })).filter((label) => label.key !== '')
    for (const tooltip of said) {
      const keys = new Set([words(tooltip), words(tooltip.replace(REPEATING_PREFIX, ''))])
      const same = labels.find((label) => keys.has(label.key))
      if (same) found.push({ at: `${file}:${source.slice(0, match.index).split('\n').length}`, tooltip, label: same.label })
    }
  }
  return found
}

const RENDERER = __dirname

describe('the tooltips of the interface', () => {
  it('never say again the label written on their control', () => {
    const files = (readdirSync(RENDERER, { recursive: true }) as string[]).filter((file) => file.endsWith('.tsx') && !file.includes('.test.'))
    expect(files.length).toBeGreaterThan(50)
    const repeats = files.flatMap((file) => repeatsIn(readFileSync(join(RENDERER, file), 'utf8'), file))
    expect(repeats.map((repeat) => `${repeat.at}: « ${repeat.tooltip} » over « ${repeat.label} »`)).toEqual([])
  })
})

describe('the reading of a control', () => {
  it('sees a header whose tooltip folds the section it names, and a tile or a row whose tooltip is its label', () => {
    // The header of a section of the site panel as it was: « Replier la section Blocage » over « Blocage ».
    const header = `<button type="button" className="scc-section-head" aria-expanded={open} title={open ? \`Replier la section \${title}\` : t('read-later.deplier-name', { name: title })} onClick={onToggle}>
        <svg className="scc-section-chevron" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
        <span className="scc-section-title">{title}</span>
        {summary && <span className="scc-section-sum">{summary.text}</span>}
      </button>`
    expect(repeatsIn(header, 'Header.tsx')).toEqual([
      { at: 'Header.tsx:1', tooltip: 'Replier la section ⟨title⟩', label: '⟨title⟩' },
      { at: 'Header.tsx:1', tooltip: 'Déplier ⟨title⟩', label: '⟨title⟩' }
    ])
    expect(repeatsIn(`<button className="scc-tile" title={tile.title} aria-label={tile.title}><svg><path d="M0" /></svg><span>{tile.title}</span></button>`, 'Tile.tsx')).toHaveLength(1)
    expect(repeatsIn(`<button className="pk-btn primary" title={\`\${t('littlearc.ouvrir-dans-un-onglet')} (⌘↩)\`}>{t('littlearc.ouvrir-dans-un-onglet')}<kbd>⌘↩</kbd></button>`, 'Peek.tsx')).toHaveLength(1)
    expect(repeatsIn(`<div role="switch" title="Mode sombre" aria-checked={on}><strong>Mode sombre</strong></div>`, 'Row.tsx')).toHaveLength(1)
    expect(repeatsIn(`<button {...tipProps(t('docked.deplier-la-barre'))}>{t('docked.deplier-la-barre')}</button>`, 'Bar.tsx')).toHaveLength(1)
  })

  it('leaves a tooltip that names an icon, says more than the label, or sits on what is no control', () => {
    expect(repeatsIn(`<button className="icon" title={t('sidebar.recharger')} aria-label={t('sidebar.recharger')}><span aria-hidden="true">↻</span></button>`, 'Icon.tsx')).toEqual([])
    expect(repeatsIn(`<button title={t('settings-profiles.ajouter-un-profil')}>{PLUS}<span className="sr-only">{t('settings-profiles.ajouter-un-profil')}</span></button>`, 'Hidden.tsx')).toEqual([])
    expect(repeatsIn(`<button className="fr-text" title={t('find-replace.remplacer-la-prochaine-occurrence')}>{t('find-replace.remplacer')}</button>`, 'More.tsx')).toEqual([])
    expect(repeatsIn(`<span className="dt-name" title={row.name}>{row.name}</span>`, 'Cut.tsx')).toEqual([])
    expect(repeatsIn(`<button title={tool === 'blur' ? t('annotate-sheet.flou-mosaique-le-texte-dessous-ne-peut-pas-etre-relu') : undefined}>{LABELS[tool]}</button>`, 'Tool.tsx')).toEqual([])
    // A comment between the attributes is not an attribute.
    expect(repeatsIn(`<button\n  // No \`title\`: the name is a bubble of its own.\n  aria-label={f.title}\n>{f.title}</button>`, 'Comment.tsx')).toEqual([])
  })
})
