import { afterEach, describe, expect, it } from 'vitest'
import { COMMANDS } from './keybindings'
import { COMMANDS as ALL, effectiveAccelerator, findConflicts } from './keybindings'
import { LANGUAGES, setLanguage } from './i18n'
import { BASIC_SHORTCUTS, SEARCH_EXAMPLES, acceleratorWords, commandLabel, conflictAnnouncement, conflictNote, conflictPartners, matchesShortcut, queryWords, quotedNames, resolveConflicts, restoreRemoved, settleConflicts, shortcutSections, withoutConflicts } from './shortcut-view'
import { frenchSpaces } from './french-typography'

describe('shortcutSections', () => {
  it('starts with the seven essentials, in the order they were chosen', () => {
    const { basics } = shortcutSections('')
    expect(basics.map((c) => c.id)).toEqual([...BASIC_SHORTCUTS])
    expect(basics).toHaveLength(7)
  })

  it('names only commands that exist', () => {
    const known = new Set(COMMANDS.map((c) => c.id))
    expect(BASIC_SHORTCUTS.filter((id) => !known.has(id))).toEqual([])
  })

  it('lists every command alphabetically, accents and case aside', () => {
    const { all } = shortcutSections('')
    expect(all).toHaveLength(COMMANDS.length)
    const labels = all.map((c) => c.label)
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }))
    expect(labels).toEqual(sorted)
    // "Épingler…" is filed under E, not after Z.
    expect(labels.findIndex((l) => l.startsWith('Épingler'))).toBeLessThan(labels.findIndex((l) => l.startsWith('Imprimer')))
  })

  it('shows only the matches while searching, without the essentials', () => {
    const { basics, all } = shortcutSections('zoom')
    expect(basics).toEqual([])
    expect(all.map((c) => c.id).sort()).toEqual(['zoomIn', 'zoomOut'])
  })

  it('finds a word whatever its accents or case, in the label or the menu name', () => {
    expect(shortcutSections('EPINGLER').all.map((c) => c.id)).toContain('pin')
    expect(shortcutSections('espaces').all.map((c) => c.id)).toEqual(expect.arrayContaining(['nextSpace', 'previousSpace']))
  })

  it('has nothing for a word no command carries', () => {
    expect(shortcutSections('xyzzy')).toEqual({ basics: [], all: [] })
  })

  it('ignores spaces around the search', () => {
    expect(shortcutSections('  zoom  ').all).toHaveLength(2)
  })
})

const accelerators = Object.fromEntries(ALL.map((c) => [c.id, effectiveAccelerator(c.id, {})]))

describe('searching by shortcut', () => {
  it('reads the same words in a spelled-out query and in symbols', () => {
    expect(queryWords('Commande E')).toEqual(['cmd', 'e'])
    expect(queryWords('⌘e')).toEqual(['cmd', 'e'])
    expect(queryWords('cmd+shift+J')).toEqual(['cmd', 'shift', 'j'])
    expect(queryWords('Option')).toEqual(['alt'])
    expect(acceleratorWords('CmdOrCtrl+Shift+J')).toEqual(['cmd', 'shift', 'j'])
  })

  it('finds ⌘E’s command from “Commande E”, the way the placeholder promises', () => {
    expect(matchesShortcut('Commande T', 'CmdOrCtrl+T')).toBe(true)
    expect(matchesShortcut('Commande T', 'CmdOrCtrl+Shift+T')).toBe(true)
    expect(matchesShortcut('Commande T', 'CmdOrCtrl+W')).toBe(false)
    expect(matchesShortcut('Commande T', undefined)).toBe(false)
  })

  it('does not take a plain word for a shortcut: “t” alone finds commands by name only', () => {
    expect(matchesShortcut('t', 'CmdOrCtrl+T')).toBe(false)
  })

  it('lists the commands of a shortcut when it is given the accelerators in force', () => {
    const found = shortcutSections('commande t', accelerators).all.map((c) => c.id)
    expect(found).toContain('newTab')
    expect(found).toContain('restoreClosed')
    expect(shortcutSections('commande t').all).toEqual([])
  })
})

describe('the example of the search box', () => {
  it('names a shortcut that exists in each language, so that trying it shows something (“Commande E” found nothing: no command has ⌘E)', () => {
    for (const language of LANGUAGES) {
      const example = SEARCH_EXAMPLES[language]
      const found = shortcutSections(example, accelerators).all
      expect(found.length, `the example “${example}” (${language}) finds no command`).toBeGreaterThan(0)
      // It is a search by shortcut, not a word that happens to be in a name.
      expect(shortcutSections(example).all, `the example “${example}” (${language}) only matches by name`).toEqual([])
    }
  })
})

describe('searching by shortcut with the keys the list shows', () => {
  const found = (query: string): string[] => shortcutSections(query, accelerators).all.map((c) => c.id).sort()

  it('takes the symbols of the modifiers (⌘ ⇧ ⌥ ⌃) in any order, with or without a gap', () => {
    expect(found('⇧⌘T')).toEqual(['restoreClosed'])
    expect(found('⌘⇧T')).toEqual(['restoreClosed'])
    expect(found('⌥ ⌘ N')).toEqual(['newLittleArc'])
    expect(found('⌃⌘N')).toEqual(['blankWindow'])
    expect(found('⌘T')).toEqual(['newTab', 'restoreClosed'])
  })

  it('takes the French names of the modifiers, with their accents or without', () => {
    expect(found('Option Commande N')).toEqual(['newLittleArc'])
    expect(found('Maj Commande T')).toEqual(['restoreClosed'])
    expect(found('Majuscule Commande T')).toEqual(['restoreClosed'])
    expect(found('Contrôle Commande N')).toEqual(['blankWindow'])
    expect(found('controle commande n')).toEqual(['blankWindow'])
    expect(found('Ctrl+Cmd+N')).toEqual(['blankWindow'])
    expect(found('Control Command N')).toEqual(['blankWindow'])
  })

  it('takes the keys as the list draws them: ⇥ ↑ ↓ ← → ↩ ⌫ ⌦ ␣', () => {
    expect(found('⌃⇥')).toEqual(['recentTab', 'recentTabBack'])
    expect(found('⌃⇥')).toEqual(found('ctrl tab'))
    // ⌥⇧⌘↓ (Déplacer l’onglet vers le bas) holds ⌘⌥↓ too, as ⇧⌘T holds ⌘T.
    expect(found('⌘⌥↓')).toEqual(['moveTabDown', 'nextTab'])
    expect(found('⌥⇧⌘↓')).toEqual(['moveTabDown'])
    for (const [glyph, name] of [['↑', 'up'], ['↓', 'down'], ['←', 'left'], ['→', 'right']] as const) expect(queryWords(`⌘${glyph}`)).toEqual(['cmd', name])
    expect(queryWords('⌘↩')).toEqual(['cmd', 'return'])
    expect(queryWords('⌘⌫')).toEqual(['cmd', 'backspace'])
    expect(queryWords('⌘⌦')).toEqual(['cmd', 'delete'])
    expect(queryWords('⌘␣')).toEqual(['cmd', 'space'])
  })

  it('takes the French names of the keys: Tabulation, Flèche gauche, Retour arrière, Supprimer, Entrée, Espace', () => {
    expect(found('Contrôle Tabulation')).toEqual(found('⌃⇥'))
    expect(queryWords('Commande Flèche gauche')).toEqual(['cmd', 'left'])
    expect(queryWords('Commande Flèches haut')).toEqual(['cmd', 'up'])
    expect(queryWords('Commande Retour arrière')).toEqual(['cmd', 'backspace'])
    expect(queryWords('Commande Supprimer')).toEqual(['cmd', 'delete'])
    expect(queryWords('Commande Entrée')).toEqual(['cmd', 'return'])
    expect(queryWords('Commande Espace')).toEqual(['cmd', 'space'])
  })

  it('finds the key “+” typed as the list shows it (⌘+ is Zoom avant), and keeps “+” as a separator between words', () => {
    expect(found('⌘+')).toEqual(['zoomIn'])
    expect(found('Commande +')).toEqual(['zoomIn'])
    expect(found('cmd++')).toEqual(['zoomIn'])
    expect(found('Commande Plus')).toEqual(['zoomIn'])
    // A "+" that ends a half-typed query joins the next word: nothing is known yet, so it is not the Plus key.
    expect(queryWords('cmd+')).toEqual(['cmd'])
    expect(queryWords('cmd+shift+J')).toEqual(['cmd', 'shift', 'j'])
    expect(queryWords('⌘ + T')).toEqual(['cmd', 't'])
    expect(queryWords('Commande + Maj + T')).toEqual(['cmd', 'shift', 't'])
  })

  it('finds the other symbol keys the list shows', () => {
    expect(found('⌘[')).toEqual(['back'])
    expect(found('⌘]')).toEqual(['forward'])
    expect(found('⌘;')).toEqual(['stop'])
    expect(found('⌘-')).toEqual(['zoomOut'])
  })
})

describe('withoutConflicts', () => {
  it('keeps the combination the user has just assigned and switches off the default command that had it', () => {
    // newTab has ⌘T by default; the user gives ⌘T to "Nouvelle fenêtre": the new assignment stays, whatever the order of the list.
    expect(withoutConflicts({ newWindow: 'CmdOrCtrl+T' })).toEqual({ newWindow: 'CmdOrCtrl+T', newTab: '' })
  })

  it('does not take the list’s order for a reason, whichever side of the default command the assigned one is on', () => {
    // newTab comes before closeTab in the list, newWindow comes after newTab: the assigned command wins in both places.
    expect(withoutConflicts({ newTab: 'CmdOrCtrl+W' })).toEqual({ newTab: 'CmdOrCtrl+W', closeTab: '' })
    expect(withoutConflicts({ closeTab: 'CmdOrCtrl+T' })).toEqual({ closeTab: 'CmdOrCtrl+T', newTab: '' })
  })

  it('leaves bindings without a clash as they are', () => {
    const bindings = { newWindow: 'CmdOrCtrl+Alt+Shift+9' }
    expect(withoutConflicts(bindings)).toEqual(bindings)
  })

  it('gives the shortcut to the command assigned last when the pane knows it, else to the one saved last', () => {
    const bindings = { reload: 'CmdOrCtrl+Alt+Q', find: 'CmdOrCtrl+Alt+Q' }
    // Nothing is known of the order they were typed in: the one saved last (find) keeps it.
    expect(withoutConflicts(bindings)).toEqual({ reload: '', find: 'CmdOrCtrl+Alt+Q' })
    // The pane saw reload typed after find: it is the newest assignment.
    expect(withoutConflicts(bindings, ['find', 'reload'])).toEqual({ reload: 'CmdOrCtrl+Alt+Q', find: '' })
  })

  it('does not take a command that went back to its default for an assignment', () => {
    // reload was typed (and is in `recent`) but has since been reset to ⌘R; find was given ⌘R: the user’s choice stays.
    expect(withoutConflicts({ find: 'CmdOrCtrl+R' }, ['reload'])).toEqual({ find: 'CmdOrCtrl+R', reload: '' })
  })

  it('settles a combination three commands share, in favour of the one just assigned', () => {
    const bindings = { newWindow: 'CmdOrCtrl+T', privateWindow: 'CmdOrCtrl+T' }
    expect(withoutConflicts(bindings, ['newWindow', 'privateWindow'])).toEqual({ newWindow: '', privateWindow: 'CmdOrCtrl+T', newTab: '' })
    expect(findConflicts(withoutConflicts(bindings))).toEqual({})
  })

  it('ends every clash, however many there are', () => {
    const bindings = { newWindow: 'CmdOrCtrl+T', find: 'CmdOrCtrl+W', reload: 'CmdOrCtrl+Alt+Q', stop: 'CmdOrCtrl+Alt+Q' }
    expect(Object.keys(findConflicts(bindings))).toHaveLength(3)
    expect(findConflicts(withoutConflicts(bindings))).toEqual({})
  })

  it('does not touch the commands whose combination spells the same as a shortcut in the list but is switched off', () => {
    expect(withoutConflicts({ newTab: '', newWindow: 'CmdOrCtrl+T' })).toEqual({ newTab: '', newWindow: 'CmdOrCtrl+T' })
  })
})

describe('resolveConflicts', () => {
  it('says which command kept the shortcut and which lost it, with what each had saved', () => {
    const bindings = { newWindow: 'CmdOrCtrl+T', reload: 'CmdOrCtrl+Alt+Q', find: 'CmdOrCtrl+Alt+Q' }
    const { settled, removed } = resolveConflicts(bindings, ['find', 'reload'])
    expect(settled).toEqual([
      { accelerator: 'CmdOrCtrl+T', kept: 'newWindow', removed: ['newTab'] },
      { accelerator: 'CmdOrCtrl+Alt+Q', kept: 'reload', removed: ['find'] }
    ])
    expect(removed).toEqual([
      { id: 'newTab', accelerator: 'CmdOrCtrl+T', was: undefined },
      { id: 'find', accelerator: 'CmdOrCtrl+Alt+Q', was: 'CmdOrCtrl+Alt+Q' }
    ])
  })

  it('reports nothing when there is no clash', () => {
    const bindings = { newWindow: 'CmdOrCtrl+Alt+Shift+9' }
    expect(resolveConflicts(bindings)).toEqual({ bindings, settled: [], removed: [] })
  })
})

describe('restoreRemoved', () => {
  it('gives back exactly what was taken: a default goes back to running on its default, a saved binding comes back as it was', () => {
    const bindings = { newWindow: 'CmdOrCtrl+T', reload: 'CmdOrCtrl+Alt+Q', find: 'CmdOrCtrl+Alt+Q' }
    const { bindings: settledBindings, removed } = resolveConflicts(bindings, ['find', 'reload'])
    expect(settledBindings).toEqual({ newWindow: 'CmdOrCtrl+T', reload: 'CmdOrCtrl+Alt+Q', find: '', newTab: '' })
    const back = restoreRemoved(settledBindings, removed)
    expect(back).toEqual(bindings)
    // The clash is back with it, as it was before the removal.
    expect(Object.keys(findConflicts(back)).sort()).toEqual(['CmdOrCtrl+Alt+Q', 'CmdOrCtrl+T'])
  })

  it('leaves alone a command the user has changed since the removal', () => {
    const bindings = { newWindow: 'CmdOrCtrl+T' }
    const { bindings: settledBindings, removed } = resolveConflicts(bindings)
    // newTab was switched off by the removal; the user then gave it ⌘9 by hand.
    const edited = { ...settledBindings, newTab: 'CmdOrCtrl+Alt+Shift+9' }
    expect(restoreRemoved(edited, removed)).toEqual(edited)
  })

  it('does nothing when nothing was removed', () => {
    const bindings = { reload: 'CmdOrCtrl+Alt+Q' }
    expect(restoreRemoved(bindings, [])).toEqual(bindings)
  })
})

describe('conflictPartners', () => {
  it('names the other commands that have the same shortcut, from either side', () => {
    const bindings = { newWindow: 'CmdOrCtrl+T' }
    expect(conflictPartners('newWindow', bindings)).toEqual(['newTab'])
    expect(conflictPartners('newTab', bindings)).toEqual(['newWindow'])
  })

  it('names none for a command with its own shortcut, a switched-off one, or an unknown one', () => {
    const bindings = { newWindow: 'CmdOrCtrl+T', reload: '' }
    expect(conflictPartners('closeTab', bindings)).toEqual([])
    expect(conflictPartners('reload', bindings)).toEqual([])
    expect(conflictPartners('nope', bindings)).toEqual([])
  })

  it('takes two spellings of one press for one shortcut', () => {
    expect(conflictPartners('muteTab', { muteTab: 'Alt+CmdOrCtrl+M', duplicateTab: 'CmdOrCtrl+Alt+M' })).toEqual(['duplicateTab'])
  })

  it('names all of the others when three share', () => {
    expect(conflictPartners('newWindow', { newWindow: 'CmdOrCtrl+T', privateWindow: 'CmdOrCtrl+T' }).sort()).toEqual(['newTab', 'privateWindow'])
  })
})

describe('quotedNames', () => {
  it('quotes the names the way each language does', () => {
    expect(quotedNames(['Nouvel onglet', 'Recharger'], 'fr')).toBe(frenchSpaces('« Nouvel onglet », « Recharger »'))
    expect(quotedNames(['New Tab'], 'en')).toBe('“New Tab”')
  })
})

describe('what the pane says about a clash', () => {
  afterEach(() => setLanguage('fr'))
  const bindings = { newWindow: 'CmdOrCtrl+T' }

  it('writes under a command which other command has its shortcut', () => {
    expect(conflictNote('newWindow', bindings)).toBe(frenchSpaces(`En conflit avec « ${commandLabel('newTab')} »`))
    expect(conflictNote('newTab', bindings)).toBe(frenchSpaces(`En conflit avec « ${commandLabel('newWindow')} »`))
    expect(conflictNote('closeTab', bindings)).toBeUndefined()
    setLanguage('en')
    expect(conflictNote('newWindow', bindings)).toBe(`Conflicts with “${commandLabel('newTab')}”`)
  })

  it('announces, when a shortcut is assigned, the shortcut and every command that now has it', () => {
    expect(conflictAnnouncement('newWindow', bindings, 'darwin')).toBe(frenchSpaces(`⌘T est utilisé par plusieurs commandes : « ${commandLabel('newWindow')} », « ${commandLabel('newTab')} ».`))
    expect(conflictAnnouncement('closeTab', bindings, 'darwin')).toBeUndefined()
    // Nothing to announce for a shortcut that was turned off.
    expect(conflictAnnouncement('newTab', { newWindow: 'CmdOrCtrl+T', newTab: '' }, 'darwin')).toBeUndefined()
    setLanguage('en')
    expect(conflictAnnouncement('newWindow', bindings, 'darwin')).toBe(`⌘T is used by several commands: “${commandLabel('newWindow')}”, “${commandLabel('newTab')}”.`)
  })
})

describe('settleConflicts', () => {
  afterEach(() => setLanguage('fr'))

  it('says what the command just assigned keeps and what was removed, and hands back what is needed to undo it', () => {
    const bindings = { newWindow: 'CmdOrCtrl+T' }
    const settled = settleConflicts(bindings, 'darwin', ['newWindow'])!
    expect(settled.bindings).toEqual({ newWindow: 'CmdOrCtrl+T', newTab: '' })
    expect(settled.text).toBe(frenchSpaces(`⌘T reste à « ${commandLabel('newWindow')} ». Raccourci retiré de « ${commandLabel('newTab')} ».`))
    expect(restoreRemoved(settled.bindings, settled.removed)).toEqual(bindings)
  })

  it('says it in English, and one sentence for each shortcut settled', () => {
    setLanguage('en')
    const settled = settleConflicts({ newWindow: 'CmdOrCtrl+T', find: 'CmdOrCtrl+W' }, 'darwin', ['newWindow', 'find'])!
    expect(settled.text).toBe(
      `⌘T stays with “${commandLabel('newWindow')}”. Shortcut removed from “${commandLabel('newTab')}”. ⌘W stays with “${commandLabel('find')}”. Shortcut removed from “${commandLabel('closeTab')}”.`
    )
  })

  it('has nothing to do, and nothing to say, when no shortcut is shared', () => {
    expect(settleConflicts({}, 'darwin')).toBeUndefined()
    expect(settleConflicts({ newWindow: 'CmdOrCtrl+Alt+Shift+9' }, 'darwin')).toBeUndefined()
  })
})
