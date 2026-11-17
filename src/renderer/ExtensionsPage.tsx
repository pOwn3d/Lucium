// The Extensions page (chrome://extensions): the extensions of each profile, and the developer's tools (reload, errors and journal,
// load a folder, pack). A tab (lucium-ui://extensions/, shared/internal-page.ts) with the look of Settings, laid out the way extension pages usually are, so that each thing is where it is expected: the
// menu ☰ on the left, the search and the switch "Mode développeur" on the right, the developer's bar under it, a grid of cards (Détails, Supprimer,
// Erreurs, the switch at the bottom right) and a page "Détails" with its rows. Nothing is decided here: each action is one request to the main
// process (shared/extension-page.ts), which checks it and answers with a sentence; the list itself comes with the snapshots.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ExtensionInfo } from '@shared/ipc'
import type { Settings } from '@shared/model'
import type { JournalEntry } from '@shared/extension-journal'
import { JOURNAL_MAX, journalRuns } from '@shared/extension-journal'
import { takenExtensionShortcuts } from '@shared/keybindings'
import {
  copyToShow,
  dataAccessLine,
  requestBlockingLine,
  extensionRows,
  extensionState,
  filterRows,
  inspectDisabledReason,
  journalOf,
  keptAfterClear,
  legacyManifestLine,
  extensionsPath,
  listedProfiles,
  parseExtensionsLocation,
  profileToShow,
  readDeveloperMode,
  sortRows,
  stateLabel,
  unlistedJournal,
  writeDeveloperMode,
  type ExtensionDetail,
  type ExtensionRow,
  type ExtensionsReply,
  type ExtensionsRequest,
  type ExtensionsTarget
} from '@shared/extension-page'
import { profileLabel } from '@shared/profiles'
import { captureOffLine, captureSwitch } from '@shared/tab-capture'
import { api, useSnapshot } from './api'
import { SearchGlyph } from './templates/glyphs'
import { getLanguage, t, tp } from '@shared/i18n'
import { ipcErrorText } from '@shared/ipc-error'
import { followJournal, journalAtEnd } from './journal-scroll'

const POLL_MS = 1500

interface Notice {
  text: string
  failed: boolean
  /** "Annuler": puts back the folder that was just removed. */
  undo?: boolean
}

const time = (at: number): string => new Date(at).toLocaleTimeString(getLanguage())

/**
 * Moves the page to a view. The address of the tab follows it (`history.pushState`, which reloads nothing and which the tab's Back goes back through), as
 * `chrome://extensions/shortcuts` and `chrome://extensions/?id=<extension>` do in Chrome; the page itself listens to `popstate` for what the address asks.
 */
function navigate(target: ExtensionsTarget): void {
  history.pushState(null, '', extensionsPath(target))
  window.dispatchEvent(new PopStateEvent('popstate'))
}

// ---- small pieces ----

const glyph = (d: string, size = 14) => (
  <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
    <path d={d} />
  </svg>
)
const BackGlyph = () => glyph('M10 3 5 8l5 5')
const ForwardGlyph = () => glyph('m6 3 5 5-5 5', 12)
const MenuGlyph = () => glyph('M2.5 4.5h11M2.5 8h11M2.5 11.5h11', 16)
const ReloadGlyph = () => glyph('M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3')

/** One "Supprimer" for both kinds: a Web Store extension is uninstalled from its profile, a folder is taken out of every profile. */
function removalOf(info: ExtensionInfo): { request: ExtensionsRequest; title: string } {
  return info.source === 'unpacked'
    ? { request: { op: 'remove-folder', extensionId: info.id }, title: t('extpage.sort-l-extension-de-tous-les-profils-le-dossier-n-est-pas-touche') }
    : { request: { op: 'uninstall', profileId: info.profileId, extensionId: info.id }, title: t('extpage.supprime-l-extension-et-ses-donnees-du-profil') }
}

/** The picture of the extension, or its initial when the manifest gives none. */
function Picture({ row }: { row: Pick<ExtensionRow, 'info' | 'detail'> }) {
  return (
    <span className="xp-glyph" aria-hidden="true">
      {row.detail?.icon ? <img src={row.detail.icon} alt="" /> : row.info.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

/** A word on a pastille: the state is written, the colour only repeats it. */
function Chip({ tone, children }: { tone?: 'ok' | 'danger' | 'warn'; children: ReactNode }) {
  return <span className={`xp-chip ${tone ?? ''}`}>{children}</span>
}

/** The name, the version and the state in words, on a card and at the top of "Détails". */
function NameLine({ row, nameId }: { row: ExtensionRow; nameId: string }) {
  return (
    <div className="xp-name">
      <span id={nameId}>{row.info.name}</span>
      <span className="xp-ver">{row.info.version}</span>
      <Chip tone={row.state === 'enabled' ? 'ok' : row.state === 'failed' ? 'danger' : undefined}>{stateLabel(row.state)}</Chip>
      {row.errors > 0 && <Chip tone="danger">{tp('extpage.count-erreurs', row.errors)}</Chip>}
      {row.info.source === 'unpacked' && <Chip>{t('extpage.non-empaquetee')}</Chip>}
    </div>
  )
}

function DeveloperSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const id = useId()
  return (
    <label className="xp-dev" htmlFor={id}>
      {t('extpage.mode-developpeur')}
      <input id={id} type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

/** The ☰ menu: the list, the shortcuts, the Web Store, and (Lucium's own) the settings of the extensions. Closed by Échap or by leaving it. */
function MainMenu({ view, webStore }: { view: ExtensionsTarget['view']; webStore: boolean }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const nav = useRef<HTMLElement>(null)
  useEffect(() => {
    if (open) nav.current?.querySelector('button')?.focus()
  }, [open])
  const go = (run: () => void) => () => {
    setOpen(false)
    run()
  }
  return (
    <div
      className="xp-menu"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault()
          setOpen(false)
          button.current?.focus()
        }
      }}
    >
      <button ref={button} className="tk-btn quiet xp-icon" aria-label={t('extpage.menu-principal')} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <MenuGlyph />
      </button>
      <nav ref={nav} id={id} className="xp-pop" hidden={!open} aria-label={t('extpage.menu-principal')}>
        <button className="xp-item" aria-current={view === 'list' ? 'page' : undefined} onClick={go(() => navigate({ view: 'list' }))}>
          {t('extpage.mes-extensions')}
        </button>
        <button className="xp-item" aria-current={view === 'shortcuts' ? 'page' : undefined} onClick={go(() => navigate({ view: 'shortcuts' }))}>
          {t('extpage.raccourcis-clavier')}
        </button>
        {webStore && (
          <button className="xp-item" onClick={go(() => api().openWebStore())}>
            {t('extension-settings.chrome-web-store')}
          </button>
        )}
        <button className="xp-item" onClick={go(() => api().openOverlay({ panel: 'settings', pane: 'tools', anchor: 'extensions' }))}>
          {t('extpage.reglages-des-extensions-points')}
        </button>
      </nav>
    </div>
  )
}

function Frame({ title, menu, back, tools, children }: { title: string; menu: ReactNode; back?: () => void; tools?: ReactNode; children: ReactNode }) {
  return (
    <div className="xp">
      <header className="xp-titlebar" lang={getLanguage()}>
        {menu}
        {back && (
          <button className="tk-btn quiet xp-back" onClick={back}>
            <BackGlyph />
            {t('extpage.extensions')}
          </button>
        )}
        <h1 className="xp-title">{title}</h1>
        <div className="xp-tools">{tools}</div>
      </header>
      <main className="xp-main" lang={getLanguage()}>
        {children}
      </main>
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string | undefined; children: ReactNode }) {
  return (
    <section className="xp-sec">
      <h2>{title}</h2>
      <div className="xp-block">{children}</div>
      {note && <p className="xp-note">{note}</p>}
    </section>
  )
}

function Line({ label, hint, children }: { label: ReactNode; hint?: ReactNode | undefined; children?: ReactNode }) {
  return (
    <div className="xp-line">
      <div className="xp-line-text">
        <span>{label}</span>
        {hint ? <div className="xp-hint">{hint}</div> : null}
      </div>
      {children ? <div className="xp-line-act">{children}</div> : null}
    </div>
  )
}

export function JournalLines({ entries, names }: { entries: readonly JournalEntry[]; names?: ReadonlyMap<string, string> }) {
  const list = useRef<HTMLUListElement>(null)
  // Whether the list showed its last line before the lines that come: known from the last scroll, since the new lines are already in it when the effect runs.
  const atEnd = useRef(true)
  useEffect(() => {
    if (list.current) followJournal(list.current, atEnd.current)
  }, [entries.length])
  return (
    <ul ref={list} className="xp-journal" aria-label={t('extpage.journal')} onScroll={(e) => void (atEnd.current = journalAtEnd(e.currentTarget))}>
      {journalRuns(entries).map(({ entry, count }) => (
        <li key={entry.id} className={entry.level}>
          <span className="at">{time(entry.at)}</span> {entry.extensionId !== undefined && names?.get(entry.extensionId) ? <strong>{names.get(entry.extensionId)} </strong> : null}
          {entry.message}
          {entry.where ? <span className="where"> ({entry.where})</span> : null}
          {count > 1 ? <span className="times"> {tp('extpage.repetee', count)}</span> : null}
        </li>
      ))}
    </ul>
  )
}

function ClearFoot({ onClear }: { onClear: () => void }) {
  return (
    <div className="xp-errs-foot">
      <button className="tk-btn quiet" onClick={onClear}>
        {t('extpage.effacer')}
      </button>
    </div>
  )
}

/** "Erreurs et journal", folded: the count of lines in the summary, "Effacer" beside it. Open by itself when there is an error. */
function JournalBox({ entries, names, onClear, className }: { entries: readonly JournalEntry[]; names?: ReadonlyMap<string, string>; onClear: () => void; className?: string }) {
  const runs = journalRuns(entries)
  const errors = runs.filter((r) => r.entry.level === 'error').length
  return (
    <details className={`xp-errs ${className ?? ''}`} open={errors > 0}>
      <summary>
        <Chip tone={errors > 0 ? 'danger' : undefined}>{t('extpage.erreurs-et-journal')}</Chip>
        <span>{errors > 0 ? `${tp('extpage.count-erreurs', errors)} · ` : ''}{tp('extpage.count-lignes', runs.length)}</span>
      </summary>
      <JournalLines entries={entries} {...(names ? { names } : {})} />
      <ClearFoot onClear={onClear} />
    </details>
  )
}

interface CardProps {
  row: ExtensionRow
  dev: boolean
  busy: boolean
  own: readonly JournalEntry[]
  act: (request: ExtensionsRequest) => Promise<ExtensionsReply>
  onDetails: () => void
  onClearJournal: () => void
}

/** One card of the grid: who it is, then "Détails", "Supprimer", "Erreurs" and the switch. The id, the service worker, "Erreurs" and the
 *  reload are the developer's (behind "Mode développeur"). */
export function ExtensionCard({ row, dev, busy, own, act, onDetails, onClearJournal }: CardProps) {
  const { info, detail } = row
  const nameId = useId()
  const errorsId = useId()
  // The "Erreurs" button: the journal opens by itself while it holds an error, until the person toggles it.
  const [toggled, setToggled] = useState<boolean | undefined>()
  const facts = detail?.facts ?? null
  const removal = removalOf(info)
  const description = detail?.failure ? <span className="xp-failed">{t('extpage.non-chargee-text', { text: detail.failure })}</span> : facts?.description
  // Said on the card itself, not only under "Détails": the person must not take a content blocker whose rules are skipped for one at work.
  const requestBlocking = requestBlockingLine(facts)
  // The old format is said on the card for the same reason, and outside developer mode too: it is a warning about what the extension does, not a tool.
  const legacy = legacyManifestLine(facts)
  const hasJournal = dev && own.length > 0
  const shown = toggled ?? row.errors > 0
  return (
    <article className={`xp-card ${info.enabled ? '' : 'off'}`} aria-labelledby={nameId}>
      <div className="xp-top">
        <Picture row={row} />
        <div className="xp-who">
          <NameLine row={row} nameId={nameId} />
          {description ? <p className="xp-desc">{description}</p> : null}
          {legacy !== null && <p className="xp-note">{legacy}</p>}
          {requestBlocking !== null && <p className="xp-note">{requestBlocking}</p>}
          {dev && (
            <div className="xp-facts">
              <span>
                <b>{t('extpage.id')}</b> {info.id}
              </span>
              {facts?.hasWorker && (
                <span>
                  <b>{t('extpage.service-worker')}</b> {detail?.workerRunning ? t('extpage.actif') : t('extpage.arrete')}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="xp-acts">
        <button className="tk-btn" aria-describedby={nameId} onClick={onDetails}>
          {t('extpage.details')}
        </button>
        <button className="tk-btn" aria-describedby={nameId} disabled={busy} title={removal.title} onClick={() => void act(removal.request)}>
          {t('extpage.supprimer')}
        </button>
        {hasJournal && (
          <button className="tk-btn" aria-describedby={nameId} aria-expanded={shown} aria-controls={errorsId} onClick={() => setToggled(!shown)}>
            {t('extpage.erreurs')}
          </button>
        )}
        <span className="xp-end">
          {dev && (
            <button className="tk-btn quiet xp-icon" aria-label={t('extpage.recharger')} aria-describedby={nameId} disabled={busy || row.state === 'disabled'} title={t('extpage.decharge-l-extension-et-la-recharge-depuis-son-dossier')} onClick={() => void act({ op: 'reload', profileId: info.profileId, extensionId: info.id })}>
              <ReloadGlyph />
            </button>
          )}
          <input
            type="checkbox"
            role="switch"
            aria-label={t('extpage.activer-name', { name: info.name })}
            checked={info.enabled}
            disabled={busy}
            onChange={(e) => void act({ op: 'set-enabled', profileId: info.profileId, extensionId: info.id, enabled: e.target.checked })}
          />
        </span>
      </div>
      {hasJournal && shown && (
        <div id={errorsId} className="xp-errs">
          <JournalLines entries={own} />
          <ClearFoot onClear={onClearJournal} />
        </div>
      )}
    </article>
  )
}

interface DetailProps {
  row: ExtensionRow
  /** The copies of the extension in every profile, each with its switch. */
  copies: readonly ExtensionInfo[]
  settings: Settings
  dev: boolean
  busy: boolean
  act: (request: ExtensionsRequest) => Promise<ExtensionsReply>
  onCopy: (extensionId: string) => void
  onGone: () => void
}

/** The rows of the page "Détails", in a fixed order; what Lucium does not do (private windows, file:// pages) is said, not offered. */
export function DetailRows({ row, copies, settings, dev, busy, act, onCopy, onGone }: DetailProps) {
  const { info, detail } = row
  const nameId = useId()
  const facts = detail?.facts ?? null
  const removal = removalOf(info)
  const unpacked = info.source === 'unpacked'
  const unavailable = <span className="muted">{t('extpage.non-disponible')}</span>
  // A Manifest V2 folder is loaded, with a word of warning: under its description, where the person reads what the extension is.
  const legacy = legacyManifestLine(facts)
  // The switch of the capture of the sound of a tab (shared/tab-capture.ts): there for an extension that asks for it, off until the person allows it in this profile.
  const capture = captureSwitch(facts, settings.profiles, info.profileId, info.id)
  const captureOff = captureOffLine(settings.extensionTabCapture)
  return (
    <section className="xp-sec">
      <div className="xp-block">
        <div className="xp-line xp-head">
          <Picture row={row} />
          <NameLine row={row} nameId={nameId} />
          <input
            type="checkbox"
            role="switch"
            aria-label={t('extpage.activer-name', { name: info.name })}
            checked={info.enabled}
            disabled={busy}
            onChange={(e) => void act({ op: 'set-enabled', profileId: info.profileId, extensionId: info.id, enabled: e.target.checked })}
          />
        </div>
        <Line
          label={t('extpage.description')}
          hint={
            <>
              {detail?.failure ? <span className="xp-failed">{t('extpage.non-chargee-text', { text: detail.failure })}</span> : facts === null ? t('extpage.le-manifeste-ne-peut-pas-etre-lu') : facts.description || '—'}
              {legacy !== null && <p className="xp-note">{legacy}</p>}
            </>
          }
        />
        <Line label={t('extpage.version')} hint={info.version} />
        {info.update && (
          <Line label={t('extension-settings.version-version-en-attente-elle-demande-de', { version: info.update.version })}>
            <button className="tk-btn" onClick={() => api().extensionUpdates({ profileId: info.profileId, extensionId: info.id })}>
              {t('extpage.examiner-la-mise-a-jour')}
            </button>
          </Line>
        )}
        <Line label={t('extpage.id')} hint={<code className="xp-code">{info.id}</code>}>
          <button className="tk-btn" onClick={() => onCopy(info.id)}>
            {t('extpage.copier')}
          </button>
        </Line>
        {dev && (
          <>
            <Line label={t('extpage.inspecter-les-vues')} hint={inspectDisabledReason()}>
              <button className="tk-btn" aria-disabled="true">
                {t('extpage.inspecter')}
              </button>
            </Line>
            {facts?.hasWorker && (
              <Line label={t('extpage.service-worker')}>
                <span className="muted">{detail?.workerRunning ? t('extpage.actif') : t('extpage.arrete-il-demarre-quand-l-extension-en-a-besoin')}</span>
              </Line>
            )}
            <Line label={t('extpage.recharger')} hint={t('extpage.decharge-l-extension-et-la-recharge-depuis-son-dossier')}>
              <button className="tk-btn" disabled={busy || row.state === 'disabled'} onClick={() => void act({ op: 'reload', profileId: info.profileId, extensionId: info.id })}>
                {t('extpage.recharger')}
              </button>
            </Line>
            {unpacked && (
              <Line label={t('extpage.empaqueter')} hint={t('extpage.fait-un-fichier-crx-et-une-cle-privee-gardee-a-cote')}>
                <button className="tk-btn" disabled={busy} onClick={() => void act({ op: 'pack', extensionId: info.id })}>
                  {t('extpage.empaqueter-points')}
                </button>
              </Line>
            )}
          </>
        )}
        {facts !== null && (
          <>
            <Line
              label={t('extpage.autorisations')}
              hint={
                <>
                  {facts.permissions.length === 0 ? (
                    t('extpage.aucune-autorisation-particuliere')
                  ) : (
                    <ul className="xp-list">
                      {facts.permissions.map((permission) => (
                        <li key={permission.id}>
                          {permission.label} <code className="xp-code">{permission.id}</code> {permission.level !== 'normal' && <Chip tone={permission.level === 'broad' ? 'danger' : 'warn'}>{permission.level === 'broad' ? t('extpage.etendue') : t('extpage.sensible')}</Chip>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {dataAccessLine(facts.dataApis, settings.extensionDataApis) !== null && <p>{dataAccessLine(facts.dataApis, settings.extensionDataApis)}</p>}
                  {facts.optionalCount > 0 && <p>{tp('extpage.count-autorisations-facultatives-accordees-a-la-demande', facts.optionalCount)}</p>}
                  {requestBlockingLine(facts) !== null && <p className="xp-note">{requestBlockingLine(facts)}</p>}
                </>
              }
            />
            {detail?.granted && (
              <Line
                label={t('extpage.autorisations-accordees-a-sa-demande')}
                hint={
                  <ul className="xp-list">
                    {detail.granted.permissions.map((permission) => (
                      <li key={`p:${permission.id}`}>
                        {permission.label} <code className="xp-code">{permission.id}</code> {permission.level !== 'normal' && <Chip tone={permission.level === 'broad' ? 'danger' : 'warn'}>{permission.level === 'broad' ? t('extpage.etendue') : t('extpage.sensible')}</Chip>}{' '}
                        <button className="tk-btn" disabled={busy} aria-label={t('extpage.retirer-l-autorisation-name', { name: permission.id })} onClick={() => void act({ op: 'revoke-granted', profileId: info.profileId, extensionId: info.id, name: permission.id })}>
                          {t('settings.retirer')}
                        </button>
                      </li>
                    ))}
                    {detail.granted.origins.map((origin) => (
                      <li key={`o:${origin}`}>
                        <code className="xp-code">{origin}</code>{' '}
                        <button className="tk-btn" disabled={busy} aria-label={t('extpage.retirer-l-autorisation-name', { name: origin })} onClick={() => void act({ op: 'revoke-granted', profileId: info.profileId, extensionId: info.id, name: origin })}>
                          {t('settings.retirer')}
                        </button>
                      </li>
                    ))}
                  </ul>
                }
              />
            )}
            <Line
              label={t('extpage.acces-au-site')}
              hint={
                <>
                  <span className={facts.sites.scope === 'all' ? 'xp-broad' : undefined}>{facts.sites.line}</span>
                  {facts.sites.patterns.length > 0 && <p className="xp-code">{facts.sites.patterns.join(' · ') + (facts.sites.count > facts.sites.patterns.length ? ` +${facts.sites.count - facts.sites.patterns.length}` : '')}</p>}
                  {facts.warning && <p>{facts.warning}</p>}
                </>
              }
            />
          </>
        )}
        {copies.map((copyOf) => (
          <Line key={copyOf.profileId} label={t('extpage.dans-le-profil-profile', { profile: profileLabel(settings, copyOf.profileId) })}>
            <input
              type="checkbox"
              role="switch"
              aria-label={t('extpage.activer-name-dans-le-profil-profile', { name: copyOf.name, profile: profileLabel(settings, copyOf.profileId) })}
              checked={copyOf.enabled}
              disabled={busy}
              onChange={(e) => void act({ op: 'set-enabled', profileId: copyOf.profileId, extensionId: copyOf.id, enabled: e.target.checked })}
            />
          </Line>
        ))}
        {capture.shown && (
          <Line
            label={t('extpage.peut-capter-le-son-d-un-onglet')}
            hint={
              <>
                {t('extpage.apres-un-clic-sur-son-icone-l-extension-peut-capter-le-son-de-l-onglet')}
                {captureOff !== null && <p className="xp-note">{captureOff}</p>}
              </>
            }
          >
            <input
              type="checkbox"
              role="switch"
              aria-label={t('extpage.autoriser-name-a-capter-le-son-d-un-onglet-dans-le-profil-profile', { name: info.name, profile: profileLabel(settings, info.profileId) })}
              checked={capture.on}
              onChange={(e) => void act({ op: 'set-tab-capture', profileId: info.profileId, extensionId: info.id, allowed: e.target.checked })}
            />
          </Line>
        )}
        {facts?.optionsPage !== undefined && (
          <button className="xp-line xp-row" disabled={busy || !info.enabled} onClick={() => void act({ op: 'open-options', profileId: info.profileId, extensionId: info.id })}>
            {t('extpage.options-de-l-extension')}
            <ForwardGlyph />
          </button>
        )}
        {/* The switches of private windows and file:// pages: Lucium never runs an extension in a private window, nor gives it file:// pages. Said, not offered. */}
        <Line label={t('extpage.autoriser-en-navigation-privee')} hint={t('browser.les-extensions-ne-fonctionnent-pas-dans-une')}>
          {unavailable}
        </Line>
        <Line label={t('extpage.autoriser-l-acces-aux-url-de-fichier')} hint={t('extpage.lucium-ne-donne-pas-aux-extensions-l-acces-aux-fichiers')}>
          {unavailable}
        </Line>
        <Line
          label={t('extpage.source')}
          hint={
            unpacked ? (
              <>
                {t('extpage.extension-non-empaquetee')}
                {detail && <p className="xp-code">{t('extpage.chargee-depuis-path', { path: detail.path })}</p>}
              </>
            ) : (
              t('extension-settings.chrome-web-store')
            )
          }
        />
        <button className="xp-line xp-row danger" disabled={busy} title={removal.title} onClick={() => void act(removal.request).then((reply) => reply.ok && reply.message && onGone())}>
          {t('extpage.supprimer-l-extension')}
          <ForwardGlyph />
        </button>
      </div>
    </section>
  )
}

export function ExtensionsPage() {
  const snapshot = useSnapshot()
  const [target, setTarget] = useState(() => parseExtensionsLocation(location.pathname, location.search))
  const [details, setDetails] = useState<ExtensionDetail[]>([])
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [chosen, setChosen] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [dev, setDev] = useState(() => readDeveloperMode())
  const lastId = useRef(0)

  useEffect(() => {
    const onPlace = () => setTarget(parseExtensionsLocation(location.pathname, location.search))
    window.addEventListener('popstate', onPlace)
    return () => window.removeEventListener('popstate', onPlace)
  }, [])

  // The name of the tab, in the language of the interface (the main process hears it as the title of the page).
  const language = snapshot?.state.settings.language
  const translated = snapshot?.state.settings.interfaceTranslated
  useEffect(() => {
    document.title = t('extpage.extensions')
  }, [language, translated])

  // `again`: the same request already failed the time before and was logged then (the journal is asked for every second and a half).
  const send = useCallback(async (request: ExtensionsRequest, again = false): Promise<ExtensionsReply> => {
    try {
      return await api().extensionsPage(request)
    } catch (error) {
      // The channel itself failed (the window is closing, the application is locked): the person is told, never left with a button that did nothing.
      // The sentence the main process wrote, without the name of the channel it came through; the whole error is kept for the log.
      if (!again) console.warn(`[extensions] the request ${request.op} failed:`, error)
      return { ok: false, message: t('extpage.l-action-a-echoue-message', { message: (ipcErrorText(error) || t('errors.erreur-inattendue')).slice(0, 200) }) }
    }
  }, [])

  const refreshDetails = useCallback(async () => {
    const reply = await send({ op: 'details' })
    if (reply.ok && reply.details) setDetails(reply.details)
    else if (reply.message) setNotice({ text: reply.message, failed: true })
  }, [send])

  // What the list says is in the snapshot; what the manifests say, in the details: read again when an extension comes, goes, is switched, or is granted or loses a permission.
  // The key of a list that has come is never the one of a list still awaited: with no extension at all the details are asked for once all the same.
  const listKey = snapshot ? `listed|${snapshot.extensions.map((e) => `${e.profileId}:${e.id}:${e.version}:${e.enabled}:${e.grantedCount ?? 0}`).join('|')}` : ''
  useEffect(() => {
    if (snapshot) void refreshDetails()
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, refreshDetails])

  // The journal is read while the window is seen, from the last line it holds.
  useEffect(() => {
    let live = true
    // A journal that cannot be read is logged when it stops answering, not at every turn of the clock; and again if it fails after it came back.
    let failing = false
    const poll = async () => {
      if (document.hidden) return
      const reply = await send({ op: 'journal', since: lastId.current }, failing)
      failing = !reply.ok
      if (!live || !reply.ok || !reply.journal) return
      if (reply.lastId !== undefined) lastId.current = reply.lastId
      if (reply.journal.length > 0) setJournal((current) => [...current, ...reply.journal!].slice(-JOURNAL_MAX))
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [send])

  const act = async (request: ExtensionsRequest): Promise<ExtensionsReply> => {
    setBusy(true)
    const reply = await send(request)
    setBusy(false)
    setNotice(reply.message ? { text: reply.message, failed: !reply.ok, ...(reply.undo ? { undo: true } : {}) } : null)
    void refreshDetails()
    return reply
  }

  const clearJournal = async (filter: { extensionId?: string; profileId?: string }) => {
    const reply = await send({ op: 'clear-journal', ...filter })
    if (!reply.ok) return setNotice({ text: reply.message ?? t('extpage.l-action-a-echoue-message', { message: '' }), failed: true })
    setJournal((current) => current.filter((e) => (filter.extensionId !== undefined && e.extensionId !== filter.extensionId) || (filter.profileId !== undefined && e.profileId !== filter.profileId)))
  }

  // "Effacer" at the foot of the list forgets the lines shown there and no other: not the journal of the extensions of the cards, nor that of another profile.
  const clearShown = async (shown: readonly JournalEntry[]) => {
    const ids = shown.map((entry) => entry.id)
    if (ids.length === 0) return
    const reply = await send({ op: 'clear-journal', ids })
    if (!reply.ok) return setNotice({ text: reply.message ?? t('extpage.l-action-a-echoue-message', { message: '' }), failed: true })
    setJournal((current) => keptAfterClear(current, ids))
  }

  // The main process writes the clipboard: `navigator.clipboard` refuses a window that does not have the keyboard focus.
  const copy = async (extensionId: string) => {
    const reply = await send({ op: 'copy-id', extensionId })
    setNotice(reply.message ? { text: reply.message, failed: !reply.ok } : null)
  }

  const toggleDev = (on: boolean) => {
    setDev(on)
    writeDeveloperMode(on)
  }

  const installed = snapshot?.extensions
  const names = useMemo(() => new Map((installed ?? []).map((e) => [e.id, e.name])), [installed])
  const infos = installed ?? []
  if (!snapshot) return null
  const { settings } = snapshot.state
  const addressed = target.view === 'detail' ? copyToShow(infos, target.extensionId, target.profileId) : undefined
  const profile = profileToShow(infos, chosen, addressed?.profileId)
  // The same rule as the menu Extensions, on the extensions that are on in the profile shown: a shortcut that is already taken has no key there.
  const takenShortcuts = takenExtensionShortcuts(
    infos.filter((e) => e.profileId === (addressed?.profileId ?? profile) && e.enabled).flatMap((e) => (e.commands ?? []).map((command) => ({ extensionId: e.id, name: command.name, accelerator: command.accelerator }))),
    settings.keyBindings
  )
  const goBack = () => navigate({ view: 'list' })
  const devSwitch = <DeveloperSwitch on={dev} onChange={toggleDev} />
  const menu = <MainMenu view={target.view} webStore={settings.webStoreInstall} />

  const noticeBar = notice && (
    <div className={`xp-notice ${notice.failed ? 'failed' : ''}`} role={notice.failed ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      {notice.undo && (
        <button className="tk-btn" onClick={() => void act({ op: 'undo-remove' })}>
          {t('extpage.annuler')}
        </button>
      )}
      <button className="tk-btn quiet" onClick={() => setNotice(null)}>
        {t('extpage.fermer')}
      </button>
    </div>
  )

  // ---- one extension: the page "Détails" ----
  if (target.view === 'detail') {
    const info = addressed
    if (!info) {
      return (
        <Frame title={t('extpage.extensions')} menu={menu} back={goBack}>
          {noticeBar}
          <p className="xp-empty-line">{t('extpage.cette-extension-n-est-pas-installee')}</p>
        </Frame>
      )
    }
    const copies = infos.filter((e) => e.id === info.id)
    const detail = details.find((d) => d.profileId === info.profileId && d.id === info.id)
    const own = journalOf(journal, info)
    const runs = journalRuns(own)
    const row: ExtensionRow = { info, ...(detail ? { detail } : {}), state: extensionState(info, detail), errors: runs.filter((r) => r.entry.level === 'error').length, warnings: runs.filter((r) => r.entry.level === 'warning').length }
    return (
      <Frame title={info.name} menu={menu} back={goBack} tools={devSwitch}>
        {noticeBar}
        <DetailRows row={row} copies={copies} settings={settings} dev={dev} busy={busy} act={act} onCopy={(id) => void copy(id)} onGone={goBack} />

        <Section title={t('extpage.raccourcis-clavier')}>
          {(info.commands ?? []).length === 0 && <Line label={<span className="muted">{t('extpage.aucun-raccourci')}</span>} />}
          {(info.commands ?? []).map((command) => (
            <Line key={command.name} label={command.description || command.name} hint={takenShortcuts.has(`${info.id}:${command.name}`) ? t('extpage.raccourci-deja-pris') : command.description ? command.name : undefined}>
              {command.label ? <kbd className="tk-kbd">{command.label}</kbd> : <span className="muted">{t('extpage.non-attribue')}</span>}
            </Line>
          ))}
        </Section>

        <Section title={t('extpage.erreurs')} note={t('extpage.le-journal-se-remplit-tant-que-cette-fenetre-est-ouverte')}>
          {own.length === 0 ? (
            <Line label={<span className="muted">{t('extpage.rien-a-signaler')}</span>} />
          ) : (
            <JournalBox entries={own} onClear={() => void clearJournal({ extensionId: info.id, profileId: info.profileId })} className="flat" />
          )}
        </Section>
      </Frame>
    )
  }

  // ---- every shortcut ----
  if (target.view === 'shortcuts') {
    const withCommands = sortRows(infos.filter((e) => (e.commands ?? []).length > 0 && e.profileId === profile).map((info) => ({ info })))
    return (
      <Frame title={t('extpage.raccourcis-clavier')} menu={menu} back={goBack}>
        {withCommands.length === 0 && <p className="xp-empty-line">{t('extpage.aucun-raccourci')}</p>}
        {withCommands.map(({ info }) => (
          <Section key={info.id} title={info.name}>
            {(info.commands ?? []).map((command) => (
              <Line key={command.name} label={command.description || command.name} hint={takenShortcuts.has(`${info.id}:${command.name}`) ? t('extpage.raccourci-deja-pris') : undefined}>
                {command.label ? <kbd className="tk-kbd">{command.label}</kbd> : <span className="muted">{t('extpage.non-attribue')}</span>}
              </Line>
            ))}
          </Section>
        ))}
      </Frame>
    )
  }

  // ---- the list ----
  const profiles = listedProfiles(infos)
  const allRows: ExtensionRow[] = profile === undefined ? [] : sortRows(extensionRows(infos, details, journal, profile))
  const rows = filterRows(allRows, query)
  const general = profile === undefined ? [] : unlistedJournal(journal, allRows.map((row) => row.info), profile)
  const folders = allRows.filter((row) => row.info.source === 'unpacked')
  const tools = (
    <>
      <div className="tk-search xp-search">
        <SearchGlyph />
        <input
          id="xp-search"
          className="tk-field"
          type="search"
          placeholder={t('extpage.rechercher-dans-les-extensions')}
          aria-label={t('extpage.rechercher-dans-les-extensions')}
          aria-keyshortcuts="Meta+F"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query !== '') {
              e.preventDefault()
              setQuery('')
            }
          }}
        />
      </div>
      {devSwitch}
    </>
  )
  return (
    <Frame title={t('extpage.extensions')} menu={menu} tools={tools}>
      {dev && (
        <div className="xp-devbar">
          <button className="tk-btn" disabled={busy} onClick={() => void act({ op: 'load-unpacked' })}>
            {t('extpage.charger-l-extension-non-empaquetee')}
          </button>
          {/* Packing usually asks for a folder; here the folders are the ones already loaded, so the button lists them. */}
          <details className="xp-pack">
            <summary className="tk-btn">{t('extpage.empaqueter-l-extension')}</summary>
            <div className="xp-pop">
              {folders.length === 0 && <p className="xp-note">{t('extpage.seule-une-extension-chargee-depuis-un-dossier-peut-etre-empaquetee')}</p>}
              {folders.map(({ info }) => (
                <button
                  key={info.id}
                  className="xp-item"
                  disabled={busy}
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open')
                    void act({ op: 'pack', extensionId: info.id })
                  }}
                >
                  {info.name}
                </button>
              ))}
            </div>
          </details>
          <button className="tk-btn" disabled={!settings.webStoreInstall} title={t('extpage.recherche-les-mises-a-jour-du-chrome-web-store')} onClick={() => api().extensionUpdates()}>
            {t('extpage.mettre-a-jour')}
          </button>
        </div>
      )}
      {noticeBar}
      {profiles.length > 1 && profile !== undefined && (
        <div className="xp-bar">
          <select className="xp-profile" aria-label={t('extpage.profil')} value={profile} onChange={(e) => setChosen(e.target.value)}>
            {profiles.map((id) => (
              <option key={id} value={id}>
                {profileLabel(settings, id)} · {tp('extpage.count-extensions', infos.filter((e) => e.profileId === id).length)}
              </option>
            ))}
          </select>
          <p className="xp-note">{t('extpage.les-extensions-sont-propres-a-chaque-profil', { profile: profileLabel(settings, profile) })}</p>
        </div>
      )}

      {rows.length === 0 && (
        <div className="tk-empty" role="status">
          <b>{infos.length === 0 ? t('extension-settings.aucune-extension-installee') : t('extpage.aucune-extension-ne-correspond')}</b>
          {infos.length > 0 && <p>{t('extpage.cherchez-par-nom-ou-effacez-la-recherche-avec-echap')}</p>}
        </div>
      )}
      <div className="xp-grid">
        {rows.map((row) => (
          <ExtensionCard
            key={`${row.info.profileId}:${row.info.id}`}
            row={row}
            dev={dev}
            busy={busy}
            own={journalOf(journal, row.info)}
            act={act}
            onDetails={() => navigate({ view: 'detail', extensionId: row.info.id, profileId: row.info.profileId })}
            onClearJournal={() => void clearJournal({ extensionId: row.info.id, profileId: row.info.profileId })}
          />
        ))}
      </div>

      {general.length > 0 && <JournalBox entries={general} names={names} onClear={() => void clearShown(general)} />}
    </Frame>
  )
}
