// Settings of the keyboard navigation and of the extension features of this group (Vim-style keys, ...). Every switch is off by default
// and costs nothing while it is off. Rendered by the Advanced pane (SettingsWindow.tsx), before the About group.

import { useId, useState } from 'react'
import { fieldError } from './field-error'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { activeProfileId } from '@shared/profiles'
import { checkSleepHost } from '@shared/sleep'
import { vimKeysSummary } from '@shared/vim-keys'
import type { SettingKey } from '@shared/settings-catalog'
import { Check, Group, Row, Subpage } from './settings-parts'
import { t } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'

interface Props {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

/** A list of sites with a field to add one: used for the sites a feature leaves out. */
export function SiteList({ title, footnote, hosts, label, onChange, settingKey }: { title: string; footnote: string; hosts: readonly string[]; label: string; onChange: (hosts: string[]) => void; settingKey: SettingKey }) {
  const [draft, setDraft] = useState('')
  const verdict = draft.trim() === '' ? null : checkSleepHost(draft, hosts)
  const error = fieldError(useId(), verdict !== null && 'error' in verdict)
  const add = () => {
    if (!verdict || !('host' in verdict)) return
    onChange([...hosts, verdict.host])
    setDraft('')
  }
  return (
    <Group title={title} footnote={footnote} keys={[settingKey]}>
      {hosts.length === 0 && (
        <div className="pref-row pref-message" role="status">
          {t('settings.aucun-site')}
        </div>
      )}
      {hosts.map((host) => (
        <Row key={host} label={<code>{host}</code>}>
          <button className="link-button" onClick={() => onChange(hosts.filter((h) => h !== host))} aria-label={t('settings.retirer-name', { name: host })}>
            {t('settings.retirer')}
          </button>
        </Row>
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
    </Group>
  )
}

/** The Vim-style keys: the switch, what each key does, and the sites where they are off. */
export function VimKeysSettings({ snapshot, update }: Props) {
  const { settings } = snapshot.state
  return (
    <>
      <Group
        title={t('key-ext-settings.navigation-au-clavier-de-type-vim')}
        footnote={
          settings.vimKeys
            ? t('key-ext-settings.les-touches-restent-a-la-page-dans-un-champ')
            : t('key-ext-settings.desactive-les-touches-restent-a-la-page')
        }
        more={settings.vimKeys ? t('key-ext-settings.keys-les-touches-sont-laissees-a-la-page', { keys: vimKeysSummary() }) : undefined}
      >
        <Check
          settingKey="vimKeys"
          label={t('key-ext-settings.navigation-au-clavier-de-type-vim')}
          hint={t('key-ext-settings.des-lettres-font-defiler-la-page-reperent')} more={t('key-ext-settings.les-lettres-font-defiler-la-page-reperent', { settingsPath: settingsPath('vimKeySites') })}
          checked={settings.vimKeys}
          onChange={(vimKeys) => update({ vimKeys })}
        />
      </Group>
      {/* The sites without Vim keys share the subpage of the sites without gestures (WebToolsSettings.tsx), whose row opens it. */}
      {settings.vimKeys && (
        <Subpage id="siteexclusions">
          <SiteList
            settingKey="vimKeysExcludedHosts"
            title={t('key-ext-settings.sites-sans-touches-de-type-vim')}
            footnote={t('key-ext-settings.un-site-de-la-liste-couvre-aussi-ses-sous')}
            hosts={settings.vimKeysExcludedHosts}
            label={t('key-ext-settings.site-sans-touches-de-type-vim')}
            onChange={(vimKeysExcludedHosts) => update({ vimKeysExcludedHosts })}
          />
        </Subpage>
      )}
    </>
  )
}

/** The keywords of extensions in the command bar: the switch, and the keywords the extensions of the space on screen declared. */
export function OmniboxKeywordSettings({ snapshot, update }: Props) {
  const { settings } = snapshot.state
  const profileId = activeProfileId(snapshot.state)
  const listed = [...new Map(snapshot.extensions.filter((e) => e.enabled && e.profileId === profileId && e.omniboxKeyword !== undefined).map((e) => [e.id, e])).values()]
  const ownKeywords = new Set(settings.siteSearches.map((s) => s.keyword.toLowerCase()))
  const seen = new Set<string>()
  return (
    <Group
      title={t('key-ext-settings.mots-cles-d-extension-dans-la-barre-de-commandes')}
      footnote={
        settings.omniboxKeywords
          ? t('key-ext-settings.tapez-le-mot-cle-un-espace-et-votre-texte-l')
          : t('key-ext-settings.desactive-la-barre-de-commandes-ne-connait')
      }
        more={settings.omniboxKeywords ? t('key-ext-settings.tapez-le-mot-cle-un-espace-votre-texte') : undefined}
    >
      <Check
        settingKey="omniboxKeywords"
        label={t('key-ext-settings.mots-cles-d-extension-dans-la-barre-de-commandes')}
        hint={t('key-ext-settings.pour-les-extensions-qui-declarent-un-mot')}
        checked={settings.omniboxKeywords}
        onChange={(omniboxKeywords) => update({ omniboxKeywords })}
      />
      {settings.omniboxKeywords && listed.length === 0 && (
        <div className="pref-row pref-message" role="status">
          {t('key-ext-settings.aucune-extension-active-dans-cet-espace-ne')}
        </div>
      )}
      {settings.omniboxKeywords &&
        listed.map((extension) => {
          const keyword = extension.omniboxKeyword!.toLowerCase()
          const hidden = ownKeywords.has(keyword) ? t('key-ext-settings.masque-par-votre-recherche-dans-un-site-omniboxkeyword', { omniboxKeyword: keyword }) : seen.has(keyword) ? t('key-ext-settings.deja-pris-par-une-autre-extension') : null
          seen.add(keyword)
          return (
            <Row key={extension.id} label={extension.name} hint={hidden ?? undefined}>
              <code>{extension.omniboxKeyword}</code>
            </Row>
          )
        })}
    </Group>
  )
}

/** The Vim keys (Keyboard and mouse) and the keywords of the command bar (Navigation), one after the other: each is drawn on the page of its own. */
export function KeyExtSettings({ snapshot, update }: Props) {
  return (
    <>
      <VimKeysSettings snapshot={snapshot} update={update} />
      <OmniboxKeywordSettings snapshot={snapshot} update={update} />
    </>
  )
}
