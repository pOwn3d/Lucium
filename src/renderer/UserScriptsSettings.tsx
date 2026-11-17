// « Fonctions en option » › Scripts utilisateur: the scripts the user imported, and the sheet where a script is read before it is added, on the subpage
// « Scripts importés », whose row follows the line of the feature (its switch, FeaturesPage.tsx). A script always arrives switched off; the code is shown
// here, in full, before and after. With the switch off nothing is drawn and nothing is asked of the main process: no list is requested, no file is read.

import { useEffect, useState } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import { USER_SCRIPT_MAX_BYTES, parseUserScript, type UserScriptView } from '@shared/userscript'
import { api } from './api'
import { Group, Row, Subpage, SubpageEntry } from './settings-parts'
import { scriptsSummary } from '@shared/settings-subpages'
import { t } from '@shared/i18n'

interface Draft {
  text: string
  /** The file it came from, when it came from one. */
  fileName?: string
}

// Getters: the texts are looked up when the pane draws, in the language chosen then.
const RUN_AT: Record<UserScriptView['runAt'], string> = {
  get 'document-start'() { return t('user-scripts-settings.des-que-le-document-est-pret') },
  get 'document-end'() { return t('user-scripts-settings.a-la-fin-du-chargement') },
  get 'document-idle'() { return t('user-scripts-settings.une-fois-la-page-chargee') }
}

function Review({ draft, busy, onAdd, onCancel }: { draft: Draft; busy: boolean; onAdd: () => void; onCancel: () => void }) {
  const parsed = parseUserScript(draft.text)
  return (
    <div className="us-review" role="group" aria-label={t('user-scripts-settings.lecture-du-script-avant-de-l-ajouter')}>
      {parsed.ok ? (
        <>
          <div className="us-title">
            {parsed.meta.name}
            {parsed.meta.version && <span className="muted"> · {parsed.meta.version}</span>}
            {draft.fileName && <span className="muted"> · {draft.fileName}</span>}
          </div>
          {parsed.meta.description && <div className="pref-hint">{parsed.meta.description}</div>}
          <div className="pref-hint">{t('user-scripts-settings.s-applique-a-sites', { sites: parsed.meta.matches.join(' · ') })}</div>
          {parsed.meta.excludes.length > 0 && <div className="pref-hint">{t('user-scripts-settings.sauf-sites', { sites: parsed.meta.excludes.join(' · ') })}</div>}
          <div className="pref-hint">{t('user-scripts-settings.s-execute-when', { when: RUN_AT[parsed.meta.runAt] })}</div>
          {parsed.warnings.map((warning) => (
            <div key={warning} className="pref-hint us-warn">
              {warning}
            </div>
          ))}
          <div className="pref-hint">{t('user-scripts-settings.lisez-le-code-il-aura-les-droits-de-la')}</div>
        </>
      ) : (
        <div className="us-error" role="alert">
          {parsed.error}
        </div>
      )}
      <pre className="us-code" tabIndex={0} aria-label={t('user-scripts-settings.code-du-script')}>
        {draft.text}
      </pre>
      <div className="us-buttons">
        <button className="button" onClick={onCancel}>
          {t('settings.annuler')}
        </button>
        <button className="button primary" disabled={!parsed.ok || busy} onClick={onAdd}>
          {t('user-scripts-settings.ajouter-desactive')}
        </button>
      </div>
    </div>
  )
}

/**
 * The scripts imported, read from the main process while the manager is on (nothing is asked while it is off), and the sentence that says a reading
 * failed: what the subpage lists, and what its row counts.
 */
function useScripts(on: boolean) {
  const [scripts, setScripts] = useState<UserScriptView[]>([])
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (!on) return
    let live = true
    void api()
      .userScripts({ kind: 'list' })
      .then((reply) => live && setScripts(reply.scripts))
      .catch((error: unknown) => live && setMessage(t('user-scripts-settings.la-liste-des-scripts-n-a-pas-pu-etre-lue', { reason: String((error as Error)?.message ?? error) })))
    return () => {
      live = false
    }
  }, [on])
  return { scripts, setScripts, message, setMessage }
}

/** What a failure to read or change the scripts says, as a row. */
const Told = ({ message }: { message: string }) =>
  message ? (
    <div className="pref-row" role="status">
      <div className="pref-label">{message}</div>
    </div>
  ) : null

/**
 * The row of the subpage « Scripts importés », under the line of the feature while it is on: how many scripts were imported, and the sentence of a
 * failure to read them.
 */
export function UserScriptsEntry({ snapshot }: { snapshot: UiSnapshot }) {
  const on = snapshot.state.settings.userScripts
  const { scripts, message } = useScripts(on)
  if (!on) return null
  return (
    <>
      <SubpageEntry id="userscripts" snapshot={snapshot} summary={message ? '' : scriptsSummary(scripts.length)} />
      <Told message={message} />
    </>
  )
}

/** The subpage « Scripts importés »: the scripts, each with its switch, its code and « Retirer », and the import of a file or of a pasted script. */
export function UserScriptsSettings({ snapshot }: { snapshot: UiSnapshot }) {
  const { settings } = snapshot.state
  const on = settings.userScripts
  const { scripts, setScripts, message, setMessage } = useScripts(on)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pasting, setPasting] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [shown, setShown] = useState<{ id: string; text: string } | null>(null)
  // The script whose removal awaits its second click: nothing keeps a copy of a script, and one that was pasted exists nowhere else.
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const ask = async (request: Parameters<ReturnType<typeof api>['userScripts']>[0]) => {
    setBusy(true)
    try {
      const reply = await api().userScripts(request)
      setScripts(reply.scripts)
      return reply
    } catch (error) {
      setMessage(t('user-scripts-settings.la-demande-a-echoue-reason', { reason: String((error as Error)?.message ?? error) }))
      return null
    } finally {
      setBusy(false)
    }
  }

  const pick = async () => {
    setMessage('')
    const reply = await ask({ kind: 'pick-file' })
    if (!reply) return
    if (reply.message) setMessage(reply.message)
    if (reply.ok && reply.text !== undefined) {
      setPasteOpen(false)
      setDraft({ text: reply.text, fileName: reply.fileName })
    }
  }

  const add = async () => {
    if (!draft) return
    const reply = await ask({ kind: 'add', text: draft.text })
    if (!reply) return
    setMessage(reply.message ?? '')
    if (reply.ok) {
      setDraft(null)
      setPasting('')
      setPasteOpen(false)
    }
  }

  const view = async (script: UserScriptView) => {
    if (shown?.id === script.id) return setShown(null)
    const reply = await ask({ kind: 'source', id: script.id })
    if (reply?.ok && reply.text !== undefined) setShown({ id: script.id, text: reply.text })
    else if (reply?.message) setMessage(reply.message)
  }

  const change = async (request: Parameters<ReturnType<typeof api>['userScripts']>[0]) => {
    const reply = await ask(request)
    if (reply && !reply.ok && reply.message) setMessage(reply.message)
    else setMessage(reply?.message ?? '')
  }

  if (!on) return null
  return (
    <Subpage id="userscripts">
    <Group title={t('settings.sub-userscripts')} footnote={t('user-scripts-settings.un-script-arrive-desactive-et-n-a-que-les')} more={t('user-scripts-settings.un-script-s-execute-dans-les-pages-qu-il')}>
      {scripts.length === 0 && <Row label={<span className="muted">{t('user-scripts-settings.aucun-script-importe')}</span>} />}
      {scripts.map((script) => (
          <div key={script.id} className="us-script">
            <label className="pref-row pref-check">
              <div className="pref-label">
                <span className="us-title">
                  {script.name}
                  {script.version && <span className="muted"> · {script.version}</span>}
                </span>
                <div className="pref-hint">{script.matches.join(' · ')}</div>
                {script.excludes.length > 0 && <div className="pref-hint">{t('user-scripts-settings.sauf-sites', { sites: script.excludes.join(' · ') })}</div>}
                {script.warnings.map((warning) => (
                  <div key={warning} className="pref-hint us-warn">
                    {warning}
                  </div>
                ))}
                {script.lastError && <div className="pref-hint us-error">{t('user-scripts-settings.derniere-erreur-message', { message: script.lastError.message })}</div>}
              </div>
              <input type="checkbox" role="switch" aria-label={t('user-scripts-settings.activer-le-script-name', { name: script.name })} checked={script.enabled} disabled={busy} onChange={(e) => void change({ kind: 'set-enabled', id: script.id, enabled: e.target.checked })} />
            </label>
            <div className="pref-row us-actions">
              <label className="us-private">
                <input type="checkbox" checked={script.allowPrivate} disabled={busy} onChange={(e) => void change({ kind: 'set-private', id: script.id, allow: e.target.checked })} /> {t('user-scripts-settings.autoriser-dans-les-fenetres-privees')}
              </label>
              <span className="pref-control">
                <button className="link-button" onClick={() => void view(script)}>
                  {shown?.id === script.id ? t('user-scripts-settings.masquer-le-code') : t('user-scripts-settings.voir-le-code')}
                </button>{' '}
                <button
                  className="link-button"
                  data-action="remove"
                  onClick={() => {
                    if (removing !== script.id) return setRemoving(script.id)
                    setRemoving(null)
                    void change({ kind: 'remove', id: script.id })
                  }}
                  onBlur={() => setRemoving((current) => (current === script.id ? null : current))}
                >
                  {removing === script.id ? t('user-scripts-settings.confirmer-le-retrait') : t('settings.retirer')}
                </button>
              </span>
            </div>
            {removing === script.id && (
              <div className="pref-row pref-hint us-warn" role="status" data-role="remove-confirm">
                {t('user-scripts-settings.le-code-sera-efface')}
              </div>
            )}
            {shown?.id === script.id && (
              <pre className="us-code" tabIndex={0} aria-label={t('user-scripts-settings.code-du-script-name', { name: script.name })}>
                {shown.text}
              </pre>
            )}
          </div>
        ))}
      <Row label={t('user-scripts-settings.importer-un-script-user-js')} hint={t('user-scripts-settings.jusqu-a-size-ko-vous-le-lisez-avant-de-l', { size: Math.round(USER_SCRIPT_MAX_BYTES / 1000) })}>
        <button className="button" disabled={busy} onClick={() => void pick()}>
          {t('user-scripts-settings.importer-un-fichier')}
        </button>{' '}
        <button className="button" disabled={busy} onClick={() => setPasteOpen((open) => !open)}>
          {t('user-scripts-settings.coller-un-script')}
        </button>
      </Row>
      {pasteOpen && !draft && (
        <div className="us-review">
          <textarea className="field us-paste" aria-label={t('user-scripts-settings.script-a-coller')} placeholder="// ==UserScript==" value={pasting} maxLength={USER_SCRIPT_MAX_BYTES} spellCheck={false} onChange={(e) => setPasting(e.target.value)} />
          <div className="us-buttons">
            <button className="button primary" disabled={pasting.trim() === ''} onClick={() => setDraft({ text: pasting })}>
              {t('user-scripts-settings.lire-le-script')}
            </button>
          </div>
        </div>
      )}
      {draft && <Review draft={draft} busy={busy} onAdd={() => void add()} onCancel={() => setDraft(null)} />}
      <Told message={message} />
    </Group>
    </Subpage>
  )
}
