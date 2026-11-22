// The privacy options borrowed from other browsers (Settings › Protection): HTTPS first, Global Privacy Control, tracking
// parameters in the addresses and in the copied links. HTTPS first is on for a new profile, the others are off.

import { useId, useState } from 'react'
import { checkBlockException } from '@shared/blocker'
import { THIRD_PARTY_COOKIE_EXCEPTIONS_MAX, trackingParamList } from '@shared/privacy'
import { fieldError } from './field-error'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { Check, Group, Row, Subpage } from './settings-parts'
import { t } from '@shared/i18n'

const SHOWN_PARAMS = 8

export function PrivacySettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  const exceptions = settings.thirdPartyCookieExceptions
  const [draft, setDraft] = useState('')
  const verdict = draft.trim() === '' ? null : exceptions.length >= THIRD_PARTY_COOKIE_EXCEPTIONS_MAX ? { error: t('guard-settings.la-liste-est-pleine') } : checkBlockException(draft, exceptions)
  const error = fieldError(useId(), verdict !== null && 'error' in verdict)
  const add = () => {
    if (!verdict || !('host' in verdict)) return
    update({ thirdPartyCookieExceptions: [...exceptions, verdict.host] })
    setDraft('')
  }
  return (
    <>
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

    <Group keys={['blockThirdPartyCookies']} title={t('privacy-settings.cookies-tiers')}>
      <Check
        settingKey="blockThirdPartyCookies"
        label={t('privacy-settings.bloquer-les-cookies-tiers')}
        hint={t('privacy-settings.un-site-integre-dans-une-autre-page-ne')}
        more={t('privacy-settings.sont-concernes-les-cookies-envoyes-et-recus')}
        checked={settings.blockThirdPartyCookies}
        onChange={(blockThirdPartyCookies) => update({ blockThirdPartyCookies })}
      />
    </Group>

    {/* The sites where the cookies of a third party are accepted: on the subpage of the other exceptions, drawn whether the option is on or not. */}
    <Subpage id="exceptions">
      <Group keys={['thirdPartyCookieExceptions']} title={t('privacy-settings.sites-ou-les-cookies-tiers-sont-acceptes')} footnote={t('privacy-settings.un-site-de-la-liste-couvre-aussi-ses-sous')}>
        <>
          {exceptions.length === 0 && <Row label={<span className="muted">{t('settings.aucun-site')}</span>} />}
          {exceptions.map((host) => (
            <div key={host} className="pref-row">
              <div className="pref-label">
                <code>{host}</code>
              </div>
              <div className="pref-control">
                <button className="link-button" onClick={() => update({ thirdPartyCookieExceptions: exceptions.filter((h) => h !== host) })} aria-label={t('settings.retirer-name', { name: host })}>
                  {t('settings.retirer')}
                </button>
              </div>
            </div>
          ))}
          <div className="pref-row pref-form">
            <input
              className="field"
              placeholder={t('settings.exemple-org')}
              aria-label={t('privacy-settings.site-ou-accepter-les-cookies-tiers')}
              {...error.field}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <button className="button" disabled={!verdict || 'error' in verdict} onClick={add}>
              {t('settings.ajouter')}
            </button>
          </div>
          {verdict && 'error' in verdict && (
            <div className="pref-row pref-message pref-error" {...error.message}>
              {verdict.error}
            </div>
          )}
        </>
      </Group>
    </Subpage>
    </>
  )
}
