import { describe, expect, it } from 'vitest'
import { layoutBlocks, menuHeadersSupported, type MenuBlock, type MenuRow } from './menu-blocks'

/** A row as a short string: `# Title` for a header, `---` for a separator, the entry itself otherwise. */
const show = (rows: readonly MenuRow<string>[]): string[] => rows.map((row) => (row.kind === 'header' ? `# ${row.title}` : row.kind === 'separator' ? '---' : row.item))

const block = (title: string | undefined, items: string[], destructive = false): MenuBlock<string> => ({ ...(title === undefined ? {} : { title }), ...(destructive ? { destructive } : {}), items })

describe('layoutBlocks with headers', () => {
  it('puts a header before the entries of each block and no separator between blocks', () => {
    const rows = layoutBlocks([block('Ouvrir', ['a', 'b']), block('Organiser', ['c'])], { headers: true })
    expect(show(rows)).toEqual(['# Ouvrir', 'a', 'b', '# Organiser', 'c'])
  })

  it('drops a block without entries, with its title', () => {
    const rows = layoutBlocks([block('Ouvrir', ['a']), block('Thème', []), block('Organiser', ['c'])], { headers: true })
    expect(show(rows)).toEqual(['# Ouvrir', 'a', '# Organiser', 'c'])
    expect(layoutBlocks([block('Ouvrir', []), block('Thème', [])], { headers: true })).toEqual([])
    expect(layoutBlocks<string>([], { headers: true })).toEqual([])
  })

  it('keeps the order of the entries and of the blocks, and puts the destructive blocks last, in their own order', () => {
    const rows = layoutBlocks([block('Supprimer', ['x'], true), block('Ouvrir', ['a']), block('Retirer', ['y'], true), block('Organiser', ['c', 'b'])], { headers: true })
    expect(show(rows)).toEqual(['# Ouvrir', 'a', '# Organiser', 'c', 'b', '# Supprimer', 'x', '# Retirer', 'y'])
    expect(rows.filter((row) => row.kind === 'header').map((row) => (row.kind === 'header' ? row.destructive : null))).toEqual([false, false, true, true])
  })

  it('sets a block without a title apart by a separator, and does not start with one', () => {
    expect(show(layoutBlocks([block(undefined, ['a']), block('Organiser', ['b'])], { headers: true }))).toEqual(['a', '# Organiser', 'b'])
    expect(show(layoutBlocks([block('Ouvrir', ['a']), block(undefined, ['b'])], { headers: true }))).toEqual(['# Ouvrir', 'a', '---', 'b'])
  })

  it('takes a title made of spaces for no title', () => {
    expect(show(layoutBlocks([block('Ouvrir', ['a']), block('  ', ['b'])], { headers: true }))).toEqual(['# Ouvrir', 'a', '---', 'b'])
  })

  it('does not change what it is given', () => {
    const blocks = [block('Supprimer', ['x'], true), block('Ouvrir', ['a'])]
    const copy = JSON.parse(JSON.stringify(blocks))
    layoutBlocks(blocks, { headers: true })
    expect(blocks).toEqual(copy)
  })
})

describe('layoutBlocks without headers (macOS before 14, or another system)', () => {
  it('separates the blocks by one separator and shows no title', () => {
    const rows = layoutBlocks([block('Ouvrir', ['a', 'b']), block('Organiser', ['c']), block('Supprimer', ['x'], true)], { headers: false })
    expect(show(rows)).toEqual(['a', 'b', '---', 'c', '---', 'x'])
    expect(rows.some((row) => row.kind === 'header')).toBe(false)
  })

  it('has no separator at the start, at the end or twice in a row, whichever blocks are empty', () => {
    const titles = ['A', 'B', 'C', 'D']
    // Every way of filling or emptying four blocks, the last one destructive.
    for (let mask = 0; mask < 16; mask++) {
      const blocks = titles.map((title, index) => block(title, mask & (1 << index) ? [`${title}1`, `${title}2`] : [], index === 3))
      const shown = show(layoutBlocks(blocks, { headers: false }))
      expect(shown[0], String(mask)).not.toBe('---')
      expect(shown.at(-1), String(mask)).not.toBe('---')
      expect(shown.join(' ').includes('--- ---'), String(mask)).toBe(false)
      expect(shown.filter((row) => row === '---').length, String(mask)).toBe(Math.max(0, blocks.filter((b) => b.items.length > 0).length - 1))
    }
  })

  it('shows a single block as it is', () => {
    expect(show(layoutBlocks([block('Ouvrir', ['a', 'b'])], { headers: false }))).toEqual(['a', 'b'])
  })
})

describe('menuHeadersSupported', () => {
  it('is true on macOS 14 and later only', () => {
    expect(menuHeadersSupported('darwin', '14.0.0')).toBe(true)
    expect(menuHeadersSupported('darwin', '15.2.1')).toBe(true)
    expect(menuHeadersSupported('darwin', '26.0')).toBe(true)
    expect(menuHeadersSupported('darwin', '13.6.4')).toBe(false)
    expect(menuHeadersSupported('darwin', '12.7')).toBe(false)
  })

  it('is false elsewhere, and when the version cannot be read', () => {
    expect(menuHeadersSupported('win32', '14.0.0')).toBe(false)
    expect(menuHeadersSupported('linux', '14')).toBe(false)
    expect(menuHeadersSupported('darwin', undefined)).toBe(false)
    expect(menuHeadersSupported('darwin', '')).toBe(false)
    expect(menuHeadersSupported('darwin', 'sonoma')).toBe(false)
  })
})
