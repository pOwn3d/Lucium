// File › Traduire cette page… : translate the text of the page on screen on this computer, put the original back, and manage the models (look up what
// would be downloaded, download it on a click, register files placed by hand). Every action is a request to the main process; this panel holds nothing but
// what it shows. The addresses and the size of a download are on screen before the button that downloads.

import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { formatSize, packFolder, type EngineId, type InstalledPack, type TranslateRequest, type TranslateView } from '@shared/translate-local'
import { OTHER_LANGUAGES, languageName } from '@shared/translate-quick'
import { api, useSnapshot } from './api'
import './translate.css'
import { settingsPath } from '@shared/settings-path'

export { languageName }

/** Languages offered for the page's language when the detector does not know it, besides the ones the models already cover. */
const COMMON = OTHER_LANGUAGES

/** What a pack's engine is, as the list of models says it: the glossary, the machine translation, or the machine translation whose engine is still to download. */
export function engineNote(pack: Pick<InstalledPack, 'engine'>, view: Pick<TranslateView, 'ready'>): string {
  if (pack.engine === 'glossary') return t('translate.engine-glossary')
  return view.ready.includes(pack.engine) ? t('translate.engine-bergamot') : t('translate.engine-bergamot-missing')
}

/** The name of an engine as the panel says which one translates: the system's own translation, Bergamot, the glossary. */
export function engineName(engine: EngineId, view: Pick<TranslateView, 'system'>): string {
  if (engine === 'system') return view.system?.kind === 'macos' ? t('translate.engine-name-system-macos') : engine
  return engine === 'bergamot' ? t('translate.engine-name-bergamot') : t('translate.engine-name-glossary')
}

/** What the panel says of the system's own translation for the pair shown, when it does not translate it: how to install it, or why it cannot. */
export function systemNote(view: Pick<TranslateView, 'system'>): string | null {
  switch (view.system?.status) {
    case 'supported':
      return t('translate.system-not-installed')
    case 'unsupported':
      return t('translate.system-unsupported')
    case 'unavailable':
      return t('translate.system-unavailable')
    default:
      return null
  }
}

/**
 * The pair the panel shows: what the person chose, else the pair the main process proposes for the page (`proposedPair`: never one that goes nowhere), else
 * what was recognised and the language chosen in the settings.
 */
export function shownPair(view: Pick<TranslateView, 'page' | 'proposed' | 'target'> | null, chosenFrom: string, chosenTo: string): { source: string; target: string } {
  return { source: chosenFrom || view?.proposed?.from || view?.page?.detection.language || '', target: chosenTo || view?.proposed?.to || view?.target || '' }
}

/**
 * The sentence under the two languages when the pair needs one: the same language on both sides (the button cannot be pressed: say why), a page whose own
 * `lang` names another language than its text (say where the proposal comes from), a page already in the language chosen in the settings (say why the target
 * is another one). Null when the pair speaks for itself.
 */
export function pairNote(view: Pick<TranslateView, 'page' | 'proposed' | 'target'> | null, source: string, target: string): string | null {
  const detection = view?.page?.detection
  if (source !== '' && source === target) return t('translate.same-language', { language: languageName(source) })
  if (detection?.declared !== undefined && detection.language !== null) return t('translate.declared-hint', { declared: languageName(detection.declared), language: languageName(detection.language) })
  const proposed = view?.proposed
  if (proposed && proposed.to !== view.target && source === proposed.from && target === proposed.to) return t('translate.page-in-target', { language: languageName(proposed.from) })
  return null
}

/** The call to the main process, as every action of the panel makes it; a failure is shown and logged, never swallowed. */
export function useTranslate(): { view: TranslateView | null; busy: boolean; failed: boolean; ask: (request: TranslateRequest) => Promise<void> } {
  const [view, setView] = useState<TranslateView | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const ask = async (request: TranslateRequest): Promise<void> => {
    setBusy(true)
    try {
      const next = await api().translate(request)
      setFailed(next === null)
      if (next) setView(next)
    } catch (error) {
      console.warn('[translate] the request failed:', error)
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return { view, busy, failed, ask }
}

/**
 * The host of an address the panel names (where the index is read, where the files come from). The address comes from an index read on the network:
 * one that is no address is shown as it was given rather than thrown on, which would take the whole layer of panels down with this one.
 */
export function shownHost(address: string | null | undefined): string {
  if (address == null) return ''
  return URL.canParse(address) ? new URL(address).hostname : address
}

/** The sentence of a key around the value of its one variable, for a value drawn as an element of its own (a path in `<code>`): what comes before it, and after. */
function around(sentence: (mark: string) => string): [string, string] {
  const mark = '\u0000'
  const [before = '', after = ''] = sentence(mark).split(mark)
  return [before, after]
}

export function TranslatePanel() {
  // Drawing a snapshot sets the language of the texts below.
  useSnapshot()
  const { view, busy, failed, ask } = useTranslate()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  // The model whose « Supprimer » was clicked once: it is removed at the second click only (tens of megabytes to download again).
  const [removing, setRemoving] = useState<string | null>(null)
  const [beforePath, afterPath] = around((path) => t('translate.folder-path', { path }))
  useEffect(() => {
    void ask({ action: 'refresh' })
    // Once, when the panel opens.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const detected = view?.page?.detection.language ?? ''
  const { source, target } = shownPair(view, from, to)
  const note = pairNote(view, source, target)
  const known = [...new Set([detected, source, ...(view?.packs.flatMap((pack) => [pack.from, pack.to]) ?? []), target, ...COMMON].filter(Boolean))]
  const translated = view?.state === 'translated'
  const route = view?.route
  const pair = route && !route.ok ? route.missing[0] : undefined
  const readOnly = view?.readOnly === true
  const hasGlossary = view?.packs.some((pack) => pack.engine === 'glossary') === true
  const needsBergamot = view?.packs.some((pack) => pack.engine === 'bergamot' && !view.ready.includes('bergamot')) === true
  const system = view ? systemNote(view) : null

  return (
    <div className="card translate-panel" role="dialog" aria-label={t('translate.title')}>
      <h2>{t('translate.title')}</h2>
      {!view && !failed && <p className="muted">{t('translate.working')}</p>}
      {failed && <p className="muted warning" role="alert">{t('translate.unavailable')}</p>}
      {view && !view.page && <p className="muted warning">{t('translate.msg-not-web')}</p>}
      {view?.page && (
        <>
          <label htmlFor="translate-from">{t('translate.page-language')}</label>
          <select id="translate-from" className="field" value={source} onChange={(e) => setFrom(e.target.value)} disabled={busy}>
            {!source && <option value="" />}
            {known.map((code) => (
              <option key={code} value={code}>
                {languageName(code)}
              </option>
            ))}
          </select>
          <p className="muted translate-note">{detected ? t('translate.detected', { language: languageName(detected) }) : t('translate.not-detected')}</p>
          <label htmlFor="translate-to">{t('translate.target')}</label>
          <select id="translate-to" className="field" value={target} onChange={(e) => setTo(e.target.value)} disabled={busy}>
            {known.map((code) => (
              <option key={code} value={code}>
                {languageName(code)}
              </option>
            ))}
          </select>
          {note && <p className="muted translate-note">{note}</p>}
          <div className="row">
            <button
              className="button primary"
              disabled={!source || !target || source === target || (busy && !translated)}
              onClick={() => {
                // The pair stays what it was when the button was pressed: the page's text is in the other language afterwards, and the proposal would follow it.
                setFrom(source)
                setTo(target)
                void ask({ action: 'run', from: source, to: target })
              }}
            >
              {busy ? t('translate.working') : t('translate.translate')}
            </button>
            {(translated || busy) && (
              <button className="button" onClick={() => void ask({ action: 'restore' })}>
                {busy ? t('translate.stop') : t('translate.show-original')}
              </button>
            )}
          </div>
          {view.using.length > 0 && <p className="muted translate-note translate-engine">{t('translate.engine-used', { engines: view.using.map((engine) => engineName(engine, view)).join(' → ') })}</p>}
          {view.using.includes('system') && <p className="muted translate-note">{t('translate.system-usage-note', { settingsPath: settingsPath('translateSystem') })}</p>}
          {system && (
            <div className="translate-step translate-system">
              <p className="muted translate-note">{system}</p>
              {view.system?.status === 'supported' && view.system.settingsLink && (
                <button className="button" disabled={busy} onClick={() => void ask({ action: 'system-settings' })}>
                  {t('translate.system-open-settings')}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <p className="translate-message" role="status">
        {view?.message}
      </p>

      {view && (
        <>
          <h3>{t('translate.models')}</h3>
          {view.system?.kind === 'macos' && <p className="muted translate-note">{t('translate.models-other-engine')}</p>}
          {view.packs.length === 0 && <p className="muted">{t('translate.none-installed')}</p>}
          <ul className="translate-packs">
            {view.packs.map((pack) => (
              <li key={pack.folder}>
                <span>
                  {languageName(pack.from)} → {languageName(pack.to)} · {formatSize(pack.bytes)} · {engineNote(pack, view)} · {pack.verified ? t('translate.verified') : t('translate.not-verified')}
                </span>
                {!readOnly && removing !== pack.folder && (
                  <button className="link-button" data-action="remove" disabled={busy} onClick={() => setRemoving(pack.folder)}>
                    {t('translate.remove')}
                  </button>
                )}
                {!readOnly && removing === pack.folder && (
                  <span className="row tight">
                    <button
                      className="link-button"
                      data-action="remove-confirm"
                      disabled={busy}
                      onClick={() => {
                        setRemoving(null)
                        void ask({ action: 'remove', from: pack.from, to: pack.to, engine: pack.engine })
                      }}
                    >
                      {t('translate.remove-confirm', { from: languageName(pack.from), to: languageName(pack.to) })}
                    </button>
                    {/* « Annuler » is last, where « Supprimer » was: the second click of a double click lands on it. */}
                    <button className="link-button" data-action="remove-cancel" onClick={() => setRemoving(null)}>
                      {t('confirm-box.annuler')}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {hasGlossary && <p className="muted translate-note">{t('translate.glossary-note')}</p>}
          {needsBergamot && <p className="muted translate-note">{t('translate.no-engine-note')}</p>}

          {!readOnly && pair && !view.offer && (
            <div className="translate-step">
              <button className="button" disabled={busy} onClick={() => void ask({ action: 'lookup', from: pair[0], to: pair[1] })}>
                {t('translate.lookup', { from: languageName(pair[0]), to: languageName(pair[1]) })}
              </button>
              <p className="muted translate-note">{t('translate.lookup-hint', { host: shownHost(view.lookupUrl) })}</p>
              <p className="muted translate-note">{t('translate.manual-hint', { name: packFolder(pair[0], pair[1]) })}</p>
              <button className="link-button" disabled={busy} onClick={() => void ask({ action: 'adopt', from: pair[0], to: pair[1] })}>
                {t('translate.adopt', { name: packFolder(pair[0], pair[1]) })}
              </button>
            </div>
          )}

          {!readOnly && view.offer && (
            <div className="translate-step" aria-label={t('translate.offer-title')}>
              <h3>{t('translate.offer-title')}</h3>
              <p className="muted translate-note">{t('translate.offer-from', { host: shownHost(view.offer.files[0]?.url) })}</p>
              <ul className="translate-files">
                {view.offer.files.map((file) => (
                  <li key={file.url} title={file.url}>
                    <code>{file.url}</code> · {formatSize(file.size)}
                    {file.kind === 'engine' && ` · ${t('translate.offer-engine')}`}
                  </li>
                ))}
              </ul>
              <p className="muted translate-note">{t('translate.offer-disk', { size: formatSize(view.offer.diskBytes) })}</p>
              <p className="muted translate-note">{t('translate.download-hint')}</p>
              <button className="button primary" disabled={busy} onClick={() => void ask({ action: 'download', from: view.offer!.from, to: view.offer!.to })}>
                {t('translate.download', { size: formatSize(view.offer.totalBytes) })}
              </button>
            </div>
          )}

          <p className="muted translate-note">
            {beforePath}
            <code>{view.folder.path}</code>
            {afterPath}
          </p>
          {!readOnly && (
            <div className="row tight">
              <button className="button" disabled={busy} onClick={() => void ask({ action: 'folder' })}>
                {t('translate.folder-choose')}
              </button>
              {!view.folder.isDefault && (
                <button className="button" disabled={busy} onClick={() => void ask({ action: 'folder-default' })}>
                  {t('translate.folder-default')}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <p className="muted translate-note">{t('translate.footnote')}</p>
      <div className="row end">
        <button className="button" autoFocus onClick={() => api().closeOverlay()}>
          {t('translate.close')}
        </button>
      </div>
    </div>
  )
}
