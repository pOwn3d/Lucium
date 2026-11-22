// The stylesheets of the panels speak of tokens, not of colours, and none of them forces the dark scheme.
// What is measured: no colour is written in a migrated sheet (but the few that are pictures or fixed on purpose, listed here with their reason), every
// `var(--x)` names something that exists, and the template sheets are as strict as the tokens themselves.

import { describe, expect, it } from 'vitest'
import tokensCss from './tokens.css?raw'

const sheets = import.meta.glob('./*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const templateSheets = import.meta.glob('./templates/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** The sheets that were moved onto the tokens, each with the rules that keep a colour of their own, and why. */
const MIGRATED: Record<string, { exempt?: RegExp[]; why?: string }> = {
  'shortcut-sheet.css': {
    why: 'the sheet that makes a direct shortcut: built on the tokens of the other sheets, with no colour of its own',
  },
  'styles.css': {
    exempt: [/\.hue-slider/, /\.side-panel-/, /body\.little/, /\.capture-box/],
    why: 'the hue ramp is a picture, the header of the extension side panel is dark in every theme, the Mini-fenêtre has its own ground, and the selection box of a capture is a fixed pink'
  },
  'settings.css': { exempt: [/\.pref-icon/, /\.keycap/, /input\[type='checkbox'\]\[role='switch'\]::after/], why: 'the coloured tiles and the two pictures of the panes, and the white thumb of a switch' },
  'annotate.css': { exempt: [/\.annotate-text/], why: 'the text typed over a screenshot is drawn over a picture, not over the interface' },
  'popovers.css': {},
  'command-bar.css': {},
  'shortcut-help.css': {},
  'site-panel.css': {},
  'plus-menu.css': {},
  'bookmarks.css': {},
  'passwords.css': {},
  'notes.css': {},
  'sessions.css': {},
  'sync-settings.css': {},
  'work-views.css': {},
  'cookies.css': {},
  'read-later.css': {},
  'manage-panels.css': {},
  'site-data.css': {},
  'qr.css': {},
  'auto-reload.css': {},
  'translate.css': {},
  'arc-dialog.css': {},
  'auth-panel.css': {},
  'prompt-panel.css': {},
  'tab-cycle.css': {},
  'import-sheet.css': {},
  'find-replace.css': {},
  'extension-review.css': {},
  'extensions-page.css': {},
  'insight.css': {},
  'shields.css': {},
  'about.css': {},
  // The sidebar and the toolbar: the shell says light or dark by its class and the sheets read the roles of the tokens.
  'sidebar.css': {},
  'sidebar-states.css': {},
  'sidebar-interactions.css': {},
  'sidebar-right.css': {},
  // The docked sidebar of a window (« barre collée »): its column of icons and the button of the full sidebar that folds it.
  'docked-sidebar.css': {},
  'tabs-ui.css': {},
  'live-folders.css': {},
  'space-menu.css': {},
  'tidy-panel.css': {},
  'dead-tabs.css': {},
  'sync-conflict.css': {},
  'toolbar.css': { exempt: [/html\.private/], why: "the bar of a private window is the colour of its theme, in stripes: an identity, not a role" },
  // The spaces: the new-space sheet, "Personnaliser l'espace", "Gérer les espaces", the icon picker, the drawing of the sidebar and the theme panel.
  'spacecreate.css': {},
  'space-customize.css': {},
  'space-manage.css': {},
  'icon-picker.css': {},
  'sidebar-thumb.css': {},
  'theme-editor.css': {},
  'settings-illustrations.css': {},
  // « Régler en quelques questions » (GuideSettings.tsx): the card, the questions and the list of what changes.
  'settings-guide.css': {},
  // The presets of the Settings (PresetSettings.tsx): the buttons or the menu, the line of the option, the notice of a choice.
  'settings-presets.css': {},
  // The launch sheets: the question of a page that holds the navigation, the welcome of the first launch, the news of an update.
  'leave-sheet.css': {},
  'welcome-sheet.css': {},
  'whats-new.css': {},
  // « Vous venez d’Arc ? »: the guide that maps the names of another browser to Lucium's.
  'arc-guide.css': {},
  // « Découvrir Lucium »: the features by task, with a search, cards and the other functions.
  'discover.css': {},
  // « Signaler un problème » (Aide): the report to read, copy or save.
  'problem-report.css': {},
  // « Notifications récentes »: the notices of the window, in the same card as the news.
  'notices.css': {},
  'first-launch.css': { exempt: [/\.color-chip/], why: 'the palette of the first-launch guide is intentionally fixed to a few brand colours' },
  // The Tweak editor: once a light panel with fixed colours, now on the tokens like the other editors.
  'boosts-editor.css': {},
  // The Find in page bar.
  'find-bar.css': {},
  // Space background media panel: upload and manage images/GIFs/videos for space backgrounds.
  'space-media-panel.css': {},
  // The windows that were drawn with their own colours: their colours are the fixed palette of tokens.css, and the mini window's address is 4.5:1 (below).
  'little.css': {},
  'lock.css': {},
  'media-player.css': {},
  // The bar of Lucium's floating video window: over a video, in every theme, so on the fixed palette like the media player.
  'floating-video.css': {},
  'find-peek.css': {},
  'split-drop.css': {},
  // The ring of the resources at the foot of the sidebar and its panel (the function resource-gauge).
  'resource-panel.css': {},
  // Small sheets that never had a colour of the old names to move: listed so that one written in them tomorrow is refused like anywhere else.
  'space-image.css': {},
  'window.css': {},
  // The buttons of the system over the window (Windows) and the room for the traffic lights: lengths and attributes only.
  'window-controls.css': {},
  'private.css': {},
  'host-text.css': {},
  'extension-settings.css': {}
}

/** The sheets that are not in the list, each for its reason: the two that define the colours, and the split bar, which is checked on its own below. */
const OUTSIDE_THE_LIST = ['palette.css', 'split-bar.css', 'tokens.css']

/** Custom properties that the TypeScript sets on an element (inline), so that no stylesheet declares them. */
const SET_BY_SCRIPT = new Set(['--veil', '--veil-color', '--toast-ms', '--notice-ms', '--hue', '--popover-right', '--sb-left', '--hero', '--fr-shadow', '--bg-gradient', '--window-border', '--window-alpha', '--card-outline', '--grain-image', '--grain-opacity', '--sidebar-width', '--p', '--tree-depth', '--tb-side', '--c', '--w', '--x0', '--y0', '--x1', '--y1', '--bx-top', '--v', '--fb-shadow', '--share', '--reload-progress', '--toast-progress', '--grip-x', '--grip-y', '--card-gap-right'])

const COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/gi

/** The text of a sheet with its comments and its embedded pictures taken out. */
const code = (sheet: string): string => sheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\("data:[^"]*"\)/g, 'url()')

/** The colours written in the rules of a sheet that are not exempt, as `selector { colour }` lines. */
function writtenColours(sheet: string, exempt: readonly RegExp[]): string[] {
  const lines: string[] = []
  for (const rule of code(sheet).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]!.trim().replace(/\s+/g, ' ')
    if (exempt.some((pattern) => pattern.test(selector))) continue
    for (const colour of rule[2]!.match(COLOUR) ?? []) lines.push(`${selector.slice(0, 70)} { ${colour} }`)
  }
  return lines
}

const declared = (sheet: string): Set<string> => new Set([...code(sheet).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]!))
const used = (sheet: string): string[] => [...code(sheet).matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!)

const everySheet = { ...sheets, ...templateSheets }
const everyDeclared = new Set([...Object.values(everySheet).flatMap((sheet) => [...declared(sheet)])])

describe('the migrated stylesheets', () => {
  it('are all there', () => {
    for (const name of Object.keys(MIGRATED)) expect(sheets[`./${name}`], name).toBeTypeOf('string')
  })

  it('are every sheet of the interface: a new sheet joins the list, or it could write a colour that no test sees', () => {
    const unlisted = Object.keys(sheets).map((path) => path.slice(2)).filter((name) => !(name in MIGRATED)).sort()
    expect(unlisted).toEqual(OUTSIDE_THE_LIST)
  })

  it.each(Object.entries(MIGRATED))('%s writes no colour: every colour is a token', (name, { exempt = [] }) => {
    expect(writtenColours(sheets[`./${name}`]!, exempt)).toEqual([])
  })

  it('keep the exceptions to a few rules, each for a reason: a picture, a colour fixed by the content, the shell of a space', () => {
    const exceptions = Object.entries(MIGRATED).filter(([, { exempt }]) => exempt && exempt.length > 0)
    expect(exceptions.map(([name]) => name).sort()).toEqual(['annotate.css', 'first-launch.css', 'settings.css', 'styles.css', 'toolbar.css'])
    for (const [name, { why }] of exceptions) expect(why, name).toBeTruthy()
  })

  it('do not force the dark scheme: the window follows the system, or what View > Appearance forces (decision R6b)', () => {
    // Three cards are drawn on a fill computed dark from the page behind them (cardSurface, popoverSurface): their text must read the dark tokens, so they say so
    // (dark-glass-scheme.test.ts checks those rules). The dark Glance card (find-peek.css) is the same case: it is dark when the page behind it is.
    // Nothing else in a migrated sheet does.
    const darkGlass: Record<string, RegExp> = {
      'site-panel.css': /^body\.overlay \.scc$/,
      'popovers.css': /^\.dlpop$/,
      'command-bar.css': /^body\.overlay \.palette:not\(\.cb-little\)$/,
      'find-peek.css': /^\.pk-card\.dark$/
    }
    for (const name of Object.keys(MIGRATED)) {
      const forced = [...code(sheets[`./${name}`]!).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((rule) => /(?<![-\w])color-scheme\s*:\s*dark/.test(rule[2]!))
        .map((rule) => rule[1]!.trim().replace(/\s+/g, ' '))
        .filter((selector) => !darkGlass[name]?.test(selector))
      expect(forced, name).toEqual([])
    }
    // The settings window used to say it ("a fixed dark window"): it does not any more.
    expect(sheets['./settings.css']).not.toMatch(/fixed dark window/)
  })

  it('leave to tokens.css the scheme and the names the stylesheets used before the tokens', () => {
    const root = /:root\s*\{[^}]*\}/.exec(code(sheets['./styles.css']!))![0]
    expect(root).not.toMatch(/--text|--muted|--hover|--active|color-scheme/)
    expect(tokensCss).toMatch(/--muted: var\(--text-2\)/)
  })

  it('refer only to custom properties that exist: a token, one of the sheet itself, or one the script sets', () => {
    const tokens = declared(tokensCss)
    for (const name of Object.keys(MIGRATED)) {
      const own = declared(sheets[`./${name}`]!)
      const unknown = used(sheets[`./${name}`]!).filter((property) => !tokens.has(property) && !own.has(property) && !everyDeclared.has(property) && !SET_BY_SCRIPT.has(property))
      expect(unknown, name).toEqual([])
    }
  })
})

describe('the sheets that are not migrated yet', () => {
  it('do not use the names of the tokens without a ground of their own: a sheet outside the list that does so is a panel to move or to pin', () => {
    const legacyNames = /var\(--(?:text|muted|hover|active)\b/
    const users = Object.keys(sheets)
      .map((path) => path.slice(2))
      .filter((name) => !(name in MIGRATED) && name !== 'tokens.css' && legacyNames.test(code(sheets[`./${name}`]!)))
      .sort()
    // What uses them today, and why it is fine: the split bar lives in the shell, which sets those names itself (inline, from the theme of the space). The sheets of
    // the sidebar and the toolbar left this list when they were moved onto the tokens, then those of the new-space sheet and the theme panel with the spaces.
    expect(users).toEqual(['split-bar.css'])
  })

  it('leave the theme panel and the new-space sheet to the system: neither pins the dark scheme any more', () => {
    for (const name of ['theme-editor.css', 'spacecreate.css']) expect(code(sheets[`./${name}`]!), name).not.toMatch(/color-scheme\s*:\s*dark/)
  })

  it('split-bar.css writes no colour either: it keeps the legacy names above, but its colours are tokens', () => {
    expect(writtenColours(sheets['./split-bar.css']!, [])).toEqual([])
  })
})

/** The value of a token of the fixed palette (palette.css), when it is written as a 6-digit hex colour. */
const tokenHex = (name: string): string => new RegExp(`${name}:\\s*(#[0-9a-f]{6});`).exec(sheets['./palette.css']!)![1]!

/** WCAG relative contrast of two 6-digit hex colours. */
function contrastOf(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const channel = parseInt(hex.slice(i, i + 2), 16) / 255
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

describe('the address of the mini window', () => {
  it('is drawn with its own host colour, not with the glyph colour', () => {
    expect(sheets['./little.css']).toMatch(/\.la-host \{[^}]*color: var\(--la-host\)/)
  })

  it('reads 4.5:1 or more on the ground at both ends of its gradient and on the plain ground, in both schemes', () => {
    for (const ground of ['--fixed-282150', '--fixed-28112d', '--fixed-17171c']) expect(contrastOf(tokenHex('--fixed-9a98a4'), tokenHex(ground)), ground).toBeGreaterThanOrEqual(4.5)
    expect(contrastOf(tokenHex('--fixed-6a6a74'), tokenHex('--fixed-f1f1f4'))).toBeGreaterThanOrEqual(4.5)
  })
})

describe('the sheets of the templates', () => {
  it('write no colour at all', () => {
    for (const [name, sheet] of Object.entries(templateSheets)) expect(writtenColours(sheet, []), name).toEqual([])
  })

  it('refer only to tokens or to their own properties', () => {
    const tokens = declared(tokensCss)
    for (const [name, sheet] of Object.entries(templateSheets)) {
      const own = declared(sheet)
      expect(used(sheet).filter((property) => !tokens.has(property) && !own.has(property)), name).toEqual([])
    }
  })

  it('keep every control at 28 px or more: the buttons, the chips and the fields take their height from --target', () => {
    const primitives = templateSheets['./templates/primitives.css']!
    for (const selector of ['.tk-btn', '.tk-chip', '.tk-field']) {
      const rule = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*\\}`).exec(code(primitives))?.[0] ?? ''
      expect(rule, selector).toMatch(/(min-)?height:\s*var\(--target\)/)
    }
  })
})

/** The px of a spacing token of tokens.css. */
const spacing = new Map([...code(tokensCss).matchAll(/(--sp-\d+):\s*(\d+(?:\.\d+)?)px/g)].map((match) => [match[1]!, Number(match[2])]))

/** The pixels a length comes to: `0`, px, a spacing token, or a calc of two of them (a sheet writes no more for a spacing). */
function pixels(length: string): number {
  const expression = length
    .trim()
    .replace(/^calc\(([\s\S]*)\)$/, '$1')
    .replace(/var\((--sp-\d+)\)/g, (_, name: string) => String(spacing.get(name) ?? Number.NaN))
    .replace(/(\d+(?:\.\d+)?)px/g, '$1')
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(?:([*/+-])\s*(-?\d+(?:\.\d+)?))?\s*$/.exec(expression)
  if (!match) return Number.NaN
  const [a, operator, b] = [Number(match[1]), match[2], Number(match[3])]
  return operator === '*' ? a * b : operator === '/' ? a / b : operator === '+' ? a + b : operator === '-' ? a - b : a
}

/** The top of the `padding` or `margin` of the rule `selector` of a sheet: its `-top`, or the first length of its shorthand. */
function topOf(sheet: string, selector: string, box: 'padding' | 'margin'): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&').replace(/\s+/g, '\\s+')
  const body = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(code(sheet))?.[1] ?? ''
  const own = new RegExp(`(?:^|;)\\s*${box}-top:\\s*([^;]+)`).exec(body)?.[1]
  if (own) return own.trim()
  const shorthand = new RegExp(`(?:^|;)\\s*${box}:\\s*([^;]+)`).exec(body)?.[1]?.trim() ?? ''
  // The first length ends at the first space outside parentheses (a calc has spaces of its own).
  let depth = 0
  for (const [index, character] of [...shorthand].entries()) {
    if (character === '(') depth++
    else if (character === ')') depth--
    else if (depth === 0 && /\s/.test(character)) return shorthand.slice(0, index)
  }
  return shorthand
}

describe('the foldable sections', () => {
  // The body of a section used to start right under its header: the header's hover ground and the tooltip of a control under the pointer
  // sat on its first line. The air comes from the spacing tokens, so that it follows them.
  const AIR = [
    { sheet: './site-panel.css', selector: 'body.overlay .scc-section-body', box: 'padding', px: 6 },
    // « Plus de réglages », the one fold of a page of Settings.
    { sheet: './settings.css', selector: '.more-settings-body', box: 'padding', px: 6 },
    // A folder of « Lire plus tard »: 4 px of the gap of its column, and the air.
    { sheet: './read-later.css', selector: '.readlater .readlater-list.inner', box: 'margin', px: 6 },
    { sheet: './read-later.css', selector: '.readlater .readlater-empty.folder-empty', box: 'margin', px: 6 }
  ] as const

  it('start their body some air under the header: in the site panel, in the folds of Settings and in the folders of « Lire plus tard »', () => {
    for (const { sheet, selector, box, px } of AIR) expect(pixels(topOf(sheets[sheet]!, selector, box)), `${sheet} ${selector}`).toBe(px)
  })

  it('take that air from the spacing tokens, not from pixels written by hand', () => {
    for (const { sheet, selector, box } of AIR) expect(topOf(sheets[sheet]!, selector, box), `${sheet} ${selector}`).toMatch(/^(calc\()?var\(--sp-\d+\)/)
  })

  it('read the lengths they are measured with', () => {
    expect([pixels('0'), pixels('6px'), pixels('var(--sp-3)'), pixels('calc(var(--sp-3) / 2)'), pixels('calc(var(--sp-1) + 2px)')]).toEqual([0, 6, 12, 6, 6])
    expect(topOf('a .b { padding: calc(var(--sp-3) / 2) 0 6px; }', 'a .b', 'padding')).toBe('calc(var(--sp-3) / 2)')
    expect(topOf('x > y { margin: 1px 0; margin-top: var(--sp-2); }', 'x > y', 'margin')).toBe('var(--sp-2)')
  })
})

describe('reduced motion', () => {
  it('stops the sliding card of the floating sidebar when the system asks for it', () => {
    expect(sheets['./window.css']).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.floating-shell\.in \.sidebar \{ animation: none; \}/)
  })

  it('takes the veil of a split view to nil duration when the system asks for it', () => {
    expect(sheets['./split-drop.css']).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.split-drop \{ --sd-ms: 0ms; \}/)
  })
})

describe('tokens.css', () => {
  it('is the only place where a colour is written as a value of the system', () => {
    expect(writtenColours(tokensCss, []).length).toBeGreaterThan(30)
  })
})

describe('the fixed palette', () => {
  // A sheet that reads a `--fixed-…` colour without importing palette.css gets it only while another sheet of the same surface imports it:
  // take that other sheet away and the colour is gone, with nothing to say so.
  it('is imported by every sheet that reads one of its colours', () => {
    const readers = Object.entries(sheets).filter(([name, sheet]) => name !== './palette.css' && /var\(--fixed-/.test(sheet))
    expect(readers.length).toBeGreaterThan(5)
    expect(readers.filter(([, sheet]) => !sheet.includes("@import './palette.css';")).map(([name]) => name)).toEqual([])
  })
})

describe('the syntax of every sheet', () => {
  // A sheet cut in the middle of a rule (a bad edit) is still read by the bundler's recovery, which drops the rule without a word. No parser is a direct
  // dependency, so the braces are counted: outside comments and strings they must close, never go below zero, and no rule may be left without its braces.
  const balance = (css: string): { depth: number; minDepth: number; dangling: string } => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
    let depth = 0
    let minDepth = 0
    for (const ch of code) {
      if (ch === '{') depth += 1
      if (ch === '}') depth -= 1
      minDepth = Math.min(minDepth, depth)
    }
    return { depth, minDepth, dangling: code.replace(/\s+/g, ' ').trim().replace(/^.*[};]\s*/, '') }
  }

  it('closes every brace of every sheet and ends each one after a closed rule', () => {
    const all = Object.entries({ ...sheets, ...templateSheets })
    expect(all.length).toBeGreaterThan(40)
    const broken = all.filter(([, css]) => {
      const { depth, minDepth, dangling } = balance(css)
      return depth !== 0 || minDepth < 0 || dangling !== ''
    })
    expect(broken.map(([name]) => name)).toEqual([])
  })

  it('sees a sheet that stops in the middle of a rule', () => {
    expect(balance('.a { color: red; }\n.b, ').dangling).not.toBe('')
    expect(balance('.a { color: red;').depth).toBe(1)
    expect(balance('.a { color: red; }\n.b { }').dangling).toBe('')
  })
})
