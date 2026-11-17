// Settings › Téléchargements et fichiers › Plus de réglages › « Exporter les données »: the file of the state, plain as before or sealed with a passphrase (AES-256-GCM, key from scrypt: see
// main/export-crypto.ts). The passphrase lives in this component only: it goes to the main process with the request and is wiped as soon as the
// export has answered; it is not logged, stored or shown again. Restoring (Aide › Restaurer les données…) asks for it in a panel.

import { useState, type ReactNode } from 'react'
import { PASSPHRASE_MAX_LENGTH } from '@shared/ipc'
import { api } from './api'
import { Check, MoreText, Row } from './settings-parts'
import { t } from '@shared/i18n'

const MIN = 8

/** `leading`: the button that shares the row with "Exporter les données" (the two stand side by side). */
export function ExportData({ leading }: { leading?: ReactNode } = {}) {
  const [sealed, setSealed] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false })

  const length = [...passphrase.normalize('NFKC')].length
  const problem = !sealed ? null : length < MIN ? t('export-data.la-phrase-secrete-doit-faire-au-moins-min', { MIN }) : passphrase !== again ? t('passwords-panel.les-deux-phrases-ne-sont-pas-identiques') : null

  const run = async () => {
    if (problem) return setStatus({ text: problem, error: true })
    setBusy(true)
    setStatus({ text: sealed ? t('export-data.chiffrement-en-cours') : '', error: false })
    try {
      const reply = await api().exportData(sealed ? { passphrase } : undefined)
      if (reply === null) setStatus({ text: '', error: false })
      else setStatus(reply.ok ? { text: t('export-data.enregistre-dans', { path: reply.path }) + (reply.encrypted ? t('export-data.chiffre-garder-la-phrase') : ''), error: false } : { text: reply.message, error: true })
    } catch (error) {
      console.warn('[export] the export failed:', error)
      setStatus({ text: t('export-data.echec'), error: true })
    } finally {
      // Whatever came of it, the phrase does not stay in the page.
      setPassphrase('')
      setAgain('')
      setBusy(false)
    }
  }

  return (
    <>
      {/* The line of buttons is what a search for « exportData » (shared/settings-synonyms.ts) lands on. */}
      <div className="pref-buttons" data-search="exportData">
        {leading}
        <button className="button" disabled={busy} onClick={() => void run()}>
          {t('ipc.exporter-les-donnees')}
        </button>
      </div>
      <Check
        label={t('export-data.chiffrer-l-exportation-avec-une-phrase-secrete')}
        hint={t('export-data.le-fichier-ne-peut-alors-etre-rouvert')}
        checked={sealed}
        onChange={(value) => {
          setSealed(value)
          setPassphrase('')
          setAgain('')
        }}
      />
      {sealed && (
        <Row label={t('export-data.phrase-secrete')} hint={t('export-data.au-moins-min-caracteres-une-seule-exportation', { min: MIN })} className="lock-form">
          <input className="field" type="password" aria-label={t('export-data.phrase-secrete')} autoComplete="off" spellCheck={false} maxLength={PASSPHRASE_MAX_LENGTH} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          <input className="field" type="password" aria-label={t('export-data.confirmer-la-phrase-secrete')} autoComplete="off" spellCheck={false} maxLength={PASSPHRASE_MAX_LENGTH} value={again} onChange={(e) => setAgain(e.target.value)} />
        </Row>
      )}
      <p className={`pref-note ${status.error ? 'pref-error' : ''}`} role={status.error ? 'alert' : 'status'}>
        {status.text || t('export-data.l-export-garde-vos-espaces-onglets-et')}
      </p>
      {!status.text && (
        <div className="pref-note pref-note-more">
          <MoreText more={t('export-data.l-export-contient-vos-espaces-onglets-dossiers')} />
        </div>
      )}
    </>
  )
}
