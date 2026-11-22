import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { FEATURES, type Feature } from '../../src/shared/features'
import { setLanguage, t as translate } from '../../src/shared/i18n'
import { en } from '../../src/shared/i18n-en'
import { fr } from '../../src/shared/i18n-fr'
import { SETTINGS_PAGES, SETTINGS_SUBPAGES } from '../../src/shared/ipc'
import { interfaceMayDispatch } from '../../src/shared/ipc-policy'
import { defaultSettings, type Settings } from '../../src/shared/model'
import { categoryOfKey, type SettingKey } from '../../src/shared/settings-catalog'
import { settingsPathSteps } from '../../src/shared/settings-path'
import { inFold } from '../../src/shared/settings-placement'
import { SUBPAGES, subpageOfKey } from '../../src/shared/settings-subpages'
import { SEARCH_IDS } from '../../src/shared/settings-synonyms'
import { DEMO_KEYWORD, SPACES, demoSettings, spaceOfPage, tabId } from './demo'
import {
  FEATURE_SCENARIOS,
  FEATURE_WIDTH,
  INDIRECT,
  MORE_LABEL,
  PANE_LABELS,
  SUBPAGE_LABELS,
  THUMB_ASPECT,
  buildManifest,
  capturable,
  checkScenarios,
  cropRegion,
  cropWebpArgs,
  outputName,
  parseCards,
  parseCatalogue,
  parseConstList,
  parseFeatureIds,
  parseObjectKeys,
  parseOverlayPanels,
  parseSettingsKeys,
  pixelCrop,
  planFeatures,
  rowSelectors,
  isRowSelector,
  selectorClasses,
  settingsPlace,
  showsQuote,
  unknownCards,
  ocrCropArgs,
  webpSize,
  type FeatureScenario,
  type ScenarioSources
} from './features'
import { namesShown } from './names'
import { SHOTS, TASK_MANAGER_SIZE } from './shots'

const appRoot = fileURLToPath(new URL('../../', import.meta.url))
const source = (path: string) => readFileSync(join(appRoot, path), 'utf8')
const siteRoot = process.env['LUCIUM_SITE_REPO'] ?? join(appRoot, '..', 'lucium-website')
const sitePages = ['fonctions/index.html', 'en/features/index.html'].map((page) => join(siteRoot, page))
const siteFound = sitePages.every((page) => existsSync(page))

/** The sources the dry run reads, read the same way (scripts/site-captures.mjs, featureSources). */
function realSources(): ScenarioSources {
  const renderer: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(tsx|ts|css)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) renderer.push(readFileSync(path, 'utf8'))
    }
  }
  walk(join(appRoot, 'src/renderer'))
  const catalog = source('src/shared/settings-catalog.ts')
  return {
    settingsKeys: parseSettingsKeys(catalog),
    searchIds: parseConstList(source('src/shared/settings-synonyms.ts'), 'SEARCH_IDS'),
    subpages: parseConstList(source('src/shared/ipc.ts'), 'SETTINGS_SUBPAGES'),
    otherKeys: parseObjectKeys(catalog, 'NO_CONTROL_KEYS'),
    overlayPanels: parseOverlayPanels(source('src/main/shell/ipc.ts')),
    featureIds: parseFeatureIds(source('src/shared/features.ts')),
    renderer: renderer.join('\n'),
    catalogues: { fr: parseCatalogue(source('src/shared/i18n-fr.ts')), en: parseCatalogue(source('src/shared/i18n-en.ts')) },
    shotIds: SHOTS.map((shot) => shot.id)
  }
}

const featureOf = (id: string): Feature | undefined => (FEATURES as readonly Feature[]).find((f) => f.id === id)
afterAll(() => setLanguage('fr'))
const settingScenarios = FEATURE_SCENARIOS.filter((s) => s.evidence === 'setting')

describe('the table of the features page', () => {
  // 130 since the card of document Picture-in-Picture (`fn-document-pip`), 131 since the one of the work views (`fn-work-views`), 132 since the one of the
  // capture of the sound of a tab by an extension (`fn-extension-tab-capture`): the features page of the site has yet to show them. 134 since the two
  // cards that had no scenario (`fn-extensions-page`, `fn-background-framing`), 135 since the tab reminders (`fn-tab-reminders`), 136 since the full-text search of the pages, 137 since the focus mode (`fn-focus-mode`).
  it('has one scenario per card, 137 of them, with one name per image, made from the id of the card', () => {
    const cards = FEATURE_SCENARIOS.map((s) => s.card)
    expect(cards).toHaveLength(137)
    expect(new Set(cards).size).toBe(cards.length)
    const names = FEATURE_SCENARIOS.flatMap((s) => (['fr', 'en'] as const).map((lang) => outputName(s.card, lang)))
    expect(new Set(names).size).toBe(names.length)
    for (const s of FEATURE_SCENARIOS) {
      expect(s.card).toMatch(/^fn-[a-z0-9-]+$/)
      expect(outputName(s.card, 'fr')).toBe(`${s.card}-fr-light.webp`)
    }
  })

  it.skipIf(!siteFound)('covers the cards of both pages of the site, each once, with the feature each card names', () => {
    const byCard = (list: ReadonlyArray<{ id: string; feature?: string | undefined }>) => list.map((card) => `${card.id} ${card.feature ?? '-'}`).sort()
    for (const page of sitePages) expect(byCard(parseCards(readFileSync(page, 'utf8')))).toEqual(byCard(FEATURE_SCENARIOS.map((s) => ({ id: s.card, feature: s.feature }))))
  })

  it('reads the cards of the features page, as the redesigned page writes them and as the page before it did', () => {
    const page = [
      '<li class="fx-item fx-card" id="fn-espaces" data-fx-item data-theme="tabs" data-state="always">',
      '<li class="fx-item fx-opt" id="fn-web-store" data-fx-item data-theme="system" data-state="on" data-feature="web-store">',
      '<li class="fn" id="fn-sleep" data-cat="tabs" data-state="on" data-feature="sleep">',
      '<li class="fx-step" id="note-1">',
      '<li class="fx-item" data-fx-item>'
    ].join('\n')
    expect(parseCards(page)).toEqual([{ id: 'fn-espaces' }, { id: 'fn-web-store', feature: 'web-store' }, { id: 'fn-sleep', feature: 'sleep' }])
  })

  it('gives every image an alternative text in French and in English, distinct, and names no other browser in it nor in the title of its card', () => {
    for (const s of FEATURE_SCENARIOS) {
      for (const lang of ['fr', 'en'] as const) {
        expect(s.alt[lang].trim().length, `${s.card} ${lang}`).toBeGreaterThan(20)
        expect(s.title[lang].trim(), `${s.card} ${lang}`).not.toBe('')
        expect(namesShown(`${s.title[lang]}\n${s.alt[lang]}`), `${s.card} ${lang}`).toEqual([])
      }
      expect(s.alt.fr, s.card).not.toBe(s.alt.en)
    }
  })

  it('names registered features only, and every optional feature of the registry has its card', () => {
    const registered = (FEATURES as readonly Feature[]).map((f) => f.id)
    for (const s of FEATURE_SCENARIOS) if (s.feature) expect(registered, s.card).toContain(s.feature)
    const carded = new Set(FEATURE_SCENARIOS.map((s) => s.feature).filter(Boolean))
    expect(registered.filter((id) => !carded.has(id))).toEqual([])
  })

  it('shows the row of the feature’s own setting, in the category of Réglages that draws it', () => {
    for (const s of settingScenarios) {
      const settings = s.scene?.settings
      expect(settings?.row, s.card).toBeDefined()
      const row = settings?.row ?? ''
      expect(s.crop?.selectors, s.card).toEqual(rowSelectors(row))
      if ((SEARCH_IDS as readonly string[]).includes(row) || isRowSelector(row)) continue
      expect(categoryOfKey(row), s.card).toBe(settings?.pane)
      if (s.feature) expect(row, s.card).toBe(featureOf(s.feature)?.key)
      expect(s.window).toBe('settings')
      expect(s.crop?.selectors).toEqual(rowSelectors(row))
    }
  })

  it('says where the row is as the texts of the application do, read from the map of the window: the page, « Plus de réglages », the subpage', () => {
    // A row of a subpage is drawn there only: the scene opens it. A row of « Plus de réglages » is said to wait there. The alternative text gives the
    // same way as `settingsPath` (src/shared/settings-path.ts), in both languages: a setting that moves, and the image and its text move with it.
    const wrong: string[] = []
    for (const s of settingScenarios) {
      const settings = s.scene?.settings
      const row = settings?.row ?? ''
      if (categoryOfKey(row) === null) continue
      const key = row as SettingKey
      if ((settings?.sub ?? null) !== (subpageOfKey(key)?.id ?? null)) wrong.push(`${s.card}: subpage ${settings?.sub ?? 'none'}, the map says ${subpageOfKey(key)?.id ?? 'none'}`)
      if ((settings?.fold === true) !== inFold(key)) wrong.push(`${s.card}: fold ${settings?.fold === true}, the map says ${inFold(key)}`)
      for (const lang of ['fr', 'en'] as const) {
        setLanguage(lang)
        const path = translate('cmd.settings-pane', { pane: settingsPathSteps({ key }).join(' › ') })
        if (!s.alt[lang].startsWith(`${path}${lang === 'fr' ? ' : ' : ': '}`)) wrong.push(`${s.card} ${lang}: « ${s.alt[lang]} » does not start with « ${path} »`)
      }
    }
    setLanguage('fr')
    expect(wrong).toEqual([])
  })

  it('names the fold and the subpages as the window does', () => {
    expect(MORE_LABEL).toEqual({ fr: fr['settings.plus-de-reglages'], en: en['settings.plus-de-reglages'] })
    expect(Object.keys(SUBPAGE_LABELS).sort()).toEqual([...SETTINGS_SUBPAGES].sort())
    for (const subpage of SUBPAGES) expect(SUBPAGE_LABELS[subpage.id], subpage.id).toEqual({ fr: fr[subpage.title], en: en[subpage.title] })
    expect(settingsPlace('protection', { sub: 'network' })).toEqual({ fr: 'Réglages › Vie privée et sécurité › DNS chiffré et proxy', en: 'Settings › Privacy and security › Encrypted DNS and proxy' })
    expect(settingsPlace('tabs', { fold: true }).fr).toBe('Réglages › Onglets et fenêtres › Plus de réglages')
  })

  it('says why, for every image that is not the feature itself, and why not, for a card without one', () => {
    for (const s of FEATURE_SCENARIOS) {
      if (INDIRECT.has(s.evidence)) expect(s.why?.trim(), s.card).toBeTruthy()
      if (s.evidence === 'none') expect(s.todo?.trim(), s.card).toBeTruthy()
      if (s.evidence === 'shot') expect(SHOTS.map((shot) => shot.id), s.card).toContain(s.shot)
      if (capturable(s)) expect(s.scene, s.card).toBeDefined()
    }
  })

  /** The switches a scene turns on although they may use the network, each with what keeps it from doing so in the demonstration. */
  const NETWORK_ALLOWED: Readonly<Record<string, string>> = {
    liveFolders: 'the demonstration has no live folder: the switch has nothing to fetch while the sheet of a new one is open'
  }

  it('changes for an image only switches that need no restart, that the interface may write and that fetch nothing, or puts back a default the demonstration turns off', () => {
    const defaults = defaultSettings()
    const demo = demoSettings('fr', 'light')
    const problems: string[] = []
    for (const s of FEATURE_SCENARIOS) {
      const patch = s.scene?.patch
      if (!patch) continue
      if (!interfaceMayDispatch({ type: 'settings/update', patch }, [])) problems.push(`${s.card}: the interface may not write ${Object.keys(patch).join(', ')}`)
      for (const [key, value] of Object.entries(patch)) {
        const settingKey = key as keyof Settings
        // The default of the application, that the demonstration profile turns off (demo.ts): shown as it ships.
        if (JSON.stringify(value) === JSON.stringify(defaults[settingKey]) && JSON.stringify(demo[settingKey]) !== JSON.stringify(value)) continue
        const feature = (FEATURES as readonly Feature[]).find((f) => f.key === key)
        if (!feature) {
          problems.push(`${s.card}: ${key} is not the switch of a feature`)
          continue
        }
        if (feature.cost.includes('network') && !Object.hasOwn(NETWORK_ALLOWED, key)) problems.push(`${s.card}: ${key} costs ${feature.cost.join(', ')}`)
        if (feature.requiresRestart) problems.push(`${s.card}: ${key} needs a restart`)
        if (feature.setIn) problems.push(`${s.card}: ${key} is set in ${feature.setIn}`)
        if (value !== true) problems.push(`${s.card}: ${key} is turned to ${JSON.stringify(value)}, not on`)
      }
    }
    expect(problems).toEqual([])
  })

  it('puts its lists and its library in the space on screen, with tabs of the demonstration', () => {
    for (const s of FEATURE_SCENARIOS) {
      const scene = s.scene
      if (!scene?.space) continue
      const space = SPACES.find((sp) => sp.key === scene.space)
      const pages = space ? [...space.pinned, ...space.folders.flatMap((f) => f.tabs), ...space.today] : []
      if (scene.tab) expect(pages, s.card).toContain(scene.tab)
      // « Lire plus tard » keeps a pinned tab open (sidebar-library.ts): the pages of the scene are pinned, or in a folder (pinned too).
      for (const key of scene.readLater ?? []) expect(space?.pinned.includes(key) || space?.folders.some((f) => f.tabs.includes(key)), `${s.card} ${key}`).toBe(true)
      for (const mark of scene.bookmarks ?? []) expect(pages, `${s.card} ${mark.tab}`).toContain(mark.tab)
      // A session is saved from the tabs of one space (the first one named decides): each of its pages is a tab of the space on screen.
      for (const session of scene.sessions ?? []) {
        expect(session.tabs.length, `${s.card} ${session.name.en}`).toBeGreaterThan(0)
        for (const key of session.tabs) expect(pages, `${s.card} ${session.name.en} ${key}`).toContain(key)
      }
      if (scene.bookmarks) expect(scene.patch?.['bookmarkManager'], s.card).toBe(true)
      if (scene.find?.regex) expect(scene.patch?.['findRegex'], s.card).toBe(true)
      for (const key of scene.readLater ?? []) expect(tabId(scene.space, key)).toMatch(/^demo-/)
    }
  })

  it('says the categories of Réglages and the items of the menu as the catalogues do', () => {
    expect(Object.keys(PANE_LABELS)).toEqual([...SETTINGS_PAGES])
    for (const pane of SETTINGS_PAGES) expect(PANE_LABELS[pane]).toEqual({ fr: fr[`settings.cat-${pane}`], en: en[`settings.cat-${pane}`] })
    const menus = FEATURE_SCENARIOS.flatMap((s) => (s.scene?.menu ? [s.scene.menu.label] : []))
    expect(menus).toEqual([
      { fr: fr['menu.nouvelle-fenetre-privee'], en: en['menu.nouvelle-fenetre-privee'] },
      { fr: fr['menu.ouvrir-le-gestionnaire-de-taches'], en: en['menu.ouvrir-le-gestionnaire-de-taches'] },
      { fr: fr['menu.nouveautes'], en: en['menu.nouveautes'] }
    ])
  })

  it('opens the task manager at the size the application gives it', () => {
    expect(source('src/main/shell/own-windows-wiring.ts')).toContain(`{ width: ${TASK_MANAGER_SIZE.width}, height: ${TASK_MANAGER_SIZE.height}, minWidth: 420, minHeight: 260 }`)
  })

  it('passes the dry run against the sources of the application', () => {
    expect(checkScenarios(FEATURE_SCENARIOS, realSources())).toEqual([])
  })
})

describe('the dry run', () => {
  const sources = realSources()
  const base = FEATURE_SCENARIOS.find((s) => s.card === 'fn-sessions') as FeatureScenario
  const setting = FEATURE_SCENARIOS.find((s) => s.card === 'fn-https-first') as FeatureScenario
  const check = (scenario: FeatureScenario, more: Partial<ScenarioSources> = {}) => checkScenarios([scenario], { ...sources, ...more })

  it('reads the sources it checks against', () => {
    expect(sources.settingsKeys['protection']).toContain('httpsUpgrade')
    expect(sources.subpages).toEqual([...SETTINGS_SUBPAGES])
    expect(sources.searchIds).toContain('exportData')
    expect(sources.otherKeys).toContain('showAdvancedSettings')
    expect(sources.overlayPanels).toEqual(expect.arrayContaining(['sessions', 'qr', 'bookmarks', 'settings']))
    expect(sources.overlayPanels).not.toContain('whatsnew')
    expect(sources.featureIds).toEqual((FEATURES as readonly Feature[]).map((f) => f.id))
    expect(sources.catalogues.fr.has('Nouvelle fenêtre privée')).toBe(true)
    expect(selectorClasses('.card.sessions [data-x="y.z"] > .row')).toEqual(['card', 'sessions', 'row'])
  })

  it('refuses a row that its category does not draw', () => {
    expect(check({ ...setting, scene: { ...setting.scene, settings: { pane: 'about', row: 'httpsUpgrade' } } })).toEqual([expect.stringContaining('httpsUpgrade')])
    expect(check({ ...setting, scene: { ...setting.scene, settings: { pane: 'protection', row: 'noSuchRow' } } })).toEqual([expect.stringContaining('noSuchRow')])
    expect(check({ ...setting, scene: { ...setting.scene, settings: { pane: 'files', row: '.no-such-buttons' } } })).toEqual([expect.stringContaining('no-such-buttons')])
  })

  it('refuses a subpage the window does not have', () => {
    const proxy = FEATURE_SCENARIOS.find((s) => s.card === 'fn-proxy') as FeatureScenario
    expect(check(proxy)).toEqual([])
    expect(check({ ...proxy, scene: { ...proxy.scene, settings: { pane: 'protection', sub: 'nosuchsub' as 'network', row: 'proxyEnabled' } } })).toEqual([expect.stringContaining('nosuchsub')])
  })

  it('finds in the text of the target the words the alternative text quotes, whatever the spaces and the case', () => {
    expect(showsQuote('Contraste de la page\u202f: Sombre\nAssombrir', 'Contraste de la page : sombre')).toBe(true)
    expect(showsQuote('DNS chiffré et proxy\nAutomatique', 'Utiliser un proxy HTTP ou SOCKS')).toBe(false)
  })

  it('refuses a panel the interface may not open, a class the interface does not have, a menu the catalogues do not name, a setting that does not exist', () => {
    expect(check({ ...base, scene: { ...base.scene, overlay: { request: { panel: 'whatsnew' }, wait: '.card.sessions' } } })).toEqual([expect.stringContaining('whatsnew')])
    expect(check({ ...base, crop: { page: 'overlay', selectors: ['.card.no-such-class'] } })).toEqual([expect.stringContaining('no-such-class')])
    expect(check({ ...base, scene: { ...base.scene, menu: { label: { fr: 'Nulle part', en: 'Nowhere' } } } })).toHaveLength(2)
    expect(check({ ...base, scene: { ...base.scene, patch: { noSuchSetting: true } } })).toEqual([expect.stringContaining('noSuchSetting')])
  })

  it('refuses two scenarios for a card, a missing text, an indirect image that does not say why, a shot that does not exist', () => {
    expect(checkScenarios([base, base], sources)).toEqual(expect.arrayContaining([expect.stringContaining('deux scénarios')]))
    expect(check({ ...base, alt: { fr: base.alt.fr, en: '' } })).toEqual(expect.arrayContaining([expect.stringContaining('en')]))
    expect(check({ ...setting, why: undefined })).toEqual([expect.stringContaining('pourquoi')])
    expect(check({ ...base, evidence: 'shot', shot: 'no-such-shot' })).toEqual([expect.stringContaining('no-such-shot')])
  })

  it('compares the table with the cards of the page: a card without a scenario, a scenario without a card, another feature', () => {
    expect(check(base, { cards: [{ id: 'fn-sessions' }] })).toEqual([])
    expect(check(base, { cards: [{ id: 'fn-sessions' }, { id: 'fn-new' }] })).toEqual([expect.stringContaining('fn-new')])
    expect(check(base, { cards: [] })).toEqual([expect.stringContaining('sans carte')])
    expect(check(base, { cards: [{ id: 'fn-sessions', feature: 'notes' }] })).toEqual([expect.stringContaining('notes')])
  })

  it('names the cards --only asks for that the table does not have', () => {
    expect(unknownCards(FEATURE_SCENARIOS, ['fn-sleep', 'fn-nope'])).toEqual(['fn-nope'])
  })
})

describe('the extensions of the demonstration a scene loads', () => {
  const loading = FEATURE_SCENARIOS.filter((s) => s.scene?.demoExtension)

  it('are used by the scene: the keyword typed in the command bar, the group made of tabs of the space on screen', () => {
    expect(loading.map((s) => s.card).sort()).toEqual(['fn-omnibox-keywords', 'fn-tab-groups-ext'])
    for (const s of loading) {
      const scene = s.scene!
      expect(s.evidence, s.card).toBe('direct')
      if (scene.demoExtension === 'keyword') {
        expect(scene.commandBar?.expect, s.card).toBe('extension')
        for (const lang of ['fr', 'en'] as const) expect(scene.commandBar?.text[lang].startsWith(`${DEMO_KEYWORD} `), `${s.card} ${lang}`).toBe(true)
        expect(scene.patch?.['omniboxKeywords'], s.card).toBe(true)
      } else {
        // The group is asked for from the page of the scene's tab, and made of open tabs of its space.
        expect(scene.tabGroup?.tabs, s.card).toContain(scene.tab)
        for (const page of scene.tabGroup?.tabs ?? []) expect(spaceOfPage(page), `${s.card} ${page}`).toBe(scene.space)
        expect(scene.patch?.['tabGroupFolders'], s.card).toBe(true)
      }
    }
    // The command bar looks for the line of an extension, and a group is made, only by the extension that does it.
    for (const s of FEATURE_SCENARIOS) {
      if (s.scene?.commandBar?.expect === 'extension') expect(s.scene.demoExtension, s.card).toBe('keyword')
      if (s.scene?.tabGroup) expect(s.scene.demoExtension, s.card).toBe('groups')
    }
  })
})

describe('the plan of a run', () => {
  it('takes every capturable card in each language, the main window first, Settings last, and never a shot of the site or a card without capture', () => {
    const plan = planFeatures(FEATURE_SCENARIOS, { langs: ['fr', 'en'] })
    expect(plan.map((session) => session.lang)).toEqual(['fr', 'en'])
    const order = { main: 0, private: 1, taskmanager: 2, settings: 3 } as Record<string, number>
    const windows = plan[0]?.scenarios.map((s) => order[s.window ?? 'main'] ?? -1) ?? []
    expect(windows).toEqual([...windows].sort((a, b) => a - b))
    expect(plan[0]?.scenarios.length).toBe(FEATURE_SCENARIOS.filter(capturable).length)
    expect(plan[0]?.scenarios.some((s) => s.evidence === 'shot' || s.evidence === 'none')).toBe(false)
  })

  it('keeps to --only, and with --missing leaves out what is already there, a language at a time', () => {
    expect(planFeatures(FEATURE_SCENARIOS, { langs: ['fr'], only: ['fn-qr-code', 'fn-sleep'] }).flatMap((s) => s.scenarios.map((x) => x.card))).toEqual(['fn-qr-code'])
    const done = (card: string, lang: string) => lang === 'fr' || card !== 'fn-qr-code'
    const plan = planFeatures(FEATURE_SCENARIOS, { langs: ['fr', 'en'], done })
    expect(plan.map((session) => [session.lang, session.scenarios.map((s) => s.card)])).toEqual([['en', ['fn-qr-code']]])
  })
})

describe('the crop', () => {
  const main = { width: 1440, height: 900 }

  it('is a 16:10 box within the window, around the target, at least as wide as asked', () => {
    const target = { x: 600, y: 300, width: 300, height: 200 }
    const box = cropRegion(target, main, { minWidth: 720 })
    expect(box.width / box.height).toBeCloseTo(THUMB_ASPECT, 1)
    expect(box.width).toBeGreaterThanOrEqual(720)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(main.width)
    expect(box.y + box.height).toBeLessThanOrEqual(main.height)
    expect(box.x).toBeLessThanOrEqual(target.x)
    expect(box.x + box.width).toBeGreaterThanOrEqual(target.x + target.width)
    expect(box.y).toBeLessThanOrEqual(target.y)
    expect(box.y + box.height).toBeGreaterThanOrEqual(target.y + target.height)
  })

  it('grows to hold a tall target, up to the window, and keeps the top of one taller still', () => {
    const card = cropRegion({ x: 460, y: 100, width: 520, height: 640 }, main, { minWidth: 720 })
    expect(card.height).toBeGreaterThanOrEqual(640)
    expect(cropRegion({ x: 0, y: 0, width: 1440, height: 900 }, main)).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    const sidebar = cropRegion({ x: 0, y: 0, width: 260, height: 900 }, { width: 780, height: 760 }, { minWidth: 400 })
    expect(sidebar.y).toBe(0)
    expect(sidebar.width).toBe(780)
  })

  it('stays inside a window narrower than the box asked, and in the pixels of the capture', () => {
    const settings = cropRegion({ x: 200, y: 700, width: 560, height: 50 }, { width: 780, height: 760 }, { minWidth: 780 })
    expect(settings).toEqual({ x: 0, y: 273, width: 780, height: 488 })
    expect(pixelCrop(settings, 2, { width: 1560, height: 1520 })).toEqual({ x: 0, y: 546, width: 1560, height: 974 })
    expect(pixelCrop({ x: 10, y: 10, width: 5000, height: 5000 }, 2, { width: 1560, height: 1520 })).toEqual({ x: 20, y: 20, width: 1540, height: 1500 })
  })

  it('cuts the same box at its full size for tesseract to read', () => {
    expect(ocrCropArgs('in.png', 'read.png', { x: 1, y: 2, width: 3, height: 4 })).toEqual(['in.png', '-crop', '3x4+1+2', '+repage', 'read.png'])
  })

  it('makes a WebP no wider than the page needs, never enlarged', () => {
    const args = cropWebpArgs('in.png', 'out.webp', { x: 1, y: 2, width: 3, height: 4 })
    expect(args.slice(0, 5)).toEqual(['in.png', '-crop', '3x4+1+2', '+repage', '-resize'])
    expect(args).toContain(`${FEATURE_WIDTH}x>`)
    expect(args.at(-1)).toBe('out.webp')
  })
})

describe('the manifest', () => {
  const vp8x = (width: number, height: number) => {
    const bytes = new Uint8Array(30)
    bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
    bytes.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8)
    const put24 = (at: number, value: number) => bytes.set([value & 255, (value >> 8) & 255, (value >> 16) & 255], at)
    put24(24, width - 1)
    put24(27, height - 1)
    return bytes
  }

  it('reads the size of a WebP from its header, and nothing from another file', () => {
    expect(webpSize(vp8x(960, 600))).toEqual({ width: 960, height: 600 })
    expect(webpSize(new Uint8Array(40))).toBeNull()
  })

  it('lists every card: its images where they are, the image of the site for a shot, none for a card waiting, with what each shows and why', () => {
    const present = new Set(['fn-qr-code-fr-light.webp'])
    const manifest = buildManifest(FEATURE_SCENARIOS, (name) => (present.has(name) ? { width: 960, height: 600 } : null))
    expect(manifest.cards.map((card) => card.card)).toEqual(FEATURE_SCENARIOS.map((s) => s.card))
    const qr = manifest.cards.find((card) => card.card === 'fn-qr-code')
    expect(qr?.files).toEqual({ fr: { file: 'fn-qr-code-fr-light.webp', width: 960, height: 600 }, en: null })
    expect(qr?.source).toBe('capture')
    const sleep = manifest.cards.find((card) => card.card === 'fn-sleep')
    expect(sleep?.source).toBe('site')
    expect(sleep?.files.fr?.file).toBe('resource-panel-asleep-fr-light.webp')
    const waiting = manifest.cards.find((card) => card.card === 'fn-videos-protegees')
    expect(waiting?.files).toEqual({ fr: null, en: null })
    expect(waiting?.todo).toBeTruthy()
    for (const card of manifest.cards) {
      expect(card.alt.fr && card.alt.en, card.card).toBeTruthy()
      expect(card.shows, card.card).toBeTruthy()
      if (card.evidence === 'setting' || card.evidence === 'command') expect(card.why, card.card).toBeTruthy()
    }
  })
})
