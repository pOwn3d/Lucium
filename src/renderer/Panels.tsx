import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { archiveBuckets } from '@shared/archive'
import { FIND_PANEL, PEEK_HEADER_HEIGHT } from '@shared/ipc'
import { commandPress, platformOf } from '@shared/platform'
import { isPeekOpenKey, peekAccent, peekAddress, peekAddressParts, peekOnAccent } from '@shared/peek'
import { REGEX_ERROR_DETAILS, findCounterText } from '@shared/regex-find'
import { pageColorBehind, popoverSurface } from '@shared/command-bar'
import { activeTab } from '@shared/sidebar'
import { spaceGlyph } from '@shared/space-icon'
import { resolveAppearance, themeHue } from '@shared/theme'
import { hostnameOf } from '@shared/url'
import { PERMISSION_ANCHOR, PERMISSION_ARM_MS, allowLabel, appLinkSchemeOf, mayRemember, permissionPhrase } from '@shared/permissions'
import { type ArchiveSource, type DownloadInfo, type PermissionRequest, type Space } from '@shared/model'
import { speedOf, withSpeed } from '@shared/download-speed'
import { canPauseDownload, downloadProgress, downloadStatus, fileExtension, finishedDownloads, offersResume, shownDownload, sortDownloads } from '@shared/downloads-view'
import { api, useSnapshot } from './api'
import { useDownloadSpeeds } from './DownloadStatus'
import { AnchoredBubble, ArchiveGlyph, BellGlyph, CameraGlyph, InfoGlyph, Invite, ListGroup, ListPanel, ListRow, PinGlyph, activeSpaceHue, useSpaceHue, type InviteTone } from './templates'
import { authText, type AuthRequest } from '@shared/http-auth'
import { PROMPT_VALUE_MAX, promptTitle, safeDialogsMessage, type DialogRequest } from '@shared/page-dialog'
import './find-peek.css'
import './find-bar.css'
import './arc-dialog.css'
import './auth-panel.css'
import './prompt-panel.css'
import { COPIED_MS, useTransient } from './transient'
import { useSystemDark } from './system-dark'
import { HostText } from './HostText'
import { PauseGlyph, PlayGlyph } from './media-glyphs'
import { settingsPath } from '@shared/settings-path'
import { zoneKey, type Zone } from '@shared/capture-zone'

/** The icon of a space in plain text, for a line of meta (nothing for a space that is gone). */
const spaceGlyphOf = (space: Space | undefined): string => (space ? spaceGlyph(space) : '')

// ---------- Find in page ----------

const GLYPH = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

/** The find-in-page panel (300 x 32): magnifier, field, "n/m" counter, previous and next, close. */
export function FindBar() {
  const snapshot = useSnapshot()
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  // A search already under way (Edit › Use Selection to Find) is the one shown, unless the user has begun typing another.
  const typed = useRef(false)
  const known = snapshot?.find?.text
  useEffect(() => {
    if (!typed.current && known) setText(known)
  }, [known])

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const find = snapshot?.find
  const searching = text !== ''
  const matches = find?.matches ?? 0
  // The ".*" button exists only when Settings ask for it; the panel otherwise keeps its default layout.
  const regexAvailable = snapshot?.state.settings.findRegex === true
  const [regex, setRegex] = useState(false)
  const regexOn = regexAvailable && regex
  const optionsFor = (more: { next?: boolean; forward?: boolean }) => (regexOn ? { ...more, regex: true } : more)
  const step = (forward: boolean) => api().find(text, optionsFor({ next: true, forward }))
  // The arrows must not take the focus from the field: Return keeps stepping after a click on them.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()

  return (
    <div className="fb-host">
      <div
        className="fb"
        role="search"
        aria-label={t('cmd.rechercher-dans-la-page')}
        style={{ '--fb-shadow': `${FIND_PANEL.shadow}px`, width: FIND_PANEL.width, height: FIND_PANEL.height } as React.CSSProperties}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            api().closeOverlay()
          }
        }}
      >
        <span className="fb-icon">
          <svg viewBox="0 0 16 16" width="13" height="13" {...GLYPH}>
            <circle cx="7" cy="7" r="5" />
            <path d="m11 11 3.500 3.500" />
          </svg>
        </span>
        <input
          ref={input}
          className="fb-input"
          value={text}
          placeholder={t('panels.rechercher-dans-la-page')}
          aria-label={t('cmd.rechercher-dans-la-page')}
          spellCheck={false}
          onChange={(e) => {
            typed.current = true
            setText(e.target.value)
            api().find(e.target.value, optionsFor({}))
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            if (searching) step(!e.shiftKey)
          }}
        />
        {regexAvailable && (
          <button
            className="fb-toggle"
            title={t('panels.expression-reguliere')}
            aria-label={t('panels.expression-reguliere')}
            aria-pressed={regexOn}
            onMouseDown={keepFocus}
            onClick={() => {
              setRegex(!regex)
              if (searching) api().find(text, !regex ? { regex: true } : {})
            }}
          >
            .*
          </button>
        )}
        {searching && (
          <>
            <span className={find?.error ? 'fb-count fb-error' : 'fb-count'} aria-live="polite" title={find?.error ? REGEX_ERROR_DETAILS[find.error] : undefined}>
              {findCounterText(find)}
            </span>
            <button className="fb-btn fb-prev" title={t('panels.occurrence-precedente')} aria-label={t('menu.occurrence-precedente')} disabled={matches === 0} onMouseDown={keepFocus} onClick={() => step(false)}>
              <svg viewBox="0 0 12 12" width="11" height="11" {...GLYPH}>
                <path d="m2.500 7.500 3.500-3.500 3.500 3.500" />
              </svg>
            </button>
            <button className="fb-btn fb-next" title={t('panels.occurrence-suivante')} aria-label={t('menu.occurrence-suivante')} disabled={matches === 0} onMouseDown={keepFocus} onClick={() => step(true)}>
              <svg viewBox="0 0 12 12" width="11" height="11" {...GLYPH}>
                <path d="m2.500 4.500 3.500 3.500 3.500-3.500" />
              </svg>
            </button>
            <span className="fb-sep" />
          </>
        )}
        <button className="fb-btn fb-close" title={t('cmd.fermer-echap')} aria-label={t('panels.fermer-la-recherche')} onClick={() => api().closeOverlay()}>
          <svg viewBox="0 0 12 12" width="10" height="10" {...GLYPH}>
            <path d="m2.500 2.500 7 7m0-7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}

// ---------- Downloads ----------

const ICON_PROPS = { viewBox: '0 0 20 20', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
/** Pause and resume of a download are the play and pause of the media player (media-glyphs.tsx), at the height of these 16 px icons' strokes. */
const DOWNLOAD_GLYPH_HEIGHT = 10

/** A sheet of paper with the file's extension on it. */
function FileIcon({ filename }: { filename: string }) {
  const extension = fileExtension(filename)
  return (
    <span className="dlpop-icon" aria-hidden="true">
      <svg viewBox="0 0 28 34" width="28" height="34" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M5 1.750h12.500L26 10.250V30.500a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3.750a2 2 0 0 1 2-2Z" />
        <path d="M17.500 1.750v6.500a2 2 0 0 0 2 2H26" />
      </svg>
      {extension && <span className="dlpop-ext">{extension}</span>}
    </span>
  )
}

const NO_DOWNLOADS: DownloadInfo[] = []

/** The downloads tray: a popover above the downloads button of the sidebar, one row per file. */
export function DownloadsPanel() {
  const snapshot = useSnapshot()
  const card = useRef<HTMLDivElement>(null)
  const act = api()
  // Escape is heard on the window: removing the row that has the focus would otherwise leave it nowhere.
  useEffect(() => {
    card.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && api().closeOverlay()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const downloads = sortDownloads(snapshot?.downloads ?? [])
  const finished = finishedDownloads(downloads)
  // The speed after the size, with the status chip on (off, the list keeps its default rows).
  const speeds = useDownloadSpeeds(snapshot?.downloads ?? NO_DOWNLOADS, snapshot?.state.settings.downloadStatusChip === true)
  // Extra: the buttons that pause and resume exist only with the setting on.
  const buttons = { pause: snapshot?.state.settings.downloadPause === true, resumeRecorded: snapshot?.state.settings.downloadResume === true }
  const pausable = buttons.pause
  // The same dark glass as the site control center, over the page behind.
  const tab = snapshot ? activeTab(snapshot.state) : undefined
  const surface = popoverSurface(pageColorBehind(tab ? (snapshot?.runtime.tabs[tab.id]?.color ?? null) : undefined))
  return (
    <div ref={card} tabIndex={-1} className="dlpop" role="dialog" aria-label={t('sidebar.telechargements')} style={{ '--scc-fill': surface.fill } as React.CSSProperties}>
      <div className="dlpop-head">
        <strong>{t('sidebar.telechargements')}</strong>
        {finished.length > 0 && (
          <button className="link-button" onClick={() => finished.forEach((d) => act.downloadAction(d.id, 'clear'))}>
            {t('panels.tout-effacer')}
          </button>
        )}
      </div>
      {downloads.length === 0 && <p className="dlpop-empty">{t('panels.aucun-telechargement-depuis-le-lancement-de-lucium')}</p>}
      <ul className="dlpop-list">
        {downloads.map((raw) => {
          // Without the settings the popover is the default one: a download is running or it is not (a pause that outlived the setting is lifted by the main process).
          const d = shownDownload(raw, buttons)
          const progress = downloadProgress(d)
          return (
            <li
              key={d.id}
              className={`dlpop-row ${d.state}${d.resumable ? ' resumable' : ''}${d.paused ? ' paused' : ''}`}
              onContextMenu={(e) => {
                e.preventDefault()
                act.showMenu({ kind: 'download', id: d.id })
              }}
            >
              <FileIcon filename={d.filename} />
              <div className="dlpop-main">
                <div className="dlpop-name" title={d.filename}>
                  {d.filename}
                </div>
                <div className="dlpop-status">{withSpeed(downloadStatus(d), speedOf(speeds, d.id))}</div>
                {d.state === 'progressing' && <progress value={progress ?? undefined} max={1} aria-label={t('panels.progression-de-filename', { filename: d.filename })} />}
              </div>
              <div className="dlpop-actions">
                {d.state === 'completed' && (
                  <>
                    <button className="dlpop-button" title={t('panels.afficher-dans-le-finder')} aria-label={t('panels.afficher-dans-le-finder')} onClick={() => act.downloadAction(d.id, 'reveal')}>
                      <svg {...ICON_PROPS}>
                        <circle cx="9" cy="9" r="5" />
                        <path d="m13 13 4 4" />
                      </svg>
                    </button>
                    <button className="dlpop-button" title={t('panels.ouvrir')} aria-label={t('panels.ouvrir')} onClick={() => act.downloadAction(d.id, 'open')}>
                      <svg {...ICON_PROPS}>
                        <path d="M7 13 13 7M8 6h5v5" />
                      </svg>
                    </button>
                  </>
                )}
                {pausable && canPauseDownload(d) && (
                  <button className="dlpop-button" data-action="pause" title={t('ctx.mettre-en-pause')} aria-label={t('ctx.mettre-en-pause')} onClick={() => act.downloadAction(d.id, 'pause')}>
                    <PauseGlyph height={DOWNLOAD_GLYPH_HEIGHT} />
                  </button>
                )}
                {offersResume(d, buttons) && (
                  <button className="dlpop-button" data-action="resume" title={t('ctx.reprendre-le-telechargement')} aria-label={t('ctx.reprendre-le-telechargement')} onClick={() => act.downloadAction(d.id, 'resume')}>
                    <PlayGlyph height={DOWNLOAD_GLYPH_HEIGHT} />
                  </button>
                )}
                <button
                  className="dlpop-button"
                  title={d.state === 'progressing' ? t('ctx.annuler-le-telechargement') : t('ctx.retirer-de-la-liste')}
                  aria-label={d.state === 'progressing' ? t('ctx.annuler-le-telechargement') : t('ctx.retirer-de-la-liste')}
                  onClick={() => act.downloadAction(d.id, d.state === 'progressing' ? 'cancel' : 'clear')}
                >
                  <svg {...ICON_PROPS}>
                    <path d="m6 6 8 8M14 6l-8 8" />
                  </svg>
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---------- Permission prompt ----------

/** The pastille and the second sentence of the bubble for the permissions that have one; every other permission has the plain look. */
/** Stands for the site in the sentence of a permission while it is cut in two around it: no site name holds this character. */
const SITE_MARK = '\u0000'

const PERMISSION_LOOKS: Record<string, { tone: InviteTone; glyph: () => ReactNode; lead?: () => string }> = {
  geolocation: { tone: 'info', glyph: PinGlyph, lead: () => t('permissions.explication-position') },
  media: { tone: 'accent', glyph: CameraGlyph, lead: () => t('permissions.explication-camera-micro') },
  notifications: { tone: 'warn', glyph: BellGlyph, lead: () => t('permissions.explication-notifications') }
}

/**
 * A site asks for a permission: a bubble under the toolbar with an arrow to the address, the page left visible behind it. The site is named in
 * bold, the box "Se souvenir pour ce site" is never ticked for the person (and not offered when the answer cannot be kept), "Refuser" comes first.
 * The prompt does not take the keyboard from the page; once the person clicks in it, Escape refuses.
 */
export function PermissionPrompt({ request }: { request: PermissionRequest }) {
  // An external application is asked about each time, unless the box « Toujours ouvrir les liens de ce type depuis ce site » is ticked: the
  // question then comes under a name that carries the scheme, and the yes is kept for that scheme of that site only.
  // A question from a private tab is never remembered (the main process ignores the box anyway): it is not offered.
  const canRemember = request.ephemeral !== true && mayRemember(request.origin, request.permission)
  const rememberLabel = appLinkSchemeOf(request.permission) !== null ? t('permissions.toujours-ouvrir-les-liens-de-ce-type-depuis-ce-site') : t('permissions.se-souvenir-pour-ce-site')
  const [remember, setRemember] = useState(false)
  const hue = useSpaceHue()
  const act = api()
  const look = PERMISSION_LOOKS[request.permission] ?? { tone: 'accent' as const, glyph: InfoGlyph }
  // « Autoriser » answers once this very question has been on screen for PERMISSION_ARM_MS: a click that lands on it as it is drawn is not an answer.
  // The wait is counted for each question (a second one that takes the place of the first starts its own).
  const [armedFor, setArmedFor] = useState<string | null>(null)
  const armed = armedFor === request.id
  useEffect(() => {
    const timer = setTimeout(() => setArmedFor(request.id), PERMISSION_ARM_MS)
    return () => clearTimeout(timer)
  }, [request.id])
  const answer = (allow: boolean) => {
    if (allow && !armed) return
    act.answerPermission(request.id, allow, canRemember && remember)
  }
  // One whole sentence from the catalogue, so that a language puts the site where its grammar wants it; the site alone is drawn in bold.
  const site = request.origin.replace(/^https?:\/\//, '')
  const [before, after = ''] = t('permissions.site-souhaite', { site: SITE_MARK, what: permissionPhrase(request.permission, request.detail) }).split(SITE_MARK)
  return (
    <AnchoredBubble anchor={PERMISSION_ANCHOR} side="bottom" align="center">
      <Invite
        scrim={false}
        className="iv-bubble"
        tone={look.tone}
        glyph={look.glyph()}
        hue={hue}
        title={
          <>
            {before}
            <strong>{site}</strong>
            {after}
          </>
        }
        lead={look.lead?.()}
        remember={canRemember ? { label: rememberLabel, checked: remember, onChange: setRemember } : undefined}
        dismiss={{ label: t('permissions.refuser'), onClick: () => answer(false) }}
        accept={{ label: allowLabel(canRemember, remember), onClick: () => answer(true), disabled: !armed }}
      />
    </AnchoredBubble>
  )
}

// ---------- Sign-in (HTTP authentication) ----------

const KEY_ICON = (
  <svg viewBox="0 0 34 34" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="22" r="6" />
    <path d="m16.500 17.500 11-11M23 11l3.500 3.500M26 8l3 3" />
  </svg>
)

/**
 * A server (401) or a proxy (407) asks for a login. The standard box with two fields: Escape or "Annuler" refuses the request,
 * Return or "Se connecter" answers it. What is typed lives in this component and goes to the engine through `answerAuth`:
 * nothing is kept, logged or stored.
 */
export function AuthPrompt({ request }: { request: AuthRequest }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const act = api()
  const text = authText(request)
  const cancel = () => act.answerAuth(request.id, null)

  // Escape belongs to the box while it is open, wherever the focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      act.answerAuth(request.id, null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [act, request.id])

  return (
    <div className="adlg-scrim" onMouseDown={(e) => e.stopPropagation()}>
      <form
        className="adlg adlg-auth"
        role="alertdialog"
        aria-modal="true"
        aria-label={text.title}
        aria-describedby="adlg-auth-message"
        onSubmit={(e) => {
          e.preventDefault()
          act.answerAuth(request.id, { username, password })
        }}
        onKeyDown={(e) => {
          // Return in a field answers, as in the other boxes; on a button it presses that button.
          if (e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'BUTTON') return
          e.preventDefault()
          act.answerAuth(request.id, { username, password })
        }}
      >
        <div className="adlg-icon">{KEY_ICON}</div>
        <h2 className="adlg-title">{text.title}</h2>
        <p className="adlg-message" id="adlg-auth-message">
          {text.message}
        </p>
        <div className="adlg-fields">
          <input className="adlg-field" name="username" aria-label={t('panels.nom-d-utilisateur')} placeholder={t('panels.nom-d-utilisateur')} autoFocus autoComplete="off" spellCheck={false} value={username} maxLength={512} onChange={(e) => setUsername(e.target.value)} />
          <input className="adlg-field" name="password" type="password" aria-label={t('panels.mot-de-passe')} placeholder={t('panels.mot-de-passe')} autoComplete="off" value={password} maxLength={512} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {text.warning && (
          <p className="adlg-warning" role="note">
            {text.warning}
          </p>
        )}
        <div className="adlg-actions">
          <button type="button" className="adlg-btn adlg-cancel" onClick={cancel}>
            {t('confirm-box.annuler')}
            <kbd>ESC</kbd>
          </button>
          <button type="submit" className="adlg-btn adlg-confirm">
            {t('panels.se-connecter')}
            <kbd>↩</kbd>
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------- Box of a page's prompt() ----------

const BUBBLE_ICON = (
  <svg viewBox="0 0 34 34" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 8.500A2.500 2.500 0 0 1 9.500 6h15A2.500 2.500 0 0 1 27 8.500v11a2.500 2.500 0 0 1-2.500 2.500H15l-5.500 5v-5h0A2.500 2.500 0 0 1 7 19.500z" />
    <path d="M12.500 12h9M12.500 16h5.500" />
  </svg>
)

/**
 * The box of a page's `alert()`, `confirm()` or `prompt()`: who asks (the host, from the address the browser holds, never the page's text), the
 * message as plain text, for `prompt()` a field with the default value, and the answers. Return or "OK" answers (with the value for `prompt()`),
 * Escape or "Annuler" cancels. `alert()` has "OK" alone, which has the focus; Escape closes it too (the page gets nothing back either way).
 * `confirm()` opens with the focus on "OK", as the box of any browser. Once a page keeps asking, a box offers to stop it; ticked, it counts for
 * either answer. What is typed goes to the page and is kept nowhere. Closing the panel gives the keyboard back to the page (browser-overlay.ts).
 */
export function PromptDialog({ request }: { request: DialogRequest }) {
  const withField = request.kind === 'prompt'
  const [value, setValue] = useState(request.defaultValue)
  const [suppress, setSuppress] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const ok = useRef<HTMLButtonElement>(null)
  // The default value is selected the moment the field takes the focus, not after: a key pressed right away replaces it.
  const selected = useRef(false)
  const act = api()
  const answer = (typed: string | null) => act.answerDialog(request.id, { value: typed, suppress: request.offerSuppress && suppress })
  // OK: the text of the field for prompt(); for the two others, any string (only null is a cancel).
  const accept = () => answer(withField ? value : '')

  // As in the box of any browser, typing replaces the default value and an arrow key edits it; without a field, Return presses OK.
  useEffect(() => {
    ;(withField ? field.current : ok.current)?.focus()
  }, [withField])

  // Escape belongs to the box while it is open, wherever the focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      act.answerDialog(request.id, { value: null, suppress: request.offerSuppress && suppress })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [act, request.id, request.offerSuppress, suppress])

  return (
    <div className="adlg-scrim" onMouseDown={(e) => e.stopPropagation()}>
      <form
        className="adlg adlg-prompt"
        data-kind={request.kind}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="adlg-prompt-title"
        aria-describedby={request.message ? 'adlg-prompt-message' : undefined}
        onSubmit={(e) => {
          e.preventDefault()
          accept()
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          // A key held down since before the box opened (the Return that sent a form of the page, say) repeats into it: only a new press answers.
          // Taken from the key itself, the repeat presses no button either (a button is pressed on the character that follows the key).
          if (e.repeat) return e.preventDefault()
          // Return in the field answers; on a button it presses that button. A key that confirms a composition (an accent, a kana) is not an answer.
          if (e.nativeEvent.isComposing || (e.target as HTMLElement).tagName === 'BUTTON') return
          e.preventDefault()
          accept()
        }}
      >
        <div className="adlg-icon">{BUBBLE_ICON}</div>
        <h2 className="adlg-title" id="adlg-prompt-title">
          {promptTitle(request.host, request.kind)}
        </h2>
        {request.message && (
          <p className="adlg-message" id="adlg-prompt-message">
            {request.message}
          </p>
        )}
        {withField && (
          <div className="adlg-fields">
            <input ref={field} className="adlg-field" name="value" type="text" aria-labelledby={request.message ? 'adlg-prompt-message' : 'adlg-prompt-title'} autoFocus autoComplete="off" spellCheck={false} value={value} maxLength={PROMPT_VALUE_MAX} onFocus={(e) => {
                if (selected.current) return
                selected.current = true
                e.currentTarget.select()
              }} onChange={(e) => setValue(e.target.value)} />
          </div>
        )}
        {request.offerSuppress && (
          <label className="adlg-suppress">
            <input type="checkbox" checked={suppress} onChange={(e) => setSuppress(e.target.checked)} />
            {safeDialogsMessage()}
          </label>
        )}
        <div className="adlg-actions">
          {request.kind !== 'alert' && (
            <button type="button" className="adlg-btn adlg-cancel" onClick={() => answer(null)}>
              {t('confirm-box.annuler')}
              <kbd>ESC</kbd>
            </button>
          )}
          <button ref={ok} type="submit" className="adlg-btn adlg-confirm" autoFocus={!withField}>
            {t('page-dialog.ok')}
            <kbd>↩</kbd>
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------- Tweak editor ----------

// The editor lives in BoostEditor.tsx; the overlay host imports it from here with the other panels.
export { BoostEditor } from './BoostEditor'
import { t } from '@shared/i18n'
import { iconSource } from '@shared/site-icon'

// ---------- Glance ----------

type Rect = { x: number; y: number; width: number; height: number }

/** The glyphs of the header's buttons (16 px grid, 1.5 px stroke). */
const PEEK_ICON = {
  back: 'M10 3 5 8l5 5',
  forward: 'm6 3 5 5-5 5',
  reload: 'M13 8a5 5 0 1 1-1.500-3.500M13 2.500v3h-3',
  stop: 'M4 4h8v8H4z',
  link: 'M7 9a3 3 0 0 0 4.200 0l2-2A3 3 0 0 0 9 2.800l-.800.800M9 7a3 3 0 0 0-4.200 0l-2 2A3 3 0 0 0 7 13.200l.800-.800',
  copy: 'M5.500 5.500V3.500a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M3.500 5.500h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z',
  done: 'm3 8.500 3.200 3.200L13 4.800',
  split: 'M3.500 3h9a1.500 1.500 0 0 1 1.500 1.500v7a1.500 1.500 0 0 1-1.500 1.500h-9A1.500 1.500 0 0 1 2 11.500v-7A1.500 1.500 0 0 1 3.500 3ZM8 3v10'
} as const

function PeekIcon({ path, size = 14 }: { path: string; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...GLYPH} strokeWidth={1.5}>
      <path d={path} />
    </svg>
  )
}

/**
 * Glance: the page under the card is dimmed (44 % black, sidebar left alone) and the card has a 40 px header, in the colours of the
 * window's appearance and with an edge of the colour of the space: back, forward and reload (stop while it loads), the page's icon, title and
 * address, then the actions written out: "Ouvrir dans un onglet ⌘↩", "Vue scindée", "Fermer Échap". The previewed page itself is a native view
 * placed right below the header, inside the edge, over this layer.
 */
export function PeekHeader({ rect, stage }: { rect: Rect; stage?: Rect }) {
  const snapshot = useSnapshot()
  const peek = snapshot?.peek
  const platform = platformOf(snapshot?.platform)
  const [copied, showCopied] = useTransient(false, COPIED_MS)
  const systemDark = useSystemDark()
  const act = api()

  // Escape closes the preview wherever the focus is in this layer; ⌘↩ (Ctrl+Enter away from macOS) opens the page in a tab, as the header says.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') api().peekAction('close')
      else if (isPeekOpenKey({ key: e.key, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey, control: e.ctrlKey }, platform)) {
        e.preventDefault()
        api().peekAction('open-in-tab')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [platform])

  const address = peek ? peekAddress(peek.url) : ''
  // The site first, drawn so that its registrable domain is never cut, and plain http written out: the header is where one reads whose page this is.
  const site = peekAddressParts(peek?.url ?? '')
  // The main process writes the clipboard: it removes the tracking parameters when the setting asks for it, as for every other copied address.
  const copy = () => {
    if (!peek) return
    act.peekAction('copy-address')
    showCopied(true)
  }
  // The scrim covers the page card; without it (an older request) the whole window is dimmed.
  const scrim: React.CSSProperties = stage ? { left: stage.x, top: stage.y, width: stage.width, height: stage.height } : { inset: 0, borderRadius: 0 }
  // Back and forward only appear once the engine reports the history of the previewed page.
  const navigable = peek?.canGoBack !== undefined
  // The window's appearance and the hue of the space the preview was opened over: the card follows both.
  const tab = snapshot ? activeTab(snapshot.state) : undefined
  const space = snapshot?.state.spaces.find((s) => s.id === (tab?.spaceId ?? snapshot.state.activeSpaceId))
  const dark = space ? resolveAppearance(space.theme, systemDark) === 'dark' : true
  const hue = space ? themeHue(space.theme) : 222
  const loading = peek?.loading === true
  const title = peek?.title ?? ''
  const stopOrReload = loading ? 'stop' : 'reload'
  const reloadLabel = loading ? t('peek.arreter-le-chargement') : t('sidebar.recharger')

  return (
    <div className="pk-host" onMouseDown={(e) => e.target === e.currentTarget && act.peekAction('close')}>
      <div className="pk-scrim" style={scrim} />
      <div
        className={`pk-card ${dark ? 'dark' : 'light'}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('peek.coup-d-oeil-title', { title: title || address })}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, '--pk-accent': peekAccent(hue, dark), '--pk-on-accent': peekOnAccent(hue, dark), '--pk-hue': hue } as React.CSSProperties}
      >
        <div className="pk-head" style={{ height: PEEK_HEADER_HEIGHT }}>
          {navigable && (
            <div className="pk-nav">
              <button className="pk-nav-btn" title={t('toolbar.precedent')} aria-label={t('toolbar.precedent')} disabled={!peek?.canGoBack} onClick={() => act.peekAction('back')}>
                <PeekIcon path={PEEK_ICON.back} />
              </button>
              <button className="pk-nav-btn" title={t('toolbar.suivant')} aria-label={t('toolbar.suivant')} disabled={!peek?.canGoForward} onClick={() => act.peekAction('forward')}>
                <PeekIcon path={PEEK_ICON.forward} />
              </button>
              <button className="pk-nav-btn" title={reloadLabel} aria-label={reloadLabel} onClick={() => act.peekAction(stopOrReload)}>
                <PeekIcon path={PEEK_ICON[stopOrReload]} />
              </button>
            </div>
          )}
          <div className="pk-id" title={peek?.url}>
            {iconSource(peek?.faviconUrl) ? <img className="pk-fav" src={iconSource(peek?.faviconUrl)} alt="" draggable={false} /> : <span className="pk-fav fallback" aria-hidden="true">{(title || address || '?').charAt(0).toUpperCase()}</span>}
            <span className="pk-txt">
              <span className="pk-ttl">{title}</span>
              <span className="pk-addr">
                {site.insecure && <span className="pk-insecure">{t('toolbar.non-securise')}</span>}
                {site.host !== '' && <HostText host={site.host} className="pk-site" />}
                <span className="pk-rest">{site.rest}</span>
              </span>
            </span>
            <button className="pk-copy" title={copied ? t('panels.adresse-copiee') : t('panels.copier-l-adresse')} aria-label={t('panels.copier-l-adresse')} onClick={copy}>
              <PeekIcon path={copied ? PEEK_ICON.done : PEEK_ICON.copy} />
            </button>
          </div>
          <button className="pk-btn primary" onClick={() => act.peekAction('open-in-tab')}>
            {t('littlearc.ouvrir-dans-un-onglet')}
            <kbd>{commandPress('↩', platform)}</kbd>
          </button>
          <button className="pk-btn split" title={t('ctx.ouvrir-en-vue-scindee')} aria-label={t('ctx.ouvrir-en-vue-scindee')} onClick={() => act.peekAction('open-in-split')}>
            <PeekIcon path={PEEK_ICON.split} />
            <span className="pk-btn-label">{t('peek.vue-scindee')}</span>
          </button>
          <button className="pk-btn quiet" aria-label={t('panels.fermer-l-apercu-echap')} onClick={() => act.peekAction('close')}>
            {t('peek.fermer')}
            <kbd>{t('peek.touche-echap')}</kbd>
          </button>
          <span className={`pk-progress ${loading ? 'on' : ''}`} aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}

// ---------- Archive ----------

const archiveSources = (): Array<[ArchiveSource | 'all', string]> => [['all', t('history-days.tout')], ['auto', t('menu.automatique')], ['manual', t('panels.manuel')], ['little', t('panels.little-source')], ['sync', t('panels.sync-source')]]

/** The archive, on the template of the panels of a list (templates/ListPanel.tsx): a filter, the origin chips, the pages by day, "Fermer". */
export function ArchivePanel() {
  const snapshot = useSnapshot()
  const [filter, setFilter] = useState('')
  const [source, setSource] = useState<ArchiveSource | 'all'>('all')
  const act = api()
  if (!snapshot) return null
  const { archive, spaces, activeSpaceId } = snapshot.state
  const needle = filter.trim().toLowerCase()
  const bySource = source === 'all' ? archive : archive.filter((a) => (a.source ?? 'auto') === source)
  const shown = needle ? bySource.filter((a) => a.title.toLowerCase().includes(needle) || a.url.toLowerCase().includes(needle)) : bySource
  const buckets = archiveBuckets(shown, Date.now())
  const restore = (id: string) => {
    void act.dispatch({ type: 'archive/restore', id })
    act.closeOverlay()
  }

  return (
    <ListPanel
      title={t('menu.archive')}
      icon={<ArchiveGlyph />}
      hue={activeSpaceHue(spaces, activeSpaceId)}
      search={{ value: filter, onChange: setFilter, label: t('panels.filtrer-l-archive'), placeholder: t('panels.filtrer-l-archive'), onSubmit: () => shown[0] && restore(shown[0].id) }}
      filters={archiveSources().map(([id, label]) => (
        <button key={id} type="button" className="tk-chip" aria-pressed={source === id} onClick={() => setSource(id)}>
          {label}
        </button>
      ))}
      doneLabel={t('extpage.fermer')}
      onDone={() => act.closeOverlay()}
    >
      {archive.length === 0 && <p className="tk-status">{t('panels.rien-d-archive', { settingsPath: settingsPath('archive') })}</p>}
      {buckets.map((bucket) => (
        <ListGroup key={bucket.id} title={bucket.label}>
          {bucket.items.map((item) => (
            <ListRow
              key={item.id}
              icon={(hostnameOf(item.url) || '?').charAt(0).toUpperCase()}
              title={item.title}
              meta={`${spaceGlyphOf(spaces.find((sp) => sp.id === item.spaceId))} ${hostnameOf(item.url)}`.trim()}
              hint={item.url}
              onOpen={() => restore(item.id)}
            />
          ))}
        </ListGroup>
      ))}
    </ListPanel>
  )
}

// ---------- Site control center ----------

// The popover lives in SitePanel.tsx; the overlay host imports it from here with the other panels.
export { SitePanel } from './SitePanel'

// ---------- Region capture ----------

/**
 * Full-window crosshair: drag to choose what to capture, Escape to cancel. From the keyboard the arrows show a zone in the middle and move it,
 * Shift and the arrows size it, Return takes it (shared/capture-zone.ts); 2 and 3 take the whole page or what is on screen.
 */
export function RegionCapture() {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [end, setEnd] = useState<{ x: number; y: number } | null>(null)
  const [zone, setZone] = useState<Zone | null>(null)
  const hintId = useId()
  const act = api()
  const dragged =
    start && end
      ? { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
      : null
  const box = dragged ?? zone
  return (
    <div
      className="capture-surface"
      tabIndex={0}
      role="dialog"
      aria-modal="true"
      aria-label={t('panels.zone-a-capturer')}
      aria-describedby={hintId}
      ref={(el) => el?.focus()}
      onKeyDown={(e) => {
        // 1 zone (the default), 2 page entière, 3 fenêtre visible: the bar's modes.
        if (e.key === 'Escape') return act.closeOverlay()
        if (e.key === '2') return act.captureFullPage()
        if (e.key === '3') return act.captureVisible()
        if (e.key === 'Enter') {
          if (zone) act.captureRegion(zone)
          return
        }
        // The first arrow shows the zone where it starts; the next ones move or size it.
        const next = zoneKey(zone, e.key, e.shiftKey, { width: window.innerWidth, height: window.innerHeight })
        if (!next) return
        e.preventDefault()
        setZone(next)
      }}
      onMouseDown={(e) => {
        setZone(null)
        setStart({ x: e.clientX, y: e.clientY })
        setEnd({ x: e.clientX, y: e.clientY })
      }}
      onMouseMove={(e) => start && setEnd({ x: e.clientX, y: e.clientY })}
      onMouseUp={() => (dragged && dragged.width >= 4 && dragged.height >= 4 ? act.captureRegion(dragged) : act.closeOverlay())}
    >
      {!dragged && (
        <div className="capture-hint" onMouseDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()}>
          <span id={hintId}>{t('panels.faites-glisser-pour-choisir-la-zone-a-capturer')}</span>
          <button type="button" className="capture-full" title={t('panels.capturer-toute-la-page-touche-2')} aria-keyshortcuts="2" onClick={() => act.captureFullPage()}>
            {t('panels.page-entiere')}
          </button>
          <button type="button" className="capture-full" title={t('panels.capturer-l-ecran-touche-3')} aria-keyshortcuts="3" onClick={() => act.captureVisible()}>
            {t('panels.fenetre-visible')}
          </button>
        </div>
      )}
      {box && <div className="capture-box" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
    </div>
  )
}
