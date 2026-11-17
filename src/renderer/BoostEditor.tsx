import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import {
  BOOST_FONTS,
  boostIsModified,
  boostRunsScript,
  draftToInput,
  isNeutralTint,
  nextBoostName,
  nextTextCase,
  nextZoom,
  primaryPoint,
  primaryToTint,
  pushHistory,
  resetBoost,
  ringColors,
  secondaryPoint,
  secondaryToTint,
  shuffleTint,
  sizeColor,
  sizeLabel,
  sliderOf,
  textCaseLabel,
  tintWithSlider,
  type BoostDraft,
  type ScriptPreviewReply,
  type PadPoint,
  type TintKey
} from '@shared/boost'
import type { BoostShareRequest } from '@shared/boost-share'
import { hiddenCharacterLine, unreadableCode } from '@shared/boost-css'
import { unreadableCodeMessage } from '@shared/userscript'
import { siteBoosts } from '@shared/boost-rows'
import { TOOLBAR_HEIGHT } from '@shared/ipc'
import { pageMargin } from '@shared/window-look'
import { clamp01 } from '@shared/clamp'
import { BOOST_JS_MAX, BOOST_ZOOM_MAX, BOOST_ZOOM_MIN, NEUTRAL_TINT, type Boost, type BoostTint } from '@shared/model'
import { api, useSnapshot } from './api'
import { ArcDialog } from './ArcDialog'
import { focusFirstEntry, moveInMenu } from './menu-keys'
import { tabListKeys } from './radio-keys'
import './boosts-editor.css'

/** Waits for the first snapshot: the editor's fields are initialised from the saved Tweak, once. */
export function BoostEditor({ host, id, zap = false }: { host: string; id?: string; zap?: boolean }) {
  const snapshot = useSnapshot()
  if (!snapshot) return null
  const normalized = host.trim().toLowerCase().replace(/^www\./, '')
  const { boosts, settings } = snapshot.state
  const top = pageMargin(settings) + (settings.showToolbar ? TOOLBAR_HEIGHT : 0) + 12
  return <BoostForm normalized={normalized} id={id} existing={boosts.find((b) => b.id === id)} siblings={boosts.filter((b) => b.host === normalized)} others={boosts} top={top} zap={zap} sharing={settings.boostSharing} />
}

const SAMPLE_PRESETS: Array<{ label: string; css: string }> = [
  {
    get label() { return t('boost-editor.mode-sombre') },
    css: 'html { filter: invert(1) hue-rotate(180deg); }\nimg, video, picture, canvas, svg image { filter: invert(1) hue-rotate(180deg); }'
  },
  { get label() { return t('boost-editor.texte-plus-lisible') }, css: 'body, p, li { font-family: system-ui, sans-serif !important; line-height: 1.6 !important; }' },
  { get label() { return t('boost-editor.masquer-les-bannieres-fixes') }, css: '[class*="cookie" i], [id*="cookie" i], [class*="banner" i] { display: none !important; }' }
]

/** The name of the Eraser, on its button and its tab. */
const eraserName = (): string => t('boost-editor.gomme')

const SAVE_DELAY_MS = 250
/** The text on the Size button once it is orange or red: that ground is fixed (`sizeColor`) in both schemes, so its ink is too. */
const SIZE_INK = '#1c1c1e'

const ICON = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

type View = 'main' | 'css' | 'js' | 'zap'

interface BoostFormProps {
  normalized: string
  id: string | undefined
  existing: Boost | undefined
  /** The Tweaks of this very site, for the title menu. */
  siblings: Boost[]
  /** Every Tweak: saving one reloads the pages of the sites whose Tweaks have a script. */
  others: Boost[]
  /** Distance of the panel from the top of the window. */
  top: number
  /** Eraser is on: the page is being picked, this layer is only the panel (see ZAP_PANEL). */
  zap: boolean
  /** The setting "Partage des Retouches" is on: the title menu offers the sharing entries. */
  sharing: boolean
}

function BoostForm({ normalized, id, existing, siblings, others, top, zap, sharing }: BoostFormProps) {
  // A new Tweak gets its id here, so the Eraser can attach elements to it before it is ever saved twice.
  const [boostId] = useState(() => existing?.id ?? id ?? crypto.randomUUID())
  const [draft, setDraftState] = useState<BoostDraft>(() => ({
    name: existing?.name ?? nextBoostName(siblings.map((b) => b.name)),
    enabled: existing?.enabled ?? true,
    css: existing?.css ?? '',
    // The field shows what was being typed when the editor (or the application) was last closed; the pages run `savedJs`.
    js: existing?.jsDraft ?? existing?.js ?? '',
    zoom: existing?.zoom ?? 1,
    zap: existing?.zap ?? [],
    tint: existing?.tint ?? NEUTRAL_TINT,
    ...(existing?.fontFamily ? { fontFamily: existing.fontFamily } : {}),
    ...(existing?.textCase ? { textCase: existing.textCase } : {}),
    ...(existing?.invert ? { invert: true } : {}),
    // A script that came from a file or a link waits, switched off, until the person turns it on in the JS tab.
    ...(existing?.jsEnabled === false ? { jsEnabled: false } : {})
  }))
  // The script the pages run: the last one the person saved. What the field holds beyond it is a draft, stored apart, that no page runs on its own.
  const [savedJs, setSavedJsState] = useState(existing?.js ?? '')
  const savedJsRef = useRef(savedJs)
  const setSavedJs = (js: string) => {
    savedJsRef.current = js
    setSavedJsState(js)
  }
  // What the shell answered to the last preview.
  const [previewNote, setPreviewNote] = useState<ScriptPreviewReply | null>(null)
  const [past, setPast] = useState<BoostDraft[]>([])
  const [view, setView] = useState<View>('main')
  const [advanced, setAdvanced] = useState(false)
  // The card of the fonts keeps its fixed size (four rows); the fonts Lucium adds are further down. A fade says so while there is more below.
  const fontsRef = useRef<HTMLDivElement>(null)
  const [moreFonts, setMoreFonts] = useState(true)
  const syncMoreFonts = () => {
    const card = fontsRef.current
    if (card) setMoreFonts(card.scrollTop + card.clientHeight < card.scrollHeight - 2)
  }
  // The chosen font is in view when the editor opens, wherever it is in the grid.
  useEffect(() => {
    fontsRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' })
    syncMoreFonts()
  }, [])
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // A Tweak of the strip of the site waiting for the answer to "Supprimer ?".
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const act = api()
  const panel = useRef<HTMLDivElement>(null)

  // The newest draft, readable from timers and from the unmount cleanup.
  const latest = useRef(draft)
  const stored = useRef(!!existing)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastEdit = useRef<{ key: string; at: number } | null>(null)

  // The Eraser list as the store has it: the one read when the editor opened, then the one of the last save.
  const savedZap = useRef(draft.zap)
  // A draft was saved: the pages that run the script have not been reloaded yet.
  const reloadOwed = useRef(false)

  // A plain save makes the engine reload every page whose Tweaks hold a script. While one does, what is typed is saved as a draft: it is
  // stored, so that it outlives the window, and the pages are reloaded once, as the editor closes.
  const scripted = (d: BoostDraft) =>
    boostRunsScript({ js: savedJsRef.current, jsEnabled: d.jsEnabled }) || others.some((b) => b.id !== boostId && b.enabled && boostRunsScript(b) && (normalized === b.host || normalized.endsWith(`.${b.host}`) || b.host.endsWith(`.${normalized}`)))

  const persist = (force = false, asDraft = false): Promise<unknown> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!dirty.current && !force && (asDraft || !reloadOwed.current)) return Promise.resolve()
    const current = latest.current
    // A Tweak that has never changed anything is not worth keeping.
    if (!stored.current && !boostIsModified(current) && !force) return Promise.resolve()
    // The Eraser adds its picks to the stored Tweak while this editor is still open: a list this editor has not changed is not sent, or it
    // would put the older one back over them.
    const { zap, ...rest } = current
    const boost = draftToInput(boostId, normalized, stored.current && zap === savedZap.current ? rest : current, savedJsRef.current)
    dirty.current = false
    stored.current = true
    savedZap.current = zap
    reloadOwed.current = asDraft
    return act.dispatch(asDraft ? { type: 'boost/save', boost, draft: true } : { type: 'boost/save', boost })
  }
  const persistRef = useRef(persist)
  persistRef.current = persist

  const schedule = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    timer.current = setTimeout(() => persistRef.current(false, scripted(latest.current)), SAVE_DELAY_MS)
  }

  /** Applies a change. Changes made in a row with the same `key` (a drag, typing) count as one step for Undo. */
  const edit = (change: Partial<BoostDraft> | ((current: BoostDraft) => Partial<BoostDraft>), key?: string) => {
    const before = latest.current
    const after = { ...before, ...(typeof change === 'function' ? change(before) : change) }
    latest.current = after
    setDraftState(after)
    const now = Date.now()
    const last = lastEdit.current
    if (!(key && last && last.key === key && now - last.at < 800)) setPast((p) => pushHistory(p, before))
    lastEdit.current = key ? { key, at: now } : null
    dirty.current = true
    schedule()
  }
  const setTint = (update: (tint: BoostTint) => BoostTint, key: string) => edit((d) => ({ tint: update(d.tint) }), key)

  const undo = () => {
    const previous = past.at(-1)
    if (!previous) return
    setPast(past.slice(0, -1))
    latest.current = previous
    setDraftState(previous)
    lastEdit.current = null
    dirty.current = true
    schedule()
  }

  /** "Enregistrer le script": what the field holds becomes the script the pages run. The only way a typed script gets there. */
  const saveScript = () => {
    setSavedJs(latest.current.js)
    setPreviewNote(null)
    void persist(true)
  }
  /** "Lancer l’aperçu": the draft is stored as it is, then the shell runs it once in the page shown. Nothing is saved by it. */
  const previewScript = async () => {
    try {
      await persist(true, scripted(latest.current))
      setPreviewNote(await act.boostPreview(boostId))
    } catch (error) {
      console.error('[boost] the preview of the script could not be asked for:', error)
      setPreviewNote({ ok: false, message: t('boost-editor.l-apercu-ne-peut-pas-etre-lance-ici') })
    }
  }

  const close = () => {
    void persist()
    act.closeOverlay()
  }

  // What is typed reaches the page as the editor closes, whichever way it closes.
  useEffect(() => {
    panel.current?.focus()
    return () => void persistRef.current()
  }, [])

  const modified = boostIsModified(draft)
  const colorsChanged = !isNeutralTint(draft.tint) || draft.invert === true

  const startZap = () => {
    // The picker looks the Tweak up by its id: it has to exist before the editor gives way to the page.
    void persist(true)
    act.zapStart(normalized, boostId)
  }
  const remove = () => {
    if (timer.current) clearTimeout(timer.current)
    dirty.current = false
    if (stored.current) void act.dispatch({ type: 'boost/delete', id: boostId })
    act.closeOverlay()
  }
  const goTo = (target: string | undefined) => {
    void persist()
    act.openOverlay({ panel: 'boost', host: normalized, id: target })
  }
  // Sharing: the shell shows its own sheets and says in a toast how it went. A Tweak that is sent is saved first, so that the file is what the editor shows;
  // one that was brought in is opened here, where its script, if it has one, waits to be read.
  const share = async (request: BoostShareRequest) => {
    setMenu(false)
    if (request.kind === 'export-file' || request.kind === 'copy-link') void persist(true)
    else void persist()
    try {
      const reply = await act.boostShare(request)
      if (reply.ok && reply.boostId && (request.kind === 'import-file' || request.kind === 'import-link')) goTo(reply.boostId)
    } catch (error) {
      console.error('[boost] sharing failed:', error)
    }
  }

  // The menu of the title, as a menu: its first entry takes the focus when it opens, and the focus goes back to the title (or to what the entry
  // opened: the field of the name, the confirmation) when it closes. Without that the entry that had the focus is gone, and the keys reach no one.
  const menuCard = useRef<HTMLDivElement>(null)
  const titleButton = useRef<HTMLButtonElement>(null)
  // Read when the menu closes, not when it opens: by then the title may have given way to the field of the name.
  const focusBack = useRef((): void => undefined)
  focusBack.current = () => {
    if (!document.activeElement || document.activeElement === document.body) (titleButton.current ?? panel.current)?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!menu) return
    if (menuCard.current) focusFirstEntry(menuCard.current)
    return () => focusBack.current()
  }, [menu])
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    if (menu) setMenu(false)
    else if (advanced) setAdvanced(false)
    else if (renaming) setRenaming(false)
    else if (view !== 'main') setView('main')
    else close()
  }

  const codeView = view !== 'main'
  // A click anywhere else in the panel puts the popovers away; their own buttons stop the event and toggle them.
  const dismissPopovers = () => {
    setMenu(false)
    setAdvanced(false)
  }
  const toggleMenu = () => {
    setMenu((open) => !open)
    setAdvanced(false)
  }
  const toggleAdvanced = () => {
    setAdvanced((open) => !open)
    setMenu(false)
  }

  return (
    <div className={`bx-host ${zap ? 'bx-zapping' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && !confirmDelete && !zap && close()} onKeyDown={onKeyDown}>
      <div ref={panel} tabIndex={-1} className={`bx ${codeView ? 'bx-wide' : ''}`} style={zap ? undefined : ({ top, '--bx-top': `${top}px` } as CSSProperties)} role="dialog" aria-label={t('boost-editor.retouche')} onMouseDown={dismissPopovers}>
        <div className="bx-card">
          <header className="bx-head">
            <button className="bx-done" title={t('settings.termine')} aria-label={t('settings.termine')} onClick={close}>
              <span>
                <svg viewBox="0 0 12 12" width="9" height="9" {...ICON} strokeWidth={2}>
                  <path d="m2.500 2.500 7 7m0-7-7 7" />
                </svg>
              </span>
            </button>
            {renaming ? (
              <input
                className="bx-rename"
                autoFocus
                defaultValue={draft.name}
                aria-label={t('boost-editor.nom-de-la-retouche')}
                maxLength={60}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => {
                  const name = e.currentTarget.value.trim()
                  if (name && name !== draft.name) edit({ name })
                  setRenaming(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  else if (e.key === 'Escape') {
                    e.stopPropagation()
                    setRenaming(false)
                  }
                }}
              />
            ) : (
              <button ref={titleButton} className="bx-title" aria-haspopup="menu" aria-expanded={menu} title={t('boost-editor.menu-de-la-retouche')} onMouseDown={(e) => e.stopPropagation()} onClick={toggleMenu}>
                <span>{draft.name}</span>
                <svg viewBox="0 0 12 12" width="9" height="9" {...ICON} strokeWidth={1.8}>
                  <path d="m2.500 4.500 3.500 3.500 3.500-3.500" />
                </svg>
              </button>
            )}
            <div className="bx-tabs" role="tablist" aria-label={t('boost-editor.onglets-de-l-editeur')} onKeyDown={tabListKeys}>
              <button role="tab" aria-selected={!codeView} tabIndex={codeView ? -1 : 0} className={!codeView ? 'on' : ''} onClick={() => setView('main')}>
                {t('boost-editor.style')}
              </button>
              <button role="tab" aria-selected={codeView} tabIndex={codeView ? 0 : -1} className={codeView ? 'on' : ''} title={t('boost-editor.modifier-le-css-et-le-javascript')} onClick={() => !codeView && setView('css')}>
                {t('boost-editor.code')}
              </button>
            </div>
            <button className="bx-undo" title={t('boost-editor.annuler-la-derniere-modification')} aria-label={t('boost-editor.annuler-la-derniere-modification')} disabled={past.length === 0} onClick={undo}>
              <svg viewBox="0 0 16 16" width="16" height="16" {...ICON}>
                <path d="M3 6.500h6.500a3.500 3.500 0 0 1 0 7H6M3 6.500 5.800 3.700M3 6.500l2.800 2.800" />
              </svg>
            </button>
          </header>

          {codeView ? (
            <CodeView
              view={view}
              draft={draft}
              onView={setView}
              savedJs={savedJs}
              previewNote={previewNote}
              onEdit={(change, key) => {
                setPreviewNote(null)
                edit(change, key)
              }}
              onSaveScript={saveScript}
              onPreview={() => void previewScript()}
              onZap={startZap}
              onDevTools={() => act.openDevTools()}
            />
          ) : (
            <>
              {/* The Tweaks this site already has, in view (they were only in the menu of the title): one click goes to one, its cross deletes it after a question. */}
              {siblings.length > 0 ? (
                <nav className="bx-sites" aria-label={t('boost-editor.retouches-de-ce-site')}>
                  {pendingDelete !== null ? (
                    <>
                      <span className="bx-sites-ask">{t('boost-editor.supprimer-name-question', { name: siblings.find((b) => b.id === pendingDelete)?.name ?? '' })}</span>
                      <button type="button" className="bx-site" autoFocus onClick={() => setPendingDelete(null)}>
                        {t('confirm-box.annuler')}
                      </button>
                      <button
                        type="button"
                        className="bx-site danger"
                        onClick={() => {
                          const gone = pendingDelete
                          setPendingDelete(null)
                          if (gone === boostId) remove()
                          else void act.dispatch({ type: 'boost/delete', id: gone })
                        }}
                      >
                        {t('site-panel.supprimer')}
                      </button>
                    </>
                  ) : (
                    <>
                      {siteBoosts(siblings, boostId, draft.name).map((b) => (
                        <span key={b.id} className={`bx-site-chip ${b.current ? 'current' : ''}`}>
                          <button type="button" className="bx-site" aria-current={b.current ? 'true' : undefined} disabled={b.current} onClick={() => goTo(b.id)}>
                            {b.name}
                          </button>
                          {b.stored && (
                            <button type="button" className="bx-site-x" title={t('site-panel.supprimer-name', { name: b.name })} aria-label={t('site-panel.supprimer-name', { name: b.name })} onClick={() => setPendingDelete(b.id)}>
                              <svg viewBox="0 0 12 12" width="8" height="8" {...ICON} strokeWidth={2}>
                                <path d="m2.500 2.500 7 7m0-7-7 7" />
                              </svg>
                            </button>
                          )}
                        </span>
                      ))}
                      {stored.current && (
                        <button type="button" className="bx-site new" onClick={() => goTo(undefined)}>
                          + {t('boost-editor.nouvelle-retouche')}
                        </button>
                      )}
                    </>
                  )}
                </nav>
              ) : null}

              <div className="bx-main">
                <div className="bx-side">
                  <ColorPad tint={draft.tint} onChange={setTint} />

                  <div className="bx-tools">
                    <button className="bx-tool" title={t('boost-editor.inverser-la-luminosite')} aria-label={t('boost-editor.inverser-la-luminosite')} aria-pressed={draft.invert === true} onClick={() => edit({ invert: draft.invert === true ? undefined : true })}>
                      <svg viewBox="0 0 20 20" width="17" height="17" {...ICON}>
                        <path d="M7.500 14.500h5M8 17h4M10 2.500a5 5 0 0 0-3 9c.6.500 1 1.200 1 2h4c0-.8.400-1.500 1-2a5 5 0 0 0-3-9z" />
                      </svg>
                    </button>
                    <button
                      className="bx-tool bx-tool-adv"
                      title={t('boost-editor.controles-de-couleur-avances')}
                      aria-label={t('boost-editor.controles-de-couleur-avances')}
                      aria-pressed={advanced}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={toggleAdvanced}
                    >
                      <svg viewBox="0 0 20 20" width="17" height="17" {...ICON}>
                        <path d="M3 6h7m4 0h3M3 14h3m4 0h7M12 3.500v5M8 11.500v5" />
                      </svg>
                    </button>
                    <button
                      className="bx-tool"
                      title={t('boost-editor.retablir-les-couleurs-d-origine')}
                      aria-label={t('boost-editor.retablir-les-couleurs-d-origine')}
                      disabled={!colorsChanged}
                      onClick={() => edit({ tint: NEUTRAL_TINT, invert: undefined })}
                    >
                      <svg viewBox="0 0 20 20" width="17" height="17" {...ICON}>
                        <circle cx="10" cy="10" r="6.500" />
                        <path d="m5.400 14.600 9.200-9.200" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="bx-rest">
                  <div className="bx-fonts" role="group" aria-label={t('menu.police')} ref={fontsRef} data-more={moreFonts} onScroll={syncMoreFonts}>
                    {BOOST_FONTS.map((font) => (
                      <button
                        key={font.id}
                        className="bx-font"
                        style={{ fontFamily: font.family }}
                        title={font.label}
                        aria-label={font.label}
                        aria-pressed={draft.fontFamily === font.id}
                        onClick={() => edit({ fontFamily: draft.fontFamily === font.id ? undefined : font.id })}
                      >
                        Aa
                      </button>
                    ))}
                  </div>

                  <div className="bx-row">
                    <button
                      className={`bx-btn bx-size ${draft.zoom !== 1 ? 'on' : ''}`}
                      style={sizeColor(draft.zoom) ? ({ background: sizeColor(draft.zoom), color: SIZE_INK } as CSSProperties) : undefined}
                      title={t('boost-editor.taille-du-texte-change-a-chaque-clic')}
                      onClick={() => edit({ zoom: nextZoom(draft.zoom) })}
                    >
                      {sizeLabel(draft.zoom)}
                    </button>
                    <button className={`bx-btn bx-case ${draft.textCase ? 'on' : ''}`} title={t('boost-editor.casse-du-texte-change-a-chaque-clic')} onClick={() => edit({ textCase: nextTextCase(draft.textCase) })}>
                      {textCaseLabel(draft.textCase)}
                    </button>
                  </div>

                  <button
                    className={`bx-btn bx-wide-btn bx-zap ${zap ? 'on' : ''}`}
                    aria-pressed={zap}
                    title={zap ? t('boost-editor.quitter-le-mode-gomme') : t('boost-editor.cliquez-ensuite-sur-des-elements-de-la-page')}
                    onClick={zap ? () => act.openOverlay({ panel: 'boost', host: normalized, id: boostId }) : startZap}
                  >
                    <span>{draft.zap.length > 0 ? `${eraserName()} · ${draft.zap.length}` : eraserName()}</span>
                    <svg viewBox="0 0 20 20" width="12" height="12" {...ICON} fill="currentColor" strokeWidth={1}>
                      <path d="M11.500 1.500 4 11h5l-1 7.500L16 8.500h-5z" />
                    </svg>
                  </button>
                </div>
              </div>
            </>
          )}

          <footer className="bx-state">
            <label className="bx-switch">
              <input type="checkbox" role="switch" checked={draft.enabled} aria-label={t('boost-editor.retouche-active-sur-host', { host: normalized })} onChange={() => edit({ enabled: !draft.enabled })} />
              {t('boost-editor.actif')}
            </label>
            {sharing && (
              <button className="bx-export" disabled={!stored.current && !modified} onClick={() => void share({ kind: 'export-file', boostId })}>
                {t('boost-editor.exporter')}
              </button>
            )}
          </footer>
        </div>

        {advanced && !codeView && <AdvancedPopover draft={draft} onTint={setTint} onZoom={(zoom) => edit({ zoom }, 'zoom')} />}

        {menu && (
          <TitleMenu card={menuCard} onLeave={() => setMenu(false)}>
            <MenuItem
              disabled={!stored.current && !modified}
              onClick={() => {
                setMenu(false)
                setRenaming(true)
              }}
            >
              {t('boost-editor.renommer-cette-retouche')}
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(false)
                edit({ tint: shuffleTint(Math.random) })
              }}
            >
              {t('boost-editor.melanger')}
            </MenuItem>
            <MenuItem
              disabled={!modified}
              onClick={() => {
                setMenu(false)
                // Asked for by name: the script goes with the rest, the saved one as well as the one being typed.
                setSavedJs('')
                edit((d) => resetBoost(d))
              }}
            >
              {t('boost-editor.reinitialiser-toutes-les-modifications')}
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(false)
                edit({ enabled: !draft.enabled })
              }}
            >
              {draft.enabled ? t('boost-editor.desactiver-cette-retouche') : t('boost-editor.activer-cette-retouche')}
            </MenuItem>
            <MenuItem
              danger
              onClick={() => {
                setMenu(false)
                // A Tweak that was never saved has nothing to delete: just leave.
                if (stored.current) setConfirmDelete(true)
                else remove()
              }}
            >
              {t('site-panel.supprimer-cette-retouche')}
            </MenuItem>
            {sharing && (
              <>
                <hr />
                <MenuItem disabled={!stored.current && !modified} onClick={() => void share({ kind: 'export-file', boostId })}>
                  {t('site-panel.exporter-cette-retouche')}
                </MenuItem>
                <MenuItem disabled={!stored.current && !modified} onClick={() => void share({ kind: 'copy-link', boostId })}>
                  {t('boost-editor.copier-le-lien-de-cette-retouche')}
                </MenuItem>
                <MenuItem onClick={() => void share({ kind: 'export-all' })}>{t('boost-editor.exporter-toutes-les-retouches-dans-un-fichier')}</MenuItem>
                <MenuItem onClick={() => void share({ kind: 'import-file' })}>{t('boost-editor.importer-une-retouche-depuis-un-fichier')}</MenuItem>
                <MenuItem onClick={() => void share({ kind: 'import-link' })}>{t('cmd.coller-une-retouche-copiee')}</MenuItem>
              </>
            )}
            <hr />
            {siblings
              .filter((b) => b.id !== boostId)
              .map((b) => (
                <MenuItem key={b.id} onClick={() => goTo(b.id)}>
                  {b.name}
                </MenuItem>
              ))}
            <MenuItem onClick={() => goTo(undefined)}>{t('boost-editor.nouvelle-retouche')}</MenuItem>
          </TitleMenu>
        )}
      </div>

      {confirmDelete && (
        <ArcDialog
          title={t('boost-editor.supprimer-cette-retouche')}
          message={t('boost-editor.cette-action-est-irreversible')}
          confirmLabel={t('site-panel.supprimer')}
          onCancel={() => {
            setConfirmDelete(false)
            panel.current?.focus()
          }}
          onConfirm={remove}
        />
      )}
    </div>
  )
}

/**
 * The card of the menu of the title. The arrows, Home and End move the focus from entry to entry; Tab leaves the menu, which closes (the focus
 * is then given back to the title, from where Tab goes on through the panel).
 */
export function TitleMenu({ card, onLeave, children }: { card?: RefObject<HTMLDivElement | null>; onLeave: () => void; children: ReactNode }) {
  return (
    <div
      ref={card}
      className="bx-menu"
      role="menu"
      aria-label={t('boost-editor.menu-de-la-retouche')}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault()
          return onLeave()
        }
        if (moveInMenu(e.currentTarget, document.activeElement, e.key)) e.preventDefault()
      }}
    >
      {children}
    </div>
  )
}

function MenuItem({ children, onClick, disabled, danger }: { children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button className={`bx-menu-item ${danger ? 'danger' : ''}`} role="menuitem" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}

// ---------- Colour pad ----------

/** Displayed colour of the main handle: grey while the page is untouched, else a swatch that follows the hue and the saturation. */
function handleColor(tint: BoostTint): string {
  if (tint.hue === 0 && tint.saturation === 1) return '#767676'
  return `hsl(${(((210 + tint.hue) % 360) + 360) % 360} ${Math.round(Math.min(1, tint.saturation / 1.4) * 70 + 15)}% 50%)`
}

function ColorPad({ tint, onChange }: { tint: BoostTint; onChange: (update: (tint: BoostTint) => BoostTint, key: string) => void }) {
  const area = useRef<HTMLDivElement>(null)
  const dragging = useRef<'primary' | 'secondary' | null>(null)
  const primary = primaryPoint(tint)
  const secondary = secondaryPoint(tint)
  const [from, to] = ringColors(tint)

  const move = (handle: 'primary' | 'secondary', point: PadPoint) =>
    onChange((current) => (handle === 'primary' ? primaryToTint(current, point) : secondaryToTint(current, point)), handle)
  const pointOf = (e: ReactPointerEvent): PadPoint => {
    const box = area.current!.getBoundingClientRect()
    return { x: clamp01((e.clientX - box.left) / box.width), y: clamp01((e.clientY - box.top) / box.height) }
  }
  const nudge = (handle: 'primary' | 'secondary', current: PadPoint) => (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.03
    const delta = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, -step] : e.key === 'ArrowDown' ? [0, step] : null
    if (!delta) return
    e.preventDefault()
    move(handle, { x: clamp01(current.x + delta[0]!), y: clamp01(current.y + delta[1]!) })
  }

  return (
    <div className="bx-pad" style={{ background: `linear-gradient(165deg, ${from}, ${to})` }}>
      <div
        ref={area}
        className="bx-pad-in"
        onPointerDown={(e) => {
          const point = pointOf(e)
          const box = area.current!.getBoundingClientRect()
          // The small handle wins when the pointer lands on it; anywhere else the main one jumps to the pointer.
          const near = Math.hypot((point.x - secondary.x) * box.width, (point.y - secondary.y) * box.height) <= 14
          dragging.current = near ? 'secondary' : 'primary'
          e.currentTarget.setPointerCapture(e.pointerId)
          move(dragging.current, point)
        }}
        onPointerMove={(e) => dragging.current && move(dragging.current, pointOf(e))}
        onPointerUp={() => (dragging.current = null)}
        onPointerCancel={() => (dragging.current = null)}
      >
        <div
          className="bx-thumb main"
          tabIndex={0}
          role="slider"
          aria-roledescription={t('boost-editor.curseur-a-deux-axes')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(primary.x * 100)}
          aria-valuetext={t('boost-editor.teinte-hue-saturation', { hue: tint.hue, saturation: Math.round(tint.saturation * 100) })}
          aria-label={t('boost-editor.teinte-et-saturation')}
          style={{ left: `${primary.x * 100}%`, top: `${primary.y * 100}%`, background: handleColor(tint) }}
          onKeyDown={nudge('primary', primary)}
        />
        <div
          className="bx-thumb second"
          tabIndex={0}
          role="slider"
          aria-roledescription={t('boost-editor.curseur-a-deux-axes')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(secondary.x * 100)}
          aria-valuetext={t('boost-editor.contraste-luminosite-values', { contrast: Math.round(tint.contrast * 100), brightness: Math.round(tint.brightness * 100) })}
          aria-label={t('boost-editor.contraste-et-luminosite')}
          style={{ left: `${secondary.x * 100}%`, top: `${secondary.y * 100}%` }} onKeyDown={nudge('secondary', secondary)} />
      </div>
    </div>
  )
}

// ---------- Advanced colour controls ----------

const SLIDERS: Array<{ key: TintKey; label: string }> = [
  { key: 'hue', get label() { return t('boost-editor.teinte') } },
  { key: 'contrast', get label() { return t('boost-editor.contraste') } },
  { key: 'brightness', get label() { return t('boost-editor.luminosite') } },
  { key: 'saturation', get label() { return t('boost-editor.saturation-d-origine') } }
]

function AdvancedPopover({ draft, onTint, onZoom }: { draft: BoostDraft; onTint: (update: (tint: BoostTint) => BoostTint, key: string) => void; onZoom: (zoom: number) => void }) {
  return (
    <div className="bx-adv" role="group" aria-label={t('boost-editor.controles-de-couleur-avances')} onMouseDown={(e) => e.stopPropagation()}>
      {SLIDERS.map(({ key, label }) => (
        <label key={key} className="bx-slider">
          <span>{label}</span>
          <input type="range" min={0} max={100} step={1} value={sliderOf(key, draft.tint)} style={{ '--v': `${sliderOf(key, draft.tint)}%` } as CSSProperties} aria-label={label} onChange={(e) => onTint((tint) => tintWithSlider(tint, key, Number(e.target.value)), `slider-${key}`)} />
        </label>
      ))}
      <label className="bx-slider">
        <span>{t('boost-editor.taille-du-texte-zoom', { zoom: Math.round(draft.zoom * 100) })}</span>
        <input type="range" min={BOOST_ZOOM_MIN * 100} max={BOOST_ZOOM_MAX * 100} step={5} value={Math.round(draft.zoom * 100)} style={{ '--v': `${((draft.zoom - BOOST_ZOOM_MIN) / (BOOST_ZOOM_MAX - BOOST_ZOOM_MIN)) * 100}%` } as CSSProperties} aria-label={t('boost-editor.taille-du-texte')} onChange={(e) => onZoom(Number(e.target.value) / 100)} />
      </label>
    </div>
  )
}

// ---------- Code ----------

interface CodeViewProps {
  view: Exclude<View, 'main'>
  draft: BoostDraft
  /** The script the pages run; `draft.js` is what the field holds. */
  savedJs: string
  previewNote: ScriptPreviewReply | null
  onView: (view: View) => void
  onEdit: (change: Partial<BoostDraft> | ((current: BoostDraft) => Partial<BoostDraft>), key?: string) => void
  onSaveScript: () => void
  onPreview: () => void
  onZap: () => void
  onDevTools: () => void
}

/** The CSS, the JavaScript and the Eraser of a Tweak (exported for its test). */
export function CodeView({ view, draft, savedJs, previewNote, onView, onEdit, onSaveScript, onPreview, onZap, onDevTools }: CodeViewProps) {
  const field = useRef<HTMLTextAreaElement>(null)
  const keysId = useId()
  // The rule of every script a person reads before it runs: one that does not show what it runs is not saved and not previewed.
  const unreadable = view === 'js' ? unreadableCode(draft.js) : null
  const invisibleLine = view === 'js' && !unreadable ? hiddenCharacterLine(draft.js) : 0
  const unsaved = draft.js !== savedJs
  const canPick = typeof window !== 'undefined' && 'EyeDropper' in window
  const key = view === 'css' ? 'css' : 'js'

  useEffect(() => {
    if (view !== 'zap') field.current?.focus()
  }, [view])

  const insert = (text: string) => {
    const el = field.current
    if (!el || view === 'zap') return
    const start = el.selectionStart
    const end = el.selectionEnd
    const value = el.value.slice(0, start) + text + el.value.slice(end)
    onEdit({ [key]: value }, key)
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + text.length
      el.focus()
    })
  }
  const pick = async () => {
    const Dropper = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!Dropper) return
    try {
      insert((await new Dropper().open()).sRGBHex)
    } catch (error) {
      // Escape in the picker rejects with an AbortError, which is not a failure.
      if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('[boost] the colour picker failed:', error)
    }
  }

  return (
    <>
      <div className="bx-seg" role="tablist" aria-label={t('boost-editor.langage')} onKeyDown={tabListKeys}>
        {(['css', 'js', 'zap'] as const).map((tab) => (
          <button key={tab} role="tab" aria-selected={view === tab} tabIndex={view === tab ? 0 : -1} className={view === tab ? 'on' : ''} onClick={() => onView(tab)}>
            {tab === 'zap' ? (draft.zap.length > 0 ? `${eraserName()} ${draft.zap.length}` : eraserName()) : tab.toUpperCase()}
          </button>
        ))}
      </div>

      {view === 'zap' ? (
        <div className="bx-zap-list">
          {draft.zap.length === 0 && <p>{t('boost-editor.aucun-element-masque-utilisez-la-gomme-pour-cliquer')}</p>}
          <ul>
            {draft.zap.map((selector) => (
              <li key={selector}>
                <code title={selector}>{selector}</code>
                <button className="bx-link" onClick={() => onEdit({ zap: draft.zap.filter((z) => z !== selector) })}>
                  {t('search-settings.retablir')}
                </button>
              </li>
            ))}
          </ul>
          <button className="bx-btn bx-zap-start" onClick={onZap}>
            {t('boost-editor.masquer-un-element-de-la-page')}
          </button>
        </div>
      ) : (
        <div className="bx-editor">
          {view === 'js' && draft.jsEnabled === false && (
            <div className="bx-script-off" role="alert">
              <span>{draft.js.trim() !== '' ? t('boost-editor.ce-script-n-est-pas-execute') : t('boost-editor.le-javascript-est-desactive-pour-cette-retouche')}</span>
              <button className="bx-script-on" onClick={() => onEdit({ jsEnabled: true })}>
                {t('boost-editor.activer-le-javascript')}
              </button>
            </div>
          )}
          <textarea
            ref={field}
            className="bx-text"
            spellCheck={false}
            aria-label={view === 'css' ? t('boost-editor.css-de-la-retouche') : t('boost-editor.javascript-de-la-retouche')}
            maxLength={view === 'js' ? BOOST_JS_MAX : undefined}
            value={view === 'css' ? draft.css : draft.js}
            placeholder={view === 'css' ? 'a { color: hotpink; }' : "document.title = '✓ ' + document.title"}
            aria-describedby={keysId}
            onChange={(e) => onEdit({ [key]: e.target.value }, key)}
            onKeyDown={(e) => {
              if (e.key !== 'Tab' || e.shiftKey) return
              e.preventDefault()
              insert('  ')
            }}
          />
          {/* Tab indents here, as in any code editor: the way out is written under the field, not left to be guessed. */}
          <p id={keysId} className="bx-keys">
            {t('boost-editor.tab-indente-sortie')}
          </p>
          {unreadable && (
            <p className="bx-warn" role="alert">
              {unreadableCodeMessage(unreadable)}
            </p>
          )}
          {invisibleLine > 0 && <p className="bx-warn">{t('boostshare.le-javascript-contient-des-caracteres-invisibles-ligne-line', { line: invisibleLine })}</p>}
          {view === 'js' && unsaved && (
            <div className="bx-script-draft">
              <span role="status">{previewNote ? previewNote.message : t('boost-editor.brouillon-non-enregistre')}</span>
              <button className="bx-script-save" disabled={unreadable !== null} onClick={onSaveScript}>
                {t('boost-editor.enregistrer-le-script')}
              </button>
              <button className="bx-link" disabled={unreadable !== null || draft.js.trim() === '' || draft.jsEnabled === false} onClick={onPreview}>
                {t('boost-editor.lancer-l-apercu')}
              </button>
              <button className="bx-link" onClick={() => onEdit({ js: savedJs })}>
                {t('boost-editor.revenir-au-script-enregistre')}
              </button>
            </div>
          )}
          {view === 'js' && (
            <p className="bx-warn">
              {t('boost-editor.un-script-s-execute-avec-les-memes-droits')}
              {savedJs.trim() !== '' && draft.jsEnabled !== false && (
                <>
                  {' '}
                  <button className="bx-link" onClick={() => onEdit({ jsEnabled: false })}>
                    {t('boost-editor.desactiver-le-script')}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      )}

      <footer className="bx-foot">
        <button className="bx-foot-btn" title={t('boost-editor.pipette-inserer-une-couleur-de-l-ecran')} aria-label={t('boost-editor.pipette')} disabled={!canPick || view === 'zap'} onClick={() => void pick()}>
          <svg viewBox="0 0 20 20" width="18" height="18" {...ICON}>
            <path d="m12.500 4.500 3 3M4 16l.5-3 7.500-7.500 2.500 2.500L7 15.500zM11 4.500l1.500-1.500a1.400 1.400 0 0 1 2 0l2.500 2.500a1.400 1.400 0 0 1 0 2L15.500 9" />
          </svg>
        </button>
        <button className="bx-foot-btn" title={t('menu.outils-de-developpement')} aria-label={t('menu.outils-de-developpement')} onClick={onDevTools}>
          <svg viewBox="0 0 20 20" width="18" height="18" {...ICON}>
            <path d="m11.500 4.500 4 4M3 17l6-6M12 3.500l4.500 4.500-2 2-4.500-4.500zM8 8l4 4" />
          </svg>
        </button>
        {view === 'css' && (
          <select
            className="bx-presets"
            aria-label={t('boost-editor.prereglages')}
            value=""
            onChange={(e) => {
              const preset = SAMPLE_PRESETS.find((p) => p.label === e.target.value)
              if (preset) onEdit((d) => ({ css: d.css.trim() ? `${d.css}\n${preset.css}` : preset.css }), 'preset')
            }}
          >
            <option value="">{t('boost-editor.prereglages-2')}</option>
            {SAMPLE_PRESETS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </footer>
    </>
  )
}

import { t } from '@shared/i18n'