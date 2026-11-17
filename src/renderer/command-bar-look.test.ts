// The command bar's row of "Copier" and "Coller", and the size and shape of its card, rendered to markup with the real component and a fake
// bridge (no window). Where a key or a pointer cannot be sent, the component is called as a function and the handler it hands to the field or to a button is called
// (as site-permissions.test.ts does). The style sheet is read as text: its rules are the contract of the size and the shape. What the buttons do is in bar-clipboard.test.ts.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BAR_WIDTH, barBox, barLayout } from '@shared/command-bar'
import { setLanguage } from '@shared/i18n'
import { COMMAND_BAR_SHAPES, COMMAND_BAR_SIZES, type CommandBarShape, type CommandBarSize, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import type { UiSnapshot } from '@shared/ipc'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, bridge: {} as Record<string, unknown> }))
vi.mock('./api', () => ({ api: () => holder.bridge, useSnapshot: () => holder.snapshot }))

import { BarClipboardButtons } from './BarClipboard'
import { applyPaste } from './bar-clipboard'
import { CommandBar } from './CommandBar'
import { SettingsView } from './SettingsWindow'
import { CommandBarSettings } from './SearchSettings'
import { TabSearch } from './TabSearch'
import commandBarCss from './command-bar.css?raw'

const ctx = { now: 1, newId: () => 'id' }

/** A snapshot of a window with its one empty space and these settings (and, when asked, one open page: at this address if one is given). */
function snapshotWith(patch: Partial<Settings> = {}, options: { page?: boolean | string } = {}): UiSnapshot {
  let state = createInitialState(ctx)
  state = { ...state, settings: { ...state.settings, ...patch } }
  if (options.page) {
    const tab = { id: 't1', spaceId: state.activeSpaceId, url: typeof options.page === 'string' ? options.page : 'https://exemple.org/page', title: 'Une page', pinned: false } as never
    state = { ...state, tabs: [tab], activeTabBySpace: { ...state.activeTabBySpace, [state.activeSpaceId]: 't1' } }
  }
  return { state, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [] } as unknown as UiSnapshot
}

/** The bar drawn for these settings. */
function bar(patch: Partial<Settings> = {}, props: { mode?: 'current' | 'new' | 'split' | 'tabs'; initial?: string; little?: boolean } = {}, options: { page?: boolean } = {}): string {
  holder.snapshot = snapshotWith(patch, options)
  return renderToStaticMarkup(createElement(CommandBar, { mode: props.mode ?? 'current', initial: props.initial ?? '', ...(props.little ? { little: { id: 'little-1' } } : {}) }))
}

/** The custom properties set in line on the card (what the style sheet reads), or null when there is no style attribute. */
function cardVariables(markup: string): Record<string, string> | null {
  const style = /<div class="palette[^"]*" role="dialog"[^>]*?style="([^"]*)"/.exec(markup)?.[1]
  if (style === undefined) return null
  return Object.fromEntries([...style.matchAll(/(--[a-z-]+):([^;]+)/g)].map((m) => [m[1]!, m[2]!.trim()]))
}

/** Every element of a tree, depth first (a component called as a function returns its elements, not their markup). */
function elementsOf(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [element, ...elementsOf(element.props['children'] as ReactNode)]
}

/** The bar as the elements it returns (it keeps state, so it is called while a render is going on). */
function barElements(patch: Partial<Settings> = {}, props: { initial?: string } = {}, options: { page?: boolean | string } = {}): ReactElement<Record<string, unknown>>[] {
  holder.snapshot = snapshotWith(patch, options)
  let tree: ReactNode = null
  const Probe = () => {
    tree = CommandBar({ mode: 'current', initial: props.initial ?? '' })
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return elementsOf(tree)
}

beforeAll(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  // The paste puts the caret at the end of the field on the next frame.
  vi.stubGlobal('requestAnimationFrame', () => 0)
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => setLanguage('fr'))
afterEach(() => {
  setLanguage('fr')
  holder.bridge = {}
})

describe('"Copier" and "Coller" on the row of the genres', () => {
  const row = (markup: string) => /<div class="cb-chips">([\s\S]*?)<\/div><div class="cb-body">/.exec(markup)?.[1] ?? ''

  it('are on the row of the genres, at the right of the three chips', () => {
    const markup = bar()
    const chips = row(markup)
    expect(chips).not.toBe('')
    const genres = chips.indexOf('class="cb-genres"')
    const clip = chips.indexOf('class="cb-clip"')
    expect(genres).toBeGreaterThanOrEqual(0)
    expect(clip).toBeGreaterThan(genres)
    // The three genres first, then the two buttons, in that order.
    const words = [...chips.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, ''))
    expect(words).toEqual(['&gt;Commandes', '@Onglets', 'Historique', 'Notifications', 'Copier', 'Coller'])
  })

  it('come after « Notifications », which opens the recent notifications at a click, named in full for a screen reader', () => {
    const opened: unknown[] = []
    holder.bridge = { openOverlay: (request: unknown) => void opened.push(request) }
    const markup = bar()
    expect(row(markup)).toContain('<button type="button" class="cb-quick" aria-label="Notifications récentes">Notifications</button>')
    const quick = barElements().find((element) => element.props['className'] === 'cb-quick')
    ;(quick!.props['onClick'] as () => void)()
    expect(opened).toEqual([{ panel: 'notices' }])
  })

  it('keep the genres in a group of their own, so that the buttons are not read as genres', () => {
    const chips = row(bar())
    const group = /<div class="cb-genres" role="group" aria-label="Filtrer par type">([\s\S]*?)<\/div>/.exec(chips)?.[1] ?? ''
    expect([...group.matchAll(/aria-pressed/g)]).toHaveLength(3)
    expect(group).not.toContain('Copier')
    expect(group).not.toContain('Coller')
  })

  it('are two buttons of their own, each with a word and a longer name that starts with it, and the same text as a tooltip', () => {
    const chips = row(bar())
    const copy = /<button type="button" class="cb-clip-copy[^"]*" title="([^"]*)" aria-label="([^"]*)">Copier<\/button>/.exec(chips)
    const paste = /<button type="button" class="cb-clip-paste" title="([^"]*)" aria-label="([^"]*)">Coller<\/button>/.exec(chips)
    expect(copy).not.toBeNull()
    expect(paste).not.toBeNull()
    expect(copy![2]).toBe('Copier le texte du champ, ou l’adresse de la page si le champ est vide')
    expect(paste![2]).toBe('Coller le presse-papiers à la place du texte du champ')
    expect(copy![1]).toBe(copy![2])
    expect(paste![1]).toBe(paste![2])
    expect(copy![2]!.startsWith('Copier')).toBe(true)
    expect(paste![2]!.startsWith('Coller')).toBe(true)
  })

  it('are a group named for a screen reader, with a live region that is in the markup before anything is said', () => {
    const chips = row(bar())
    expect(chips).toContain('<div class="cb-clip" role="group" aria-label="Presse-papiers">')
    expect(chips).toMatch(/<span class="cb-clip-note " role="status" aria-live="polite" aria-atomic="true"><\/span>/)
  })

  it('are not in the bar of the Mini-fenêtre, which has no row of genres and its own layout', () => {
    const markup = bar({}, { little: true })
    expect(markup).toContain('cb-little')
    for (const absent of ['cb-chips', 'cb-clip', 'Copier', 'Coller', 'cb-genres']) expect(markup, absent).not.toContain(absent)
  })

  it('are in the bar opened for a new tab, for a split view, and with a page open', () => {
    for (const mode of ['new', 'split', 'current'] as const) expect(bar({}, { mode }, { page: true }), mode).toContain('class="cb-clip"')
  })

  it('read in English when the interface does', () => {
    setLanguage('en')
    const chips = row(bar())
    expect([...chips.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, '')).slice(-2)).toEqual(['Copy', 'Paste'])
    expect(chips).toContain('aria-label="Clipboard"')
    expect(chips).toContain('Copy the field’s text, or the page address if the field is empty')
  })

  it('take no focus from the field when clicked (the pointer would take the caret away), as the chips do, and each reaches its own action', () => {
    const copied = vi.fn()
    const pasted = vi.fn()
    const buttons = elementsOf(BarClipboardButtons({ notice: null, onCopy: copied, onPaste: pasted })).filter((element) => element.type === 'button')
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      const onMouseDown = button.props['onMouseDown'] as ((event: unknown) => void) | undefined
      expect(onMouseDown, 'the button handles the pointer going down').toBeTypeOf('function')
      const event = { preventDefault: vi.fn() }
      onMouseDown!(event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    const [copy, paste] = buttons as [ReactElement<Record<string, unknown>>, ReactElement<Record<string, unknown>>]
    ;(copy.props['onClick'] as () => void)()
    expect([copied.mock.calls.length, pasted.mock.calls.length]).toEqual([1, 0])
    ;(paste.props['onClick'] as () => void)()
    expect([copied.mock.calls.length, pasted.mock.calls.length]).toEqual([1, 1])
  })

  it('are real buttons, which the keyboard reaches: they are not taken out of the order of the Tab key', () => {
    const clip = /<div class="cb-clip"[\s\S]*$/.exec(row(bar()))?.[0] ?? ''
    expect(clip.match(/<button type="button"/g)).toHaveLength(2)
    expect(clip).not.toContain('tabindex')
  })

  it('leave the field to the Tab key, which only completes a site search when the bar offers one', () => {
    const wikipedia = { keyword: 'wk', name: 'Wikipédia', url: 'https://fr.wikipedia.org/w/index.php?search=%s' }
    const tabIn = (initial: string, shiftKey = false): { preventDefault: ReturnType<typeof vi.fn> } => {
      const field = barElements({ siteSearches: [wikipedia] }, { initial }).find((element) => element.props['role'] === 'combobox')
      expect(field, 'the field is in the bar').toBeDefined()
      const event = { key: 'Tab', shiftKey, metaKey: false, preventDefault: vi.fn() }
      ;(field!.props['onKeyDown'] as (event: unknown) => void)(event)
      return event
    }
    // Nothing to complete: the key is not swallowed, the focus goes on to the genres, then to "Copier" and "Coller".
    expect(tabIn('zzzzzz').preventDefault).not.toHaveBeenCalled()
    // "wk" is the keyword of a site search: Tab completes it (a pill) and keeps the focus in the field.
    expect(tabIn('wk').preventDefault).toHaveBeenCalledOnce()
    // Shift+Tab goes back, whatever the bar offers: it completed the keyword too, and the focus could not leave the field backwards.
    expect(tabIn('wk', true).preventDefault).not.toHaveBeenCalled()
  })
})

describe('what the buttons do in the bar (the wiring of the handlers; their logic is in bar-clipboard.test.ts)', () => {
  const clipboard = () => {
    const written: string[] = []
    holder.bridge = {
      writeClipboardText: async (text: string) => {
        written.push(text)
        return true
      },
      readClipboardText: vi.fn(async () => ({ ok: true as const, text: 'un texte' }))
    }
    return written
  }
  const TRACKED = 'https://exemple.org/page?id=7&utm_source=news&gclid=abc'
  const buttons = (patch: Partial<Settings>, initial = '') => barElements(patch, { initial }, { page: TRACKED }).find((element) => element.type === BarClipboardButtons)!.props as { onCopy(): void; onPaste(): void }

  it('copies what the field shows, or the address of the tab when the field is empty, without the tracking parameters when the setting asks', async () => {
    const written = clipboard()
    buttons({ stripCopiedLinks: false }).onCopy()
    await vi.waitFor(() => expect(written).toEqual([TRACKED]))
    buttons({ stripCopiedLinks: true }).onCopy()
    await vi.waitFor(() => expect(written).toEqual([TRACKED, 'https://exemple.org/page?id=7']))
    buttons({ stripCopiedLinks: true }, 'exemple').onCopy()
    await vi.waitFor(() => expect(written).toEqual([TRACKED, 'https://exemple.org/page?id=7', 'exemple']))
  })

  it('pastes over the whole field: the text replaces the query, nothing is completed, the list starts again at its first line, the caret goes to the end', () => {
    const steps: string[] = []
    const field = {
      say: (notice: { kind: string }) => void steps.push(`say ${notice.kind}`),
      setTyping: (typing: boolean) => void steps.push(`typing ${typing}`),
      setQuery: (text: string) => void steps.push(`query ${text}`),
      setSelected: (index: number) => void steps.push(`selected ${index}`),
      caretToEnd: () => void steps.push('caret at the end')
    }
    applyPaste({ text: 'un texte' }, field)
    expect(steps).toEqual(['typing false', 'query un texte', 'selected 0', 'say pasted', 'caret at the end'])
  })

  it('leaves the field as it is when the paste only has a notice to say', () => {
    const steps: string[] = []
    const field = { say: (notice: { kind: string }) => void steps.push(`say ${notice.kind}`), setTyping: () => void steps.push('typing'), setQuery: () => void steps.push('query'), setSelected: () => void steps.push('selected'), caretToEnd: () => void steps.push('caret') }
    applyPaste({ notice: { kind: 'problem', message: 'Rien à coller' } }, field)
    expect(steps).toEqual(['say problem'])
  })

  it('pastes by reading the clipboard through the bridge once, and never writes to it', async () => {
    const written = clipboard()
    const read = holder.bridge['readClipboardText'] as ReturnType<typeof vi.fn>
    buttons({}).onPaste()
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(written).toEqual([])
  })
})

describe('what the buttons show after they were used', () => {
  const draw = (notice: Parameters<typeof BarClipboardButtons>[0]['notice']) => renderToStaticMarkup(createElement(BarClipboardButtons, { notice, onCopy: () => undefined, onPaste: () => undefined }))

  it('say "Copié" on the button for a moment after a copy, and to a screen reader', () => {
    const markup = draw({ kind: 'copied' })
    expect(markup).toMatch(/<button type="button" class="cb-clip-copy done"[^>]*aria-label="Copié">Copié<\/button>/)
    expect(markup).toMatch(/<span class="cb-clip-note " role="status" aria-live="polite" aria-atomic="true">Copié<\/span>/)
    expect(markup).toContain('>Coller</button>')
  })

  it('go back to "Copier" when the notice is taken away', () => {
    expect(draw(null)).toMatch(/<button type="button" class="cb-clip-copy "[^>]*>Copier<\/button>/)
    expect(draw(null)).not.toContain('Copié')
  })

  it('say "Collé" to a screen reader after a paste, and keep "Copier" on its button', () => {
    const markup = draw({ kind: 'pasted' })
    expect(markup).toMatch(/aria-atomic="true">Collé<\/span>/)
    expect(markup).toContain('>Copier</button>')
  })

  it('show the sentence of a problem, in the markup, beside the buttons (nothing is silent)', () => {
    const markup = draw({ kind: 'problem', message: 'Aucun texte à coller.' })
    expect(markup).toMatch(/<span class="cb-clip-note problem" title="Aucun texte à coller\." role="status" aria-live="polite" aria-atomic="true">Aucun texte à coller\.<\/span>/)
    expect(markup).toContain('>Copier</button>')
    expect(markup.indexOf('cb-clip-note')).toBeLessThan(markup.indexOf('cb-clip-copy'))
  })

  it('escape the sentence: a message is text, never markup', () => {
    const markup = draw({ kind: 'problem', message: '<img src=x onerror=alert(1)>' })
    expect(markup).not.toContain('<img')
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('the size and the shape of the card', () => {
  // `@` narrows the bar to the open tabs: with none that answers, there are no lines to choose from and the card holds the field alone.
  const ALONE = '@zzzzzz'

  it('is, by default, the card the bar always had: 720 px wide with lines to choose from, a list of 380 px, a preview of 250 px', () => {
    const markup = bar()
    expect(markup).toContain('cb-wide')
    expect(cardVariables(markup)).toMatchObject({ '--cb-width': '720px', '--cb-list': '380px', '--cb-preview': '250px' })
    expect(barLayout(1, false)).toEqual({ width: BAR_WIDTH.results, preview: true })
  })

  it('is, by default, 640 px wide for the field alone', () => {
    const markup = bar({}, { initial: ALONE })
    expect(markup).not.toContain('cb-wide')
    expect(markup).toContain('role="combobox"')
    expect(markup).toContain('aria-expanded="false"')
    expect(cardVariables(markup)).toMatchObject({ '--cb-width': '640px', '--cb-list': '380px', '--cb-preview': '250px' })
    expect(barLayout(0, false)).toEqual({ width: BAR_WIDTH.field, preview: false })
  })

  it.each(COMMAND_BAR_SIZES.flatMap((size) => COMMAND_BAR_SHAPES.map((shape) => [size, shape] as const)))('reads %s and %s from the settings, and sets what barBox says, with lines and for the field alone', (size: CommandBarSize, shape: CommandBarShape) => {
    const withLines = bar({ commandBarSize: size, commandBarShape: shape })
    const box = barBox(size, shape, true)
    expect(withLines).toContain('cb-wide')
    expect(cardVariables(withLines)).toMatchObject({ '--cb-width': `${box.width}px`, '--cb-list': `${box.list}px`, '--cb-preview': `${box.previewWidth}px` })
    const alone = bar({ commandBarSize: size, commandBarShape: shape }, { initial: ALONE })
    expect(alone).not.toContain('cb-wide')
    expect(cardVariables(alone)).toMatchObject({ '--cb-width': `${barBox(size, shape, false).width}px`, '--cb-list': `${box.list}px` })
  })

  it('makes the card larger for XL than for S, as drawn', () => {
    const small = cardVariables(bar({ commandBarSize: 's' }))!
    const large = cardVariables(bar({ commandBarSize: 'xl' }))!
    for (const key of ['--cb-width', '--cb-list', '--cb-preview']) expect(parseInt(large[key]!, 10), key).toBeGreaterThan(parseInt(small[key]!, 10))
  })

  it('gives back the default card for a setting that is not one of the words', () => {
    const damaged = cardVariables(bar({ commandBarSize: 'huge' as never, commandBarShape: 7 as never }))!
    expect(damaged).toEqual(cardVariables(bar())!)
  })

  it('keeps the split view as it was, with the size applied to its card', () => {
    const markup = bar({ commandBarSize: 'l' }, { mode: 'split' })
    expect(markup).toContain('cb-split')
    expect(parseInt(cardVariables(markup)!['--cb-width']!, 10)).toBeGreaterThan(640)
  })

  it('sets nothing on the card of the Mini-fenêtre, which fills its own window', () => {
    holder.snapshot = snapshotWith({ commandBarSize: 'xl', commandBarShape: 'wide' })
    const markup = renderToStaticMarkup(createElement(CommandBar, { mode: 'current', initial: '', little: { id: 'little-1' } }))
    expect(cardVariables(markup)).toBeNull()
    expect(markup).not.toContain('--cb-width')
  })

  it('leaves the Onglets mode (TabSearch) its own card, which sets none of the variables', () => {
    holder.snapshot = snapshotWith({ commandBarSize: 'xl', commandBarShape: 'wide' })
    const variables = cardVariables(renderToStaticMarkup(createElement(TabSearch)))
    // The card has a style of its own (its colours), and none of the size or of the shape.
    expect(variables).not.toBeNull()
    expect(Object.keys(variables!)).not.toEqual([])
    for (const name of ['--cb-width', '--cb-list', '--cb-preview']) expect(variables, name).not.toHaveProperty(name)
  })
})

describe('the style sheet of the command bar', () => {
  const rules = [...commandBarCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim().replace(/\s+/g, ' '), body: m[2]! }))
  /** The declarations of every rule whose selector matches (the same selector can be written again in a media query). */
  const rule = (selector: RegExp): string => rules.filter((r) => selector.test(r.selector)).map((r) => r.body).join(' ')

  it('has, for the card, the numbers of the size M and the balanced shape as defaults (the Onglets mode sets none)', () => {
    const card = rule(/^body:is\(\.overlay, \.little\) \.palette:not\(\.cb-little\)$/)
    expect(card).toContain('--cb-width: 640px;')
    expect(card).toContain('--cb-list: 380px;')
    expect(card).toContain('--cb-preview: 250px;')
    expect(rule(/^body:is\(\.overlay, \.little\) \.palette\.cb-wide$/)).toContain('--cb-width: 720px;')
  })

  it('reads the width, the list and the preview column from the variables', () => {
    expect(rule(/^body:is\(\.overlay, \.little\) \.palette:not\(\.cb-little\) \.results$/)).toContain('max-height: min(var(--cb-list), calc(100vh - var(--cb-top) - 210px))')
    expect(rule(/palette\.cb-wide:not\(\.cb-tabs\) \.cb-body$/)).toContain('grid-template-columns: minmax(0, 1fr) var(--cb-preview)')
    expect(commandBarCss).not.toMatch(/minmax\(0, 1fr\) 250px/)
    expect(commandBarCss).not.toMatch(/max-height: min\(380px/)
  })

  it('never lets the card beyond the window, whatever size is chosen', () => {
    const card = rule(/^body:is\(\.overlay, \.little\) \.palette:not\(\.cb-little\)$/)
    expect(card).toContain('left: max(8px, calc(50% - var(--cb-width) / 2))')
    expect(card).toContain('width: min(var(--cb-width), calc(100% - 16px))')
    expect(card).toContain('max-height: calc(100% - var(--cb-top) - 16px)')
    // The list keeps the room under the card as its limit, at every size.
    expect(rule(/\.palette:not\(\.cb-little\) \.results$/)).toContain('calc(100vh - var(--cb-top) - 210px)')
  })

  it('keeps the card of a split view inside the window too: the left edge is never negative, and follows the width the card really has', () => {
    const split = rule(/\.palette\.cb-split:not\(\.cb-little\)$/)
    expect(split).toContain('left: max(8px, min(calc(50% - 6px), calc(100% - min(var(--cb-width), calc(100% - 16px)) - 8px)))')
  })

  it('leaves the Mini-fenêtre alone: none of its rules reads a variable of the size', () => {
    const little = rules.filter((r) => /\.cb-little/.test(r.selector) && !/:not\(\.cb-little\)/.test(r.selector))
    expect(little.length).toBeGreaterThan(20)
    for (const { selector, body } of little) expect(`${selector}{${body}}`, selector).not.toMatch(/--cb-(width|list|preview)/)
  })

  it('draws the buttons on the height of a control (--target), in tokens, and does not let the row wrap', () => {
    expect(rule(/\.cb-clip button$/)).toContain('min-height: var(--target)')
    expect(rule(/\.cb-clip button$/)).toMatch(/background: var\(--tile\)/)
    const row = rule(/\.palette \.cb-chips$/)
    expect(row).toContain('display: flex')
    expect(row).not.toContain('flex-wrap')
    expect(rule(/\.palette \.cb-clip$/)).toContain('margin-left: auto')
    // The sentence of a problem is the part that gives way when the row is short.
    expect(rule(/\.cb-clip-note$/)).toMatch(/overflow: hidden;[^}]*text-overflow: ellipsis/)
  })

  it('shows the sentence of a problem and hides a confirmation (it is said, not shown: the button says "Copié")', () => {
    expect(rule(/\.cb-clip-note\.problem$/)).toContain('color: var(--warn-ink)')
    expect(rule(/\.cb-clip-note:not\(\.problem\)$/)).toMatch(/clip: rect\(0 0 0 0\)/)
  })

  it('styles the chips of the genres by their own group, so that the new buttons do not take the look of a chip that switches a genre on', () => {
    expect(commandBarCss).toMatch(/\.cb-genres button\[aria-pressed='true'\]/)
    expect(commandBarCss).not.toMatch(/\.cb-chips button/)
  })
})

describe('Settings › Barre de commandes › Apparence de la barre de commandes', () => {
  const draw = (patch: Partial<Settings> = {}): string => {
    vi.stubGlobal('location', { hash: '#navigation' })
    return renderToStaticMarkup(createElement(SettingsView, { snapshot: snapshotWith(patch), initialQuery: '', initialOpen: null }))
  }
  const menu = (markup: string, label: string) => new RegExp(`<select[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</select>`).exec(markup)?.[1] ?? ''
  const options = (html: string) => [...html.matchAll(/<option value="([a-z]+)"( selected="")?[^>]*>([^<]*)</g)].map((m) => `${m[1]}:${m[3]}${m[2] ? '*' : ''}`)

  it('has a group of its own, with a menu of the four sizes and a menu of the three shapes', () => {
    const markup = draw()
    expect(markup).toContain('<span class="pref-title">Apparence de la barre de commandes</span>')
    expect(markup).toContain('data-setting="commandBarSize"')
    expect(markup).toContain('data-setting="commandBarShape"')
    expect(options(menu(markup, 'Taille de la barre de commandes')).map((o) => o.replace('*', ''))).toEqual(['s:Petite (S)', 'm:Moyenne (M)', 'l:Grande (L)', 'xl:Très grande (XL)'])
    expect(options(menu(markup, 'Forme de la barre de commandes')).map((o) => o.replace('*', ''))).toEqual(['balanced:Équilibrée', 'wide:Large', 'tall:Haute'])
  })

  it('lists the options in the order of the model, so that a size added there is added here', () => {
    const markup = draw()
    expect(options(menu(markup, 'Taille de la barre de commandes')).map((o) => o.split(':')[0])).toEqual([...COMMAND_BAR_SIZES])
    expect(options(menu(markup, 'Forme de la barre de commandes')).map((o) => o.split(':')[0])).toEqual([...COMMAND_BAR_SHAPES])
  })

  it('shows M and balanced for a new profile, and the choice that was made otherwise', () => {
    const fresh = draw()
    expect(options(menu(fresh, 'Taille de la barre de commandes')).filter((o) => o.endsWith('*'))).toEqual(['m:Moyenne (M)*'])
    expect(options(menu(fresh, 'Forme de la barre de commandes')).filter((o) => o.endsWith('*'))).toEqual(['balanced:Équilibrée*'])
    for (const size of COMMAND_BAR_SIZES) expect(options(menu(draw({ commandBarSize: size }), 'Taille de la barre de commandes')).filter((o) => o.endsWith('*')).map((o) => o.split(':')[0])).toEqual([size])
    for (const shape of COMMAND_BAR_SHAPES) expect(options(menu(draw({ commandBarShape: shape }), 'Forme de la barre de commandes')).filter((o) => o.endsWith('*')).map((o) => o.split(':')[0])).toEqual([shape])
  })

  it('puts a dot on the category and a mark on the row when the choice is not the default', () => {
    expect(draw()).not.toContain('pref-changed')
    const changed = draw({ commandBarSize: 'xl' })
    expect(changed).toContain('<span class="pref-changed settings-cat-changed" title="Modifié"><span class="sr-only">1 réglage modifié</span></span>')
  })

  it('reads in English when the interface does', () => {
    setLanguage('en')
    const markup = draw()
    expect(markup).toContain('<span class="pref-title">Appearance of the command bar</span>')
    expect(options(menu(markup, 'Size of the command bar')).map((o) => o.replace('*', ''))).toEqual(['s:Small (S)', 'm:Medium (M)', 'l:Large (L)', 'xl:Extra large (XL)'])
    expect(options(menu(markup, 'Shape of the command bar')).map((o) => o.replace('*', ''))).toEqual(['balanced:Balanced', 'wide:Wide', 'tall:Tall'])
  })

  it('writes the choice as the word of the model, with nothing else', () => {
    const update = vi.fn()
    let tree: ReactNode = null
    const Probe = () => {
      tree = CommandBarSettings({ snapshot: snapshotWith(), update })
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    const choose = (label: string, value: string): void => {
      const field = elementsOf(tree).find((element) => element.type === 'select' && element.props['aria-label'] === label)
      expect(field, label).toBeDefined()
      ;(field!.props['onChange'] as (event: unknown) => void)({ target: { value } })
    }
    for (const size of COMMAND_BAR_SIZES) {
      choose('Taille de la barre de commandes', size)
      expect(update).toHaveBeenLastCalledWith({ commandBarSize: size })
    }
    for (const shape of COMMAND_BAR_SHAPES) {
      choose('Forme de la barre de commandes', shape)
      expect(update).toHaveBeenLastCalledWith({ commandBarShape: shape })
    }
  })
})
