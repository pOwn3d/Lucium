// Settings › Pour commencer › Langue: the language of the interface (shared/i18n.ts). "Français" is the interface as it always was (the function is off);
// any other choice turns the translation on with that language, and "Automatique" follows the language of the system.

import { LANGUAGE_NAMES, t, type LanguageSetting } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { Group, Row } from './settings-parts'

export function LanguageSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  // With the function off the interface is French, whatever `language` holds: the choice shown is what is on screen.
  const shown: LanguageSetting = settings.interfaceTranslated ? settings.language : 'fr'
  const choose = (value: LanguageSetting): void => update(value === 'fr' ? { interfaceTranslated: false } : { interfaceTranslated: true, language: value })
  return (
    <Group keys={['language', 'interfaceTranslated']} title={t('lang.langue')} footnote={t('lang.les-pages-web-et-les-noms-que-vous-donnez-ne')} more={t('lang.footnote')}>
      <Row label={t('lang.interface')} hint={t('lang.hint')}>
        <select className="field pop" aria-label={t('lang.interface')} value={shown} onChange={(e) => choose(e.target.value as LanguageSetting)}>
          <option value="auto">{t('lang.auto')}</option>
          <option value="fr">{LANGUAGE_NAMES.fr}</option>
          <option value="en">{LANGUAGE_NAMES.en}</option>
        </select>
      </Row>
    </Group>
  )
}
