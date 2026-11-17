import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SETTINGS_PANES, SETTINGS_SUBPAGES } from '../../src/shared/ipc'
import { LITTLE_SIZE_MAX } from '../../src/shared/little-window'
import { en } from '../../src/shared/i18n-en'
import { fr } from '../../src/shared/i18n-fr'
import { GUIDE_QUESTIONS, guidePlan, guideQuestionsOf } from '../../src/shared/settings-guide'
import { subpageById } from '../../src/shared/settings-subpages'
import { settingsHash } from '../../src/shared/settings-target'
import { reduce } from '../../src/shared/sidebar'
import { savedStateOf } from '../../src/shared/sidebar-state'
import { SETTINGS_WINDOW_OPTIONS } from '../../src/main/shell/settings-window'
import { NOTES_PAGE, SITE_TABS, VAULT_PAGE, demoSite, demoState, pageDef, pageUrl, spaceId, spaceOfPage, tabId } from './demo'
import { respond } from './pages'
import {
  GUIDE_STEPS_MAX,
  LANGS,
  LITTLE_SIZE,
  MAIN_SIZE,
  SETTINGS_SIZE,
  SHOTS,
  SITE_SHOTS,
  TASK_MANAGER_SIZE,
  THEMES,
  developmentOnlyShots,
  parseChoice,
  parseWidths,
  planSessions,
  settingsAddress,
  shotFiles,
  todoShots,
  type Shot
} from './shots'

const byId = (id: string): Shot => SHOTS.find((shot) => shot.id === id)!
const source = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
const NOW = Date.UTC(2026, 10, 4, 10, 0, 0)

describe('the list of shots', () => {
  it('holds the shots the site and the film need, each once, with a name fit for a file', () => {
    const ids = SHOTS.map((shot) => shot.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(ids).toEqual(
      expect.arrayContaining([
        'main-window', 'space-switch', 'space-projects', 'command-bar-calc', 'command-bar-tab', 'split-view', 'split-view-4', 'peek', 'little-window',
        'resource-panel', 'resource-panel-asleep', 'settings-privacy', 'settings-privacy-off', 'settings-guide', 'settings-guide-recap', 'first-launch',
        'import', 'import-done', 'community', 'community-voted', 'reader-mode', 'pdf-viewer', 'translate', 'quick-notes', 'space-themes',
        'vault-touch-id', 'extensions'
      ])
    )
    // The site shows the sheet of the import as `import` (data-shot="import"): the old name names another browser.
    expect(ids).not.toContain('import-arc')
  })

  it('takes each shot in both languages and both themes, at the size of its window', () => {
    for (const shot of SHOTS) {
      expect(shot.langs).toEqual(LANGS)
      expect(shot.themes).toEqual(THEMES)
      expect(shot.description.length).toBeGreaterThan(10)
      const size = { main: MAIN_SIZE, settings: SETTINGS_SIZE, little: LITTLE_SIZE, taskmanager: TASK_MANAGER_SIZE, private: MAIN_SIZE }[shot.window]
      expect(shot.size, shot.id).toEqual(size)
    }
    expect(MAIN_SIZE).toEqual({ width: 1440, height: 900 })
    // The script cannot load the application's modules (Node's type stripping): the sizes it copies are checked against them here.
    expect(LITTLE_SIZE).toEqual(LITTLE_SIZE_MAX)
    expect(SETTINGS_SIZE).toEqual({ width: SETTINGS_WINDOW_OPTIONS.width, height: SETTINGS_WINDOW_OPTIONS.height })
    // The Extensions page is a tab of the main window now: its shot is the 16:10 of the tiles of the film.
    expect(SHOTS.find((s) => s.id === 'extensions')).toMatchObject({ window: 'main', size: MAIN_SIZE })
    expect(MAIN_SIZE.width / MAIN_SIZE.height).toBe(1.6)
  })

  it('names, in a demonstration session, a space and one of its tabs, and splits a view with tabs of that space, four panes at most', () => {
    for (const shot of SHOTS.filter((s) => s.session === 'demo')) {
      const { space, tab, split = [] } = shot.scene
      expect(space, shot.id).toBeDefined()
      expect(spaceOfPage(tab!), shot.id).toBe(space)
      expect(split.length, shot.id).toBeLessThanOrEqual(3)
      for (const other of split) expect(spaceOfPage(other), `${shot.id} ${other}`).toBe(space)
    }
  })

  it('makes its split views without moving a tab in the sidebar: the shots that follow see it as it was', () => {
    for (const shot of SHOTS.filter((s) => (s.scene.split ?? []).length > 0)) {
      const { space, tab, split = [] } = shot.scene
      const ctx = { now: NOW, newId: (() => { let n = 0; return () => `id-${n++}` })() }
      const start = savedStateOf(JSON.parse(JSON.stringify(demoState('fr', 'light', NOW))))
      let state = reduce(start, { type: 'tab/select', id: tabId(space!, tab!) }, ctx)
      for (const other of split) state = reduce(state, { type: 'split/create', tabId: tabId(space!, tab!), withTabId: tabId(space!, other) }, ctx)
      expect(state.splits.find((s) => s.tabIds.includes(tabId(space!, tab!)))?.tabIds, shot.id).toEqual([tab!, ...split].map((key) => tabId(space!, key)))
      const place = (s: typeof start) => s.tabs.map((t) => [t.id, t.pinned, t.folderId ?? null])
      expect(place(state), shot.id).toEqual(place(start))
    }
  })

  it('opens what exists: the link of the Glance is in the page of its tab, the found tab and the page of the mini window are pages of the demonstration', () => {
    const site = demoSite()
    for (const lang of LANGS) {
      const peek = byId('peek')
      const url = new URL(pageUrl(peek.scene.tab!, lang))
      const html = respond(site, url.host, url.pathname).body
      expect(html).toContain(`id="${peek.scene.peek!.link.slice(1)}"`)
      expect(spaceOfPage(byId('command-bar-tab').scene.commandBar!.openTab!)).toBe(byId('command-bar-tab').scene.space)
      expect(pageDef(byId('little-window').scene.little!).kind).toBe('museum')
    }
    expect(byId('command-bar-calc').scene.commandBar!.text).toEqual({ fr: '12*(3+4)', en: '12*(3+4)' })
    expect(SETTINGS_PANES).toContain(byId('settings-privacy').scene.settings!.pane)
  })

  it('shows each feature on a page made for it: an article in reader mode, a PDF in its viewer, the Community page of the site, the notes and logins of the demonstration', () => {
    expect(pageDef(byId('reader-mode').scene.tab!).kind).toBe('article')
    expect(pageDef(byId('pdf-viewer').scene.tab!).kind).toBe('pdf')
    for (const id of SITE_SHOTS) expect(SITE_TABS.map((t) => t.key)).toContain(byId(id).scene.tab)
    expect(SHOTS.filter((s) => s.scene.community !== undefined).map((s) => s.id)).toEqual([...SITE_SHOTS])
    expect(byId('quick-notes').scene.tab).toBe(NOTES_PAGE)
    expect(byId('vault-touch-id').scene.tab).toBe(VAULT_PAGE)
    expect(byId('community-voted').scene.community).toBe('voted')
    expect(byId('resource-panel-asleep').scene.resourcePanel).toBe('asleep')
    expect(byId('import').scene.importBookmarks).toBe('preview')
    expect(byId('import-done').scene.importBookmarks).toBe('done')
  })

  it('walks the guide from « Pour commencer », its one entry, with answers its questions offer, and stops at a question it asks', () => {
    const guides = SHOTS.filter((s) => s.scene.settings?.guide)
    expect(guides.map((s) => s.id)).toEqual(['settings-guide', 'settings-guide-recap'])
    for (const shot of guides) {
      const { pane, answers, question } = shot.scene.settings!
      // The window draws the card of the guide on « Pour commencer » only, and its « Commencer » asks the questions of every category in turn.
      expect(pane, shot.id).toBe('home')
      const offered = guideQuestionsOf('all').map((q) => q.answers.map((a) => a.id))
      // Each answer is offered by one question, and only by it: the script finds it by its value.
      for (const answer of answers ?? []) expect(offered.filter((ids) => ids.includes(answer)), `${shot.id} ${answer}`).toHaveLength(1)
      // The question to stop at is found by its title, as the window writes it in the language of the run.
      if (question) expect(GUIDE_QUESTIONS.filter((q) => fr[q.title] === question.fr && en[q.title] === question.en), shot.id).toHaveLength(1)
    }
    expect(byId('settings-guide').scene.settings).toMatchObject({ guide: 'question', question: { fr: fr['guide.bloqueur'], en: en['guide.bloqueur'] } })
    expect(byId('settings-guide-recap').scene.settings).toMatchObject({ guide: 'recap' })
    // Each answer of the recap changes something from the demonstration profile (« Renforcée », as a new profile): none is an answer already given.
    const demo = savedStateOf(JSON.parse(JSON.stringify(demoState('fr', 'light', NOW)))).settings
    const questions = guideQuestionsOf('all')
    for (const answer of byId('settings-guide-recap').scene.settings!.answers ?? []) {
      const question = questions.find((q) => q.answers.some((a) => a.id === answer))!
      expect(guidePlan(questions, demo, { [question.id]: answer }).count, answer).toBeGreaterThan(0)
    }
    expect(byId('settings-privacy-off').scene.settings).toMatchObject({ blockerOff: true })
    // Every question can be passed before the script gives up.
    expect(GUIDE_STEPS_MAX).toBeGreaterThan(GUIDE_QUESTIONS.length)
    expect(source('src/renderer/SettingsWindow.tsx')).toMatch(/pane === HOME && <GuideCard pane="all"/)
    expect(source('src/renderer/GuideSettings.tsx')).toContain('className="button primary guide-start"')
    expect(source('src/renderer/GuideSettings.tsx')).toContain('className="guide-question-title"')
  })

  it('opens the Settings window at the address of its page, or of its subpage', () => {
    expect(settingsAddress({ pane: 'protection' })).toBe('protection')
    expect(settingsAddress({ pane: 'protection', sub: 'network' })).toBe('protection/network')
    // The address the application gives the window for the same place (the request `openOverlay` of the script names the page and the subpage).
    for (const sub of SETTINGS_SUBPAGES) {
      const pane = subpageById(sub).pane
      expect(settingsHash(pane, sub), sub).toBe(settingsAddress({ pane, sub }))
    }
    expect(settingsHash('protection')).toBe(settingsAddress({ pane: 'protection' }))
  })

  it('takes the first-launch sheet in a fresh profile, and everything else in the demonstration one', () => {
    expect(SHOTS.filter((s) => s.session === 'fresh').map((s) => s.id)).toEqual(['first-launch'])
    expect(byId('first-launch').scene.firstLaunch).toBe(true)
  })

  it('reads the text of the import sheets and of the first launch for another browser’s name before taking them', () => {
    expect(SHOTS.filter((s) => s.noBrowserNames).map((s) => s.id).sort()).toEqual(['first-launch', 'import', 'import-done'])
  })

  it('keeps the shots of the main window first, then the mini window, then the Settings window, which take the focus', () => {
    const order = SHOTS.filter((s) => s.session === 'demo').map((s) => s.window)
    const lastMain = order.lastIndexOf('main')
    const firstLittle = order.indexOf('little')
    const firstSettings = order.indexOf('settings')
    expect(lastMain).toBeLessThan(firstLittle)
    expect(firstLittle).toBeLessThan(firstSettings)
    expect(order.slice(firstSettings).every((kind) => kind === 'settings')).toBe(true)
  })

  it('puts every tab but the one on screen to sleep only in the last shot of the main window, and the blocker off before it is on', () => {
    const main = SHOTS.filter((s) => s.session === 'demo' && s.window === 'main')
    expect(main.at(-1)!.id).toBe('resource-panel-asleep')
    expect(SHOTS.indexOf(byId('settings-privacy-off'))).toBeLessThan(SHOTS.indexOf(byId('settings-privacy')))
    expect(SHOTS.indexOf(byId('import'))).toBeLessThan(SHOTS.indexOf(byId('import-done')))
  })
})

describe('the plan of a run', () => {
  it('runs, for each language then each theme, the demonstration profile and then the fresh one', () => {
    const plan = planSessions(SHOTS, { langs: LANGS, themes: THEMES })
    expect(plan.map((p) => p.key)).toEqual(['fr/light/demo', 'fr/light/fresh', 'fr/dark/demo', 'fr/dark/fresh', 'en/light/demo', 'en/light/fresh', 'en/dark/demo', 'en/dark/fresh'])
    expect(plan[0]!.shots.map((s) => s.id)).toEqual(SHOTS.filter((s) => s.session === 'demo' && s.todo === undefined).map((s) => s.id))
  })

  it('keeps only the languages, themes and shots asked for, and drops a session left with none', () => {
    const plan = planSessions(SHOTS, { langs: ['en'], themes: ['dark'], only: ['peek', 'first-launch'] })
    expect(plan.map((p) => [p.key, p.shots.map((s) => s.id)])).toEqual([
      ['en/dark/demo', ['peek']],
      ['en/dark/fresh', ['first-launch']]
    ])
    expect(planSessions(SHOTS, { langs: ['fr'], themes: ['light'], only: ['peek'] }).map((p) => p.key)).toEqual(['fr/light/demo'])
  })

  it('leaves out a shot marked « à faire » and lists it apart: the translation, which would need models from the Internet', () => {
    const pending: Shot = { ...byId('peek'), id: 'pending', todo: 'not yet' }
    const plan = planSessions([...SHOTS, pending], { langs: LANGS, themes: THEMES })
    expect(plan.flatMap((p) => p.shots).some((s) => s.id === 'pending' || s.id === 'translate')).toBe(false)
    expect(todoShots([...SHOTS, pending]).map((s) => s.id)).toEqual(['translate', 'pending'])
  })

  it('leaves out, with a packaged application, the shots that need the main process of the development build, and only those', () => {
    const all = planSessions(SHOTS, { langs: ['fr'], themes: ['light'] }).flatMap((p) => p.shots.map((s) => s.id))
    const packaged = planSessions(SHOTS, { langs: ['fr'], themes: ['light'], packaged: true }).flatMap((p) => p.shots.map((s) => s.id))
    const needing = developmentOnlyShots(SHOTS).map((s) => s.id)
    expect(needing.sort()).toEqual(['extensions', 'first-launch', 'import', 'import-done', 'reader-mode'])
    expect(packaged).toEqual(all.filter((id) => !needing.includes(id)))
    expect(planSessions(SHOTS, { langs: ['fr'], themes: ['light'], packaged: true }).map((p) => p.key)).toEqual(['fr/light/demo'])
  })

  it('leaves out the shots of the Community page without a checkout of the site, even when asked for', () => {
    const plan = planSessions(SHOTS, { langs: ['fr'], themes: ['light'], only: ['community', 'peek'], without: SITE_SHOTS })
    expect(plan.flatMap((p) => p.shots.map((s) => s.id))).toEqual(['peek'])
  })

  it('takes, in a full run, 27 shots in each language and theme: 108 in all', () => {
    const plan = planSessions(SHOTS, { langs: LANGS, themes: THEMES })
    expect(plan.reduce((n, p) => n + p.shots.length, 0)).toBe(108)
  })
})

describe('the demonstration state of the shots', () => {
  it('has the tab of every scene in its space', () => {
    for (const lang of LANGS) {
      const state = demoState(lang, 'light', NOW)
      for (const shot of SHOTS.filter((s) => s.session === 'demo')) {
        const tab = state.tabs.find((t) => t.id === tabId(shot.scene.space!, shot.scene.tab!))
        expect(tab?.spaceId, shot.id).toBe(spaceId(shot.scene.space!))
      }
    }
  })
})

describe('the files of a shot', () => {
  it('go in <root>/<language>/<theme>/, with and without the shadow, and as WebP at each width', () => {
    expect(shotFiles('/x/out-captures/', 'fr', 'dark', 'peek', [1280, 2560])).toEqual({
      shadow: '/x/out-captures/fr/dark/peek.png',
      flat: '/x/out-captures/fr/dark/peek-no-shadow.png',
      web: [
        { from: 'shadow', width: 1280, path: '/x/out-captures/fr/dark/web/peek-1280.webp' },
        { from: 'shadow', width: 2560, path: '/x/out-captures/fr/dark/web/peek-2560.webp' },
        { from: 'flat', width: 1280, path: '/x/out-captures/fr/dark/web/peek-no-shadow-1280.webp' },
        { from: 'flat', width: 2560, path: '/x/out-captures/fr/dark/web/peek-no-shadow-2560.webp' }
      ]
    })
  })

  it('never share a path between two shots, languages or themes', () => {
    const paths = LANGS.flatMap((lang) => THEMES.flatMap((theme) => SHOTS.flatMap((shot) => {
      const files = shotFiles('/out', lang, theme, shot.id)
      return [files.shadow, files.flat, ...files.web.map((w) => w.path)]
    })))
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('the options of the command line', () => {
  it('take every value by default, and the ones listed, each once', () => {
    expect(parseChoice(undefined, LANGS, 'langue')).toEqual(['fr', 'en'])
    expect(parseChoice(' ', THEMES, 'thème')).toEqual(['light', 'dark'])
    expect(parseChoice('en, en,fr', LANGS, 'langue')).toEqual(['en', 'fr'])
  })

  it('refuse a value that is not one of the list', () => {
    expect(() => parseChoice('fr,de', LANGS, 'langue')).toThrow(/langue : valeur inconnue « de »/)
  })

  it('read the widths of the WebP images as whole numbers within bounds, in order', () => {
    expect(parseWidths(undefined)).toEqual([1280, 2560])
    expect(parseWidths('2560,1280,1280')).toEqual([1280, 2560])
    for (const bad of ['abc', '0', '1280.5', '100000', '1280,']) expect(() => parseWidths(bad), bad).toThrow(/largeurs invalides/)
  })
})
