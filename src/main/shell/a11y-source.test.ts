// A static pass over the interface's source: a button with nothing but an icon in it, a field with no label, an image with no `alt` are the
// commonest accessibility faults, and they are written in the source. The engine test (main/smoke-a11y.ts) reads the real accessibility
// tree of every surface; this pass fails earlier, with the file and the line, and also covers the markup of a state the engine test does
// not open. A control whose name comes from a spread of props cannot be judged here and is left to the engine test.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fr } from '@shared/i18n-fr'

const RENDERER = fileURLToPath(new URL('../../renderer/', import.meta.url))

interface Tag {
  name: string
  attributes: string
  /** What is between the opening and the closing tag (empty for a self-closing tag). */
  children: string
  line: number
  index: number
}

/** Reads the end of a JSX opening tag from `start` (just after the tag name): braces and strings are skipped, so `=>` and `>` in a prop do not end it. */
function endOfOpeningTag(source: string, start: number): { end: number; selfClosing: boolean } {
  let depth = 0
  let quote = ''
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!
    if (quote) {
      if (ch === quote && source[i - 1] !== '\\') quote = ''
      continue
    }
    if (depth === 0 && (ch === '"' || ch === "'")) quote = ch
    else if (ch === '`') quote = ch
    else if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) return { end: i, selfClosing: source[i - 1] === '/' }
  }
  return { end: source.length, selfClosing: false }
}

export function tagsOf(source: string, names: readonly string[]): Tag[] {
  const found: Tag[] = []
  const opening = new RegExp(`<(${names.join('|')})(?=[\\s/>])`, 'g')
  for (const match of source.matchAll(opening)) {
    const from = match.index! + match[0].length
    const { end, selfClosing } = endOfOpeningTag(source, from)
    const attributes = source.slice(from, selfClosing ? end - 1 : end)
    let children = ''
    if (!selfClosing) {
      const close = source.indexOf(`</${match[1]}>`, end)
      children = close === -1 ? '' : source.slice(end + 1, close)
    }
    found.push({ name: match[1]!, attributes, children, line: source.slice(0, match.index).split('\n').length, index: match.index! })
  }
  return found
}

const hasAttribute = (tag: Tag, ...names: string[]) => names.some((name) => new RegExp(`(^|\\s)${name}(=|\\s|$)`).test(tag.attributes))
const spreads = (tag: Tag) => /\{\s*\.\.\./.test(tag.attributes)

/** Whether what is inside a control says something: text, or an expression (a label held in a variable) — not an icon alone. */
export function hasLabelInside(children: string): boolean {
  const withoutIcons = children
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[A-Z][A-Za-z]*(Glyph|Icon|Mark)\b[^>]*\/>/g, '')
    .replace(/<(img|span|i)\b[^>]*\/>/g, '')
    .replace(/<span[^>]*\baria-hidden\b[^>]*>[\s\S]*?<\/span>/g, '')
  return /[\p{L}\p{N}]/u.test(withoutIcons.replace(/<[^>]*>/g, ' ').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ''))
}

/** Whether a `<label>` is open around the tag (the last `<label` before it has not been closed): the label's text names the field. */
function insideLabel(source: string, tag: Tag): boolean {
  const before = source.slice(0, tag.index)
  return before.lastIndexOf('<label') > before.lastIndexOf('</label>')
}

export function unnamedControls(file: string, source: string): string[] {
  const problems: string[] = []
  const at = (tag: Tag, what: string) => problems.push(`${file}:${tag.line} ${what}`)
  for (const tag of tagsOf(source, ['button'])) {
    if (spreads(tag) || hasAttribute(tag, 'aria-label', 'aria-labelledby', 'title')) continue
    if (!hasLabelInside(tag.children)) at(tag, '<button> has no name (no text, aria-label or title)')
  }
  for (const tag of tagsOf(source, ['img'])) {
    if (!spreads(tag) && !hasAttribute(tag, 'alt')) at(tag, '<img> has no alt (use alt="" for a decorative picture)')
  }
  for (const tag of tagsOf(source, ['select', 'textarea'])) {
    if (spreads(tag) || hasAttribute(tag, 'aria-label', 'aria-labelledby', 'title', 'id')) continue
    if (insideLabel(source, tag)) continue
    at(tag, `<${tag.name}> has no label`)
  }
  for (const tag of tagsOf(source, ['input'])) {
    if (spreads(tag) || hasAttribute(tag, 'aria-label', 'aria-labelledby', 'title', 'id', 'placeholder')) continue
    if (/type=["'](hidden|file)["']/.test(tag.attributes) || insideLabel(source, tag)) continue
    at(tag, '<input> has no label')
  }
  return problems
}

const sources = (): Array<[string, string]> =>
  readdirSync(RENDERER)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => [name, readFileSync(join(RENDERER, name), 'utf8')])

describe('the source of the interface', () => {
  it('has no button, picture or field without a name', () => {
    const problems = sources().flatMap(([name, source]) => unnamedControls(name, source))
    expect(problems).toEqual([])
  })

  it('has no live region added as an afterthought: the toast region is always there, not mounted with its message', () => {
    const sidebar = sources().find(([name]) => name === 'Sidebar.tsx')![1]
    expect(sidebar).toMatch(/<div className="toast-region" role="status" aria-live="polite" aria-atomic="true">/)
    expect(sidebar).not.toMatch(/<div className="toast" role="status"/)
  })

  it('gives every tab row a role, a name and a place in the keyboard order', () => {
    const rows = sources().find(([name]) => name === 'SidebarRows.tsx')![1]
    const row = rows.slice(rows.indexOf('function TabRowView'), rows.indexOf('function SplitRowView'))
    // The row is not the button: the button inside it (`tab-main`) takes the keys, the name and the place in the Tab order.
    expect(row).not.toContain('role="button"')
    for (const needle of ['className="tab-main"', 'tabIndex={', 'aria-label={rowName}', "e.key === 'ArrowDown'", "e.key === 'Delete'", "e.key === 'F2'"]) expect(row, needle).toContain(needle)
    // The name of the row is the tab's name, to which the words of its states are added when the marks are on, and its turn in « Actualiser tous les onglets ».
    expect(row).toContain('[...spoken.map(tabStateLabel), ...reloadMarkWords(')
    expect(row).toContain('[tabName(tab), ...said]')
    expect(row).toContain(': tabName(tab)')
  })
})

describe('what a name or a state of the sidebar is made of', () => {
  const read = (file: string) => sources().find(([name]) => name === file)![1]

  it('names a favourite and a space by their title, not by the letter or the emoji they show', () => {
    const sidebar = read('Sidebar.tsx')
    expect(sidebar).toContain('aria-label={f.title}')
    expect(sidebar).toContain('aria-label={s.name}')
  })

  it('makes the command bar a combobox whose chosen result is the one read aloud', () => {
    const bar = read('CommandBar.tsx')
    for (const needle of ['role="combobox"', 'aria-activedescendant={', 'aria-controls="cb-results"', 'role="listbox"', 'role="option"', 'aria-selected={i === selected}', 'id={`cb-option-${i}`}']) expect(bar, needle).toContain(needle)
  })

  it('gives the focus to a panel that draws late (it waits for the panel instead of giving up when there is none yet)', () => {
    // The host watches what the panel draws, and overlay-focus.ts gives the focus to the panel (its behaviour is measured in overlay-focus.test.ts).
    const host = read('OverlayHost.tsx')
    expect(host).toContain('keepPanelFocus(root, document,')
    expect(host).toContain('new MutationObserver(')
    expect(host).toContain('observer.disconnect()')
    expect(readFileSync(join(RENDERER, 'overlay-focus.ts'), 'utf8')).toContain(`'[role="dialog"], [role="alertdialog"], [role="menu"]'`)
  })

  it('says whether a folder is open', () => {
    expect(read('SidebarRows.tsx')).toContain('aria-expanded={!folder.collapsed}')
  })

  it('names the fields that rename a tab and a folder in place', () => {
    const rows = read('SidebarRows.tsx')
    // The names come from the catalogue now; the French ones are the originals.
    expect(rows).toContain("aria-label={t('sidebar.nom-de-l-onglet')}")
    expect(rows).toContain("aria-label={t('sidebar.nom-du-dossier')}")
    expect(fr['sidebar.nom-de-l-onglet']).toBe('Nom de l’onglet')
    expect(fr['sidebar.nom-du-dossier']).toBe('Nom du dossier')
  })
})

describe('the scanner itself', () => {
  it('finds a button with only an icon in it, and accepts the other ways of naming one', () => {
    const bad = `<div>\n<button className="x" onClick={() => go()}>\n  <CloseGlyph />\n</button>\n</div>`
    expect(unnamedControls('Bad.tsx', bad)).toEqual(['Bad.tsx:2 <button> has no name (no text, aria-label or title)'])
    expect(unnamedControls('A.tsx', `<button aria-label="Fermer"><CloseGlyph /></button>`)).toEqual([])
    expect(unnamedControls('B.tsx', `<button title="Fermer"><svg><path d="M0 0" /></svg></button>`)).toEqual([])
    expect(unnamedControls('C.tsx', `<button onClick={() => a > b}>Fermer</button>`)).toEqual([])
    expect(unnamedControls('D.tsx', `<button>{label}</button>`)).toEqual([])
    expect(unnamedControls('E.tsx', `<button {...props}><svg /></button>`)).toEqual([])
    expect(unnamedControls('F.tsx', `<button><svg><path /></svg><span>Vider</span></button>`)).toEqual([])
  })

  it('finds a picture without alt and a field without a label', () => {
    expect(unnamedControls('G.tsx', `<img src="a.png" />`)).toEqual(['G.tsx:1 <img> has no alt (use alt="" for a decorative picture)'])
    expect(unnamedControls('H.tsx', `<img src="a.png" alt="" />`)).toEqual([])
    expect(unnamedControls('I.tsx', `<input className="field" />`)).toEqual(['I.tsx:1 <input> has no label'])
    expect(unnamedControls('J.tsx', `<input placeholder="Rechercher" />`)).toEqual([])
    expect(unnamedControls('K.tsx', `<select className="field"><option>a</option></select>`)).toEqual(['K.tsx:1 <select> has no label'])
    expect(unnamedControls('L.tsx', `<label>Nom <input className="field" /></label>`)).toEqual([])
    expect(unnamedControls('M.tsx', `<label>Nom</label><input className="field" />`)).toEqual(['M.tsx:1 <input> has no label'])
  })

  it('is not fooled by an arrow function or a greater-than sign inside a prop', () => {
    expect(tagsOf(`<button onClick={(e) => e.x > 1 && go()} disabled>Ok</button>`, ['button'])[0]).toMatchObject({ children: 'Ok' })
  })
})
