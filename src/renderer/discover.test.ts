// @vitest-environment happy-dom
// « Découvrir Lucium » (Discover.tsx), drawn and used in a document: the search and the chips narrow the cards, a card says where to find the function and its
// shortcut as it is set now, « Essayer » does the real thing (a panel, a call the interface already makes), « Régler » opens the setting, a function that is
// switched off says so and offers only the setting, and the keyboard works alone: Tab reaches every button, Escape empties the search then closes.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_DISCOVER_ENTRIES, DISCOVER_ENTRIES, REGISTRY_ENTRIES, discoverSettingsRequest, filterDiscover } from '@shared/discover'
import { FEATURES, featureById } from '@shared/features'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import { defaultSettings, type Settings, type SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as Array<[string, unknown[]]> }))
vi.mock('./api', () => {
  const act = new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => void holder.asked.push([name, args]) })
  return { api: () => act, useSnapshot: () => holder.snapshot }
})

import { Discover } from './Discover'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

function show(settings: Partial<Settings> = {}, platform = 'darwin'): void {
  const state: SidebarState = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), ...settings } }
  holder.snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, platform }
  act(() => root.render(createElement(Discover)))
}

beforeEach(() => {
  setLanguage('fr')
  holder.asked = []
  holder.snapshot = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setLanguage('fr')
})

const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('article.dv-card')]
const cardNamed = (name: string): HTMLElement => cards().find((card) => card.querySelector('h4')?.textContent === name)!
const button = (within: ParentNode, label: string): HTMLButtonElement | undefined => [...within.querySelectorAll('button')].find((b) => b.textContent === label)
const click = (el: Element | undefined): void => void act(() => (el as HTMLElement).click())
const type = (value: string): void => {
  const field = host.querySelector<HTMLInputElement>('input[type="search"]')!
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const discoverNameOf = (entry: (typeof REGISTRY_ENTRIES)[number]): string => featureById(entry.feature!).label
const status = (): string => host.querySelector('[role="status"]')!.textContent ?? ''
const calls = (name: string): unknown[][] => holder.asked.filter(([called]) => called === name).map(([, args]) => args)

describe('the panel', () => {
  it('draws nothing until the first snapshot has arrived', () => {
    act(() => root.render(createElement(Discover)))
    expect(host.innerHTML).toBe('')
  })

  it('is a dialog named by its title, with a labelled search, chips that say which one is pressed, and a status that is announced', () => {
    show()
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(host.querySelector(`#${dialog.getAttribute('aria-labelledby')}`)?.textContent).toBe('Découvrir Lucium')
    expect(host.querySelector('[role="search"] input')?.getAttribute('aria-label')).toBe('Chercher une fonction')
    const groups = [...host.querySelectorAll('[role="group"][aria-label]')].map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(expect.arrayContaining(['Que voulez-vous faire ?', 'Niveau']))
    const pressed = [...host.querySelectorAll('.tk-chip[aria-pressed="true"]')].map((chip) => chip.textContent)
    expect(pressed).toHaveLength(2)
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite')
    expect(status()).toContain('fonctions affichées')
  })

  it('shows one card for each function of Lucium, under the heading of its task, each card named by its heading, and says the exact count', () => {
    show()
    expect(cards()).toHaveLength(ALL_DISCOVER_ENTRIES.length)
    expect(ALL_DISCOVER_ENTRIES.length).toBeGreaterThanOrEqual(FEATURES.length)
    expect(status()).toBe(`${ALL_DISCOVER_ENTRIES.length} fonctions affichées.`)
    expect(host.querySelector('.dv-other')).toBeNull()
    expect([...host.querySelectorAll('section.dv-group > h3')].map((h) => h.textContent).slice(0, 6)).toEqual(['Aller plus vite', 'Organiser mes onglets', 'Lire et travailler', 'Garder et capturer', 'Me concentrer', 'Protéger ma vie privée'])
    for (const card of cards()) {
      const heading = card.querySelector('h4')!
      expect(card.getAttribute('aria-labelledby')).toBe(heading.id)
      for (const b of card.querySelectorAll('button')) expect(b.getAttribute('aria-describedby'), heading.textContent ?? '').toBe(heading.id)
    }
  })

  it('names each button by its action and its function, so that a list of buttons tells them apart (« Essayer, Captures »)', () => {
    show()
    const capture = cardNamed('Captures')
    expect(button(capture, 'Essayer')?.getAttribute('aria-label')).toBe('Essayer, Captures')
    expect(button(capture, 'Régler')?.getAttribute('aria-label')).toBe('Régler, Captures')
    const names = [...host.querySelectorAll('article button')].map((b) => b.getAttribute('aria-label'))
    expect(names.every((name) => name !== null && /^(Essayer|Régler|Mettre l’animation en pause|Reprendre l’animation), ./.test(name))).toBe(true)
    // The name begins with the visible text (WCAG 2.5.3, label in name), and no two buttons of a card share a name.
    for (const b of host.querySelectorAll('article button')) expect(b.getAttribute('aria-label')!.startsWith(b.textContent!)).toBe(true)
    for (const card of cards()) {
      const labels = [...card.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
      expect(new Set(labels).size).toBe(labels.length)
    }
    setLanguage('en')
    show()
    expect(button(cardNamed('Screenshots'), 'Try it')?.getAttribute('aria-label')).toBe('Try it, Screenshots')
    expect(button(cardNamed('Screenshots'), 'Adjust')?.getAttribute('aria-label')).toBe('Adjust, Screenshots')
  })

  it('says where to find the function, and what level and novelty it is, in words (never by colour alone)', () => {
    show()
    const card = cardNamed('Captures')
    expect(card.querySelector('.dv-where')?.textContent).toContain('Où')
    expect(card.querySelector('.dv-where')?.textContent).toContain('Fichier › Capturer')
    expect(card.querySelector('.dv-badge.level')?.textContent).toBe('Pour débuter')
    expect(cardNamed('Capture de la page entière').textContent).toContain('Nouveau')
    expect(cardNamed('Captures').textContent).not.toContain('Nouveau')
  })
})

describe('the shortcut of a card', () => {
  it('is the one in force: the default, the one the person gave, none, and the keys of the system', () => {
    show()
    expect([...cardNamed('Captures').querySelectorAll('.dv-keys kbd')].map((k) => k.textContent)).toEqual(['⇧', '⌘', '2'])
    expect(cardNamed('Captures').querySelector('.dv-keys')?.getAttribute('aria-label')).toBe(frenchSpaces('Raccourci : ⇧ ⌘ 2'))
    // The capsules are drawn for the eye; the group says the keys once, to the screen reader.
    for (const kbd of cardNamed('Captures').querySelectorAll('.dv-keys kbd')) expect(kbd.getAttribute('aria-hidden')).toBe('true')
    show({ keyBindings: { captureRegion: 'CmdOrCtrl+Alt+9' } })
    expect([...cardNamed('Captures').querySelectorAll('.dv-keys kbd')].map((k) => k.textContent)).toEqual(['⌥', '⌘', '9'])
    show({ keyBindings: { captureRegion: '' } })
    expect(cardNamed('Captures').querySelector('.dv-keys')).toBeNull()
    expect(cardNamed('Captures').querySelector('.dv-nokey')?.textContent).toBe('Pas de raccourci')
    show({}, 'win32')
    expect(cardNamed('Captures').querySelector('.dv-keys')?.getAttribute('aria-label')).toContain('Ctrl')
  })
})

describe('« Essayer »', () => {
  it('opens the panel the card leads to, after closing this one', () => {
    show()
    click(button(cardNamed('Barre de commandes'), 'Essayer'))
    expect(holder.asked).toEqual([['closeOverlay', []], ['openOverlay', [{ panel: 'commandbar', mode: 'new', initial: '' }]]])
  })

  it('makes the call the interface already makes for a capture of the whole page, a save as Markdown, a private tab', () => {
    show({ privateTabs: true })
    click(button(cardNamed('Capture de la page entière'), 'Essayer'))
    expect(holder.asked).toEqual([['closeOverlay', []], ['captureFullPage', []]])
    click(button(cardNamed('Enregistrer la page en Markdown'), 'Essayer'))
    expect(calls('markdownExport')).toEqual([['save']])
    click(button(cardNamed('Onglet privé'), 'Essayer'))
    expect(calls('newPrivateTab')).toEqual([[]])
    expect(calls('openOverlay')).toEqual([])
    // The panel is closed before each of the three calls: a tab, a capture or a save box opened behind a modal dialog would show nothing.
    expect(holder.asked.map(([name]) => name)).toEqual(['closeOverlay', 'captureFullPage', 'closeOverlay', 'markdownExport', 'closeOverlay', 'newPrivateTab'])
  })

  it('is offered on no card that only gives a way to start (a click on a tab, a page) or is a setting', () => {
    show({ tabReminders: true })
    const reminder = cardNamed('Rappel d’onglet')
    expect(button(reminder, 'Essayer')).toBeUndefined()
    expect(reminder.querySelector('.dv-note')?.textContent).toContain('se lance depuis un menu, un geste ou une page')
    const focus = cardNamed('Mode concentration')
    expect(button(focus, 'Essayer')).toBeUndefined()
    expect(button(focus, 'Régler')?.className).toContain('primary')
  })
})

describe('« Régler »', () => {
  it('opens the page of the Settings of the function, after closing this panel', () => {
    show()
    const entry = DISCOVER_ENTRIES.find((e) => e.id === 'capture')!
    click(button(cardNamed('Captures'), 'Régler'))
    expect(holder.asked).toEqual([['closeOverlay', []], ['openOverlay', [discoverSettingsRequest(entry)]]])
  })

  it('is on every card, the cards of the registry alone included, with the page that holds the setting', () => {
    show()
    for (const card of cards()) expect(button(card, 'Régler'), card.querySelector('h4')?.textContent ?? '').toBeDefined()
    const entry = REGISTRY_ENTRIES[0]!
    const first = cards().find((card) => card.querySelector('h4')?.textContent === discoverNameOf(entry))!
    click(button(first, 'Régler'))
    expect(holder.asked).toEqual([['closeOverlay', []], ['openOverlay', [discoverSettingsRequest(entry)]]])
    expect(first.querySelector('.dv-where')?.textContent).toContain('Réglages')
  })
})

describe('a function that is switched off', () => {
  it('says so in words, offers only the setting (as the main button) and keeps « Essayer » away: it would do nothing', () => {
    show({ bookmarkManager: false })
    const card = cardNamed('Bibliothèque de signets avec étiquettes')
    expect(card.querySelector('.dv-badge.off')?.textContent).toBe('Désactivée pour l’instant')
    expect(card.querySelector('.dv-note')?.textContent).toContain('Activez-la')
    expect(button(card, 'Essayer')).toBeUndefined()
    expect(button(card, 'Régler')?.className).toContain('primary')
    show({ bookmarkManager: true })
    const on = cardNamed('Bibliothèque de signets avec étiquettes')
    expect(on.querySelector('.dv-badge.off')).toBeNull()
    expect(button(on, 'Essayer')).toBeDefined()
  })
})

describe('the search and the chips', () => {
  it('narrow the cards by the words of everyday, say how many are left, and bring the cards back when the search is cleared', () => {
    show()
    type('marque-pages')
    expect(cards().map((card) => card.querySelector('h4')?.textContent)).toEqual(['Signets et historique par préfixe', 'Bibliothèque de signets avec étiquettes'])
    expect(status()).toMatch(/fonction/)
    type('')
    expect(cards()).toHaveLength(ALL_DISCOVER_ENTRIES.length)
  })

  it('counts, on each chip, the cards the words and the level would show, whatever task is chosen', () => {
    show()
    const count = (label: string): string => ([...host.querySelectorAll('.tk-chip')].find((c) => c.textContent?.startsWith(label))?.querySelector('.dv-n')?.textContent ?? '')
    expect(count('Tout')).toBe(String(ALL_DISCOVER_ENTRIES.length))
    type('capture')
    const wanted = filterDiscover({ query: 'capture', task: 'all', level: 'all' })
    expect(count('Tout')).toBe(String(wanted.length))
    expect(count('Garder et capturer')).toBe(String(wanted.filter((e) => e.task === 'keep').length))
    expect(count('Protéger ma vie privée')).toBe(String(wanted.filter((e) => e.task === 'protect').length))
    for (const chip of host.querySelectorAll('.dv-n')) expect(chip.getAttribute('aria-hidden')).toBe('true')
  })

  it('says nothing matches, with a way out that clears the search', () => {
    show()
    type('xyzzy')
    expect(cards()).toHaveLength(0)
    expect(status()).toBe('Aucune fonction ne correspond.')
    expect(host.querySelector('.dv-empty')?.textContent).toContain('Rien ne correspond')
    click(button(host, 'Effacer la recherche'))
    expect(host.querySelector('.dv-empty')).toBeNull()
    expect(cards()).toHaveLength(ALL_DISCOVER_ENTRIES.length)
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('')
  })

  it('filter by task and by level, and mark the chip pressed', () => {
    show()
    const chip = (label: string): HTMLButtonElement => button(host, label) ?? ([...host.querySelectorAll('.tk-chip')].find((c) => c.textContent?.startsWith(label)) as HTMLButtonElement)
    click(chip('Garder et capturer'))
    expect(chip('Garder et capturer').getAttribute('aria-pressed')).toBe('true')
    expect(chip('Tout').getAttribute('aria-pressed')).toBe('false')
    expect([...host.querySelectorAll('section.dv-group > h3')].map((h) => h.textContent)).toEqual(['Garder et capturer'])
    expect(cards().length).toBe(ALL_DISCOVER_ENTRIES.filter((e) => e.task === 'keep').length)
    click(chip('Pour débuter'))
    expect(cards().every((card) => card.querySelector('.dv-badge.level')?.textContent === 'Pour débuter')).toBe(true)
    expect([...host.querySelectorAll('article')].some((card) => card.textContent?.includes('Avancé'))).toBe(false)
  })
})

describe('the keyboard', () => {
  const key = (target: Element, name: string): void => void act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })))

  it('empties the search with Escape, and closes the panel with the next one', () => {
    show()
    type('capture')
    key(host.querySelector('input[type="search"]')!, 'Escape')
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('')
    expect(calls('closeOverlay')).toEqual([])
    key(host.querySelector('input[type="search"]')!, 'Escape')
    expect(calls('closeOverlay')).toEqual([[]])
  })

  it('has a button to close, named, and every control is a real button or field that Tab reaches (no clickable box)', () => {
    show()
    expect(button(host, '')?.getAttribute('aria-label')).toContain('Fermer')
    expect(host.querySelectorAll('[onclick], [role="button"], div[tabindex="0"]:not(.dv-body)')).toHaveLength(0)
    for (const b of host.querySelectorAll('button')) expect(b.getAttribute('type')).toBe('button')
    expect(host.querySelector('.dv-body')?.getAttribute('tabindex')).toBe('0')
  })

  it('moves the focus into the search when it opens', () => {
    show()
    expect(document.activeElement).toBe(host.querySelector('input[type="search"]'))
  })
})

describe('in English', () => {
  it('speaks English: title, tasks, buttons, the sentence that says where to find it', () => {
    setLanguage('en')
    show()
    expect(host.querySelector('h2')?.textContent).toBe('Discover Lucium')
    expect([...host.querySelectorAll('section.dv-group > h3')].map((h) => h.textContent).slice(0, 2)).toEqual(['Go faster', 'Organize my tabs'])
    expect(button(cardNamed('Screenshots'), 'Try it')).toBeDefined()
    expect(button(cardNamed('Screenshots'), 'Adjust')).toBeDefined()
    expect(cardNamed('Screenshots').querySelector('.dv-where')?.textContent).toContain('Menu File › Capture')
  })
})

describe('the demos in the cards', () => {
  const demoIds = ['tab-reminders', 'focus-mode', 'markdown', 'totp', 'prefixes', 'split-view', 'command-bar', 'capture']

  it('show an animated demo in the eight cards that have one, and in no other', () => {
    show()
    const figures = [...host.querySelectorAll<HTMLElement>('figure.dvd')]
    expect(figures.map((figure) => figure.dataset['demo'])).toEqual(demoIds.map((id) => ALL_DISCOVER_ENTRIES.findIndex((entry) => entry.id === id)).sort((a, b) => a - b).map((index) => ALL_DISCOVER_ENTRIES[index]!.id))
    for (const figure of figures) expect(figure.closest('article.dv-card'), figure.dataset['demo']).not.toBeNull()
    expect(cards().filter((card) => card.querySelector('figure.dvd') === null).length).toBe(ALL_DISCOVER_ENTRIES.length - demoIds.length)
  })

  it('give the text equivalent after the summary, and a pause that is named after its own card', () => {
    show()
    const card = cardNamed('Rappel d’onglet')
    const figure = card.querySelector('figure.dvd')!
    expect(figure.querySelector('figcaption')!.textContent).toContain('Texte équivalent')
    expect(card.querySelector('.dv-summary')!.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const pause = button(figure, 'Mettre l’animation en pause')!
    expect(pause.getAttribute('aria-label')).toBe('Mettre l’animation en pause, Rappel d’onglet')
    expect(pause.getAttribute('aria-describedby')).toBe(card.querySelector('h4')!.id)
  })

  it('pause and resume the animation of the card where the button is, and touch neither the other demos nor the application', () => {
    show()
    const [first, second] = [...host.querySelectorAll<HTMLElement>('figure.dvd')]
    click(button(first!, 'Mettre l’animation en pause'))
    expect(first!.dataset['paused']).toBe('true')
    expect(button(first!, 'Reprendre l’animation')).toBeDefined()
    expect(second!.dataset['paused']).toBe('false')
    click(button(first!, 'Reprendre l’animation'))
    expect(first!.dataset['paused']).toBe('false')
    expect(holder.asked).toEqual([])
  })

  it('leave the count of the cards as it was, and follow the search: a search that finds a card finds its demo', () => {
    show()
    const total = cards().length
    expect(status()).toContain(String(total))
    type('2FA')
    expect(cards().length).toBeGreaterThanOrEqual(1)
    expect(host.querySelector('figure.dvd[data-demo="totp"]')).not.toBeNull()
    expect(host.querySelector('figure.dvd[data-demo="capture"]')).toBeNull()
  })
})
