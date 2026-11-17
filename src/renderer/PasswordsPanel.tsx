import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_GENERATOR, GENERATOR_LENGTH, generatorLengthOf } from '@shared/password-generator'
import { PASSWORD_LIMITS, phraseProblem, type PasswordReply, type PasswordRequest, type PasswordsView } from '@shared/passwords'
import { api } from './api'
import './site-data.css'
import './passwords.css'
import { t, tp } from '@shared/i18n'
import { ipcErrorText } from '@shared/ipc-error'
import { fieldError } from './field-error'
import { useCountdown } from './use-countdown'
import { settingsPath } from '@shared/settings-path'

/** Rows drawn at once: the filter is there to find the others. */
const ROWS_SHOWN = 200

/** The sections under the list. Each is a disclosure (a button that shows or hides it): none is open at first, and a second click closes it. */
const SECTIONS = ['add', 'files', 'vault'] as const
type Section = (typeof SECTIONS)[number]
const sectionId = (id: Section): string => `pw-section-${id}`
const sectionLabel = (id: Section): string => (id === 'add' ? t('passwords-panel.ajouter') : id === 'files' ? t('passwords-panel.importer-exporter') : t('passwords-panel.coffre'))

const errorText = ipcErrorText

/** A value of a sentence that `withBold` draws in bold, wherever the language puts it (a host or a username holds no control character). */
const bold = (value: string): string => `\u0000${value}\u0000`
/** A translated sentence with the values marked by `bold` drawn as <strong>. */
const withBold = (text: string): ReactNode[] => text.split('\u0000').map((part, index) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : part))

/**
 * "Mots de passe…": the vault of the password manager (docs/gestionnaire-mots-de-passe.md). What this panel holds is what the main process
 * sends it: hosts, usernames, counts. A password never comes to it; the one it does hold is what the person types into a field (a new
 * login, a phrase), and it is cleared once the request that used it succeeded, and whenever the vault is seen locked (« Verrouiller », the idle
 * time, the Mac's sleep). Filling is a click on "Remplir" in a row.
 */
/** « Afficher » or « Masquer » beside a password being typed. Its text says what a click does, so it carries no pressed state: with one, a screen reader said « Masquer, enfoncé ». No hook: a test calls it as a function. */
export function RevealButton({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="link-button" onClick={onToggle}>
      {shown ? t('passwords-panel.masquer') : t('passwords-panel.afficher')}
    </button>
  )
}

export function PasswordsPanel() {
  const [view, setView] = useState<PasswordsView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [phrase, setPhrase] = useState('')
  const [again, setAgain] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [section, setSection] = useState<Section | null>(null)
  const [draft, setDraft] = useState({ address: '', username: '', password: '' })
  const [reveal, setReveal] = useState(false)
  // The length as it is typed: it is held to its bounds when the field is left or « Générer » pressed (`generatorLengthOf`).
  const [length, setLength] = useState(String(DEFAULT_GENERATOR.length))
  const [exportPhrase, setExportPhrase] = useState('')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [destroyPhrase, setDestroyPhrase] = useState('')
  const [touchPhrase, setTouchPhrase] = useState('')
  // When another phrase may be tried, as a time of this page: the answer gives a delay once, and the seconds left are counted here.
  const [retryAt, setRetryAt] = useState(0)
  const retrySeconds = useCountdown(retryAt)
  const phraseErrorId = useId()
  const live = useRef(true)
  /** Touch ID is asked by itself once per opening of the panel, not at every focus. */
  const triedTouchId = useRef(false)

  useEffect(
    () => () => {
      live.current = false
    },
    []
  )

  const ask = useCallback(async (request: PasswordRequest): Promise<PasswordReply | null> => {
    setBusy(true)
    try {
      const reply = await api().passwords(request)
      if (live.current) {
        setView(reply.view)
        setRetryAt(reply.view.retryInMs > 0 ? Date.now() + reply.view.retryInMs : 0)
        setFailure(null)
        if (reply.message !== undefined) setMessage(reply.message)
      }
      return reply
    } catch (error) {
      console.warn('[passwords] a request failed:', error instanceof Error ? error.name : typeof error)
      if (live.current) setFailure(errorText(error))
      return null
    } finally {
      if (live.current) setBusy(false)
    }
  }, [])

  useEffect(() => {
    void ask({ kind: 'status' }).then((reply) => {
      // A locked vault with Touch ID on: the fingerprint is asked at once, and the phrase field stays there for when it does not succeed.
      const touch = reply?.view.touchId
      if (triedTouchId.current || reply?.view.vault !== 'locked' || !touch?.enabled || !touch.available) return
      triedTouchId.current = true
      void ask({ kind: 'unlock-touch-id' })
    })
    // The vault may have locked itself meanwhile (the idle time, the Mac's sleep): coming back to the window looks again.
    const onFocus = () => void ask({ kind: 'status' })
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [ask])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (view?.entries ?? []).filter((row) => q === '' || row.host.toLowerCase().includes(q) || row.username.toLowerCase().includes(q))
  }, [view, filter])

  const forget = useCallback(() => {
    setPhrase('')
    setAgain('')
    setCurrent('')
    setNext('')
    setExportPhrase('')
    setDestroyPhrase('')
    setTouchPhrase('')
    setDraft((d) => ({ ...d, password: '' }))
    setReveal(false)
  }, [])

  // A vault seen locked keeps nothing of what was typed while it was open (a phrase to change, to export or to delete with, a generated password):
  // the sections that held them are gone from the screen, and their texts would stay in the page for as long as the panel does.
  const vault = view?.vault
  useEffect(() => {
    if (vault === 'locked') forget()
  }, [vault, forget])

  if (failure !== null) {
    return (
      <div className="card sitedata passwords" role="dialog" aria-label={t('passwords-panel.mots-de-passe')}>
        <h2>{t('passwords-panel.mots-de-passe')}</h2>
        <p className="muted warning" role="alert">
          {t('passwords-panel.le-gestionnaire-ne-repond-pas-failure', { failure })}
        </p>
        <div className="row end">
          <button className="button primary" onClick={() => api().closeOverlay()}>
            {t('passwords-panel.fermer')}
          </button>
        </div>
      </div>
    )
  }
  if (view === null) {
    return (
      <div className="card sitedata passwords" role="dialog" aria-label={t('passwords-panel.mots-de-passe')}>
        <h2>{t('passwords-panel.mots-de-passe')}</h2>
        <p className="muted">{t('passwords-panel.lecture')}</p>
      </div>
    )
  }
  if (!view.enabled) {
    return (
      <div className="card sitedata passwords" role="dialog" aria-label={t('passwords-panel.mots-de-passe')}>
        <h2>{t('passwords-panel.mots-de-passe')}</h2>
        <p className="muted">{t('passwords-panel.gestionnaire-desactive', { settingsPath: settingsPath('passwords') })}</p>
        <div className="row end">
          <button className="button primary" autoFocus onClick={() => api().closeOverlay()}>
            {t('passwords-panel.fermer')}
          </button>
        </div>
      </div>
    )
  }

  const unlocked = view.vault === 'unlocked'
  const waiting = retrySeconds > 0
  // Why « Créer le coffre » cannot be pressed: the phrase itself, then the second one once it is typed and differs.
  const phraseHint = phrase !== '' ? (phraseProblem(phrase) ?? (again !== '' && again !== phrase ? t('passwords-panel.les-deux-phrases-ne-sont-pas-identiques') : null)) : null
  const phraseError = fieldError(phraseErrorId, phraseHint !== null)
  const touchReady = view.touchId.enabled && view.touchId.available
  const captured = view.capture ? { username: bold(view.capture.username === '' ? t('passwords-panel.sans-identifiant') : view.capture.username), host: bold(view.capture.host) } : undefined

  const create = async () => {
    if (phrase !== again) return setMessage(t('passwords-panel.les-deux-phrases-ne-sont-pas-identiques'))
    const reply = await ask({ kind: 'create', phrase })
    if (reply?.ok) forget()
  }
  const unlock = async () => {
    const reply = await ask({ kind: 'unlock', phrase })
    if (reply?.ok) forget()
    else setPhrase('')
  }
  const add = async () => {
    const reply = await ask({ kind: 'add', address: draft.address, username: draft.username, password: draft.password })
    if (reply?.ok) {
      setDraft({ address: '', username: '', password: '' })
      setReveal(false)
      setSection(null)
    }
  }
  const generate = async () => {
    const held = generatorLengthOf(length)
    setLength(String(held))
    const reply = await ask({ kind: 'generate', options: { ...DEFAULT_GENERATOR, length: held } })
    if (reply?.password !== undefined) {
      setDraft((d) => ({ ...d, password: reply.password! }))
      setReveal(true)
    }
  }
  const fill = async (id: string) => {
    const reply = await ask({ kind: 'fill', id })
    if (reply?.ok) api().closeOverlay()
  }

  return (
    <div className="card sitedata passwords" role="dialog" aria-label={t('passwords-panel.mots-de-passe')}>
      <h2>{t('passwords-panel.mots-de-passe')}</h2>

      {view.capture && (
        <div className="passwords-capture" role="group" aria-label={t('passwords-panel.identifiant-a-enregistrer')}>
          <p>
            {withBold(view.capture.kind === 'update' ? t('passwords-panel.mettre-a-jour-le-mot-de-passe-de-username-pour-host', captured) : t('passwords-panel.enregistrer-le-mot-de-passe-de-username-pour-host', captured))}
          </p>
          <div className="row end">
            <button className="button" disabled={busy} onClick={() => void ask({ kind: 'capture', op: 'dismiss', offer: view.capture!.offer })}>
              {t('passwords-panel.ignorer')}
            </button>
            <button className="button primary" disabled={busy || !unlocked} title={unlocked ? undefined : t('passwords-panel.deverrouillez-le-coffre-d-abord')} onClick={() => void ask({ kind: 'capture', op: 'confirm', offer: view.capture!.offer })}>
              {view.capture.kind === 'update' ? t('passwords-panel.mettre-a-jour') : t('passwords-panel.enregistrer')}
            </button>
          </div>
          {!unlocked && <p className="muted">{view.vault === 'none' ? t('passwords-panel.creez-le-coffre-ci-dessous-puis-enregistrez') : t('passwords-panel.deverrouillez-le-coffre-ci-dessous-puis')}</p>}
        </div>
      )}

      {view.vault === 'none' && (
        <form
          className="passwords-form"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <p className="muted">{t('passwords-panel.coffre-chiffre-sur-ce-mac')}</p>
          <label className="field-label" htmlFor="pw-phrase">
            {t('passwords-panel.phrase-du-coffre-phrasemin-caracteres-au-moins', { phraseMin: PASSWORD_LIMITS.phraseMin })}
          </label>
          <input id="pw-phrase" className="field" type="password" autoFocus autoComplete="off" spellCheck={false} maxLength={PASSWORD_LIMITS.phraseMax} value={phrase} onChange={(e) => setPhrase(e.target.value)} {...phraseError.field} />
          <label className="field-label" htmlFor="pw-again">
            {t('passwords-panel.la-meme-phrase-encore-une-fois')}
          </label>
          <input id="pw-again" className="field" type="password" autoComplete="off" spellCheck={false} maxLength={PASSWORD_LIMITS.phraseMax} value={again} onChange={(e) => setAgain(e.target.value)} />
          {phraseHint && (
            <p className="muted warning" {...phraseError.message}>
              {phraseHint}
            </p>
          )}
          <div className="row end">
            <button className="button primary" type="submit" aria-describedby={phraseHint ? phraseErrorId : undefined} disabled={busy || phraseProblem(phrase) !== null || phrase !== again}>
              {t('passwords-panel.creer-le-coffre')}
            </button>
          </div>
        </form>
      )}

      {view.vault === 'locked' && (
        <form
          className="passwords-form"
          onSubmit={(e) => {
            e.preventDefault()
            void unlock()
          }}
        >
          <label className="field-label" htmlFor="pw-phrase">
            {t('passwords-panel.phrase-du-coffre')}
          </label>
          <input id="pw-phrase" className="field" type="password" autoFocus autoComplete="off" spellCheck={false} maxLength={PASSWORD_LIMITS.phraseMax} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          {waiting && (
            <p id={phraseErrorId} className="muted warning">
              {t('passwords-panel.trop-d-essais-patientez-seconds-s', { seconds: retrySeconds })}
            </p>
          )}
          <div className="row end">
            {touchReady && (
              <button
                type="button"
                className="button"
                disabled={busy}
                aria-label={t('pwd-touch.bouton-aria')}
                onClick={async () => {
                  const reply = await ask({ kind: 'unlock-touch-id' })
                  if (reply?.ok) forget()
                }}
              >
                {t('pwd-touch.bouton')}
              </button>
            )}
            <button className="button primary" type="submit" aria-describedby={waiting ? phraseErrorId : undefined} disabled={busy || waiting || phrase === ''}>
              {t('passwords-panel.deverrouiller')}
            </button>
          </div>
        </form>
      )}

      {unlocked && (
        <>
          {view.page?.host ? (
            <p className="muted passwords-page">
              {withBold(t('passwords-panel.page-host', { host: bold(view.page.host) }))}
              {' · '}
              {view.page.fillable
                ? view.page.matching.length > 0
                  ? tp('passwords-panel.identifiants-pour-cette-adresse', view.page.matching.length)
                  : t('passwords-panel.aucun-identifiant-pour-cette-adresse-exacte')
                : (view.page.reason ?? t('passwords-panel.rien-ne-peut-etre-rempli-ici'))}
            </p>
          ) : (
            <p className="muted passwords-page">{view.page?.reason ?? t('pwd.aucune-page-a-remplir')}</p>
          )}
          <input className="field passwords-filter" autoFocus spellCheck={false} aria-label={t('passwords-panel.filtrer-les-identifiants')} placeholder={t('passwords-panel.filtrer-les-identifiants-2')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          {rows.length === 0 ? (
            <p className="muted">{view.entries.length === 0 ? t('passwords-panel.le-coffre-est-vide') : t('passwords-panel.aucun-identifiant-ne-correspond')}</p>
          ) : (
            <ul className="passwords-list" aria-label={t('passwords-panel.identifiants')}>
              {rows.slice(0, ROWS_SHOWN).map((row) => {
                const here = view.page?.matching.includes(row.id) === true
                return (
                  <li key={row.id} className={`passwords-row ${here ? 'here' : ''}`}>
                    <div className="passwords-name">
                      <span className="passwords-host" title={row.origin}>
                        {row.host}
                      </span>
                      <span className="muted">{row.username === '' ? t('passwords-panel.sans-identifiant') : row.username}</span>
                    </div>
                    {removing === row.id ? (
                      <>
                        <button type="button" className="link-button" disabled={busy} onClick={() => setRemoving(null)}>
                          {t('passwords-panel.annuler')}
                        </button>
                        <button
                          type="button"
                          className="link-button passwords-danger"
                          disabled={busy}
                          onClick={async () => {
                            await ask({ kind: 'remove', id: row.id })
                            setRemoving(null)
                          }}
                        >
                          {t('passwords-panel.supprimer')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="button" disabled={busy || !here} title={here ? t('passwords-panel.remplir-la-page') : t('passwords-panel.l-adresse-de-la-page-n-est-pas-exactement-celle')} aria-label={t('passwords-panel.remplir-username-sur-host', { username: row.username, host: row.host })} onClick={() => void fill(row.id)}>
                          {t('passwords-panel.remplir')}
                        </button>
                        <button type="button" className="link-button" disabled={busy} aria-label={t('passwords-panel.supprimer-username-sur-host', { username: row.username, host: row.host })} onClick={() => setRemoving(row.id)}>
                          {t('passwords-panel.supprimer')}
                        </button>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {rows.length > ROWS_SHOWN && <p className="muted">{t('passwords-panel.shown-identifiants-sur-count-filtrez', { shown: ROWS_SHOWN, count: rows.length })}</p>}

          {/* Disclosures, not tabs: none is open at first and a second click closes the open one, which a tab list
              cannot do. Each button says whether its section is shown and names it. */}
          <div className="passwords-tabs" role="group" aria-label={t('passwords-panel.actions-du-coffre')}>
            {SECTIONS.map((id) => (
              <button key={id} type="button" aria-expanded={section === id} aria-controls={section === id ? sectionId(id) : undefined} className={`link-button ${section === id ? 'on' : ''}`} onClick={() => setSection(section === id ? null : id)}>
                {sectionLabel(id)}
              </button>
            ))}
          </div>

          {section === 'add' && (
            <form
              id={sectionId('add')}
              aria-label={sectionLabel('add')}
              className="passwords-form"
              onSubmit={(e) => {
                e.preventDefault()
                void add()
              }}
            >
              <input className="field" spellCheck={false} aria-label={t('passwords-panel.adresse-du-site')} placeholder={t('passwords-panel.adresse-du-site-exemple-fr')} value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
              <input className="field" spellCheck={false} autoComplete="off" aria-label={t('passwords-panel.identifiant')} placeholder={t('passwords-panel.identifiant')} value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
              <div className="passwords-secret">
                <input className="field" type={reveal ? 'text' : 'password'} spellCheck={false} autoComplete="new-password" aria-label={t('panels.mot-de-passe')} placeholder={t('panels.mot-de-passe')} value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
                <RevealButton shown={reveal} onToggle={() => setReveal(!reveal)} />
              </div>
              <div className="passwords-generator">
                <label className="muted" htmlFor="pw-length">
                  {t('passwords-panel.longueur')}
                </label>
                <input id="pw-length" className="field" type="number" min={GENERATOR_LENGTH.min} max={GENERATOR_LENGTH.max} value={length} onChange={(e) => setLength(e.target.value)} onBlur={() => setLength(String(generatorLengthOf(length)))} />
                <button type="button" className="button" disabled={busy} onClick={() => void generate()}>
                  {t('passwords-panel.generer')}
                </button>
              </div>
              <div className="row end">
                <button className="button primary" type="submit" disabled={busy || draft.address.trim() === '' || draft.password === ''}>
                  {t('passwords-panel.enregistrer')}
                </button>
              </div>
            </form>
          )}

          {section === 'files' && (
            <div id={sectionId('files')} role="region" aria-label={sectionLabel('files')} className="passwords-form">
              <p className="muted">{t('passwords-panel.un-csv-d-export-d-un-navigateur-de')}</p>
              <div className="row">
                <button className="button" disabled={busy} onClick={() => void ask({ kind: 'import-csv' })}>
                  {t('passwords-panel.importer-un-csv')}
                </button>
              </div>
              <label className="field-label" htmlFor="pw-export">
                {t('passwords-panel.phrase-de-l-export-phrasemin-caracteres-au-moins', { phraseMin: PASSWORD_LIMITS.phraseMin })}
              </label>
              <input id="pw-export" className="field" type="password" autoComplete="off" spellCheck={false} maxLength={PASSWORD_LIMITS.phraseMax} value={exportPhrase} onChange={(e) => setExportPhrase(e.target.value)} />
              <div className="row">
                <button
                  className="button"
                  disabled={busy || phraseProblem(exportPhrase) !== null}
                  onClick={async () => {
                    const reply = await ask({ kind: 'export', phrase: exportPhrase })
                    if (reply?.ok) setExportPhrase('')
                  }}
                >
                  {t('passwords-panel.exporter-chiffre')}
                </button>
                <button
                  className="button"
                  disabled={busy || exportPhrase === ''}
                  onClick={async () => {
                    const reply = await ask({ kind: 'import-export', phrase: exportPhrase })
                    if (reply?.ok) setExportPhrase('')
                  }}
                >
                  {t('passwords-panel.importer-un-export-chiffre')}
                </button>
              </div>
            </div>
          )}

          {section === 'vault' && (
            <div id={sectionId('vault')} role="region" aria-label={sectionLabel('vault')} className="passwords-form">
              <p className="muted">{t('passwords-panel.le-coffre-se-verrouille-tout-seul-apres-minutes', { minutes: PASSWORD_LIMITS.autoLockMs / 60000 })}</p>
              <div className="row">
                <button className="button" disabled={busy} onClick={() => void ask({ kind: 'lock' })}>
                  {t('passwords-panel.verrouiller-maintenant')}
                </button>
              </div>
              {view.touchId.enabled ? (
                <>
                  <p className="field-label">{t('pwd-touch.titre')}</p>
                  <p className="muted">{t('pwd-touch.explication-active')}</p>
                  <div className="row">
                    <button className="button" disabled={busy} onClick={() => void ask({ kind: 'touch-id-off' })}>
                      {t('pwd-touch.desactiver')}
                    </button>
                  </div>
                </>
              ) : view.touchId.available ? (
                <>
                  <label className="field-label" htmlFor="pw-touch">
                    {t('pwd-touch.titre')}
                  </label>
                  <p className="muted">{t('pwd-touch.explication-inactive')}</p>
                  <input id="pw-touch" className="field" type="password" autoComplete="off" spellCheck={false} maxLength={PASSWORD_LIMITS.phraseMax} aria-label={t('pwd-touch.phrase-pour-activer')} placeholder={t('pwd-touch.phrase-pour-activer')} value={touchPhrase} onChange={(e) => setTouchPhrase(e.target.value)} />
                  <div className="row">
                    <button
                      className="button"
                      disabled={busy || touchPhrase === ''}
                      onClick={async () => {
                        await ask({ kind: 'touch-id-on', phrase: touchPhrase })
                        setTouchPhrase('')
                      }}
                    >
                      {t('pwd-touch.activer')}
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted">{t(view.touchId.installed ? 'pwd-touch.pas-maintenant-court' : 'pwd-touch.indisponible-court')}</p>
              )}
              <label className="field-label" htmlFor="pw-current">
                {t('passwords-panel.changer-la-phrase')}
              </label>
              <input id="pw-current" className="field" type="password" autoComplete="off" aria-label={t('passwords-panel.phrase-actuelle')} placeholder={t('passwords-panel.phrase-actuelle')} value={current} onChange={(e) => setCurrent(e.target.value)} />
              <input className="field" type="password" autoComplete="off" aria-label={t('passwords-panel.nouvelle-phrase')} placeholder={t('passwords-panel.nouvelle-phrase-phrasemin-caracteres-au-moins', { phraseMin: PASSWORD_LIMITS.phraseMin })} value={next} onChange={(e) => setNext(e.target.value)} />
              <div className="row">
                <button
                  className="button"
                  disabled={busy || current === '' || phraseProblem(next) !== null}
                  onClick={async () => {
                    const reply = await ask({ kind: 'change-phrase', current, next })
                    if (reply?.ok) {
                      setCurrent('')
                      setNext('')
                    }
                  }}
                >
                  {t('passwords-panel.changer-la-phrase')}
                </button>
              </div>
              <label className="field-label" htmlFor="pw-destroy">
                {t('passwords-panel.supprimer-le-coffre-et-tous-ses-identifiants')}
              </label>
              <input id="pw-destroy" className="field" type="password" autoComplete="off" aria-label={t('passwords-panel.phrase-du-coffre-pour-le-supprimer')} placeholder={t('passwords-panel.phrase-du-coffre')} value={destroyPhrase} onChange={(e) => setDestroyPhrase(e.target.value)} />
              <div className="row">
                <button
                  className="button passwords-danger"
                  disabled={busy || destroyPhrase === ''}
                  onClick={async () => {
                    const reply = await ask({ kind: 'destroy', phrase: destroyPhrase })
                    setDestroyPhrase('')
                    if (reply?.ok) setSection(null)
                  }}
                >
                  {t('passwords-panel.supprimer-le-coffre')}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}

      <div className="row end">
        {unlocked && (
          <button className="button" disabled={busy} onClick={() => void ask({ kind: 'lock' })}>
            {t('passwords-panel.verrouiller')}
          </button>
        )}
        <button className="button primary" onClick={() => api().closeOverlay()}>
          {t('passwords-panel.fermer')}
        </button>
      </div>
    </div>
  )
}
