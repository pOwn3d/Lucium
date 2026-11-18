// The sheet « Conflit réglé » (SyncConflictSheet.tsx), drawn with no window: what it tells of each conflict (the name, what each device did, what is in
// force), « Comparer » and « Rétablir », and what the buttons ask of the page that mounts it. The sentences themselves: shared/sync-conflicts.test.ts.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import { mergeSnapshots } from '@shared/sync-merge'
import { parseSnapshot, type SyncSnapshot } from '@shared/sync-snapshot'
import { settleConflicts, type SettledChange, type SettledConflict } from '@shared/sync-conflicts'
import { elementsOf, type Element } from './render.test-support'
import { nextComparing, SyncConflictSheet } from './SyncConflictSheet'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

const M = '1790000000001-0000-mac'
const NOW = new Date(2026, 10, 18, 10, 0).getTime()
const read = (value: unknown): SyncSnapshot => {
  const parsed = parseSnapshot(value)
  if ('problem' in parsed) throw new Error(parsed.problem)
  return parsed.snapshot
}
const stamp = (hour: number, minute: number, device: string): string => `${new Date(2026, 10, 18, hour, minute).getTime()}-0000-${device}`

/** A Mac and an iPhone that changed the name of a space, deleted/changed a tab, and reordered the tabs of a space, between two sessions. */
function entries(peer: 'ios' | 'mac' = 'ios', title = 'Garde'): SettledConflict[] {
  const space = (name: string, mark: string) => ({ fields: { name }, stamps: { name: mark } })
  const tab = (customTitle: string | null, mark: string) => ({
    fields: { spaceId: 's1', pinned: true, anchorUrl: 'https://example.com/a', ...(customTitle === null ? {} : { customTitle }) },
    stamps: { spaceId: M, pinned: M, anchorUrl: M, ...(customTitle === null ? {} : { customTitle: mark }) },
  })
  const plain = (id: string) => ({ fields: { spaceId: 's1', pinned: true, anchorUrl: `https://example.com/${id}` }, stamps: { spaceId: M, pinned: M, anchorUrl: M } })
  const [t2, t3] = [plain('b'), plain('c')]
  const snapshot = (name: string, nameMark: string, tabs: Record<string, unknown>, order: string[], orderMark: string, tombstones = {}) =>
    read({ entities: { space: { s1: space(name, nameMark) }, tab: tabs }, tombstones, order: { 'tabs:s1:-': order }, orderStamps: { 'tabs:s1:-': orderMark } })
  const base = snapshot('Travail', M, { t1: tab(null, M), t2, t3 }, ['t1', 't2', 't3'], M)
  // The Mac renamed the space at 9:12, deleted t1 at 9:25 and reordered the others at 9:30; the iPhone renamed the space at 9:15, titled t1 at 9:20 and reordered at 9:20.
  const local = snapshot('Pro', stamp(9, 12, 'mac'), { t2, t3 }, ['t3', 't2'], stamp(9, 30, 'mac'), { tab: { t1: stamp(9, 25, 'mac') } })
  const remote = snapshot('Boulot', stamp(9, 15, 'phone'), { t1: tab(title, stamp(9, 20, 'phone')), t2, t3 }, ['t1', 't3', 't2'], stamp(9, 20, 'phone'))
  const merged = mergeSnapshots(base, local, remote)
  return settleConflicts({ conflicts: merged.conflicts, local, remote, merged: merged.snapshot, now: NOW, peer })
}

function sheet(lines: SettledConflict[], extra: { initialComparing?: string } = {}) {
  const calls: { closed: number; restored: [SettledChange, string][] } = { closed: 0, restored: [] }
  const props = { entries: lines, now: NOW, onClose: () => void calls.closed++, onRestore: (change: SettledChange, id: string) => void calls.restored.push([change, id]), ...extra }
  const markup = renderToStaticMarkup(createElement(SyncConflictSheet, props))
  const elements = elementsOf(createElement(SyncConflictSheet, props))
  const text = (element: Element): string => {
    const children = element.props['children']
    return (Array.isArray(children) ? children : [children]).filter((child) => typeof child === 'string').join('')
  }
  const button = (label: string): Element => {
    const found = elements.find((element) => element.type === 'button' && text(element) === label)
    if (found === undefined) throw new Error(`no button « ${label} »`)
    return found
  }
  const submit = (): void => (elements.find((element) => element.type === 'form')!.props['onSubmit'] as (event: { preventDefault(): void }) => void)({ preventDefault: () => undefined })
  return { markup, button, submit, calls }
}

describe('the sheet « Conflit réglé »', () => {
  it('is a dialog that says two changes crossed, how many were settled, and for each one its name, what each device did and when, and what is in force', () => {
    const { markup } = sheet(entries())
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"/)
    expect(markup).toContain('>Deux changements se croisaient</h2>')
    expect(markup).toContain('3 conflits réglés')
    expect(markup).toContain('Faits sur les deux appareils depuis leur dernière synchronisation.')
    // The space: both versions, the Mac at 9:12 then the iPhone at 9:15, the newer one applied.
    expect(markup).toContain('>Espace</span>')
    expect(markup).toContain('Boulot')
    expect(markup).toContain(frenchSpaces('Nom changé en « Pro »'))
    expect(markup).toContain(frenchSpaces('Nom changé en « Boulot »'))
    expect(markup).toContain('La version de l’iPhone, la plus récente, est appliquée.')
    // The tab that was deleted on one device and changed on the other: kept, on both.
    expect(markup).toContain('Onglet épinglé')
    expect(markup).toContain('>Supprimé</span>')
    expect(markup).toContain('>Modifié</span>')
    expect(markup).toContain('Gardé sur les deux appareils.')
    // The list: the order of the Mac or of the iPhone.
    expect(markup).toContain('Liste réordonnée')
    expect(markup).toContain('L’ordre du Mac, le plus récent, est gardé.')
    // Each device is named with its own change: the Mac renamed it « Pro », the iPhone « Boulot », and the title carries the name in force.
    expect(markup).toContain(frenchSpaces('<span class="sc-device">Mac</span><span class="sc-text">Nom changé en « Pro »</span>'))
    expect(markup).toContain(frenchSpaces('<span class="sc-device">iPhone</span><span class="sc-text">Nom changé en « Boulot »</span>'))
    expect(markup).toContain(frenchSpaces('<span class="sc-label" title="Boulot">« Boulot »</span>'))
  })

  it('tells the winner from the point of view of the device that shows it', () => {
    expect(sheet(entries('ios')).markup).toContain('La version de l’iPhone, la plus récente, est appliquée.')
    // The same session seen from the iPhone: its peer is the Mac, and the version that won is the Mac's… the other way round.
    expect(sheet(entries('mac')).markup).toContain('La version du Mac, la plus récente, est appliquée.')
  })

  it('is told in English when the interface is', () => {
    setLanguage('en')
    const { markup } = sheet(entries())
    expect(markup).toContain('>Two changes crossed</h2>')
    expect(markup).toContain('3 conflicts settled')
    expect(markup).toContain('The iPhone’s version, the most recent, is applied.')
    expect(markup).toContain('Kept on both devices.')
    expect(markup).toContain('>Compare</button>')
    expect(markup).toContain('>OK</button>')
  })

  it('never asks a question: « D’accord » is its only main button, and it only closes the sheet', () => {
    const view = sheet(entries())
    expect(markup(view)).toMatch(/<button type="submit" class="tk-btn primary">D’accord<\/button>/)
    expect(markup(view)).not.toContain('Annuler')
    view.submit()
    expect(view.calls.closed).toBe(1)
    expect(view.calls.restored).toEqual([])
  })

  it('has « Comparer » for a field and for a list, and « Le supprimer partout » for a deletion that lost', () => {
    const view = sheet(entries())
    expect(view.markup.match(/aria-expanded="false"[^>]*>Comparer</g)).toHaveLength(2)
    expect(view.markup).toContain('>Le supprimer partout</button>')
    ;(view.button('Le supprimer partout').props['onClick'] as () => void)()
    expect(view.calls.restored).toHaveLength(1)
    expect(view.calls.restored[0]?.[0]).toEqual({ type: 'delete', kind: 'tab', id: 't1' })
  })

  it('shows both versions on « Comparer », and puts the one that lost back, as an ordinary change, only when asked', () => {
    const lines = entries()
    const name = lines.find((l) => l.field === 'name')!
    const view = sheet(lines, { initialComparing: name.id })
    // The kept version holds the value in force, the other one the value that lost.
    expect(view.markup).toMatch(/<section class="sc-version kept"[^>]*><h4>Version gardée<\/h4><p class="sc-value">Boulot<\/p><\/section>/)
    expect(view.markup).toMatch(/<section class="sc-version lost"[^>]*><h4>Version écartée<\/h4><p class="sc-value">Pro<\/p><button type="button" class="tk-btn">Rétablir cette version<\/button><\/section>/)
    expect(view.markup).toContain('Version écartée')
    expect(view.markup).toContain('>Masquer la comparaison</button>')
    expect(view.markup).toContain(frenchSpaces('Rétablir est un changement ordinaire : il part à la prochaine synchronisation.'))
    expect(view.calls.restored).toEqual([])
    ;(view.button('Rétablir cette version').props['onClick'] as () => void)()
    expect(view.calls.restored).toEqual([[{ type: 'set', kind: 'space', id: 's1', field: 'name', value: 'Pro' }, name.id]])
  })

  it('opens a line on « Comparer », closes it on the next touch, and moves to another line when that one is touched', () => {
    expect(nextComparing(null, 'a')).toBe('a')
    expect(nextComparing('a', 'a')).toBeNull()
    expect(nextComparing('a', 'b')).toBe('b')
  })

  it('keeps a closed line closed, and opens only one at a time', () => {
    const lines = entries()
    const order = lines.find((l) => l.kind === 'order')!
    const view = sheet(lines, { initialComparing: order.id })
    expect(view.markup.match(/class="sc-compare"/g)).toHaveLength(1)
    expect(sheet(lines).markup).not.toContain('sc-compare')
  })

  it('writes what the person typed as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const { markup } = sheet(entries('ios', hostile), { initialComparing: entries('ios', hostile).find((l) => l.kind === 'tab')?.id })
    expect(markup).not.toContain('<img')
    const named = renderToStaticMarkup(createElement(SyncConflictSheet, { entries: entries().map((l) => ({ ...l, label: hostile })), now: NOW, onClose: () => undefined, onRestore: () => undefined }))
    expect(named).not.toContain('<img')
    expect(named).toContain('&lt;img')
  })

  it('tells a time for the day of the screen and a date for another day', () => {
    const today = sheet(entries()).markup
    expect(today).toMatch(/class="sc-time">(9:12|09:12|9 h 12)</)
    const later = renderToStaticMarkup(createElement(SyncConflictSheet, { entries: entries(), now: NOW + 5 * 24 * 60 * 60 * 1000, onClose: () => undefined, onRestore: () => undefined }))
    expect(later).toMatch(/class="sc-time">[^<]*nov[^<]*</i)
  })
})

function markup(view: { markup: string }): string {
  return view.markup
}
