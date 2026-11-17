// Settings › Extensions et outils › Traduction locale: the switch of the function, the language pages are translated into, the folder the models are kept in and the models
// that are there. The models themselves are looked up and downloaded in the panel of File › Traduire cette page…, where the address and size are shown first.
// « Traduction automatique »: the languages always translated and the sites never translated, which the toolbar button's popover fills; here they are removed.

import { useEffect } from 'react'
import { t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { formatSize } from '@shared/translate-local'
import { languagePhrase } from '@shared/translate-quick'
import { Check, Group, Row, Subpage, SubpageEntry } from './settings-parts'
import { engineNote, languageName, useTranslate } from './TranslatePanel'

const TARGETS = ['fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'sv', 'pl', 'ru', 'ja', 'zh']

export function TranslateSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  const { view, busy, ask } = useTranslate()
  // The list of models is read only while the function is on; nothing is read from any page.
  useEffect(() => {
    if (settings.translateLocal) void ask({ action: 'packs' })
    // The settings change when the switch does.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.translateLocal, settings.translateModelsDir])
  return (
    <>
      <Group title={t('translate.settings-title')} footnote={t('translate.settings-footnote')}>
        <Check settingKey="translateLocal" label={t('translate.settings-switch')} hint={t('translate.traduit-une-page-sur-ce-mac-sans-service-en')} more={t('translate.settings-hint')} checked={settings.translateLocal} onChange={(translateLocal) => update({ translateLocal })} />
        {settings.translateLocal && (
          <>
            <Row settingKey="translateTarget" label={t('translate.settings-target')}>
              <select className="field pop" aria-label={t('translate.settings-target')} value={settings.translateTarget} onChange={(e) => update({ translateTarget: e.target.value })}>
                <option value="auto">{t('translate.settings-target-auto')}</option>
                {TARGETS.map((code) => (
                  <option key={code} value={code}>
                    {languageName(code)}
                  </option>
                ))}
              </select>
            </Row>
            <SubpageEntry id="translatelists" snapshot={snapshot} />
            <Row settingKey="translateModelsDir" label={t('translate.folder')} hint={view?.folder.path ?? ''}>
              <button className="button" disabled={busy || snapshot.private === true} onClick={() => void ask({ action: 'folder' })}>
                {t('translate.folder-choose')}
              </button>
              {!(view?.folder.isDefault ?? true) && (
                <button className="button" disabled={busy || snapshot.private === true} onClick={() => void ask({ action: 'folder-default' })}>
                  {t('translate.folder-default')}
                </button>
              )}
            </Row>
            {/* The system's own translation, first when it has the pair (macOS): nothing is asked of it from here, the panel does. */}
            <Check settingKey="translateSystemEngine" label={t('translate.settings-system-switch')} hint={t('translate.traduit-sur-ce-mac-avec-macos-quand-la')} more={t('translate.settings-system-hint')} disabled={!view?.system} checked={settings.translateSystemEngine} onChange={(translateSystemEngine) => update({ translateSystemEngine })} />
            {(view?.packs ?? []).map((pack) => (
              <Row key={pack.folder} label={`${languageName(pack.from)} → ${languageName(pack.to)}`} hint={`${formatSize(pack.bytes)} · ${engineNote(pack, view!)}`}>
                <button className="link-button" disabled={busy || snapshot.private === true} onClick={() => void ask({ action: 'remove', from: pack.from, to: pack.to, engine: pack.engine })}>
                  {t('translate.remove')}
                </button>
              </Row>
            ))}
          </>
        )}
      </Group>
      {settings.translateLocal && (
        <Subpage id="translatelists">
          <AutoTranslateLists settings={settings} update={update} />
        </Subpage>
      )}
    </>
  )
}

/** « Traduction automatique »: the two lists, each entry with « Retirer ». They are filled from the toolbar button's popover, never typed here. */
export function AutoTranslateLists({ settings, update }: { settings: Pick<Settings, 'translateAlways' | 'translateNeverSites'>; update: (patch: Partial<Settings>) => void }) {
  const { translateAlways: languages, translateNeverSites: sites } = settings
  return (
    <Group keys={['translateAlways', 'translateNeverSites']} title={t('translate.settings-auto-title')} footnote={t('translate.un-site-de-la-liste-n-est-jamais-traduit-de')} more={t('translate.settings-auto-footnote')}>
      {languages.length === 0 && sites.length === 0 && (
        <div className="pref-row pref-message" role="status">
          {t('translate.settings-auto-none')}
        </div>
      )}
      {languages.map((code) => {
        const label = t('translate.quick-always', { language: languagePhrase(code, 'the') })
        return (
          <Row key={`language:${code}`} label={label}>
            <button className="link-button" onClick={() => update({ translateAlways: languages.filter((entry) => entry !== code) })} aria-label={t('settings.retirer-name', { name: label })}>
              {t('settings.retirer')}
            </button>
          </Row>
        )
      })}
      {sites.map((host) => (
        <Row key={`site:${host}`} label={t('translate.settings-never', { host })}>
          <button className="link-button" onClick={() => update({ translateNeverSites: sites.filter((entry) => entry !== host) })} aria-label={t('settings.retirer-name', { name: host })}>
            {t('settings.retirer')}
          </button>
        </Row>
      ))}
    </Group>
  )
}
