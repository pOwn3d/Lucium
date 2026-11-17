// The switches of the optional features (shared/features.ts). `FeatureSwitch`: the switch of a preference of a category that has no row of its own in a
// pane (settings-catalog.ts, FEATURE_ONLY_SWITCHES). `CatalogueFeature`: the line of a feature to add in « Fonctions en option » (FeaturesPage.tsx), with
// the first sentence of its description, its cost said in a sentence and the whole text behind « En savoir plus ». Both write the very setting the
// feature's registry entry names, so everything agrees.

import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { costSentence, featureById, featureLine, featureShownPatch, featureSummary, featureSwitchable, featureWritable, isFeatureShownOn, unmetNeeds, type Feature, type FeatureId } from '@shared/features'
import { Check, FeatureCheck } from './settings-parts'
import { getLanguage, quoted, t, type MessageKey } from '@shared/i18n'

/** What the row of a feature says: `text` (its description, or its short line), and what it needs, whether it asks for a restart and where it is set. */
const hintOf = (feature: Feature, writable: boolean, unmet: readonly Feature[], text = feature.description): string => {
  const base = feature.requiresRestart ? t('features-settings.description-demande-de-redemarrer-lucium', { description: text }) : text
  // A feature that does nothing while the ones it needs are off says which ones (its switch is greyed while it is off).
  const needed = unmet.length === 0 ? base : `${base} ${t('features-settings.sans-effet-tant-que-names-n-est-pas-active', { names: new Intl.ListFormat(getLanguage(), { type: 'disjunction' }).format(unmet.map((need) => quoted(need.label))) })}`
  // A switch the interface cannot write is shown as it is, with the place where it is set.
  return writable ? needed : `${needed} ${t('features-settings.se-regle-dans-place', { place: feature.setIn ?? t('features-settings.son-propre-volet') })}`
}

interface SwitchProps {
  id: FeatureId
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

export function FeatureSwitch({ id, snapshot, update }: SwitchProps) {
  const { settings } = snapshot.state
  const feature = featureById(id)
  const writable = featureWritable(id)
  const unmet = unmetNeeds(settings, id)
  // A feature with a short line says it, and keeps its whole description behind « En savoir plus ».
  const summary = featureSummary(feature)
  return (
    <Check
      settingKey={feature.key}
      label={feature.label}
      hint={hintOf(feature, writable, unmet, summary ?? feature.description)}
      more={summary === null ? undefined : feature.description}
      checked={isFeatureShownOn(settings, id)}
      disabled={!featureSwitchable(settings, id)}
      onChange={(on) => update(featureShownPatch(id, on))}
    />
  )
}

/**
 * What the row of a feature said in its category before it moved to « Fonctions en option » (its help, the note of its group), when the description of
 * the registry does not say it: kept behind « En savoir plus », so that nothing it told is lost.
 */
const FORMER_HELP: Readonly<Partial<Record<FeatureId, readonly MessageKey[]>>> = {
  'tab-groups-ext': ['key-ext-settings.pour-les-extensions-qui-regroupent-des', 'key-ext-settings.tant-que-le-groupe-existe-ses-onglets-sont', 'key-ext-settings.desactive-les-groupes-qu-une-extension'],
  'tab-memory': ['settings.une-ligne-sur-la-carte-qui-s-ouvre-quand-le'],
  'web-panels': ['spaces-settings.chaque-espace-garde-une-liste-de-sites'],
  'name-windows': ['settings.ajoute-nommer-la-fenetre-au-menu-fenetre-et'],
  'private-tabs': ['privacy-extra-settings.fichier-nouvel-onglet-prive-une-session-en'],
  'guest-profile': ['guest-settings.une-fenetre-invite-garde-une-session-en', 'guest-settings.desactive-l-entree-et-son-raccourci'],
  'user-scripts': ['user-scripts-settings.desactive-aucun-script-ne-s-execute-et'],
  'qr-code': ['web-tools-settings.ajoute-code-qr-de-cette-page-au-menu'],
  'read-aloud': ['web-tools-settings.des-boutons-dans-le-mode-lecture-et-lire'],
  'page-watch': ['web-tools-settings.ajoute-surveiller-cette-page-au-menu'],
  'download-pause': ['download-settings.un-bouton-dans-la-fenetre-des'],
  'open-unsaved': ['download-settings.le-fichier-est-telecharge-dans-un-dossier'],
  'pdf-with-source': ['download-settings.ajoute-enregistrer-en-pdf-avec-l-adresse'],
  'find-regex': ['search-settings.info-regex'],
  'cookie-manager': ['privacy-extra-settings.la-liste-des-cookies-de-chaque-site-noms', 'privacy-extra-settings.chaque-interrupteur-est-reel-desactive-la']
}

/**
 * The line of a feature in « Fonctions en option »: its short line (or the first sentence of its description) under its name, then its cost in a sentence; « En savoir
 * plus » unfolds the whole text (with what it needs and where it is set, as `FeatureSwitch` says them, and what its row said in its category) when
 * there is more than that sentence.
 */
export function CatalogueFeature({ id, snapshot, update }: SwitchProps) {
  const { settings } = snapshot.state
  const feature = featureById(id)
  const first = featureLine(feature)
  const whole = hintOf(feature, featureWritable(id), unmetNeeds(settings, id))
  const more = [...(whole === first ? [] : [whole]), ...(FORMER_HELP[id] ?? []).map((key) => t(key))]
  return (
    <FeatureCheck
      settingKey={feature.key}
      label={feature.label}
      hint={first}
      cost={costSentence(feature)}
      more={more.length === 0 ? undefined : more}
      checked={isFeatureShownOn(settings, id)}
      disabled={!featureSwitchable(settings, id)}
      onChange={(on) => update(featureShownPatch(id, on))}
    />
  )
}
