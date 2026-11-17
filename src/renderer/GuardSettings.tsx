// Settings › Vie privée et sécurité › Plus de réglages: the protections that put code or limits into the pages you visit: the extended rules of the blocker (scriptlets, stand-in
// resources, $removeparam, $csp) and the fingerprint protection with the sites it leaves alone. Each switch is real: off, nothing is added to a
// page and nothing runs for it. Rendered by the Advanced pane (SettingsWindow.tsx) before "À propos".

import { useId, useState } from 'react'
import { fieldError } from './field-error'
import { blockerIsOn, checkBlockException } from '@shared/blocker'
import { FINGERPRINT_EXCEPTIONS_MAX } from '@shared/fingerprint'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { Check, Group, Row, Subpage, SubpageEntry } from './settings-parts'
import { t } from '@shared/i18n'

export function GuardSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  const exceptions = settings.fingerprintExceptions
  const [draft, setDraft] = useState('')
  const verdict = draft.trim() === '' ? null : exceptions.length >= FINGERPRINT_EXCEPTIONS_MAX ? { error: t('guard-settings.la-liste-est-pleine') } : checkBlockException(draft, exceptions)
  const error = fieldError(useId(), verdict !== null && 'error' in verdict)
  const add = () => {
    if (!verdict || !('host' in verdict)) return
    update({ fingerprintExceptions: [...exceptions, verdict.host] })
    setDraft('')
  }
  const blocking = blockerIsOn(settings)
  return (
    <>
      <Group
        title={t('guard-settings.protection-renforcee-des-pages')}
        footnote={t('guard-settings.s-applique-a-la-page-suivante-que-vous')} more={t('guard-settings.s-applique-a-la-page-que-vous-ouvrez-au')}
      >
        <Check
          settingKey="blockScriptlets"
          label={t('guard-settings.scriptlets-et-regles-etendues-du-bloqueur')}
          hint={blocking ? t('guard-settings.bloque-davantage-grace-aux-regles-avancees') : t('guard-settings.demande-l-un-des-deux-blocages-ci-dessus')}
          more={blocking ? t('guard-settings.applique-les-regles-js-redirect') : undefined}
          checked={settings.blockScriptlets}
          onChange={(blockScriptlets) => update({ blockScriptlets })}
        />
        <Check
          settingKey="reduceFingerprint"
          label={t('guard-settings.protection-contre-l-empreinte-numerique')}
          hint={t('guard-settings.un-bruit-leger-sur-ce-qu-une-page-lit-de')} more={t('guard-settings.ajoute-un-bruit-leger-stable-sur-un-site')}
          checked={settings.reduceFingerprint}
          onChange={(reduceFingerprint) => update({ reduceFingerprint })}
        />
        <Check
          settingKey="fingerprintStrict"
          label={t('guard-settings.mode-strict-de-la-protection-contre-l-empreinte')}
          hint={t('guard-settings.brouille-davantage-l-empreinte-de-l-appareil')} more={t('guard-settings.ecran-arrondi-a-une-taille-courante-carte')}
          checked={settings.fingerprintStrict}
          disabled={!settings.reduceFingerprint}
          onChange={(fingerprintStrict) => update({ fingerprintStrict })}
        />
        {/* The sites where a protection is lifted (the blocker's, the pop-ups', the fingerprint's), on one subpage. */}
        <SubpageEntry id="exceptions" snapshot={snapshot} />
      </Group>

      <Subpage id="exceptions">
      <Group keys={['fingerprintExceptions']} title={t('guard-settings.sites-sans-protection-contre-l-empreinte')} footnote={t('web-tools-settings.un-site-de-la-liste-couvre-aussi-ses-sous')} more={t('guard-settings.un-site-de-la-liste-couvre-aussi-ses-sous-domaines')}>
        {exceptions.length === 0 && <Row label={<span className="muted">{t('settings.aucun-site')}</span>} />}
        {exceptions.map((host) => (
          <div key={host} className="pref-row">
            <div className="pref-label">
              <code>{host}</code>
            </div>
            <div className="pref-control">
              <button className="link-button" onClick={() => update({ fingerprintExceptions: exceptions.filter((h) => h !== host) })} aria-label={t('settings.retirer-name', { name: host })}>
                {t('settings.retirer')}
              </button>
            </div>
          </div>
        ))}
        <div className="pref-row pref-form">
          <input
            className="field"
            placeholder={t('settings.exemple-org')}
            aria-label={t('guard-settings.site-a-exclure-de-la-protection-contre-l')}
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
      </Group>
      </Subpage>
    </>
  )
}
