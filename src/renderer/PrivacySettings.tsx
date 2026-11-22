// The privacy options borrowed from other browsers (Settings › Protection): HTTPS first, Global Privacy Control, tracking
// parameters in the addresses and in the copied links. HTTPS first is on for a new profile, the others are off.

import { useId, useState } from 'react'
import { checkBlockException } from '@shared/blocker'
import { THIRD_PARTY_COOKIE_EXCEPTIONS_MAX, trackingParamList } from '@shared/privacy'
import { SAFE_BROWSING_EXCEPTIONS_MAX } from '@shared/safe-browsing'
import { fieldError } from './field-error'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { Check, Group, Row, Subpage } from './settings-parts'
import { t } from '@shared/i18n'

const SHOWN_PARAMS = 8

/** A list of sites (a host and its subdomains) with a field to add one: what the exceptions of an option are. */
function SiteList({ settingKey, sites, max, title, footnote, label, onChange }: { settingKey: 'thirdPartyCookieExceptions' | 'safeBrowsingExceptions' | 'unwrapExceptions'; sites: readonly string[]; max: number; title: string; footnote: string; label: string; onChange: (sites: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const verdict = draft.trim() === '' ? null : sites.length >= max ? { error: t('guard-settings.la-liste-est-pleine') } : checkBlockException(draft, sites)
  const error = fieldError(useId(), verdict !== null && 'error' in verdict)
  const add = () => {
    if (!verdict || !('host' in verdict)) return
    onChange([...sites, verdict.host])
    setDraft('')
  }
  return (
    <Group keys={[settingKey]} title={title} footnote={footnote}>
      <>
        {sites.length === 0 && <Row label={<span className="muted">{t('settings.aucun-site')}</span>} />}
        {sites.map((host) => (
          <div key={host} className="pref-row">
            <div className="pref-label">
              <code>{host}</code>
            </div>
            <div className="pref-control">
              <button className="link-button" onClick={() => onChange(sites.filter((h) => h !== host))} aria-label={t('settings.retirer-name', { name: host })}>
                {t('settings.retirer')}
              </button>
            </div>
          </div>
        ))}
        <div className="pref-row pref-form">
          <input className="field" placeholder={t('settings.exemple-org')} aria-label={label} {...error.field} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
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
  )
}

export function PrivacySettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  return (
    <>
    <Group keys={['httpsUpgrade', 'sendGpc', 'stripTrackingParams', 'unwrapRedirects']} title={t('privacy-settings.confidentialite-renforcee')} footnote={t('privacy-settings.allumees-pour-un-nouveau-profil-elles-valent')} more={t('privacy-settings.quatre-protections-que-d-autres-navigateurs')}>
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
      <Check
        settingKey="unwrapRedirects"
        label={t('privacy-settings.contourner-les-redirections-de-suivi-et-les-pages-amp')}
        hint={t('privacy-settings.un-lien-qui-passe-par-un-redirecteur-ou-une-page-amp-de-google')}
        more={t('privacy-settings.seules-sont-depliees-les-adresses-qui-contiennent')}
        checked={settings.unwrapRedirects}
        onChange={(unwrapRedirects) => update({ unwrapRedirects })}
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

    <Group keys={['safeBrowsing']} title={t('privacy-settings.navigation-sure')}>
      <Check
        settingKey="safeBrowsing"
        label={t('privacy-settings.prevenir-avant-d-ouvrir-un-site-dangereux')}
        hint={t('privacy-settings.compare-chaque-page-a-une-liste-livree')}
        more={t('privacy-settings.la-liste-est-livree-avec-lucium')}
        checked={settings.safeBrowsing}
        onChange={(safeBrowsing) => update({ safeBrowsing })}
      />
      {settings.safeBrowsing && snapshot.safeLists === 'unavailable' && (
        <div className="pref-row pref-message pref-error" role="status">
          {t('privacy-settings.liste-indisponible')}
        </div>
      )}
    </Group>

    {/* The sites where third-party cookies are accepted, where the warning of safe browsing is not shown, and whose links are left as they are: on the subpage of the other exceptions, drawn whether the option is on or not. */}
    <Subpage id="exceptions">
      <SiteList
        settingKey="thirdPartyCookieExceptions"
        sites={settings.thirdPartyCookieExceptions}
        max={THIRD_PARTY_COOKIE_EXCEPTIONS_MAX}
        title={t('privacy-settings.sites-ou-les-cookies-tiers-sont-acceptes')}
        footnote={t('privacy-settings.un-site-de-la-liste-couvre-aussi-ses-sous')}
        label={t('privacy-settings.site-ou-accepter-les-cookies-tiers')}
        onChange={(thirdPartyCookieExceptions) => update({ thirdPartyCookieExceptions })}
      />
      <SiteList
        settingKey="safeBrowsingExceptions"
        sites={settings.safeBrowsingExceptions}
        max={SAFE_BROWSING_EXCEPTIONS_MAX}
        title={t('privacy-settings.sites-ou-la-navigation-sure-ne-previent-pas')}
        footnote={t('privacy-settings.un-site-de-la-liste-couvre-aussi-ses-sous')}
        label={t('privacy-settings.site-ou-ne-pas-prevenir')}
        onChange={(safeBrowsingExceptions) => update({ safeBrowsingExceptions })}
      />
      <SiteList
        settingKey="unwrapExceptions"
        sites={settings.unwrapExceptions}
        max={THIRD_PARTY_COOKIE_EXCEPTIONS_MAX}
        title={t('privacy-settings.sites-dont-les-liens-restent-tels-quels')}
        footnote={t('privacy-settings.un-site-de-la-liste-couvre-aussi-ses-sous')}
        label={t('privacy-settings.site-dont-les-liens-restent-tels-quels')}
        onChange={(unwrapExceptions) => update({ unwrapExceptions })}
      />
    </Subpage>
    </>
  )
}
