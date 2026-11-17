// Rows of a category that « Pour commencer » draws again (`mirror`): each is one component, drawn in both places, so that the two never differ. The
// presets (PresetSettings.tsx) are such rows: the level of protection, the launch and the links of other applications here, the sleep in TabsSettings.tsx.

import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { adsBlockingOn, adsBlockingPatch } from '@shared/privacy-dashboard'
import { t } from '@shared/i18n'
import { PRESETS } from '@shared/settings-presets'
import { PresetRow } from './PresetSettings'
import { Check, type DrawsRows } from './settings-parts'

type PaneProps = { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }

/**
 * « Niveau de protection »: Standard, Renforcée or Stricte, in Vie privée et sécurité › Protection and again on « Pour commencer » (`mirror`). No
 * setting tells its levels apart (every one blocks the ads): the row carries a search id. Four of the switches it writes stand under it (the ads,
 * the cookie banners, the tracking parameters, the fingerprint: shared/settings-placement.ts), the five others wait in « Plus de réglages ».
 */
export function ProtectionLevelRow({ snapshot, update, mirror }: PaneProps & { mirror?: boolean }) {
  return <PresetRow preset={PRESETS.protection.id} settings={snapshot.state.settings} update={update} mirror={mirror} />
}

/** « Quand vous ouvrez Lucium », in Onglets et fenêtres › Au lancement and again on « Pour commencer »: the row of the windows of the last session. */
export function LaunchRow({ snapshot, update, mirror }: PaneProps & { mirror?: boolean }) {
  return <PresetRow preset={PRESETS.lancement.id} settings={snapshot.state.settings} update={update} mirror={mirror} />
}
;(LaunchRow as DrawsRows).rows = ['restoreWindows']

/** « Liens venus d’autres applications », in Navigation › Liens and again on « Pour commencer »: the row of the links of other applications. */
export function LinksPresetRow({ snapshot, update, mirror }: PaneProps & { mirror?: boolean }) {
  return <PresetRow preset={PRESETS.liens.id} settings={snapshot.state.settings} update={update} mirror={mirror} />
}
;(LinksPresetRow as DrawsRows).rows = ['externalLinksInLittleArc']

/**
 * The switch of the ads and the trackers, in Vie privée et sécurité › Bloqueur, under the level of protection. One switch for both: `blockTrackers` is the alias of `blockAds` (the blocker reads either), so the switch shows the two as one and writes both: off
 * would otherwise leave the blocking on.
 */
export function BlockAdsRow({ snapshot, update }: PaneProps) {
  return (
    <Check
      settingKey="blockAds"
      label={t('settings.bloquer-les-publicites-et-les-traqueurs')}
      hint={t('guide.bloqueur-pubs-effet')} more={t('settings.s-applique-aux-pages-au-prochain-chargement')}
      checked={adsBlockingOn(snapshot.state.settings)}
      onChange={(on) => update(adsBlockingPatch(on))}
    />
  )
}
;(BlockAdsRow as DrawsRows).rows = ['blockAds']
