// Settings › Historique et données (`HistorySettings`), and Settings › Réseau et listes (`NetworkSettings`): what these privacy features add:
// history, cookies and private tabs; encrypted DNS and the proxy. Each switch is real: off, the feature does nothing
// at all. The copied links are with the other protections (PrivacySettings.tsx).

import { DOH_CUSTOM, DOH_MODES, DOH_MODE_HINTS, DOH_MODE_LABELS, DOH_PROVIDERS, DOH_SYSTEM, parseDohTemplate, planHostResolver, type DohMode } from '@shared/dns'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { SYSTEM_PROXY } from '@shared/proxy'
import { useId, useState, type ReactNode } from 'react'
import { api } from './api'
import { FeatureSwitch } from './FeaturesSettings'
import { fieldError } from './field-error'
import { Check, Group, Row } from './settings-parts'
import { ProxyEditor } from './ProxyEditor'
import { t } from '@shared/i18n'

/**
 * The row of the address of a server typed by the user. It is saved once it is finished (the field is left, or Return), and only when it is a valid https
 * address: what is saved reconfigures the resolver at once, and nearly every keystroke of an address makes a valid address of another host
 * (`https://d/`, `https://dns.exemple.or/`), which the DNS requests of that moment would be sent to. An address that is refused says why, and
 * that the one before stays in use.
 */
export function DohAddress({ value, onValid }: { value: string; onValid: (template: string) => void }) {
  const [text, setText] = useState(value)
  const invalid = text.trim() !== '' && parseDohTemplate(text) === null
  const error = fieldError(useId(), invalid)
  const save = () => {
    const valid = parseDohTemplate(text)
    if (valid !== null && valid !== value) onValid(valid)
  }
  return (
    <>
      <Row settingKey="dohCustomUrl" label={t('privacy-extra-settings.adresse-du-serveur')} hint={t('privacy-extra-settings.https-hote-dns-query-seul-https-est')}>
        <input
          className="field"
          spellCheck={false}
          aria-label={t('privacy-extra-settings.adresse-du-serveur-dns-chiffre')}
          {...error.field}
          placeholder={t('privacy-extra-settings.https-dns-exemple-org-dns-query')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
        />
      </Row>
      {invalid && (
        <div className="pref-row pref-message pref-error" {...error.message}>
          {t('privacy-extra-settings.adresse-dns-non-valide')}
        </div>
      )}
    </>
  )
}

/**
 * The history (the cookies per site and the private tabs are features to add). `leading`: the first row of the group (the clearing of the data of the
 * profile on screen); `trailing`: its last (the row of the subpage « Effacer certains sites en partant »).
 */
export function HistorySettings({ snapshot, update, leading, trailing }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void; leading?: ReactNode; trailing?: ReactNode }) {
  const { settings } = snapshot.state
  return (
    <Group title={t('privacy-extra-settings.historique-cookies-et-onglets-prives')}>
      {leading}
      <Check
        settingKey="historyOff"
        label={t('privacy-extra-settings.garder-l-historique-des-pages-visitees')}
        hint={t('guide.historique-garder-effet')}
        more={t('privacy-extra-settings.les-pages-visitees-ne-sont-plus-ajoutees-a')}
        // Said in the affirmative: on while the history is kept, which is the stored setting `historyOff` turned around.
        checked={!settings.historyOff}
        onChange={(keep) => update({ historyOff: !keep })}
      />
      <FeatureSwitch id="page-content-index" snapshot={snapshot} update={update} />
      {settings.pageContentIndex && <ClearPageIndexRow />}
      {trailing}
    </Group>
  )
}

/** « Effacer l’index du contenu des pages »: every index of every profile at once; the setting stays on, and the index fills again as pages are read. */
function ClearPageIndexRow() {
  const [done, setDone] = useState<'' | 'ok' | 'failed'>('')
  const clear = () => {
    setDone('')
    api()
      .clearPageIndex()
      .then(
        (erased) => setDone(erased ? 'ok' : 'failed'),
        (error: unknown) => {
          console.warn('[page-index] the index could not be erased:', error)
          setDone('failed')
        }
      )
  }
  return (
    <Row label={t('privacy-extra-settings.effacer-l-index-du-contenu-des-pages')} hint={t('privacy-extra-settings.efface-le-texte-garde-de-toutes-les-pages')}>
      <button type="button" className="btn" onClick={clear}>
        {t('privacy-extra-settings.effacer-l-index-du-contenu-des-pages')}
      </button>
      <span role="status" className="tk-status">{done === 'ok' ? t('privacy-extra-settings.index-efface') : done === 'failed' ? t('privacy-extra-settings.index-non-efface') : ''}</span>
    </Row>
  )
}

/** The encrypted DNS and the proxy: the network, for every profile. */
export function NetworkSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  const plan = planHostResolver(settings)
  return (
    <>
      <Group title={t('privacy-extra-settings.dns-chiffre')} footnote={t('privacy-extra-settings.le-serveur-choisi-voit-les-noms-de-domaine')}>
        <Check
          settingKey="dohCustom"
          label={t('privacy-extra-settings.regler-le-dns-chiffre-moi-meme')}
          hint={t('privacy-extra-settings.desactive-le-moteur-decide-seul-mode')}
          checked={settings.dohCustom}
          onChange={(dohCustom) => update({ dohCustom })}
        />
        {settings.dohCustom && (
          <>
            <Row settingKey="dohMode" label={t('blocking-settings.mode')} hint={DOH_MODE_HINTS[settings.dohMode]}>
              <select className="field pop" aria-label={t('privacy-extra-settings.mode-du-dns-chiffre')} value={settings.dohMode} onChange={(e) => update({ dohMode: e.target.value as DohMode })}>
                {DOH_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {DOH_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </Row>
            {settings.dohMode !== 'off' && (
              <Row settingKey="dohProvider" label={t('privacy-extra-settings.serveur')} hint={t('privacy-extra-settings.une-liste-fixe-de-fournisseurs-ou-une')}>
                <select className="field pop" aria-label={t('privacy-extra-settings.serveur-dns-chiffre')} value={settings.dohProvider} onChange={(e) => update({ dohProvider: e.target.value })}>
                  <option value={DOH_SYSTEM}>{t('privacy-extra-settings.celui-du-reseau-aucun')}</option>
                  {DOH_PROVIDERS.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                  <option value={DOH_CUSTOM}>{t('privacy-extra-settings.autre-adresse')}</option>
                </select>
              </Row>
            )}
            {settings.dohMode !== 'off' && settings.dohProvider === DOH_CUSTOM && (
              <DohAddress value={settings.dohCustomUrl} onValid={(dohCustomUrl) => update({ dohCustomUrl })} />
            )}
            {plan.kind === 'refused' && (
              <div className="pref-row pref-message" role="alert">
                {plan.reason} {t('privacy-extra-settings.tant-que-ce-n-est-pas-fait-le-moteur-garde')}
              </div>
            )}
          </>
        )}
      </Group>

      <Group keys={['proxy']} title={t('settings-profiles.proxy')} footnote={t('privacy-extra-settings.le-proxy-vaut-aussi-pour-les-fenetres')} more={t('privacy-extra-settings.le-proxy-s-applique-aux-pages-aux-fenetres')}>
        <Check
          settingKey="proxyEnabled"
          label={t('privacy-extra-settings.utiliser-un-proxy-http-ou-socks')}
          hint={t('privacy-extra-settings.desactive-le-proxy-du-systeme-est-utilise')}
          checked={settings.proxyEnabled}
          onChange={(proxyEnabled) => update({ proxyEnabled })}
        />
        {settings.proxyEnabled && <ProxyEditor name={t('privacy-extra-settings.tous-les-profils')} title={t('proxy-editor.reseau-d-lucium')} value={settings.proxy ?? SYSTEM_PROXY} onChange={(proxy) => update({ proxy })} />}
      </Group>
    </>
  )
}

/** Both, one under the other (settings-r11.test.ts draws them together). */
export function PrivacyExtraSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  return (
    <>
      <HistorySettings snapshot={snapshot} update={update} />
      <NetworkSettings snapshot={snapshot} update={update} />
    </>
  )
}
