// Settings › Vie privée et sécurité › Verrouillage, and its options on the subpage « Options du verrouillage ». A lock of the interface: Lucium (or a space) asks for a phrase, or Touch ID where the Mac has it, before it
// shows tabs. It does not encrypt anything on the disk, and the panel says so. The phrase lives in this component while it is typed and goes to the
// main process, which keeps only a hash of it in a file of its own (never in the state, never in an export).

import { useContext, useState } from 'react'
import { LOCK_PHRASE_MIN, type LockConfig, type LockReply } from '@shared/lock'
import { PRIVATE_IDLE_CHOICES } from '@shared/private-lock'
import { minutesLabel } from '@shared/backup-settings'
import { PASSPHRASE_MAX_LENGTH, type UiSnapshot } from '@shared/ipc'
import { api } from './api'
import { Check, Choice, Group, Row, Subpage, SubpageEntry } from './settings-parts'
import { SubpageContext } from './settings-context'
import { t } from '@shared/i18n'
import { ipcErrorText } from '@shared/ipc-error'

type Mode = 'idle' | 'choose' | 'change' | 'disable'

export function LockSettings({ snapshot }: { snapshot: UiSnapshot }) {
  const { settings, spaces } = snapshot.state
  const lock = snapshot.lock
  const on = settings.lockEnabled && lock?.active === true
  const [mode, setMode] = useState<Mode>('idle')
  const [current, setCurrent] = useState('')
  const [phrase, setPhrase] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const subpage = useContext(SubpageContext)

  const wipe = () => {
    setCurrent('')
    setPhrase('')
    setAgain('')
  }
  const send = async (config: LockConfig, done?: () => void) => {
    setBusy(true)
    try {
      const reply: LockReply = await api().lockConfigure(config)
      if (reply.ok) {
        setMessage('')
        done?.()
      } else setMessage(reply.message)
    } catch (error) {
      // The sentence the main process wrote, without the name of the channel it came through; the whole error is kept for the log.
      console.warn('[lock] the settings of the lock could not be changed:', error)
      setMessage(ipcErrorText(error) || t('errors.erreur-inattendue'))
    } finally {
      setBusy(false)
      wipe()
    }
  }

  const phraseProblem = (): string | null => {
    if ([...phrase.normalize('NFKC')].length < LOCK_PHRASE_MIN) return t('lock-settings.la-phrase-doit-faire-au-moins-lock-phrase-min', { LOCK_PHRASE_MIN })
    return phrase === again ? null : t('lock-settings.les-deux-phrases-ne-sont-pas-identiques')
  }
  const submitPhrase = () => {
    const problem = phraseProblem()
    if (problem) return setMessage(problem)
    void send({ op: 'set-phrase', phrase, ...(mode === 'change' ? { current } : {}) }, () => setMode('idle'))
  }

  const guarded = spaces.filter((space) => lock?.guardedSpaces.includes(space.id))
  const form = (withCurrent: boolean, confirm: string, run: () => void) => (
    <Row label={withCurrent ? t('lock-settings.phrase-actuelle') : t('lock-settings.nouvelle-phrase')} className="lock-form">
      {withCurrent && <input className="field" type="password" aria-label={t('lock-settings.phrase-actuelle')} autoComplete="off" spellCheck={false} maxLength={PASSPHRASE_MAX_LENGTH} value={current} onChange={(e) => setCurrent(e.target.value)} />}
      {mode !== 'disable' && (
        <>
          <input className="field" type="password" aria-label={t('lock-settings.nouvelle-phrase-du-verrou')} placeholder={t('lock-settings.nouvelle-phrase')} autoComplete="off" spellCheck={false} maxLength={PASSPHRASE_MAX_LENGTH} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          <input className="field" type="password" aria-label={t('lock-settings.confirmer-la-phrase-du-verrou')} placeholder={t('lock-settings.confirmer')} autoComplete="off" spellCheck={false} maxLength={PASSPHRASE_MAX_LENGTH} value={again} onChange={(e) => setAgain(e.target.value)} />
        </>
      )}
      <button className="button primary" disabled={busy} onClick={run}>
        {confirm}
      </button>
      <button
        className="button"
        onClick={() => {
          setMode('idle')
          setMessage('')
          wipe()
        }}
      >
        {t('settings.annuler')}
      </button>
    </Row>
  )

  const error = message && (
    <div className="pref-row pref-message pref-error" role="alert">
      {message}
    </div>
  )
  // On the page: the phrase to choose while the lock is off, the row of the subpage of its options once it is on. On the subpage: the options.
  return (
    <>
    <Group
      id="lock"
      title={t('lock-settings.verrouillage')}
      footnote={t('lock-settings.un-verrou-de-l-interface-vos-fichiers-ne')} more={t('lock-settings.c-est-un-verrou-de-l-interface-lucium')}
    >
      {!on && mode !== 'choose' && (
        <Row settingKey="lockEnabled" label={t('lock-settings.demander-une-phrase-ou-touch-id-pour-ouvrir')}>
          <button className="button" onClick={() => setMode('choose')}>
            {t('lock-settings.choisir-une-phrase')}
          </button>
        </Row>
      )}
      {!on && mode === 'choose' && form(false, t('lock-settings.activer'), submitPhrase)}
      {on && <SubpageEntry id="lockoptions" snapshot={snapshot} />}
      {!on && error}
    </Group>
    {on && (
      <Subpage id="lockoptions">
      <Group title={t('lock-settings.verrouillage')} footnote={t('lock-settings.un-verrou-de-l-interface-vos-fichiers-ne')} more={t('lock-settings.c-est-un-verrou-de-l-interface-lucium')}>
          <Check
            settingKey="lockApp"
            label={t('lock-settings.verrouiller-lucium-au-lancement-et-a-la')}
            hint={t('lock-settings.une-fenetre-de-verrouillage-remplace-tout')}
            checked={settings.lockApp}
            disabled={busy}
            onChange={(value) => void send({ op: 'app', value })}
          />
          <Check
            settingKey="lockTouchId"
            label={t('lock-settings.utiliser-touch-id-quand-il-est-disponible')}
            hint={lock?.touchId ? t('lock-settings.la-phrase-reste-le-recours-si-touch-id-echoue') : t('lock-settings.touch-id-n-est-pas-disponible-sur-ce-mac')}
            checked={settings.lockTouchId}
            disabled={busy}
            onChange={(value) => void send({ op: 'touch-id', value })}
          />
          <Row settingKey="lockPrivateIdle" label={t('lock-settings.verrouiller-les-fenetres-privees-apres')} hint={t('lock-settings.une-fenetre-privee-laissee-seule-se-ferme-sur')}>
            <Choice
              label={t('lock-settings.verrouiller-les-fenetres-privees-apres')}
              value={settings.lockPrivateIdle}
              choices={PRIVATE_IDLE_CHOICES.map((minutes): [number, string] => [minutes, minutes === 0 ? t('lock-settings.jamais') : minutesLabel(minutes)])}
              disabled={busy}
              onChange={(minutes) => void send({ op: 'private-idle', minutes })}
            />
          </Row>
          <Row settingKey="lockedSpaces" label={t('lock-settings.espaces-verrouilles')} hint={t('lock-settings.le-menu-d-un-espace-clic-droit-sur-son')}>
            {guarded.length === 0 ? <span className="muted">{t('lock-settings.aucun')}</span> : <span>{guarded.map((space) => space.name).join(', ')}</span>}
          </Row>
          <Row label={t('menu.verrouiller-maintenant')}>
            <button className="button" disabled={busy} onClick={() => void send({ op: 'lock-now' })}>
              {t('lock-settings.verrouiller')}
            </button>
          </Row>
          {mode === 'idle' && (
            <Row label={t('lock-settings.phrase-du-verrou')}>
              <button className="button" onClick={() => setMode('change')}>
                {t('settings.changer')}
              </button>
              <button className="button" onClick={() => setMode('disable')}>
                {t('lock-settings.desactiver-le-verrouillage')}
              </button>
            </Row>
          )}
          {mode === 'change' && form(true, t('lock-settings.changer'), submitPhrase)}
          {/* Once the lock is off its options are gone: the subpage leads back to the page, where the phrase can be chosen again. */}
          {mode === 'disable' && form(true, t('lock-settings.desactiver'), () => void send({ op: 'disable', current }, () => {
            setMode('idle')
            subpage.close()
          }))}
          {error}
      </Group>
      </Subpage>
    )}
    </>
  )
}
