// @vitest-environment happy-dom
// The menus, the notices, the panels, the command bar and the typed addresses that open the Settings at a place (`{ panel: 'settings', pane, anchor }`):
// each one, read in the sources, is in the table below with the place it announces, and the window, mounted at the address the main process gives it,
// shows that place: its page in the sidebar, the group or the subpage under the title the table says, « Plus de réglages » opened for a group that
// waits there, and the focus on that title.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLanguage, t, type MessageKey } from '@shared/i18n'
import { FLOW_ANCHORS, ANCHOR_PANE, resolveSettingsTarget, settingsAnchorLabel } from '@shared/settings-catalog'
import { SETTINGS_ANCHORS, SETTINGS_SUBPAGES, type SettingsAnchor, type SettingsPage, type UiSnapshot } from '@shared/ipc'
import { settingsHash } from '@shared/settings-target'
import { subpageById } from '@shared/settings-subpages'
import { createInitialState } from '@shared/sidebar'
import { installBridge, mount, settle, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'

interface Link {
  /** Where the link is: what a person clicks or types. */
  from: string
  /** The texts of the menus and the notices that lead here (the label of the entry, the button of the notice). */
  labels?: readonly MessageKey[]
  page: SettingsPage
  /** The title of the place it lands on: the group, the subpage, or the questions of the guide. */
  title: MessageKey
  /** The group waits in « Plus de réglages ». */
  fold?: true
}

/** Every `pane/anchor` the sources ask for, with the place it announces. */
const LINKS: Readonly<Record<string, Link>> = {
  'about/status': { from: 'Aide › État de Lucium… ; la notice d’une erreur interne (« Voir le journal »)', labels: ['menu.etat-d-lucium', 'app.voir-le-journal'], page: 'about', title: 'engine-status.etat-d-lucium', fold: true },
  'about/icon': { from: '« Découvrir Lucium » : la carte « Icône de l’application » (« Régler »)', page: 'about', title: 'settings.icone-de-l-application' },
  'about/about': { from: 'chrome://settings/help, chrome://settings/about', page: 'about', title: 'about-settings.a-propos' },
  'tools/extensions': { from: 'Extensions › Gérer les extensions ; le menu d’une extension ; la page des extensions', labels: ['menu.gerer-les-extensions'], page: 'tools', title: 'settings.extensions' },
  'keyboard/shortcuts': { from: 'Aide › Raccourcis clavier essentiels ; la barre de commandes ; l’aide des raccourcis', labels: ['menu.raccourcis-clavier-essentiels'], page: 'keyboard', title: 'settings.section-raccourcis-clavier' },
  'general/guide': { from: 'Aide › Configuration rapide… ; la feuille d’import ; le premier lancement', page: 'home', title: 'guide.configuration-rapide' },
  'protection/lock': { from: 'le menu d’un espace (Verrouiller l’espace…) ; chrome://settings/passwords, gestionnaire coupé', labels: ['ctx.verrouiller-l-espace-2'], page: 'protection', title: 'lock-settings.verrouillage' },
  'appearance/panelsize': { from: 'la notice de la taille des panneaux (« Régler »)', labels: ['panel-size.regler'], page: 'appearance', title: 'panel-size.titre', fold: true },
  'navigation/links': { from: 'la mini-fenêtre ; le guide « Vous venez d’Arc »', page: 'navigation', title: 'little-arc-settings.mini-fenetre', fold: true },
  'protection/permissions': { from: 'Infos et réglages du site (Autorisations) ; chrome://settings/content', page: 'protection', title: 'settings.sub-permissions' },
  'protection/sitedata': { from: 'la feuille « Effacer les données du site » (Réglages de l’effacement)', page: 'protection', title: 'site-data-settings.titre', fold: true },
  'protection/securitycheck': { from: '« Découvrir Lucium » : la carte « Vérification de sécurité » (« Régler »)', page: 'protection', title: 'security-check.title' },
  'files/downloads': { from: 'chrome://settings/downloads', page: 'files', title: 'download-settings.telechargements-et-lecture' },
  'navigation/engine': { from: 'chrome://settings/search, chrome://settings/searchengines', page: 'navigation', title: 'settings-profiles.moteur-de-recherche' }
}

// The document of the tests has its own `URL`, which `fileURLToPath` refuses: the path is read from the string.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..') + '/'

/** The sources of the application: no test, no engine suite. */
function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'vendor' ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|test-support|^smoke|lint-witness/.test(entry.name) ? [path] : []
  })
}

/** The `pane/anchor` of every place a source opens the Settings at: the requests written out, and the helpers of the typed addresses. */
function askedPlaces(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const add = (pane: string, anchor: string, file: string) => found.set(`${pane}/${anchor}`, [...(found.get(`${pane}/${anchor}`) ?? []), file.slice(SRC.length)])
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/panel: 'settings', pane: '([a-z]+)', anchor: '([a-z]+)'/g)) add(match[1]!, match[2]!, file)
    for (const match of text.matchAll(/(?:toSettings\(address|settingsRequest\(|settingsLabel\()\s*,?\s*'([a-z]+)', '([a-z]+)'\)/g)) add(match[1]!, match[2]!, file)
  }
  return found
}

/** The entries of the menus and the notices that open a place: the text they show (the key read last before the request, on its line) and the place. */
function labelledPlaces(): Array<{ label: string; place: string }> {
  const found: Array<{ label: string; place: string }> = []
  for (const file of sources()) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /panel: 'settings', pane: '([a-z]+)', anchor: '([a-z]+)'/.exec(line)
      const label = match ? [...line.slice(0, match.index).matchAll(/\bt\('([a-z0-9.-]+)'/g)].at(-1)?.[1] : undefined
      if (match && label) found.push({ label, place: `${match[1]}/${match[2]}` })
    }
  }
  return found
}

let mounted: Mounted | null = null

const snapshot = (): UiSnapshot => {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

/** The window opened at the address the main process gives it for `pane` and `anchor` (settings-window.ts), its effects run. */
async function openAt(pane: string, anchor: string): Promise<HTMLElement> {
  location.hash = settingsHash(pane, anchor)
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot: snapshot() }))
  await settle()
  return mounted.container
}

/** The text of the element that has the focus: the title alone when it is the title of a group. */
function focused(): string | null {
  const active = document.activeElement as HTMLElement | null
  if (!active || active === document.body) return null
  return (active.matches('.pref-section > h3') ? active.querySelector('.pref-title') : active)?.textContent?.trim() ?? null
}

/** Where the window landed: its page, the title shown for the place, whether that place is in a closed fold, and the text of the focused element. */
function landing(window: HTMLElement, anchor: SettingsAnchor) {
  const page = window.querySelector('.settings-cat[aria-current="page"]')?.getAttribute('data-cat') ?? null
  const subpage = (SETTINGS_SUBPAGES as readonly string[]).includes(anchor)
  const group = subpage || FLOW_ANCHORS.has(anchor) ? null : window.querySelector<HTMLElement>(`[id="${anchor}"]`)
  const title = subpage || FLOW_ANCHORS.has(anchor) ? window.querySelector('main h2.settings-pane-title')?.textContent : group?.querySelector(':scope > h3 .pref-title')?.textContent
  return {
    page,
    title: title ?? null,
    hiddenInFold: group?.closest<HTMLElement>('.more-settings-body')?.hidden ?? null,
    inFold: group ? group.closest('.more-settings-body') !== null : null,
    // The title of a group is its .pref-title (its h3 also holds the count of its settings).
    focus: focused()
  }
}

beforeEach(() => {
  setLanguage('fr')
  installBridge({})
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the links that open the Settings at a place', () => {
  it('are all in the table: a new one says there where it leads', () => {
    const asked = askedPlaces()
    expect(asked.size).toBeGreaterThan(8)
    const missing = [...asked].filter(([place]) => !Object.hasOwn(LINKS, place)).map(([place, files]) => `${place} (${files.join(', ')})`)
    expect(missing).toEqual([])
  })

  it('are named in the table by the menus and the notices that lead there: each entry opens the place it names', () => {
    const labelled = labelledPlaces()
    expect(labelled.map((one) => one.label)).toEqual(expect.arrayContaining(['menu.etat-d-lucium', 'app.voir-le-journal', 'menu.gerer-les-extensions']))
    const wrong = labelled.filter(({ label, place }) => !(LINKS[place]?.labels ?? []).includes(label as MessageKey)).map(({ label, place }) => `${label} → ${place}`)
    expect(wrong).toEqual([])
  })

  it('Aide › État de Lucium… opens « À propos et mises à jour », unfolds « Plus de réglages » and puts the focus on « État de Lucium »', async () => {
    const window = await openAt('about', 'status')
    expect(landing(window, 'status')).toEqual({ page: 'about', title: 'État de Lucium', hiddenInFold: false, inFold: true, focus: 'État de Lucium' })
    expect(window.querySelector('#status')?.classList.contains('pref-flash')).toBe(true)
    // The menu says the same name.
    expect(t('menu.etat-d-lucium').replace(/…$/, '')).toBe('État de Lucium')
  })

  for (const [place, link] of Object.entries(LINKS)) {
    it(`${place} (${link.from}) leads to its place`, async () => {
      const [pane, anchor] = place.split('/') as [string, SettingsAnchor]
      expect(resolveSettingsTarget(pane, anchor)?.pane, 'the page the address resolves to').toBe(link.page)
      const window = await openAt(pane, anchor)
      const landed = landing(window, anchor)
      expect(landed.page).toBe(link.page)
      expect(landed.title).toBe(t(link.title))
      if (!(SETTINGS_SUBPAGES as readonly string[]).includes(anchor) && !FLOW_ANCHORS.has(anchor)) {
        expect(landed.inFold, 'waits in « Plus de réglages »').toBe(link.fold === true)
        expect(landed.hiddenInFold === true, 'hidden in a closed fold').toBe(false)
      }
      // The focus is on the title of the place (the guide keeps its own: its first question).
      if (!FLOW_ANCHORS.has(anchor)) expect(landed.focus).toBe(t(link.title))
    })
  }
})

/**
 * The places whose name in the command bar is not the title they show, and why: the editor of the shortcuts is named by what one does there, and the
 * subpage of the remembered permissions by the group of the page whose row opens it.
 */
const NAMED_OTHERWISE: Readonly<Partial<Record<SettingsAnchor, string>>> = {
  shortcuts: 'Modifier les raccourcis clavier',
  permissions: 'Autorisations des sites'
}

describe('the places of the command bar (« Réglages › <place> »)', () => {
  it('name each place by the title it shows', async () => {
    const wrong: string[] = []
    for (const anchor of new Set([...SETTINGS_ANCHORS, ...SETTINGS_SUBPAGES].filter((name) => !FLOW_ANCHORS.has(name) && !Object.hasOwn(NAMED_OTHERWISE, name)))) {
      const window = await openAt(ANCHOR_PANE[anchor], anchor)
      const shown = landing(window, anchor).title
      if (shown !== settingsAnchorLabel(anchor)) wrong.push(`${anchor}: « ${settingsAnchorLabel(anchor)} » / « ${shown} »`)
      mounted!.unmount()
      mounted = null
    }
    expect(wrong).toEqual([])
  })
})

// The subpage titles the table names are those of the map, and the names kept apart are the ones the command bar gives.
describe('the table', () => {
  it('keeps apart only names the command bar gives', () => {
    for (const [anchor, name] of Object.entries(NAMED_OTHERWISE)) expect(settingsAnchorLabel(anchor as SettingsAnchor)).toBe(name)
  })

  it('names the title of each subpage it leads to as the map does', () => {
    for (const [place, link] of Object.entries(LINKS)) {
      const anchor = place.split('/')[1] as SettingsAnchor
      if ((SETTINGS_SUBPAGES as readonly string[]).includes(anchor)) expect(link.title, place).toBe(subpageById(anchor as never).title)
    }
  })
})
