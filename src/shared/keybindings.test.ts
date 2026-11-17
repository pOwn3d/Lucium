import { describe, expect, it } from 'vitest'
import { COMMANDS, acceleratorFromKeyEvent, acceleratorMatches, canonicalAccelerator, cleanBindings, keyLayoutOf, parseKeyLayout, heldModifiers, physicalKey, sameAccelerator, effectiveAccelerator, findConflicts, formatAccelerator, isValidAccelerator, macPress, takenExtensionShortcuts, FIXED_SHORTCUTS, otherUseOf, samePress, secondAccelerator } from './keybindings'
import { DEVTOOLS_EXTRA_ACCELERATOR } from './devtools-request'
import { PASS_SHORTCUT } from './window-share-pass'

const press = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('defaults', () => {
  it('give every command a valid accelerator or none, and no two commands the same one', () => {
    expect(COMMANDS.every((c) => c.accelerator === '' || isValidAccelerator(c.accelerator))).toBe(true)
    expect(findConflicts({})).toEqual({})
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length)
  })
})

describe('effectiveAccelerator', () => {
  it('uses the default, an override, or nothing when the shortcut is disabled', () => {
    expect(effectiveAccelerator('newTab', {})).toBe('CmdOrCtrl+T')
    expect(effectiveAccelerator('newTab', { newTab: 'CmdOrCtrl+Alt+N' })).toBe('CmdOrCtrl+Alt+N')
    expect(effectiveAccelerator('newTab', { newTab: '' })).toBeUndefined()
  })

  it('treats a command bound to nothing as having no shortcut (an empty accelerator would make Electron throw), until the user gives it one', () => {
    expect(COMMANDS.find((c) => c.id === 'share')?.accelerator).toBe('')
    expect(effectiveAccelerator('share', {})).toBeUndefined()
    expect(effectiveAccelerator('share', { share: 'CmdOrCtrl+Alt+P' })).toBe('CmdOrCtrl+Alt+P')
  })
})

describe('isValidAccelerator', () => {
  it('accepts modified keys and function keys, refuses bare letters and Shift-only', () => {
    for (const ok of ['CmdOrCtrl+T', 'CmdOrCtrl+Shift+[', 'Alt+F4', 'F5', 'Ctrl+Alt+Left', 'CmdOrCtrl+PageDown', 'Alt+PageUp']) expect(isValidAccelerator(ok)).toBe(true)
    for (const bad of ['T', 'Shift+T', 'CmdOrCtrl+', 'Cmd++', 'Hyper+T', 'CmdOrCtrl+CmdOrCtrl+T', 'CmdOrCtrl+TT', '']) expect(isValidAccelerator(bad)).toBe(false)
  })
})

describe('acceleratorFromKeyEvent', () => {
  it('builds accelerators from physical keys, with modifiers in a stable order', () => {
    expect(acceleratorFromKeyEvent(press('KeyJ', { metaKey: true, shiftKey: true }))).toBe('CmdOrCtrl+Shift+J')
    expect(acceleratorFromKeyEvent(press('BracketLeft', { metaKey: true }))).toBe('CmdOrCtrl+[')
    expect(acceleratorFromKeyEvent(press('Digit4', { metaKey: true, altKey: true }))).toBe('CmdOrCtrl+Alt+4')
    expect(acceleratorFromKeyEvent(press('F5'))).toBe('F5')
  })

  // A French keyboard (AZERTY): what each key gives alone, by its `code`. The key marked A sits where a US keyboard has Q.
  const AZERTY: Record<string, string> = { KeyQ: 'a', KeyA: 'q', KeyW: 'z', KeyZ: 'w', Semicolon: 'm', KeyM: ',', Comma: ';', Period: ':', Slash: '=', Equal: '-', Quote: 'ù', BracketRight: '$', Digit1: '&', Digit2: 'é' }
  const azerty = (code: string) => AZERTY[code]
  const typed = (code: string, key: string, mods: Parameters<typeof press>[1] = {}) => ({ ...press(code, mods), key })

  it('keeps the letter typed on a French keyboard, not the letter a US keyboard has at that place', () => {
    expect(acceleratorFromKeyEvent(typed('KeyQ', 'a', { metaKey: true }))).toBe('CmdOrCtrl+A')
    expect(acceleratorFromKeyEvent(typed('KeyW', 'Z', { metaKey: true, shiftKey: true }))).toBe('CmdOrCtrl+Shift+Z')
    expect(acceleratorFromKeyEvent(typed('Semicolon', 'm', { ctrlKey: true }))).toBe('Ctrl+M')
    expect(acceleratorFromKeyEvent(typed('KeyM', ',', { metaKey: true }))).toBe('CmdOrCtrl+,')
    expect(acceleratorFromKeyEvent(typed('KeyQ', 'a', { ctrlKey: true, altKey: true }), 'win32')).toBe('CmdOrCtrl+Alt+A')
  })

  it('asks the layout for the letter when Option hides it, and reads the place of the key only when nothing says it', () => {
    // ⌥⌘A on a French keyboard types « æ ».
    expect(acceleratorFromKeyEvent(typed('KeyQ', 'æ', { metaKey: true, altKey: true }), 'darwin', azerty)).toBe('CmdOrCtrl+Alt+A')
    expect(acceleratorFromKeyEvent(typed('Semicolon', 'µ', { metaKey: true, altKey: true }), 'darwin', azerty)).toBe('CmdOrCtrl+Alt+M')
    expect(acceleratorFromKeyEvent(typed('Period', '/', { metaKey: true, shiftKey: true }), 'darwin', azerty)).toBeNull()
    // No layout: a US keyboard types « ∆ » for ⌥J and « ? » for ⇧/, and the place of the key is the key.
    expect(acceleratorFromKeyEvent(typed('KeyJ', '∆', { metaKey: true, altKey: true }))).toBe('CmdOrCtrl+Alt+J')
    expect(acceleratorFromKeyEvent(typed('Slash', '?', { metaKey: true, shiftKey: true }))).toBe('CmdOrCtrl+Shift+/')
  })

  it('reads a digit key as its digit and a letter key of another script as the letter of its place', () => {
    expect(acceleratorFromKeyEvent(typed('Digit1', '&', { metaKey: true }))).toBe('CmdOrCtrl+1')
    expect(acceleratorFromKeyEvent(typed('Digit2', '2', { metaKey: true, shiftKey: true }), 'darwin', azerty)).toBe('CmdOrCtrl+Shift+2')
    expect(acceleratorFromKeyEvent(typed('KeyA', 'ф', { metaKey: true }))).toBe('CmdOrCtrl+A')
  })

  it('makes no shortcut of a key whose character no accelerator can name, rather than the shortcut of another key', () => {
    expect(acceleratorFromKeyEvent(typed('Quote', 'ù', { metaKey: true }))).toBeNull()
    expect(acceleratorFromKeyEvent(typed('BracketRight', '$', { metaKey: true }))).toBeNull()
    expect(acceleratorFromKeyEvent(typed('BracketLeft', 'Dead', { metaKey: true }))).toBeNull()
    expect(acceleratorFromKeyEvent(typed('BracketRight', '¤', { metaKey: true, altKey: true }), 'darwin', azerty)).toBeNull()
  })

  it('keeps the keys that are the same on every layout, whatever the press says it types', () => {
    expect(acceleratorFromKeyEvent(typed('Space', ' ', { ctrlKey: true }))).toBe('Ctrl+Space')
    expect(acceleratorFromKeyEvent(typed('ArrowLeft', 'ArrowLeft', { metaKey: true, altKey: true }))).toBe('CmdOrCtrl+Alt+Left')
    expect(acceleratorFromKeyEvent(typed('Enter', 'Enter', { metaKey: true }))).toBe('CmdOrCtrl+Return')
    expect(acceleratorFromKeyEvent(typed('F5', 'F5'))).toBe('F5')
  })

  it('recognises a shortcut by the letter typed, as it was recorded', () => {
    expect(acceleratorMatches('Ctrl+A', typed('KeyQ', 'a', { ctrlKey: true }))).toBe(true)
    expect(acceleratorMatches('Ctrl+Q', typed('KeyQ', 'a', { ctrlKey: true }))).toBe(false)
  })

  it('still reads the shortcuts saved before, which name a key as any accelerator does', () => {
    expect(cleanBindings({ newTab: 'CmdOrCtrl+Q', reload: 'CmdOrCtrl+Alt+;' })).toEqual({ newTab: 'CmdOrCtrl+Q', reload: 'CmdOrCtrl+Alt+;' })
  })

  it('refuses a lone modifier, a bare letter and unknown keys', () => {
    expect(acceleratorFromKeyEvent(press('MetaLeft', { metaKey: true }))).toBeNull()
    expect(acceleratorFromKeyEvent(press('KeyA'))).toBeNull()
    expect(acceleratorFromKeyEvent(press('KeyA', { shiftKey: true }))).toBeNull()
    expect(acceleratorFromKeyEvent(press('IntlBackslash', { metaKey: true }))).toBeNull()
  })
})

describe('cleanBindings and conflicts', () => {
  it('drops unknown commands and unusable accelerators but keeps explicit disables', () => {
    expect(cleanBindings({ newTab: 'CmdOrCtrl+Alt+N', ghost: 'CmdOrCtrl+Q', reload: 'R', find: '' })).toEqual({ newTab: 'CmdOrCtrl+Alt+N', find: '' })
    expect(cleanBindings(undefined)).toEqual({})
  })

  it('reports an accelerator given to two commands', () => {
    expect(findConflicts({ reload: 'CmdOrCtrl+T' })).toEqual({ 'CmdOrCtrl+T': ['newTab', 'reload'] })
    expect(findConflicts({ reload: 'CmdOrCtrl+T', newTab: '' })).toEqual({})
  })
})

describe('formatAccelerator', () => {
  it('shows macOS symbols in the usual order', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+J', 'darwin')).toBe('⇧⌘J')
    expect(formatAccelerator('CmdOrCtrl+Alt+Shift+S', 'darwin')).toBe('⌥⇧⌘S')
    expect(formatAccelerator('Ctrl+Left', 'darwin')).toBe('⌃←')
  })
})

// The commands added for the missing shortcuts and the ones of the window features: nothing is bound to them in the menu bar.
const ADDED_COMMANDS = ['duplicateTab', 'muteTab', 'toggleFolder', 'moveTabNextSpace', 'moveTabPreviousSpace', 'reloadAll', 'clearHistory', 'importData', 'taskManager', 'addExtension', 'manageExtensions', 'nameWindow']

describe('the commands that had no shortcut to give', () => {
  it('exist in the list, once each, so that Settings › Raccourcis can give them a key', () => {
    for (const id of ADDED_COMMANDS) expect(COMMANDS.filter((c) => c.id === id), id).toHaveLength(1)
  })

  it('have no default shortcut, and so cannot clash with anything', () => {
    for (const id of ADDED_COMMANDS) expect(effectiveAccelerator(id, {}), id).toBeUndefined()
    expect(findConflicts({})).toEqual({})
  })

  it('can be given any free shortcut, and are in conflict when two of them are given the same one', () => {
    expect(effectiveAccelerator('duplicateTab', { duplicateTab: 'CmdOrCtrl+Alt+D' })).toBe('CmdOrCtrl+Alt+D')
    expect(cleanBindings({ muteTab: 'CmdOrCtrl+Alt+M', toggleFolder: 'F' })).toEqual({ muteTab: 'CmdOrCtrl+Alt+M' })
    expect(findConflicts({ muteTab: 'CmdOrCtrl+Alt+M', duplicateTab: 'CmdOrCtrl+Alt+M' })).toEqual({ 'CmdOrCtrl+Alt+M': ['duplicateTab', 'muteTab'] })
    // A key a default command already uses is a conflict too: a new command never takes it silently.
    expect(findConflicts({ moveTabNextSpace: 'CmdOrCtrl+T' })).toEqual({ 'CmdOrCtrl+T': ['newTab', 'moveTabNextSpace'] })
  })

  it('are told in French, like the others', () => {
    expect(COMMANDS.filter((c) => ADDED_COMMANDS.includes(c.id)).map((c) => c.label)).toEqual(expect.arrayContaining(['Dupliquer l’onglet', 'Couper / rétablir le son de l’onglet', 'Replier / déplier le dossier de l’onglet', 'Déplacer l’onglet vers l’espace suivant', 'Déplacer l’onglet vers l’espace précédent', 'Actualiser tous les onglets', 'Nommer la fenêtre…']))
  })
})

describe('window commands', () => {
  it('open a window, a blank window and a private window with their usual shortcuts', () => {
    expect(['newWindow', 'blankWindow', 'privateWindow'].map((id) => formatAccelerator(effectiveAccelerator(id, {})!, 'darwin'))).toEqual(['⌘N', '⌃⌘N', '⇧⌘N'])
  })
})

describe('the sidebar of this window docked to a column of icons', () => {
  it('is ⌃⌘S by default, in View, which no other command takes (⌘S hides the sidebar, ⇧⌘S saves the page, ⌥⌘S captures it)', () => {
    const dock = COMMANDS.find((c) => c.id === 'dockSidebar')!
    expect(dock.group).toBe('Affichage')
    expect(formatAccelerator(effectiveAccelerator('dockSidebar', {})!, 'darwin')).toBe('⌃⌘S')
    const taken = COMMANDS.filter((c) => c.id !== 'dockSidebar' && c.accelerator !== '' && sameAccelerator(c.accelerator, dock.accelerator)).map((c) => c.id)
    expect(taken).toEqual([])
    expect(['toggleSidebar', 'savePage', 'captureVisible'].map((id) => formatAccelerator(effectiveAccelerator(id, {})!, 'darwin'))).toEqual(['⌘S', '⇧⌘S', '⌥⌘S'])
  })

  it('can be moved or switched off in Réglages › Raccourcis, and conflicts with a command given the same keys', () => {
    expect(effectiveAccelerator('dockSidebar', { dockSidebar: 'CmdOrCtrl+Alt+D' })).toBe('CmdOrCtrl+Alt+D')
    expect(effectiveAccelerator('dockSidebar', { dockSidebar: '' })).toBeUndefined()
    expect(Object.values(findConflicts({ toggleToolbar: 'Ctrl+CmdOrCtrl+S' })).map((ids) => [...ids].sort())).toEqual([['dockSidebar', 'toggleToolbar']])
  })
})

describe('site commands', () => {
  it('clear the data of a site with ⇧⌘X, which no other command takes', () => {
    expect(formatAccelerator(effectiveAccelerator('clearSiteData', {})!, 'darwin')).toBe('⇧⌘X')
    expect(COMMANDS.filter((c) => c.accelerator === 'CmdOrCtrl+Shift+X').map((c) => c.id)).toEqual(['clearSiteData'])
  })

  it('clear them without the panel with ⌥⇧⌘X, which no other command takes, and both can be moved or switched off', () => {
    expect(formatAccelerator(effectiveAccelerator('clearSiteDataNow', {})!, 'darwin')).toBe('⌥⇧⌘X')
    expect(COMMANDS.filter((c) => c.accelerator === 'CmdOrCtrl+Alt+Shift+X').map((c) => c.id)).toEqual(['clearSiteDataNow'])
    expect(effectiveAccelerator('clearSiteDataNow', { clearSiteDataNow: 'CmdOrCtrl+Shift+X', clearSiteData: '' })).toBe('CmdOrCtrl+Shift+X')
    expect(effectiveAccelerator('clearSiteData', { clearSiteData: '' })).toBeUndefined()
    expect(findConflicts({ clearSiteDataNow: 'CmdOrCtrl+Shift+X' })).toEqual({ 'CmdOrCtrl+Shift+X': ['clearSiteData', 'clearSiteDataNow'] })
  })
})

// The reference shortcuts of the menu bar, next to their entries (scratchpad/arc-menus.txt), as macOS prints them.
const ARC_MENU_SHORTCUTS: Record<string, string> = {
  settings: '⌘,', newTab: '⌘T', newWindow: '⌘N', blankWindow: '⌃⌘N', privateWindow: '⇧⌘N', newLittleArc: '⌥⌘N', restoreClosed: '⇧⌘T', openLocation: '⌘L',
  closeWindow: '⇧⌘W', closeTab: '⌘W', captureRegion: '⇧⌘2', savePage: '⇧⌘S', print: '⌘P',
  findReplace: '⌥⌘F', find: '⌘F', findNext: '⌘G', findPrevious: '⇧⌘G', jumpToSelection: '⌘J', copyUrl: '⇧⌘C', copyUrlMarkdown: '⌥⇧⌘C', copyUrlQuote: '⌃⇧⌘C',
  toggleSidebar: '⌘S', toggleToolbar: '⇧⌘D', stop: '⌘;', reload: '⌘R', hardReload: '⇧⌘R', addSplit: '⌃⇧=', closeSplitPane: '⌃⇧-', zoomReset: '⌘0', zoomIn: '⌘+', zoomOut: '⌘-',
  viewSource: '⌥⌘U', devTools: '⌥⌘I', inspectElement: '⌥⌘C', jsConsole: '⌥⌘J', developerMode: '⌃D', fullscreen: '⌃⌘F',
  nextSpace: '⌥⌘→', previousSpace: '⌥⌘←', space1: '⌃1', space2: '⌃2', space3: '⌃3', space4: '⌃4',
  pin: '⌘D', nextTab: '⌥⌘↓', previousTab: '⌥⌘↑', clearToday: '⇧⌘K', back: '⌘[', forward: '⌘]', history: '⌘Y'
}

describe('the keys a web page keeps', () => {
  // Guard: a registered ⌘I was taken before the page (no italics in a web editor), and Édition › Format shows ⌘I for « Italique ».
  it('give no default command ⌘I, ⌘B or ⌘U: the Format menu shows them as the page’s own', () => {
    for (const key of ['CmdOrCtrl+I', 'CmdOrCtrl+B', 'CmdOrCtrl+U']) expect(COMMANDS.filter((c) => c.accelerator === key).map((c) => c.id), key).toEqual([])
  })

  it('leave the panel of the site on ⇧⌘I, where nothing else is', () => {
    expect(formatAccelerator(effectiveAccelerator('siteInfo', {})!, 'darwin')).toBe('⇧⌘I')
    expect(COMMANDS.filter((c) => c.accelerator === 'CmdOrCtrl+Shift+I').map((c) => c.id)).toEqual(['siteInfo'])
  })
})

describe('the reference menu shortcuts', () => {
  it('are the defaults of the commands that carry them', () => {
    const ours = Object.fromEntries(Object.keys(ARC_MENU_SHORTCUTS).map((id) => [id, formatAccelerator(effectiveAccelerator(id, {}) ?? '', 'darwin')]))
    expect(ours).toEqual(ARC_MENU_SHORTCUTS)
  })

  it('leave unbound the commands whose menu entry shows no shortcut', () => {
    for (const id of ['newProfile', 'share', 'capturePortrait', 'useSelectionToFind', 'collapsePinned', 'clearCookies', 'clearCache', 'separateSplit', 'expandSplit', 'networkInspector', 'newSpace', 'editTheme', 'renameSpace', 'manageSpaces', 'asideSpace', 'newFolder', 'revealTab', 'resetPinned', 'clearArchive', ...ADDED_COMMANDS]) {
      expect(effectiveAccelerator(id, {}), id).toBeUndefined()
    }
  })

  it('give the nine spaces ⌃1…⌃9 and the nine sidebar items ⌘1…⌘9, all of them remappable', () => {
    for (let n = 1; n <= 9; n++) {
      expect(effectiveAccelerator(`space${n}`, {})).toBe(`Ctrl+${n}`)
      expect(effectiveAccelerator(`item${n}`, {})).toBe(`CmdOrCtrl+${n}`)
    }
    expect(effectiveAccelerator('space3', { space3: 'Ctrl+Alt+3' })).toBe('Ctrl+Alt+3')
  })
})

describe('the commands of the sessions of tabs', () => {
  it('have no shortcut until the user gives one, and take any free one', () => {
    for (const id of ['sessions', 'saveSession']) {
      expect(COMMANDS.find((c) => c.id === id)?.group, id).toBe('Fichier')
      expect(effectiveAccelerator(id, {}), id).toBeUndefined()
    }
    expect(effectiveAccelerator('saveSession', { saveSession: 'CmdOrCtrl+Alt+K' })).toBe('CmdOrCtrl+Alt+K')
    expect(cleanBindings({ sessions: 'CmdOrCtrl+Alt+J', saveSession: 'nope' })).toEqual({ sessions: 'CmdOrCtrl+Alt+J' })
    // Giving a session command a key another command already holds is a conflict the Settings pane reports.
    expect(findConflicts({ sessions: 'CmdOrCtrl+T' })).toEqual({ 'CmdOrCtrl+T': ['newTab', 'sessions'] })
  })
})

describe('⌃Tab in the order of use', () => {
  it('is bound by default to ⌃Tab and ⌃⇧Tab, and a user can move or disable either', () => {
    expect(effectiveAccelerator('recentTab', {})).toBe('Ctrl+Tab')
    expect(effectiveAccelerator('recentTabBack', {})).toBe('Ctrl+Shift+Tab')
    expect(effectiveAccelerator('recentTab', { recentTab: 'Alt+Tab' })).toBe('Alt+Tab')
    expect(effectiveAccelerator('recentTab', { recentTab: '' })).toBeUndefined()
    expect(isValidAccelerator('Ctrl+Tab') && isValidAccelerator('Ctrl+Shift+Tab')).toBe(true)
  })

  it('conflicts with a command that is given the same keys', () => {
    expect(findConflicts({ nextTab: 'Ctrl+Tab' })).toEqual({ 'Ctrl+Tab': ['nextTab', 'recentTab'] })
    expect(findConflicts({ nextTab: 'Ctrl+Tab', recentTab: '' })).toEqual({})
  })

  it('recognises the key press, with the modifiers exactly as bound (a ⌃⇧Tab is not a ⌃Tab)', () => {
    expect(acceleratorMatches('Ctrl+Tab', press('Tab', { ctrlKey: true }))).toBe(true)
    expect(acceleratorMatches('Ctrl+Tab', press('Tab', { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(acceleratorMatches('Ctrl+Shift+Tab', press('Tab', { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(acceleratorMatches('Ctrl+Tab', press('Tab', { ctrlKey: true, metaKey: true }))).toBe(false)
    expect(acceleratorMatches('Ctrl+Tab', press('Tab'))).toBe(false)
    expect(acceleratorMatches(undefined, press('Tab', { ctrlKey: true }))).toBe(false)
    expect(sameAccelerator('Ctrl+Shift+Tab', 'shift+ctrl+tab')).toBe(true)
  })

  it('reads the key of a made event (no `code`) for the keys a switcher needs, and refuses to guess for the others', () => {
    expect(physicalKey({ code: 'Tab', key: 'Tab' })).toBe('Tab')
    expect(physicalKey({ code: '', key: 'Tab' })).toBe('Tab')
    expect(physicalKey({ code: '', key: 'Escape' })).toBe('Escape')
    expect(physicalKey({ code: '', key: 'a' })).toBe('')
    expect(physicalKey({ code: 'KeyA', key: 'a' })).toBe('KeyA')
  })

  it('knows which modifiers to wait for the release of: those of the accelerator, never Shift', () => {
    expect(heldModifiers('Ctrl+Tab')).toEqual(['control'])
    expect(heldModifiers('Ctrl+Shift+Tab')).toEqual(['control'])
    expect(heldModifiers('Alt+Tab')).toEqual(['alt'])
    expect(heldModifiers('CmdOrCtrl+Alt+J')).toEqual(['alt', 'meta'])
    expect(heldModifiers('F5')).toEqual([])
  })
})

describe('shortcuts written in another order of modifiers', () => {
  it('settles the order of the modifiers (the one a recorded shortcut has)', () => {
    expect(canonicalAccelerator('Ctrl+CmdOrCtrl+N')).toBe('CmdOrCtrl+Ctrl+N')
    expect(canonicalAccelerator('Shift+Alt+CmdOrCtrl+S')).toBe('CmdOrCtrl+Alt+Shift+S')
    expect(canonicalAccelerator('CmdOrCtrl+T')).toBe('CmdOrCtrl+T')
    expect(canonicalAccelerator('F5')).toBe('F5')
  })

  it('flags a shortcut recorded as ⌃⌘N when a default (written Ctrl+CmdOrCtrl+N) already has it', () => {
    // The press ⌃⌘N is recorded as CmdOrCtrl+Ctrl+N (acceleratorFromKeyEvent); "Fenêtre vierge" has it by default, spelled the other way round.
    const recorded = acceleratorFromKeyEvent({ code: 'KeyN', metaKey: true, ctrlKey: true, altKey: false, shiftKey: false })
    expect(recorded).toBe('CmdOrCtrl+Ctrl+N')
    expect(findConflicts({ findNext: recorded! })).toEqual({ 'CmdOrCtrl+Ctrl+N': ['blankWindow', 'findNext'] })
  })

  it('flags two commands given the same press in two orders', () => {
    expect(findConflicts({ muteTab: 'Alt+CmdOrCtrl+M', duplicateTab: 'CmdOrCtrl+Alt+M' })).toEqual({ 'CmdOrCtrl+Alt+M': ['duplicateTab', 'muteTab'] })
  })

  it('has no clash between the defaults, however they are spelled', () => {
    expect(findConflicts({})).toEqual({})
  })
})

describe('the shortcuts extensions suggest', () => {
  const shortcut = (extensionId: string, name: string, accelerator: string | null) => ({ extensionId, name, accelerator })

  it('one press has one name, however its modifiers are spelled and ordered', () => {
    expect(macPress('Command+Shift+9')).toBe(macPress('Shift+CmdOrCtrl+9'))
    expect(macPress('MacCtrl+Alt+K')).toBe(macPress('Option+Control+k'))
    expect(macPress('Cmd+T')).not.toBe(macPress('Ctrl+T'))
    expect(macPress('Cmd+T')).not.toBe(macPress('Cmd+Shift+T'))
  })

  it('a shortcut that a command of Lucium holds is taken, until the user moves or switches off that command', () => {
    const suggested = [shortcut('aaa', 'clip', 'Cmd+T'), shortcut('aaa', 'free', 'Alt+Shift+9'), shortcut('aaa', 'none', null)]
    expect([...takenExtensionShortcuts(suggested, undefined)]).toEqual(['aaa:clip'])
    expect([...takenExtensionShortcuts(suggested, { newTab: 'CmdOrCtrl+Alt+T' })]).toEqual([])
    expect([...takenExtensionShortcuts(suggested, { newTab: '' })]).toEqual([])
    // A key the user gave to a command of Lucium is taken too.
    expect([...takenExtensionShortcuts(suggested, { reload: 'Shift+Alt+9' })].sort()).toEqual(['aaa:clip', 'aaa:free'])
  })

  it('two extensions that suggest the same key: the first by its id, then by the name of the command, keeps it, whatever order they are listed in', () => {
    const one = shortcut('aaa', 'go', 'Alt+Shift+9')
    const two = shortcut('bbb', 'go', 'Shift+Alt+9')
    const three = shortcut('aaa', 'again', 'Alt+Shift+9')
    expect([...takenExtensionShortcuts([two, one, three], undefined)].sort()).toEqual(['aaa:go', 'bbb:go'])
    expect([...takenExtensionShortcuts([three, two, one], undefined)].sort()).toEqual(['aaa:go', 'bbb:go'])
  })

  it('a command that only opens the popup or the panel of its extension holds no key of the menu, and loses none', () => {
    expect([...takenExtensionShortcuts([shortcut('aaa', '_execute_action', 'Alt+Shift+9'), shortcut('bbb', 'go', 'Alt+Shift+9')], undefined)]).toEqual([])
    expect([...takenExtensionShortcuts([shortcut('aaa', '_execute_action', 'Cmd+T')], undefined)]).toEqual([])
  })
})

describe('the keyboard layout the interface sends', () => {
  it('keeps the character of each key, and leaves out what is not one', () => {
    expect(parseKeyLayout({ KeyQ: 'a', Digit1: '&', Bad: 3, 'Key Q': 'x', KeyX: '', KeyZ: 'longer' })).toEqual({ KeyQ: 'a', Digit1: '&' })
  })

  it('refuses what is not a layout', () => {
    for (const raw of [undefined, null, 'KeyQ', 3, ['a'], {}, { KeyQ: 3 }]) expect(parseKeyLayout(raw), JSON.stringify(raw)).toBeNull()
    expect(parseKeyLayout(Object.fromEntries(Array.from({ length: 161 }, (_, i) => [`Key${i}`, 'a'])))).toBeNull()
  })

  it('answers by the key, never by what every object has', () => {
    const layout = keyLayoutOf({ KeyQ: 'a' })
    expect(layout('KeyQ')).toBe('a')
    expect(layout('constructor')).toBeUndefined()
  })

  it('lets a press with Option be matched to the shortcut of its letter', () => {
    const french = keyLayoutOf({ KeyQ: 'a' })
    const press = { code: 'KeyQ', key: 'æ', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }
    expect(acceleratorMatches('Alt+A', press, french)).toBe(true)
    expect(acceleratorMatches('Alt+Q', press, french)).toBe(false)
    // Without a layout the press is read by the place of its key.
    expect(acceleratorMatches('Alt+Q', press)).toBe(true)
  })
})

// Some defaults cannot be typed as they are written on a French keyboard (« [ », « ] », « / »), or are shared with macOS or with pages:
// each keeps its key and has a second one.
describe('the second shortcut of a command', () => {
  const SECONDS: Readonly<Record<string, string>> = {
    back: 'Ctrl+CmdOrCtrl+Left',
    forward: 'Ctrl+CmdOrCtrl+Right',
    shortcutHelp: 'CmdOrCtrl+Alt+K',
    clearSiteData: 'Ctrl+CmdOrCtrl+X',
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`space${i + 1}`, `Ctrl+CmdOrCtrl+${i + 1}`]))
  }

  it('is given to the defaults a French keyboard, macOS or a page gets in the way of, which keep the key they had', () => {
    expect(Object.fromEntries(COMMANDS.flatMap((c) => (c.second ? [[c.id, c.second]] : [])))).toEqual(SECONDS)
    expect(effectiveAccelerator('back', {})).toBe('CmdOrCtrl+[')
    expect(effectiveAccelerator('forward', {})).toBe('CmdOrCtrl+]')
    expect(effectiveAccelerator('shortcutHelp', {})).toBe('CmdOrCtrl+/')
    expect(effectiveAccelerator('clearSiteData', {})).toBe('CmdOrCtrl+Shift+X')
    for (let n = 1; n <= 9; n++) expect(effectiveAccelerator(`space${n}`, {})).toBe(`Ctrl+${n}`)
    for (const id of Object.keys(SECONDS)) expect(secondAccelerator(id, {}), id).toBe(SECONDS[id])
    expect(secondAccelerator('newTab', {})).toBeUndefined()
    expect(secondAccelerator('nothing', {})).toBeUndefined()
  })

  it('is a press Electron accepts that no command, no fixed entry of the menus and no other second shortcut holds', () => {
    const seconds = COMMANDS.flatMap((c) => (c.second ? [c.second] : []))
    const held = [...COMMANDS.flatMap((c) => (c.accelerator ? [c.accelerator] : [])), ...FIXED_SHORTCUTS.map((fixed) => fixed.accelerator), DEVTOOLS_EXTRA_ACCELERATOR, PASS_SHORTCUT]
    for (const second of seconds) {
      expect(isValidAccelerator(second), second).toBe(true)
      expect(held.filter((other) => samePress(other, second)), second).toEqual([])
      expect(seconds.filter((other) => samePress(other, second)), second).toEqual([second])
    }
  })

  it('can be typed on every keyboard, and is not a press of text fields, of macOS or of pages', () => {
    for (const second of COMMANDS.flatMap((c) => (c.second ? [c.second] : []))) {
      const parts = second.split('+')
      const key = parts.at(-1)!
      // A letter, a digit or an arrow: no punctuation, which a layout may put behind Shift or Option.
      expect(key, second).toMatch(/^([A-Z0-9]|Left|Right)$/)
      expect(otherUseOf(second), second).toBeUndefined()
      // ⌘, ⌥ or ⌃ alone with an arrow moves the cursor in a text field (or the desktop, for ⌃), with or without Shift: an arrow comes with two of them.
      // ⌃ alone with a digit is Mission Control's, and ⌥⌘ with a digit is the heading of many editors.
      const modifiers = parts.slice(0, -1).filter((part) => part !== 'Shift')
      if (/^(Left|Right|[0-9])$/.test(key)) expect([...modifiers].sort(), second).toEqual(['CmdOrCtrl', 'Ctrl'])
      else expect(modifiers.length, second).toBe(2)
    }
  })

  it('stays when the first is changed, and goes when the command is switched off', () => {
    expect(secondAccelerator('back', { back: 'CmdOrCtrl+Alt+Shift+K' })).toBe('Ctrl+CmdOrCtrl+Left')
    expect(secondAccelerator('back', { back: '' })).toBeUndefined()
    expect(secondAccelerator('forward', { back: '' })).toBe('Ctrl+CmdOrCtrl+Right')
  })

  it('gives way to a command the user gave that press to, however it is spelled, and is not said twice by the command itself', () => {
    expect(secondAccelerator('back', { history: 'Ctrl+CmdOrCtrl+Left' })).toBeUndefined()
    expect(secondAccelerator('back', { history: 'Cmd+Ctrl+Left' })).toBeUndefined()
    expect(secondAccelerator('forward', { history: 'Ctrl+CmdOrCtrl+Left' })).toBe('Ctrl+CmdOrCtrl+Right')
    expect(secondAccelerator('back', { back: 'Ctrl+CmdOrCtrl+Left' })).toBeUndefined()
    // No press runs two commands, whatever the user binds.
    expect(findConflicts({ history: 'Ctrl+CmdOrCtrl+Left' })).toEqual({})
  })

  it('is for macOS: the defaults of the other systems were not looked at', () => {
    expect(secondAccelerator('back', {}, 'darwin')).toBe('Ctrl+CmdOrCtrl+Left')
    expect(secondAccelerator('back', {}, 'win32')).toBeUndefined()
    expect(secondAccelerator('back', {}, 'linux')).toBeUndefined()
  })

  it('is held against the shortcut an extension suggests, like the first', () => {
    const suggested = [{ extensionId: 'ext', name: 'go', accelerator: 'Ctrl+Command+X' }, { extensionId: 'ext', name: 'free', accelerator: 'Ctrl+Command+U' }]
    expect([...takenExtensionShortcuts(suggested, {})]).toEqual(['ext:go'])
    expect([...takenExtensionShortcuts(suggested, { clearSiteData: '' })]).toEqual([])
  })
})
