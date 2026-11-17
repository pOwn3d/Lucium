// Settings › Vie privée et sécurité › Mots de passe: the switch of the password manager, and the way into its panel. Off, the group asks nothing of the main
// process: no script is loaded in the pages, no file is read. The vault itself is kept in a file of its own, never in the state.

import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { PASSWORD_LIMITS } from '@shared/passwords'
import { Check, Group, Row, type DrawsRows } from './settings-parts'
import { t } from '@shared/i18n'

/** The switch of the password manager: in Vie privée et sécurité, and again on « Pour commencer » (`mirror`). */
export function PasswordManagerRow({ snapshot, update, mirror }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void; mirror?: boolean }) {
  return (
    <Check
      settingKey="passwordManager"
      mirror={mirror}
      label={t('passwords-settings.gestionnaire-de-mots-de-passe')}
      hint={t('passwords-settings.desactive-rien-n-est-charge-dans-les-pages')}
      checked={snapshot.state.settings.passwordManager}
      onChange={(passwordManager) => update({ passwordManager })}
    />
  )
}
;(PasswordManagerRow as DrawsRows).rows = ['passwordManager']

export function PasswordsSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const on = snapshot.state.settings.passwordManager
  return (
    <Group
      title={t('passwords-panel.mots-de-passe')}
      footnote={t('passwords-settings.un-coffre-chiffre-sur-ce-mac-sans-compte-ni')}
      more={t('passwords-settings.un-coffre-chiffre-sur-ce-mac-phrase-de', { phraseMin: PASSWORD_LIMITS.phraseMin, minutes: PASSWORD_LIMITS.autoLockMs / 60000 })}
    >
      <PasswordManagerRow snapshot={snapshot} update={update} />
      {on && <Row label={<span className="muted">{t('passwords-settings.le-coffre-l-import-et-l-export-sont-dans')}</span>} />}
    </Group>
  )
}
