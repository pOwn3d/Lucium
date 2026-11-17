// Espaces et fenêtre (Apparence): the side of the sidebar, and the switches the category adds under it (the compact mode, the media player…). The web
// panels are a feature to add, in « Fonctions en option » (FeaturesPage.tsx).

import type { ReactNode } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { Group, Row, type DrawsRows } from './settings-parts'
import { t } from '@shared/i18n'

/**
 * The side of the sidebar: in Apparence, and again on « Pour commencer » (`mirror`). A menu of its two sides, « À gauche » and « À droite », the words of
 * the guide; it writes the same setting as before, `sidebarRight` (its values are the text of that boolean).
 */
export function SidebarSideRow({ snapshot, update, mirror }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void; mirror?: boolean }) {
  const label = t('spaces-settings.placer-la-barre-laterale-a-droite-de-la-fenetre')
  return (
    <Row settingKey="sidebarRight" mirror={mirror} label={label} hint={t('spaces-settings.la-barre-laterale-et-les-panneaux-passent-a')} more={t('spaces-settings.la-fenetre-est-inversee-barre-laterale')}>
      <select className="field pop" aria-label={label} value={String(snapshot.state.settings.sidebarRight)} onChange={(e) => update({ sidebarRight: e.target.value === 'true' })}>
        <option value="false">{t('guide.cote-barre-gauche')}</option>
        <option value="true">{t('guide.cote-barre-droite')}</option>
      </select>
    </Row>
  )
}
;(SidebarSideRow as DrawsRows).rows = ['sidebarRight']

/** `children`: more rows of the group (the switches of the compact mode and of the media player, which have no pane of their own). */
export function SpacesSettings({ snapshot, update, children }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void; children?: ReactNode }) {
  return (
    <Group title={t('spaces-settings.espaces-et-fenetre')}>
      <SidebarSideRow snapshot={snapshot} update={update} />
      {children}
    </Group>
  )
}
