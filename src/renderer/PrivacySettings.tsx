// The privacy options borrowed from other browsers (Settings › Protection): HTTPS first, Global Privacy Control, tracking
// parameters in the addresses and in the copied links. HTTPS first is on for a new profile, the others are off.

import { useId, useState } from 'react'
import { checkBlockException } from '@shared/blocker'
import { HTTPS_ONLY_EXCEPTIONS_MAX, THIRD_PARTY_COOKIE_EXCEPTIONS_MAX, trackingParamList } from '@shared/privacy'
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
  // The sites « HTTPS seul » opens over http with no warning: the same form as the sites of the third-party cookies.
  const httpOk = settings.httpsOnlyExceptions
  const [httpDraft, setHttpDraft] = useState('')
  const httpVerdict = httpDraft.trim() === '' ? null : httpOk.length >= HTTPS_ONLY_EXCEPTIONS_MAX ? { error: t('guard-settings.la-liste-est-pleine') } : checkBlockException(httpDraft, httpOk)
  const httpError = fieldError(useId(), httpVerdict !== null && 'error' in httpVerdict)
  const addHttp = () => {
    if (!httpVerdict || !('host' in httpVerdict)) return
    update({ httpsOnlyExceptions: [...httpOk, httpVerdict.host] })
    setHttpDraft('')
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

    <Group keys={['blockPings', 'trimReferer', 'httpsOnly']} title={t('privacy-settings.protection-du-reseau')}>
      <Check
        settingKey="blockPings"
        label={t('privacy-settings.bloquer-les-pings-de-suivi')}
        hint={t('privacy-settings.pings-hint')}
        more={t('privacy-settings.pings-more')}
        checked={settings.blockPings}
        onChange={(blockPings) => update({ blockPings })}
      />
      <Check
        settingKey="trimReferer"
        label={t('privacy-settings.rogner-le-referer')}
        hint={t('privacy-settings.referer-hint')}
        more={t('privacy-settings.referer-more')}
        checked={settings.trimReferer}
        onChange={(trimReferer) => update({ trimReferer })}
      />
      <Check
        settingKey="httpsOnly"
        label={t('privacy-settings.https-seul')}
        hint={t('privacy-settings.https-seul-hint')}
        more={t('privacy-settings.https-seul-more')}
        checked={settings.httpsOnly}
        onChange={(httpsOnly) => update({ httpsOnly })}
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
      <Group keys={['httpsOnlyExceptions']} title={t('privacy-settings.sites-autorises-en-http')} footnote={t('privacy-settings.https-seul-liste-note')}>
        <>
          {httpOk.length === 0 && <Row label={<span className="muted">{t('settings.aucun-site')}</span>} />}
          {httpOk.map((host) => (
            <div key={host} className="pref-row">
              <div className="pref-label">
                <code>{host}</code>
              </div>
              <div className="pref-control">
                <button className="link-button" onClick={() => update({ httpsOnlyExceptions: httpOk.filter((h) => h !== host) })} aria-label={t('settings.retirer-name', { name: host })}>
                  {t('settings.retirer')}
                </button>
              </div>
            </div>
          ))}
          <div className="pref-row pref-form">
            <input
              className="field"
              placeholder={t('settings.exemple-org')}
              aria-label={t('privacy-settings.site-a-ouvrir-en-http')}
              {...httpError.field}
              value={httpDraft}
              onChange={(e) => setHttpDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addHttp()}
            />
            <button className="button" disabled={!httpVerdict || 'error' in httpVerdict} onClick={addHttp}>
              {t('settings.ajouter')}
            </button>
          </div>
          {httpVerdict && 'error' in httpVerdict && (
            <div className="pref-row pref-message pref-error" {...httpError.message}>
              {httpVerdict.error}
            </div>
          )}
        </>
      </Group>
    </Subpage>
    </>
  )
}
