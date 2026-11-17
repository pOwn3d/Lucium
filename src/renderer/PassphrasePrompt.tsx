// The passphrase panel: the main process asks for the phrase of an encrypted export being restored. It is an invite (templates/Invite.tsx) with one
// field. Escape or "Annuler" gives up, Return answers. What is typed lives in this component and goes to the main process through
// `answerPassphrase`: it is not kept, logged or stored.

import { useState } from 'react'
import { PASSPHRASE_MAX_LENGTH, type PassphraseRequest } from '@shared/ipc'
import { api } from './api'
import { Invite, LockGlyph, useSpaceHue } from './templates'
import { t } from '@shared/i18n'

export function PassphrasePrompt({ request }: { request: PassphraseRequest }) {
  const [passphrase, setPassphrase] = useState('')
  const hue = useSpaceHue()
  const act = api()
  const answer = (value: string | null) => {
    act.answerPassphrase(request.id, value)
    setPassphrase('')
  }

  return (
    <Invite
      className="passphrase-prompt"
      glyph={<LockGlyph />}
      hue={hue}
      title={request.title}
      lead={request.message}
      banner={request.problem ? { tone: 'warn', text: request.problem, alert: true } : undefined}
      initialFocus="field"
      dismiss={{ label: t('passphrase-prompt.annuler'), kbd: 'ESC', onClick: () => answer(null) }}
      accept={{ label: t('passphrase-prompt.ouvrir'), kbd: '↩', disabled: passphrase === '', onClick: () => passphrase !== '' && answer(passphrase) }}
    >
      <input
        className="tk-field"
        name="passphrase"
        type="password"
        data-autofocus=""
        aria-label={t('passphrase-prompt.phrase-secrete')}
        placeholder={t('passphrase-prompt.phrase-secrete')}
        autoComplete="off"
        spellCheck={false}
        value={passphrase}
        maxLength={PASSPHRASE_MAX_LENGTH}
        onChange={(e) => setPassphrase(e.target.value)}
      />
    </Invite>
  )
}
