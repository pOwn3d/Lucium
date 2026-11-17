// The privacy options borrowed from other browsers (Settings › Protection): HTTPS first, Global Privacy Control, tracking
// parameters in the addresses and in the copied links. HTTPS first is on for a new profile, the others are off.

import { trackingParamList } from '@shared/privacy'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { Check, Group } from './settings-parts'
import { t } from '@shared/i18n'

const SHOWN_PARAMS = 8

export function PrivacySettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  return (
    <Group keys={['httpsUpgrade', 'sendGpc', 'stripTrackingParams']} title={t('privacy-settings.confidentialite-renforcee')} footnote={t('privacy-settings.allumees-pour-un-nouveau-profil-elles-valent')} more={t('privacy-settings.quatre-protections-que-d-autres-navigateurs')}>
      <Check
        settingKey="httpsUpgrade"
        label={t('privacy-settings.toujours-essayer-https-d-abord')}
        hint={t('privacy-settings.ouvre-les-sites-en-connexion-chiffree-quand')} more={t('privacy-settings.une-adresse-en-http-est-ouverte-en-https')}
        checked={settings.httpsUpgrade}
        onChange={(httpsUpgrade) => update({ httpsUpgrade })}
      />
      <Check
        settingKey="sendGpc"
        label={t('privacy-settings.envoyer-le-signal-global-privacy-control')}
        hint={t('privacy-settings.ajoute-l-en-tete-sec-gpc-1-a-chaque')}
        checked={settings.sendGpc}
        onChange={(sendGpc) => update({ sendGpc })}
      />
      <Check
        settingKey="stripTrackingParams"
        label={t('privacy-settings.retirer-les-parametres-de-suivi-des-adresses')}
        hint={t('privacy-settings.supprime-utm-fbclid-gclid-mc-eid-igshid')}
        checked={settings.stripTrackingParams}
        onChange={(stripTrackingParams) => update({ stripTrackingParams })}
      />
      <Check
        settingKey="stripCopiedLinks"
        label={t('privacy-extra-settings.retirer-les-parametres-de-suivi-des-liens-copies')}
        hint={t('privacy-extra-settings.une-adresse-copiee-perd-ses-parametres-de')}
        more={t('privacy-extra-settings.quand-vous-copiez-une-adresse-copier-l-adresse', { params: trackingParamList().slice(0, SHOWN_PARAMS).join(', ') })}
        checked={settings.stripCopiedLinks}
        onChange={(stripCopiedLinks) => update({ stripCopiedLinks })}
      />
    </Group>
  )
}
