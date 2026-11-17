import { describe, expect, it } from 'vitest'
import { NO_SELECTION, clickSelection, groupLabels, groupSummary, markdownLinks, pruneSelection, selectedInOrder, type Selection } from './selection'

const order = ['a', 'b', 'c', 'd', 'e']
const plain = { toggle: false, range: false }
const cmd = { toggle: true, range: false }
const shift = { toggle: false, range: true }
const sel = (ids: string[], anchor: string | null = ids.at(-1) ?? null): Selection => ({ ids, anchor })

describe('clicking a row', () => {
  it('a plain click clears the selection, makes the tab the one shown and becomes the anchor', () => {
    expect(clickSelection(sel(['a', 'b', 'c']), 'd', plain, order, 'a')).toEqual({ selection: { ids: [], anchor: 'd' }, activate: true })
  })

  it('⌘-click adds a tab to the selection, counting the tab being shown as selected, and leaves the page alone', () => {
    const out = clickSelection(NO_SELECTION, 'c', cmd, order, 'a')
    expect(out).toEqual({ selection: { ids: ['a', 'c'], anchor: 'c' }, activate: false })
  })

  it('⌘-click again takes a tab out; down to one tab there is no multiple selection any more', () => {
    const three = clickSelection(sel(['a', 'c']), 'e', cmd, order, 'a').selection
    expect(three.ids).toEqual(['a', 'c', 'e'])
    expect(clickSelection(three, 'c', cmd, order, 'a').selection.ids).toEqual(['a', 'e'])
    expect(clickSelection(sel(['a', 'c']), 'c', cmd, order, 'a').selection.ids).toEqual([])
  })

  it('keeps the selection in the order of the sidebar whatever the order of the clicks', () => {
    let out = clickSelection(NO_SELECTION, 'd', cmd, order, 'c').selection
    out = clickSelection(out, 'a', cmd, order, 'c').selection
    expect(out.ids).toEqual(['a', 'c', 'd'])
  })

  it('⌘-click with nothing shown and nothing selected just selects the tab', () => {
    expect(clickSelection(NO_SELECTION, 'b', cmd, order, null)).toEqual({ selection: { ids: [], anchor: 'b' }, activate: true })
  })

  it('⇧-click selects the range from the tab being shown, in either direction', () => {
    expect(clickSelection(NO_SELECTION, 'd', shift, order, 'b')).toEqual({ selection: { ids: ['b', 'c', 'd'], anchor: 'b' }, activate: false })
    expect(clickSelection(NO_SELECTION, 'a', shift, order, 'c').selection.ids).toEqual(['a', 'b', 'c'])
  })

  it('⇧-click ranges from the last clicked tab and re-ranges from it when clicked again', () => {
    const first = clickSelection(sel(['b', 'c'], 'b'), 'e', shift, order, 'a').selection
    expect(first).toEqual({ ids: ['b', 'c', 'd', 'e'], anchor: 'b' })
    expect(clickSelection(first, 'c', shift, order, 'a').selection.ids).toEqual(['b', 'c'])
  })

  it('⇧-click on the anchor itself is one tab, so no selection', () => {
    expect(clickSelection(sel(['b', 'c'], 'b'), 'b', shift, order, 'a').selection.ids).toEqual([])
  })

  it('⇧-click with no anchor and no tab shown behaves like a plain click', () => {
    expect(clickSelection(NO_SELECTION, 'c', shift, order, null)).toEqual({ selection: { ids: [], anchor: 'c' }, activate: true })
  })

  it('a range does not reach into rows that are not on screen', () => {
    // "c" is hidden in a collapsed folder: it is not in the order of the rows.
    const visible = ['a', 'b', 'd', 'e']
    expect(clickSelection(NO_SELECTION, 'e', shift, visible, 'b').selection.ids).toEqual(['b', 'd', 'e'])
    expect(clickSelection(NO_SELECTION, 'c', shift, visible, 'b')).toMatchObject({ activate: true })
  })
})

describe('keeping a selection valid', () => {
  it('drops tabs that are gone, and a single survivor is no selection', () => {
    expect(pruneSelection(sel(['a', 'b', 'c']), new Set(['a', 'c', 'd'])).ids).toEqual(['a', 'c'])
    expect(pruneSelection(sel(['a', 'b', 'c']), new Set(['a', 'd'])).ids).toEqual([])
  })

  it('returns the same selection when nothing changed, so React has nothing to redraw', () => {
    const same = sel(['a', 'b'], 'b')
    expect(pruneSelection(same, new Set(['a', 'b', 'z']))).toBe(same)
  })

  it('forgets an anchor that is gone', () => {
    expect(pruneSelection(sel(['a', 'b'], 'b'), new Set(['a'])).anchor).toBeNull()
  })

  it('sorts the selected ids by the order of the rows and ignores unknown ones', () => {
    expect(selectedInOrder(sel(['d', 'x', 'a']), order)).toEqual(['a', 'd'])
  })
})

describe('copying links as Markdown', () => {
  it('writes one [title](url) line per tab, using the name the user gave a tab', () => {
    const text = markdownLinks([
      { title: 'Alpha', url: 'https://a.fr/' },
      { title: 'Beta', customTitle: 'Mon beta', url: 'https://b.fr/x' }
    ])
    expect(text).toBe('[Alpha](https://a.fr/)\n[Mon beta](https://b.fr/x)')
  })

  it('escapes the brackets of a title and the parentheses of an address, which would end the link early', () => {
    expect(markdownLinks([{ title: 'Arc [browser]', url: 'https://en.wikipedia.org/wiki/Arc_(browser)' }])).toBe('[Arc \\[browser\\]](https://en.wikipedia.org/wiki/Arc_%28browser%29)')
  })

  it('falls back to the address when a tab has no title', () => {
    expect(markdownLinks([{ title: ' ', url: 'https://a.fr/' }])).toBe('[https://a.fr/](https://a.fr/)')
  })
})

describe('the wording of the group menu', () => {
  it('counts what each entry applies to', () => {
    const summary = groupSummary([{ pinned: false }, { pinned: false }, { pinned: true }])
    expect(summary).toEqual({ count: 3, archivable: 2, pinned: 1, allPinned: false })
    expect(groupLabels(summary)).toEqual({
      archive: 'Archiver 2 onglets',
      pin: 'Épingler 2 onglets',
      close: 'Fermer 3 onglets',
      copyLinks: 'Copier les liens en Markdown',
      newFolder: 'Nouveau dossier avec la sélection'
    })
  })

  it('offers to unpin when every tab is pinned, and says "onglet" for one', () => {
    const labels = groupLabels(groupSummary([{ pinned: true }, { pinned: true }]))
    expect(labels.pin).toBe('Désépingler 2 onglets')
    expect(labels.archive).toBe('Archiver 0 onglet')
    expect(groupLabels(groupSummary([{ pinned: false }])).archive).toBe('Archiver 1 onglet')
  })
})
