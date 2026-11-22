import { describe, expect, it } from 'vitest'
import { adsBlockingOn, adsBlockingPatch, blockerIsOn } from './blocker'
import { interfaceMayDispatch } from './ipc-policy'
import { defaultSettings, type Settings } from './model'
import {
  costSentence,
  defaultFeaturesPatch,
  FEATURE_GROUPS,
  FEATURES,
  archiveHasWork,
  featureById,
  featureWritable,
  featureDefault,
  featureRuns,
  featurePatch,
  featureSwitchable,
  firstSentence,
  isFeatureOn,
  isFeatureShownOn,
  featureShownPatch,
  NOT_OPTIONAL_SETTINGS,
  unmetNeeds,
  type Feature,
  type FeatureId
} from './features'
import type { ProfileSettings } from './profiles'
import { setLanguage, t } from './i18n'
import { frenchSpaces } from './french-typography'

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaultSettings(), ...patch })
const all: readonly Feature[] = FEATURES
/** The ads and trackers switch off: the setting and its alias (the blocker reads either). */
const adsOff = adsBlockingPatch(false)

describe('the registry of features', () => {
  it('gives every feature a unique id and a unique setting', () => {
    expect(new Set(all.map((f) => f.id)).size).toBe(all.length)
    expect(new Set(all.map((f) => f.key)).size).toBe(all.length)
    for (const f of all) expect(f.id).toMatch(/^[a-z]+(-[a-z]+)*$/)
  })

  it('links each feature to a setting that exists, of the type its kind needs', () => {
    const defaults = defaultSettings() as unknown as Record<string, unknown>
    for (const f of all) {
      const value = defaults[f.key]
      expect(value, `${f.id}: the setting ${f.key} is not in defaultSettings()`).not.toBeUndefined()
      expect(typeof value, `${f.id}: ${f.key} must be ${f.kind === 'threshold' ? 'a number' : 'a boolean'}`).toBe(f.kind === 'threshold' ? 'number' : 'boolean')
    }
  })

  it('has a French label, a one-line description, a known group and a cost for each feature', () => {
    const groups = new Set(FEATURE_GROUPS.map((g) => g.id))
    for (const f of all) {
      expect(f.label.trim(), f.id).toBe(f.label)
      expect(f.label.length, f.id).toBeGreaterThan(5)
      expect(f.description, f.id).toMatch(/[.)»]$/)
      expect(f.description, f.id).not.toContain('\n')
      expect(groups.has(f.group), `${f.id}: unknown group ${f.group}`).toBe(true)
      expect(f.cost.length, f.id).toBeGreaterThan(0)
      // "none" says nothing runs: it cannot be mixed with a cost.
      if (f.cost.includes('none')) expect(f.cost, f.id).toEqual(['none'])
      expect(new Set(f.cost).size, `${f.id}: a cost twice`).toBe(f.cost.length)
    }
    for (const g of FEATURE_GROUPS) expect(all.some((f) => f.group === g.id), `group ${g.id} is empty`).toBe(true)
  })

  it('gives a threshold feature a value that switches it on, and 0 for off', () => {
    for (const f of all.filter((x) => x.kind === 'threshold')) {
      const on = featurePatch(f.id as FeatureId, true)[f.key as keyof Settings] as number
      expect(on, f.id).toBeGreaterThan(0)
      expect(isFeatureOn(settings(featurePatch(f.id as FeatureId, true)), f.id as FeatureId)).toBe(true)
      expect(isFeatureOn(settings(featurePatch(f.id as FeatureId, false)), f.id as FeatureId)).toBe(false)
    }
  })

  // The test that makes a feature added without its registration fail: a function needs a switch, or a reason not to have one.
  it('registers every boolean setting, or lists it as not optional with its reason', () => {
    const registered = new Set<string>(all.map((f) => f.key))
    const excluded = NOT_OPTIONAL_SETTINGS as Record<string, string>
    const unregistered = Object.entries(defaultSettings())
      .filter(([key, value]) => typeof value === 'boolean' && !registered.has(key) && !(key in excluded))
      .map(([key]) => key)
    expect(
      unregistered,
      `Réglage booléen sans inscription : ${unregistered.join(', ')}. Ajoutez une entrée à FEATURES (src/shared/features.ts) pour une fonction, ou à NOT_OPTIONAL_SETTINGS avec la raison pour un simple état.`
    ).toEqual([])
  })

  it('keeps the list of exclusions honest: real boolean settings, with a reason, none of them registered', () => {
    const defaults = defaultSettings() as unknown as Record<string, unknown>
    const registered = new Set<string>(all.map((f) => f.key))
    for (const [key, reason] of Object.entries(NOT_OPTIONAL_SETTINGS)) {
      expect(typeof defaults[key], `${key} is not a boolean setting any more: remove it from NOT_OPTIONAL_SETTINGS`).toBe('boolean')
      expect(reason?.trim().length, `${key} needs a reason`).toBeGreaterThan(10)
      expect(registered.has(key), `${key} is registered: remove it from NOT_OPTIONAL_SETTINGS`).toBe(false)
    }
  })
})

describe('isFeatureOn', () => {
  it('reads a flag', () => {
    expect(isFeatureOn(settings({ resolveFavicons: true }), 'favicons')).toBe(true)
    expect(isFeatureOn(settings({ resolveFavicons: false }), 'favicons')).toBe(false)
  })

  it('reads a delay: above 0 is on', () => {
    expect(isFeatureOn(settings({ sleepAfterMinutes: 30 }), 'sleep')).toBe(true)
    expect(isFeatureOn(settings({ sleepAfterMinutes: 0.001 }), 'sleep')).toBe(true)
    expect(isFeatureOn(settings({ sleepAfterMinutes: 0 }), 'sleep')).toBe(false)
  })

  it('counts a setting that is not what it should be as off', () => {
    const odd = (patch: Record<string, unknown>) => ({ ...defaultSettings(), ...patch }) as unknown as Settings
    expect(isFeatureOn(odd({ autoBackup: 'yes' }), 'auto-backup')).toBe(false)
    expect(isFeatureOn(odd({ sleepAfterMinutes: NaN }), 'sleep')).toBe(false)
    expect(isFeatureOn(odd({ sleepAfterMinutes: '30' }), 'sleep')).toBe(false)
    expect(isFeatureOn(odd({ sleepAfterMinutes: -5 }), 'sleep')).toBe(false)
  })
})

describe('featureRuns', () => {
  const odd = (patch: Record<string, unknown>) => ({ ...defaultSettings(), ...patch }) as unknown as Settings

  it('is the switch for every feature that has no rule of its own', () => {
    const combos = [settings(), settings({ sleepAfterMinutes: 0, autoUpdate: false, blockAds: true }), odd({ sleepAfterMinutes: NaN, autoBackup: 'yes' })]
    for (const f of all.filter((x) => !x.runsWhen)) for (const s of combos) expect(featureRuns(s, f.id as FeatureId), f.id).toBe(isFeatureOn(s, f.id as FeatureId))
  })

  it('keeps the pictures of the tabs taken while the hover cards or the tab overview is on, and stops when both are off', () => {
    expect(featureRuns(settings({ hoverCards: true, tabGrid: false }), 'hover-cards')).toBe(true)
    expect(featureRuns(settings({ hoverCards: false, tabGrid: true }), 'hover-cards')).toBe(true)
    expect(featureRuns(settings({ hoverCards: false, tabGrid: false }), 'hover-cards')).toBe(false)
    // The switch of the pane is still the hover cards' own.
    expect(isFeatureOn(settings({ hoverCards: false, tabGrid: true }), 'hover-cards')).toBe(false)
  })

  it('lets archiving run while the general delay or a profile\'s delay is above 0, though the switch of the pane reads the general one', () => {
    const profiles = (hours: number) => ({ work: { autoArchiveHours: hours } })
    expect(featureRuns(settings({ autoArchiveHours: 12 }), 'auto-archive')).toBe(true)
    expect(featureRuns(settings({ autoArchiveHours: 0 }), 'auto-archive')).toBe(false)
    expect(featureRuns(settings({ autoArchiveHours: 0, profiles: profiles(6) }), 'auto-archive')).toBe(true)
    expect(isFeatureOn(settings({ autoArchiveHours: 0, profiles: profiles(6) }), 'auto-archive')).toBe(false)
    expect(featureRuns(settings({ autoArchiveHours: 0, profiles: profiles(0) }), 'auto-archive')).toBe(false)
    expect(featureRuns(settings({ autoArchiveHours: 0, profiles: { a: { autoArchiveHours: 0 }, b: { searchSuggestions: true }, c: { autoArchiveHours: 1 } } }), 'auto-archive')).toBe(true)
  })

  it('counts a delay that is not a positive number as "Jamais"', () => {
    expect(archiveHasWork(odd({ autoArchiveHours: NaN }))).toBe(false)
    expect(archiveHasWork(odd({ autoArchiveHours: -3 }))).toBe(false)
    expect(archiveHasWork(odd({ autoArchiveHours: '12' }))).toBe(false)
    expect(archiveHasWork(odd({ autoArchiveHours: 0, profiles: { a: { autoArchiveHours: '5' }, b: null, c: 7 } }))).toBe(false)
    expect(archiveHasWork(odd({ autoArchiveHours: 0, profiles: null }))).toBe(false)
  })
})

describe('defaults and patches', () => {
  it('reports the default of a feature from the default settings, not from a second table', () => {
    expect(featureDefault('favicons')).toBe(defaultSettings().resolveFavicons)
    expect(featureDefault('block-ads')).toBe(true)
    expect(featureDefault('sleep')).toBe(true)
  })

  it('switches a flag by writing the setting itself', () => {
    expect(featurePatch('auto-update', false)).toEqual({ autoUpdate: false })
    expect(featurePatch('auto-update', true)).toEqual({ autoUpdate: true })
  })

  // `blockTrackers` is the alias of `blockAds` and is on by default: a switch that wrote `blockAds` alone would read "off" while the blocker
  // went on filtering, and the "everything off" profile of `pnpm perf` would measure a blocker that is on.
  it('switches the ads and trackers off for the blocker itself: the setting and its alias together', () => {
    expect(featurePatch('block-ads', false)).toEqual({ blockAds: false, blockTrackers: false })
    expect(featurePatch('block-ads', true)).toEqual({ blockAds: true, blockTrackers: true })
    const off = settings(featurePatch('block-ads', false))
    expect(adsBlockingOn(off)).toBe(false)
    expect(blockerIsOn({ ...off, blockCookieBanners: false })).toBe(false)
    expect(adsBlockingOn(settings(featurePatch('block-ads', true)))).toBe(true)
  })

  it('shows the ads and trackers switch as the blocker reads it: on while the alias alone is on', () => {
    expect(isFeatureOn(settings({ blockAds: false, blockTrackers: true }), 'block-ads')).toBe(true)
    expect(isFeatureOn(settings({ blockAds: true, blockTrackers: false }), 'block-ads')).toBe(true)
    expect(isFeatureOn(settings(adsOff), 'block-ads')).toBe(false)
  })

  it('reads every feature as off after its switch is turned off, and as on after it is turned on', () => {
    for (const f of all) {
      const id = f.id as FeatureId
      expect(isFeatureOn(settings(featurePatch(id, false)), id), `${id} off`).toBe(false)
      expect(isFeatureOn(settings(featurePatch(id, true)), id), `${id} on`).toBe(true)
    }
  })

  it('switches a delay off with 0 and on with the default delay (or its own value)', () => {
    expect(featurePatch('sleep', false)).toEqual({ sleepAfterMinutes: 0 })
    expect(featurePatch('sleep', true)).toEqual({ sleepAfterMinutes: defaultSettings().sleepAfterMinutes })
  })

  it('goes back to the defaults for every feature and nothing else', () => {
    const patch = defaultFeaturesPatch()
    // Every feature the pane may write (the lock is shown, not written: see below).
    expect(Object.keys(patch).sort()).toEqual(all.filter((f) => featureWritable(f.id as FeatureId)).flatMap((f) => Object.keys(featurePatch(f.id as FeatureId, true))).sort())
    const changed = settings({ ...adsOff, sleepAfterMinutes: 0, autoUpdate: false, searchUrlTemplate: 'https://exemple.org/?q=%s', sleepMode: 'freeze' })
    const back = { ...changed, ...patch }
    for (const f of all.filter((x) => featureWritable(x.id as FeatureId))) expect(isFeatureOn(back, f.id as FeatureId), f.id).toBe(isFeatureOn(defaultSettings(), f.id as FeatureId))
    expect(back.searchUrlTemplate).toBe('https://exemple.org/?q=%s')
    expect(back.sleepMode).toBe('freeze')
  })
})

describe('what the pane may write', () => {
  const reset = (patch: Partial<Settings>) => interfaceMayDispatch({ type: 'settings/update', patch }, [])

  // The lock's settings change only through the lock's own handler: a reset patch that held one would be refused whole and reset nothing.
  it('sends a reset patch that the interface policy lets through', () => {
    expect(reset(defaultFeaturesPatch())).toBe(true)
  })

  it('shows but never writes a feature whose setting the interface may not change, and says where it is set', () => {
    const readOnly = all.filter((f) => !featureWritable(f.id as FeatureId))
    expect(readOnly.map((f) => f.id)).toContain('lock')
    for (const f of readOnly) {
      expect(f.setIn, `${f.id} is refused to the interface: give it a setIn`).toBeTruthy()
      expect(Object.keys(defaultFeaturesPatch())).not.toContain(f.key)
    }
    // …and the other way: a place named for a feature the pane can write would be a stale note.
    for (const f of all.filter((x) => featureWritable(x.id as FeatureId))) expect(f.setIn, `${f.id} can be written: drop its setIn`).toBeUndefined()
  })

  it('leaves the features it cannot write out of what a reset would change', () => {
    expect(defaultFeaturesPatch()).not.toHaveProperty('lockEnabled')
  })

  it('lets every other switch through the policy, on and off', () => {
    for (const f of all.filter((x) => featureWritable(x.id as FeatureId))) {
      expect(reset(featurePatch(f.id as FeatureId, true)), f.id).toBe(true)
      expect(reset(featurePatch(f.id as FeatureId, false)), f.id).toBe(true)
    }
  })
})

// « Fonctions en option » says what a feature costs in a sentence, built from the classes of `cost`: what it does while it is on, and that it costs nothing
// off (the rule of design of every feature), or that it costs nothing even on.
describe('the cost said in a sentence', () => {
  it('says that a feature that runs nothing costs nothing, even on', () => {
    setLanguage('fr')
    expect(costSentence(featureById('tab-tree'))).toBe(frenchSpaces('Ne coûte rien, même allumée.'))
    setLanguage('en')
    expect(costSentence(featureById('tab-tree'))).toBe('Costs nothing, even when on.')
    setLanguage('fr')
  })

  it('says what the feature does while it is on, every class of its cost once, the network first, and nothing off', () => {
    setLanguage('fr')
    expect(costSentence(featureById('live-folders'))).toBe(frenchSpaces('Allumée : utilise le réseau, garde des données en mémoire et fait tourner une minuterie. Coupée : rien.'))
    expect(costSentence(featureById('tab-memory'))).toBe(frenchSpaces('Allumée : fait tourner une minuterie. Coupée : rien.'))
    expect(costSentence(featureById('containers'))).toBe(frenchSpaces('Allumée : garde des données en mémoire et écrit sur le disque. Coupée : rien.'))
    expect(costSentence(featureById('find-regex'))).toBe(frenchSpaces('Allumée : lance un programme. Coupée : rien.'))
    setLanguage('en')
    expect(costSentence(featureById('page-watch'))).toBe('On: uses the network, starts a program, and runs a timer. Off: nothing.')
    expect(costSentence(featureById('pwa'))).toBe('On: listens to events. Off: nothing.')
    setLanguage('fr')
  })

  it('names a cost for every class a feature of the registry has', () => {
    setLanguage('fr')
    for (const feature of all) {
      const sentence = costSentence(feature)
      if (feature.cost.includes('none')) expect(sentence, feature.id).toBe(frenchSpaces('Ne coûte rien, même allumée.'))
      else expect(sentence, feature.id).toMatch(/^Allumée\s: [^.]+\. Coupée\s: rien\.$/)
    }
  })
})

describe('the first sentence of a description', () => {
  it('stops at the first full stop a capital letter follows, and keeps a text of one sentence whole', () => {
    expect(firstSentence('Un onglet ouvert depuis un lien se range sous son parent. Désactivé, l’arbre est aplati.')).toBe('Un onglet ouvert depuis un lien se range sous son parent.')
    expect(firstSentence('Affiche la mémoire et le processeur d’un onglet sur sa carte de survol.')).toBe('Affiche la mémoire et le processeur d’un onglet sur sa carte de survol.')
    expect(firstSentence('Un texte. « Une citation » suit.')).toBe('Un texte.')
  })

  it('goes on past an ellipsis, a question mark of an address or a full stop that no capital letter follows', () => {
    expect(firstSentence('Fichier › Notes… ou la barre de commandes. Aucune dans une fenêtre privée.')).toBe('Fichier › Notes… ou la barre de commandes.')
    expect(firstSentence('Fichier › « Enregistrer en PDF avec l’adresse… » ajoute l’adresse.')).toBe('Fichier › « Enregistrer en PDF avec l’adresse… » ajoute l’adresse.')
    expect(firstSentence('Accepte « lucium://open?url=… » envoyée par un script.')).toBe('Accepte « lucium://open?url=… » envoyée par un script.')
  })

  it('cuts every description of the registry, in both languages, to a sentence that starts it', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      for (const feature of all) {
        const first = firstSentence(feature.description)
        expect(feature.description.startsWith(first), feature.id).toBe(true)
        expect(first, `${language} ${feature.id}`).toMatch(/[.!?…»)]$/)
      }
    }
    setLanguage('fr')
  })
})

describe('the features that need another one', () => {
  const needing = all.filter((f) => f.needsAnyOf !== undefined)

  it('name features of the registry, never themselves, and no feature that needs another in turn', () => {
    for (const f of needing) {
      expect(f.needsAnyOf!.length, f.id).toBeGreaterThan(0)
      for (const need of f.needsAnyOf!) {
        expect(all.some((x) => x.id === need), `${f.id} needs ${need}, which is not registered`).toBe(true)
        expect(need, `${f.id} needs itself`).not.toBe(f.id)
        expect(all.find((x) => x.id === need)!.needsAnyOf, `${f.id} needs ${need}, which needs another feature in turn: say it flat`).toBeUndefined()
      }
    }
  })

  // The blocker's own code decides (page-guard.test.ts: "the switch alone is not enough without a blocking option"; service.test.ts: the user's
  // lists belong to the ads option): the registry says it too, so that the pane greys a switch that would do nothing.
  it('records what the blocker does: the extended rules need one of its two options, the user\'s own lists need the ads option', () => {
    expect(featureById('block-scriptlets').needsAnyOf).toEqual(['block-ads', 'block-cookie-banners'])
    expect(featureById('custom-filter-lists').needsAnyOf).toEqual(['block-ads'])
  })

  it('lists what is missing only while none of the needed features is on', () => {
    const off = settings({ ...adsOff, blockCookieBanners: false })
    expect(unmetNeeds(off, 'block-scriptlets').map((f) => f.id)).toEqual(['block-ads', 'block-cookie-banners'])
    expect(unmetNeeds(settings({ ...adsOff, blockCookieBanners: true }), 'block-scriptlets')).toEqual([])
    expect(unmetNeeds(settings({ blockAds: true }), 'block-scriptlets')).toEqual([])
    // The cookie option is not enough for the user's lists: they belong to the ads option only.
    expect(unmetNeeds(settings({ ...adsOff, blockCookieBanners: true }), 'custom-filter-lists').map((f) => f.id)).toEqual(['block-ads'])
    expect(unmetNeeds(off, 'sleep')).toEqual([])
  })

  it('greys the switch of a feature that would do nothing, but lets an "on" that does nothing be switched off', () => {
    const none = { ...adsOff, blockCookieBanners: false }
    expect(featureSwitchable(settings({ ...none, blockScriptlets: false }), 'block-scriptlets')).toBe(false)
    expect(featureSwitchable(settings({ ...none, blockScriptlets: true }), 'block-scriptlets')).toBe(true)
    expect(featureSwitchable(settings({ blockAds: true, blockScriptlets: false }), 'block-scriptlets')).toBe(true)
    // A feature with no need is as writable as before; the lock, which the pane cannot write, stays greyed.
    expect(featureSwitchable(settings(), 'sleep')).toBe(true)
    expect(featureSwitchable(settings(), 'lock')).toBe(false)
  })
})

describe('the features a profile may override', () => {
  // Every key a profile may hold is classified here: the compiler fails when ProfileSettings gets a key this table does not know.
  const OVERRIDDEN_BY: Record<keyof ProfileSettings, FeatureId | null> = {
    searchUrlTemplate: null,
    searchSuggestions: 'search-suggestions',
    autoArchiveHours: 'auto-archive',
    downloadDir: null,
    disabledExtensions: null,
    tabCaptureExtensions: null,
    historyOff: 'history-off',
    proxy: 'proxy'
  }

  // The switch of the pane writes the general setting only: a profile with its own choice keeps it, so the line says so (the switch off would
  // otherwise promise "no request" or "no history" for a profile that decided the opposite).
  it('say in their description that a profile may choose for itself', () => {
    for (const [key, id] of Object.entries(OVERRIDDEN_BY)) {
      if (id === null) continue
      expect(featureById(id).description, `${id} (profile setting ${key})`).toMatch(/profil/i)
    }
  })
})

describe('the cost of what a card measures', () => {
  it('does not claim that the memory figures of a tab launch a program: the card only asks Electron for its metrics while it is open', () => {
    expect(featureById('tab-memory').cost).toEqual(['timer'])
  })
})

describe('the history (history-off)', () => {
  // The row of the window says it in the affirmative, « Garder l’historique des pages visitées », on while the history is kept: the registry, its search
  // and the documents name it the same way. The registry keeps its own sense (on while nothing is recorded), so that its id and its setting stay.
  it('is named as its row says it, in both languages, and its line says what keeping it does', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      const history = featureById('history-off')
      expect(history.label, language).toBe(t('privacy-extra-settings.garder-l-historique-des-pages-visitees'))
      expect(history.description, language).toMatch(language === 'fr' ? /^Les pages visitées sont notées/ : /^Visited pages are recorded/)
      expect(`${history.label} ${history.description}`, language).not.toMatch(/jamais|never|plus aucune|no page/i)
    }
    setLanguage('fr')
  })

  it('keeps the setting and its sense: on while nothing is recorded, off by default', () => {
    expect(isFeatureOn({ ...defaultSettings(), historyOff: true }, 'history-off')).toBe(true)
    expect(isFeatureOn(defaultSettings(), 'history-off')).toBe(false)
    expect(featurePatch('history-off', true)).toEqual({ historyOff: true })
  })

  it('is the only feature whose row shows the opposite of the registry, and it shows the history kept by default', () => {
    expect(FEATURES.filter((feature) => featureById(feature.id as FeatureId).turnedAround).map((feature) => feature.id)).toEqual(['history-off'])
    for (const settings of [defaultSettings(), { ...defaultSettings(), historyOff: true }]) {
      for (const feature of FEATURES) {
        expect(isFeatureShownOn(settings, feature.id as FeatureId), feature.id).toBe(featureById(feature.id as FeatureId).turnedAround ? !isFeatureOn(settings, feature.id as FeatureId) : isFeatureOn(settings, feature.id as FeatureId))
      }
    }
    expect(isFeatureShownOn(defaultSettings(), 'history-off')).toBe(true)
    expect(featureShownPatch('history-off', false)).toEqual({ historyOff: true })
  })
})

