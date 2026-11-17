// What `pnpm perf` does with the registry of optional features (features.ts): the two scenarios "toutes les fonctions coupées" and "toutes
// allumées" switch every registered feature one way or the other, and the cost class of each feature says what a measure of that scenario can
// and cannot see of it. The pure part of the measure itself is in perf-core.ts; this file is the link between the two.

import { FEATURES, featurePatch, type FeatureCost, type FeatureId } from './features'
import type { Settings } from './model'

/**
 * Features the scenario "toutes allumées" leaves off, with the reason. A feature is only listed when switching it on would make the measure
 * mean something else than the cost of Lucium: it would depend on the machine, or the application would switch it off again by itself.
 */
export const PERF_SKIPPED: Partial<Record<FeatureId, string>> = {
  lock: 'sans phrase enregistrée, l’application remet le verrouillage à « désactivé » dès le lancement (LockService.start) : l’allumer ne mesurerait rien',
  proxy: 'passe par le proxy du système de la machine de mesure : le résultat dépendrait du réseau de celui qui lance la mesure, pas de Lucium',
  doh: 'change le résolveur DNS de l’application vers un serveur externe : le résultat dépendrait du réseau de celui qui lance la mesure, pas de Lucium'
}

/** What a measure of `pnpm perf` sees of a class of cost (the classes are those of the registry, features.ts). */
export interface CostClassPerf {
  seen: 'yes' | 'partly' | 'no'
  /** French: what is measured, or why it is not. The text of docs/performance.md follows it. */
  how: string
}

/**
 * One line per class of cost. The type forces a new class to be added here; perf-features.test.ts fails for a feature whose cost is empty or
 * not in this table.
 */
export const COST_CLASS_PERF: Record<FeatureCost, CostClassPerf> = {
  none: { seen: 'yes', how: 'rien ne tourne : l’écart entre « toutes allumées » et « toutes coupées » doit rester dans le bruit pour ces fonctions' },
  timer: { seen: 'partly', how: 'le processeur moyen sur la fenêtre de mesure voit une minuterie dont la période est courte ; un balayage de 10 minutes ou un contrôle quotidien n’y apparaît pas' },
  listeners: { seen: 'partly', how: 'le coût d’un écouteur arrive avec l’événement qu’il suit : seule l’inactivité de 10 pages locales est mesurée, pas une navigation ni un défilement' },
  network: { seen: 'no', how: 'les mesures se font sans Internet (le bloqueur ne télécharge aucune liste dans ce mode) : ni les requêtes ni la mémoire des données téléchargées ne sont mesurées' },
  memory: { seen: 'partly', how: 'la mémoire résidente du processus principal et des pages est mesurée ; celle de données chargées à l’usage (listes du bloqueur, vignettes, historique) ne l’est que si le scénario les charge' },
  process: { seen: 'partly', how: 'les processus de l’arbre sont comptés ; un programme lancé à la demande (hôte de messagerie native, lecture à voix haute, fil de recherche) n’est pas lancé par les scénarios' },
  disk: { seen: 'no', how: 'aucune mesure d’écriture sur le disque' }
}

/** Ids of the features whose cost is empty or names a class this file does not know. */
export function featuresWithoutCostClass(features: ReadonlyArray<{ id: string; cost: readonly string[] }>): string[] {
  return features.filter((feature) => feature.cost.length === 0 || feature.cost.some((cost) => !Object.hasOwn(COST_CLASS_PERF, cost))).map((feature) => feature.id)
}

export interface PerfFeaturePatch {
  patch: Partial<Settings>
  /** The features the patch switches on, then those it switches off (for `on`, the ones left aside). */
  on: FeatureId[]
  off: FeatureId[]
}

/** The settings of every registered feature, all on (but PERF_SKIPPED, which are off) or all off. Nothing else is touched. */
export function perfFeaturePatch(mode: 'on' | 'off'): PerfFeaturePatch {
  const patch: Record<string, unknown> = {}
  const on: FeatureId[] = []
  const off: FeatureId[] = []
  for (const feature of FEATURES) {
    const switchedOn = mode === 'on' && !Object.hasOwn(PERF_SKIPPED, feature.id)
    Object.assign(patch, featurePatch(feature.id, switchedOn))
    ;(switchedOn ? on : off).push(feature.id)
  }
  return { patch: patch as Partial<Settings>, on, off }
}
