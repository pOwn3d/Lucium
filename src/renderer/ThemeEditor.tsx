// The theme panel of a space, with a live preview: a list of named themes (dark, light, the themes of the user's other spaces) with a drawing
// of the sidebar that takes the theme under the pointer or the focus before it is clicked, then the colour to start from, the hue, the strength and the texture;
// everything else (the colour pad, the harmony, the codes) stays under "Contrôles de couleur avancés". The sidebar behind the panel is the live preview of what is
// chosen: the changes reach the main process at most once per frame. "Terminé" keeps them, Escape and "Réinitialiser" go back to the theme the panel opened with.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { radioGroupKeys } from './radio-keys'
import { HARMONIES, MAX_THEME_COLORS, OVERLAYS, cleanTheme, colorAtPadPoint, hexToHsl, hslToHex, padPointOf, themeHue, withColorAt, withColorCount, withHarmony, type Appearance, type Harmony, type Overlay, type SpaceTheme } from '@shared/theme'
import { encodeThemeCode, parseThemeCode } from '@shared/theme-code'
import { NAMED_COLORS } from '@shared/theme-colors'
import { hueOfTheme, huePatch, noisePatch, overlayPatch } from '@shared/theme-controls'
import { currentChoice, flatChoices, previewedTheme, themeGroups, type ThemeChoice } from '@shared/theme-list'
import { appearanceLabel } from '@shared/space-customize'
import { builtinBackground } from '@shared/builtin-backgrounds'
import { userFileBackground, type AutoVeilLook } from '@shared/auto-veil'
import { nextRowIndex } from '@shared/panel-keys'
import { api, useSnapshot } from './api'
import { startDrag } from './drag'
import { useFirstKnown } from './first-known'
import { SidebarThumb } from './SidebarThumb'
import { SpaceMark } from './SpaceMark'
import { SpaceMediaPanel } from './SpaceMediaPanel'
import './templates/primitives.css'
import './theme-editor.css'
import { useSystemDark } from './system-dark'

const HARMONY_LABELS: Record<Harmony, string> = {
  get complementary() { return t('theme-editor.complementaire') },
  get analogous() { return t('theme-panel.analogue') },
  get triadic() { return t('theme-panel.triade') },
  get monochrome() { return t('theme-panel.monochrome') },
  get custom() { return t('theme-panel.libre') }
}
const OVERLAY_LABELS: Record<Overlay, string> = {
  get none() { return t('appearance-settings.aucune') },
  get grain() { return t('theme-panel.grain') },
  get fine() { return t('theme-panel.fine') },
  get coarse() { return t('theme-editor.grossiere') }
}
const APPEARANCES: readonly Appearance[] = ['auto', 'light', 'dark']
/** The words on the segment of the header, short (the full ones are the names of the buttons). */
const SHORT_APPEARANCE: Record<Appearance, () => string> = { auto: () => t('theme-panel.auto'), light: () => t('menu.clair'), dark: () => t('menu.sombre') }

const PAD_SIZE = 340
const COPIED_MS = 1500

/**
 * The theme being edited. Changes show at once (the sidebar behind the panel is the live preview) and reach the main
 * process at most once per frame, merged into one patch so a fast drag never queues a backlog of IPC calls.
 */
function useThemeDraft(spaceId: string, saved: SpaceTheme) {
  const [draft, setDraft] = useState<SpaceTheme | null>(null)
  const working = useRef(saved)
  const queued = useRef<Partial<SpaceTheme> | null>(null)
  const frame = useRef(0)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Without a draft in progress the saved theme is the truth (it can also change from elsewhere).
  if (!draft) working.current = saved

  const flush = () => {
    frame.current = 0
    const patch = queued.current
    queued.current = null
    if (!patch) return
    void api()
      .dispatch({ type: 'space/update', id: spaceId, patch: { theme: patch } })
      .finally(() => {
        if (queued.current) return
        // The snapshot normally lands before this; the timer is only a fallback so a stale draft cannot stick.
        settle.current = setTimeout(() => setDraft(null), 300)
      })
  }

  const change = (patch: Partial<SpaceTheme>) => {
    if (settle.current) clearTimeout(settle.current)
    const next = cleanTheme({ ...working.current, ...patch }, working.current)
    working.current = next
    setDraft(next)
    queued.current = { ...queued.current, ...patch }
    if (!frame.current) frame.current = requestAnimationFrame(flush)
  }

  /** Sends what is waiting now (the panel is about to close: a frame that has not come yet would be lost). */
  const flushNow = () => {
    if (!frame.current) return
    cancelAnimationFrame(frame.current)
    flush()
  }

  useEffect(
    () => () => {
      flushNow()
      if (settle.current) clearTimeout(settle.current)
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // As soon as the saved theme catches up with the draft, hand control back to it.
  useEffect(() => {
    if (draft && !queued.current && JSON.stringify(saved) === JSON.stringify(draft)) setDraft(null)
  }, [saved, draft])

  return { theme: draft ?? saved, change, flushNow }
}

function Segmented<T extends string>({ value, options, labels, onChange, label }: { value: T; options: readonly T[]; labels: Record<T, string>; onChange: (value: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" onKeyDown={radioGroupKeys} aria-label={label}>
      {options.map((option) => (
        <button key={option} role="radio" aria-checked={option === value} className={option === value ? 'current' : ''} onClick={() => onChange(option)}>
          {labels[option]}
        </button>
      ))}
    </div>
  )
}

/** The grid of dots behind the colour dots: each dot shows the colour a position would give. Drawn once. */
function PadGrid() {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    const context = el?.getContext('2d')
    if (!el || !context) return
    const ratio = window.devicePixelRatio || 1
    el.width = PAD_SIZE * ratio
    el.height = PAD_SIZE * ratio
    context.scale(ratio, ratio)
    for (let x = 4; x < PAD_SIZE; x += 6) {
      for (let y = 4; y < PAD_SIZE; y += 6) {
        context.fillStyle = colorAtPadPoint(x / PAD_SIZE, y / PAD_SIZE, 0.6)
        context.globalAlpha = 0.5
        context.beginPath()
        context.arc(x, y, 0.9, 0, Math.PI * 2)
        context.fill()
      }
    }
  }, [])
  return <canvas ref={canvas} className="pad-grid" width={PAD_SIZE} height={PAD_SIZE} aria-hidden="true" />
}

/**
 * The colour pad: one dot per base colour, the first one big. With a derived harmony only the first moves; the others follow it.
 * Dragging changes a colour's hue (along) and lightness (up and down) and keeps its saturation.
 */
function ColorPad({ theme, selected, onSelect, onMove, children }: { theme: SpaceTheme; selected: number; onSelect: (index: number) => void; onMove: (index: number, hex: string) => void; children?: ReactNode }) {
  const pad = useRef<HTMLDivElement>(null)
  const free = theme.harmony === 'custom'

  return (
    <div
      ref={pad}
      className="color-pad"
      style={{ width: PAD_SIZE, height: PAD_SIZE }}
      role="group"
      aria-label={t('theme-editor.pave-de-couleurs')}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) return
        event.preventDefault()
        const rect = pad.current!.getBoundingClientRect()
        const at = (e: { clientX: number; clientY: number }) => ({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height })
        const start = at(event)
        // Grab the nearest dot when they are all free; otherwise the primary colour is the only one that moves.
        let index = 0
        if (free) {
          const distance = (i: number) => {
            const p = padPointOf(theme.baseColors[i]!)
            return Math.hypot(p.x - start.x, p.y - start.y)
          }
          index = theme.baseColors.map((_, i) => i).sort((a, b) => distance(a) - distance(b))[0]!
        }
        onSelect(index)
        const saturation = Math.max(0.35, hexToHsl(theme.baseColors[index]!).s)
        const move = (e: { clientX: number; clientY: number }) => {
          const p = at(e)
          onMove(index, colorAtPadPoint(p.x, p.y, saturation))
        }
        move(event)
        startDrag(move)
      }}
    >
      <PadGrid />
      {theme.baseColors.map((color, index) => {
        const p = padPointOf(color)
        const movable = free || index === 0
        return (
          <span
            key={index}
            className={`pad-dot ${index === 0 ? 'primary' : ''} ${index === selected ? 'selected' : ''} ${movable ? '' : 'derived'}`}
            style={{ left: p.x * PAD_SIZE, top: p.y * PAD_SIZE, background: color }}
          />
        )
      })}
      {children}
    </div>
  )
}

/** The pastille of a choice in the list. Only values of the tables (shared/theme-presets.ts) or of a validated theme reach the style. */
const swatchStyle = (choice: ThemeChoice): CSSProperties => ({ background: choice.swatch })

export function ThemeEditor({ spaceId, from }: { spaceId: string; from?: 'space' }) {
  const snapshot = useSnapshot()
  const space = snapshot?.state.spaces.find((s) => s.id === spaceId)
  const saved = space?.theme
  // What the theme and media background were when the panel opened: "Réinitialiser" and Escape go back to them.
  const original = useRef<SpaceTheme | null>(null)
  // Taken once: a space that had no background when the panel opened goes back to none, whatever was added since.
  const originalBackground = useFirstKnown(space !== undefined, space?.background)
  if (saved && !original.current) original.current = saved
  const [selected, setSelected] = useState(0)
  const [hexInput, setHexInput] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [hovered, setHovered] = useState<ThemeChoice | null>(null)
  const [rover, setRover] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const systemDark = useSystemDark()
  const [codeNotice, setCodeNotice] = useState<{ text: string; ok: boolean } | null>(null)
  const [copied, setCopied] = useState<'color' | 'code' | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const { theme, change, flushNow } = useThemeDraft(spaceId, saved ?? cleanTheme(null))

  const close = () => {
    flushNow()
    void api().closeOverlay()
  }
  const restoreBackground = () => {
    void api().dispatch({ type: 'space/update', id: spaceId, patch: { background: originalBackground.current ? { ...originalBackground.current } : undefined } })
  }
  // Escape goes back to the theme and background the panel opened with (and says so in the foot): the sidebar behind showed every step, so nothing is asked.
  const cancel = () => {
    if (original.current) change(original.current)
    restoreBackground()
    close()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !event.defaultPrevented && cancel()
    window.addEventListener('keydown', onKey)
    card.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!snapshot || !space || !saved) return null

  const groups = themeGroups(snapshot.state.spaces, space.id)
  const choices = flatChoices(groups)
  const current = currentChoice(groups, theme)
  const shown = previewedTheme(hovered, theme)
  const index = Math.min(selected, theme.baseColors.length - 1)
  const color = theme.baseColors[index]!
  const hsl = hexToHsl(color)
  const free = theme.harmony === 'custom'
  const moveColor = (i: number, hex: string) => {
    const patch = withColorAt(theme, i, hex)
    if (patch) change(patch)
  }
  const canEditSelected = free || index === 0
  const themeCode = encodeThemeCode(theme)
  const primary = theme.baseColors[0]?.toLowerCase()

  // A request the main process did not answer (it threw, or the channel failed): said in the line of the panel, with the cause in the console.
  // Without this the button would do nothing and say nothing.
  const told = (what: string, work: Promise<void>) =>
    void work.catch((error: unknown) => {
      console.warn(`[theme] ${what} failed:`, error)
      setCodeNotice({ text: t('theme-editor.l-action-n-a-pas-abouti'), ok: false })
    })
  // The shell owns the clipboard: a copy or a paste is a request, answered with the sentence to show.
  const copyText = async (text: string, what: 'color' | 'code') => {
    const reply = await api().themeCode({ kind: 'copy', text })
    setCodeNotice(reply.ok ? null : { text: reply.message, ok: false })
    if (!reply.ok) return
    setCopied(what)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS)
  }
  const pasteText = async (text?: string) => {
    const reply = await api().themeCode({ kind: 'paste', spaceId, ...(text === undefined ? {} : { text }) })
    setCodeNotice({ text: reply.message, ok: reply.ok })
    if (!reply.ok) return
    setPasted('')
    setSelected(0)
  }
  const applyToAll = async () => {
    // The draft is sent along: the last move of a slider may not have reached the saved theme yet.
    const reply = await api().themeCode({ kind: 'apply-all', spaceId, theme })
    setCodeNotice(reply.ok ? null : { text: reply.message, ok: false })
  }
  const changeBackground = (media: { filename: string; mimeType: string; look?: AutoVeilLook } | null) => {
    if (!media) {
      void api().dispatch({ type: 'space/update', id: spaceId, patch: { background: undefined } })
      return
    }
    void api().dispatch({
      type: 'space/update',
      id: spaceId,
      patch: {
        // A video of Lucium comes with its look (veil, text colour, shadow), in the same update; a file of the user's with the look measured from it,
        // or the one set by hand it replaces (as in Personnaliser l'espace).
        background: builtinBackground(media.filename) ?? userFileBackground(space.background, media)
      }
    })
  }
  const takeSiteColor = async () => {
    const hex = await api().siteColor()
    if (!hex) return setNotice(t('theme-editor.cette-page-ne-declare-pas-de-couleur'))
    setNotice('')
    const patch = withColorAt(theme, 0, hex)
    if (patch) change(patch)
    setSelected(0)
  }

  const choose = (choice: ThemeChoice) => {
    change(choice.theme)
    setSelected(0)
    setRover(choice.id)
  }
  const rovingId = rover && choices.some((choice) => choice.id === rover) ? rover : (current?.id ?? choices[0]?.id)
  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const to = buttons[nextRowIndex(at, buttons.length, event.key)]
    if (!to) return
    event.preventDefault()
    to.focus()
    to.scrollIntoView?.({ block: 'nearest' })
  }

  return (
    <div ref={card} tabIndex={-1} className="theme-pop tk-panel tk-hue" role="dialog" aria-label={t('cmd.modifier-le-theme-de-l-espace')} style={{ '--hue': themeHue(theme) } as CSSProperties}>
      <div className="tp-head">
        {from === 'space' && (
          <button
            type="button"
            className="tk-btn quiet tp-back"
            title={t('theme-panel.retour-a-personnaliser-l-espace')}
            aria-label={t('theme-panel.retour-a-personnaliser-l-espace')}
            onClick={() => {
              flushNow()
              void api().openOverlay({ panel: 'space', spaceId })
            }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path d="M10 3.500 5.500 8l4.500 4.500" />
            </svg>
          </button>
        )}
        <h2>{t('panels.theme')}</h2>
        <span className="tp-ctx" title={space.name}>
          {space.name}
        </span>
        <div className="ip-seg" role="group" aria-label={t('menu.apparence')}>
          {APPEARANCES.map((appearance) => (
            <button key={appearance} type="button" aria-pressed={theme.appearance === appearance} aria-label={appearanceLabel(appearance)} onClick={() => change({ appearance })}>
              {SHORT_APPEARANCE[appearance]()}
            </button>
          ))}
        </div>
      </div>

      <div className="tp-twocol">
        <div className="tp-left">
          <div className="tp-label">
            {t('theme-panel.themes-prets')} <span className="tp-n">· {choices.length}</span>
          </div>
          <div
            ref={list}
            className="tp-list"
            role="group"
            aria-label={t('theme-panel.liste-des-themes')}
            onKeyDown={onListKey}
            onMouseLeave={() => setHovered(null)}
            onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setHovered(null)}
          >
            {groups.map((group) => (
              <section key={group.id}>
                <h3 className="tp-group">{group.id === 'dark' ? t('theme-panel.sombres') : group.id === 'light' ? t('theme-panel.clairs') : t('theme-panel.mes-themes')}</h3>
                {group.choices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    className="tp-theme"
                    aria-pressed={current?.id === choice.id}
                    tabIndex={choice.id === rovingId ? 0 : -1}
                    onMouseEnter={() => setHovered(choice)}
                    onFocus={() => {
                      setHovered(choice)
                      setRover(choice.id)
                    }}
                    onClick={() => choose(choice)}
                  >
                    <i style={swatchStyle(choice)} aria-hidden="true" />
                    <span>{choice.name}</span>
                    {group.id === 'mine' && <small>{choice.appearance === 'auto' ? t('menu.automatique') : choice.appearance === 'dark' ? t('menu.sombre') : t('menu.clair')}</small>}
                  </button>
                ))}
              </section>
            ))}
          </div>
          <SpaceMediaPanel
            space={space}
            onMediaChange={changeBackground}
            onBackgroundChange={(background) => void api().dispatch({ type: 'space/update', id: spaceId, patch: { background } })}
            onPositionChange={(x, y) => void api().dispatch({ type: 'space/background-position', id: spaceId, x, y })}
            forceReduceMotion={snapshot.state.settings.forceReduceMotion}
          />
          <p className="tp-hint">{t('theme-panel.apercu-au-survol')}</p>
          <button type="button" className="tp-link" disabled={snapshot.state.spaces.length < 2} onClick={() => told('applying the theme to every space', applyToAll())}>
            {t('theme-panel.appliquer-a-tous-les-espaces')}
          </button>
        </div>
        <SidebarThumb
          className="tp-thumb"
          theme={shown}
          name={space.name}
          mark={<SpaceMark space={space} className="thumb" />}
          systemDark={systemDark}
        />
      </div>

      <div className="tp-label">{t('theme-panel.couleur-de-depart')}</div>
      <div className="tp-swatches" role="group" aria-label={t('theme-panel.couleur-de-depart')}>
        {NAMED_COLORS.map((named) => (
          <button key={named.id} type="button" className="tp-swatch" style={{ '--c': named.hex } as CSSProperties} title={named.name()} aria-label={named.name()} aria-pressed={primary === named.hex} onClick={() => moveColor(0, named.hex)} />
        ))}
      </div>

      <div className="tp-sliders">
        <label>
          {t('theme-panel.teinte')}
          <input
            type="range"
            min={0}
            max={359}
            value={hueOfTheme(theme)}
            disabled={!canEditSelected && index !== 0}
            aria-label={t('theme-panel.teinte')}
            onChange={(event) => {
              const patch = huePatch(theme, Number(event.target.value))
              if (patch) change(patch)
            }}
          />
        </label>
        <label>
          {t('theme-editor.intensite')}
          <input type="range" min={0} max={100} value={Math.round(theme.intensity * 100)} aria-label={t('theme-editor.intensite')} onChange={(event) => change({ intensity: Number(event.target.value) / 100 })} />
        </label>
        <label>
          {t('theme-panel.texture')}
          <select className="tk-field" value={theme.overlay} aria-label={t('theme-panel.texture')} onChange={(event) => change(overlayPatch(theme, event.target.value as Overlay))}>
            {OVERLAYS.map((overlay) => (
              <option key={overlay} value={overlay}>
                {OVERLAY_LABELS[overlay]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <details className="theme-advanced">
        <summary>{t('theme-editor.controles-de-couleur-avances')}</summary>
        <ColorPad theme={theme} selected={index} onSelect={setSelected} onMove={moveColor}>
          <div className="pad-count">
            <button type="button" title={t('theme-editor.retirer-une-couleur')} aria-label={t('theme-editor.retirer-une-couleur')} disabled={theme.baseColors.length <= 1} onClick={() => change(withColorCount(theme, theme.baseColors.length - 1))}>
              −
            </button>
            <button type="button" title={t('theme-editor.ajouter-une-couleur')} aria-label={t('theme-editor.ajouter-une-couleur')} disabled={theme.baseColors.length >= MAX_THEME_COLORS} onClick={() => change(withColorCount(theme, theme.baseColors.length + 1))}>
              +
            </button>
          </div>
        </ColorPad>
        <div className="tp-label">{t('theme-editor.harmonie')}</div>
        <Segmented value={theme.harmony} options={HARMONIES} labels={HARMONY_LABELS} label={t('theme-editor.harmonie')} onChange={(harmony) => change(withHarmony(theme, harmony))} />
        <div className="swatches">
          {theme.baseColors.map((c, i) => (
            <button key={i} type="button" className={`swatch ${i === index ? 'current' : ''}`} style={{ background: c }} title={c} aria-label={t('theme-panel.couleur-n', { n: i + 1 })} aria-pressed={i === index} onClick={() => setSelected(i)} />
          ))}
        </div>
        <label>
          {t('theme-panel.code-couleur')}
          <span className="code-row">
            <input
              className="tk-field"
              value={hexInput ?? color}
              disabled={!canEditSelected}
              spellCheck={false}
              onChange={(e) => {
                setHexInput(e.target.value)
                // A code pasted without its "#" counts too; only six digits apply, so a half-typed code never moves the colour.
                const text = e.target.value.trim()
                const typed = /^#?[0-9a-f]{6}$/i.test(text) ? parseThemeCode(text) : null
                if (typed?.ok && typed.kind === 'color') moveColor(index, typed.color)
              }}
              onBlur={() => setHexInput(null)}
            />
            <button type="button" className="tk-btn" onClick={() => told('copying the colour', copyText(color, 'color'))}>
              {copied === 'color' ? t('theme-editor.copie') : t('menu.copier')}
            </button>
          </span>
        </label>
        <label>
          {t('theme-panel.saturation', { value: Math.round(hsl.s * 100) })}
          <input className="hue-slider zoom-slider" type="range" min={0} max={100} disabled={!canEditSelected} value={Math.round(hsl.s * 100)} onChange={(e) => moveColor(index, hslToHex({ ...hsl, s: Number(e.target.value) / 100 }))} />
        </label>
        <label>
          {t('theme-panel.direction-du-degrade', { value: Math.round(theme.angle) })}
          <input className="hue-slider zoom-slider" type="range" min={0} max={360} value={Math.round(theme.angle)} onChange={(e) => change({ angle: Number(e.target.value) })} />
        </label>
        <label>
          {t('theme-panel.quantite-de-texture', { value: Math.round(theme.noise * 100) })}
          <input className="hue-slider zoom-slider" type="range" min={0} max={100} value={Math.round(theme.noise * 100)} onChange={(e) => change(noisePatch(theme, Number(e.target.value) / 100))} />
        </label>
        <label className="inline">
          <input type="checkbox" checked={theme.vibrant} onChange={(e) => change({ vibrant: e.target.checked })} /> {t('theme-panel.couleurs-vives')}
        </label>
        <div className="tp-label">{t('theme-editor.translucidite')}</div>
        <Segmented value={theme.translucency} options={['light', 'dark'] as const} labels={{ get light() { return t('theme-panel.claire') }, get dark() { return t('menu.sombre') } }} label={t('theme-editor.translucidite')} onChange={(translucency) => change({ translucency })} />
        <div className="tp-label">{t('theme-editor.code-du-theme')}</div>
        <div className="code-row">
          <input className="tk-field code-text" readOnly value={themeCode} aria-label={t('theme-editor.code-du-theme')} spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="tk-btn" onClick={() => told('copying the code of the theme', copyText(themeCode, 'code'))}>
            {copied === 'code' ? t('theme-editor.copie') : t('menu.copier')}
          </button>
        </div>
        <div className="code-row">
          <input
            className="tk-field code-text"
            value={pasted}
            placeholder={t('theme-editor.coller-un-code-de-theme-ou-une-couleur')}
            aria-label={t('theme-editor.coller-un-code-de-theme')}
            spellCheck={false}
            maxLength={400}
            onChange={(e) => setPasted(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              // An empty field pastes the clipboard, like the button.
              told('pasting a code', pasteText(pasted.trim() ? pasted : undefined))
            }}
          />
          <button type="button" className="tk-btn" onClick={() => told('pasting a code', pasteText(pasted.trim() ? pasted : undefined))}>
            {t('menu.coller')}
          </button>
        </div>
      </details>

      {notice && (
        <p className="tp-note warning" role="status">
          {notice}
        </p>
      )}
      {codeNotice && (
        <p className={`tp-note ${codeNotice.ok ? '' : 'warning'}`} role="status">
          {codeNotice.text}
        </p>
      )}
      <div className="tp-foot">
        <button
          type="button"
          className="tk-btn quiet"
          onClick={() => {
            if (original.current) change(original.current)
            restoreBackground()
          }}
        >
          {t('theme-panel.reinitialiser')}
        </button>
        <span className="tp-spacer" />
        <button type="button" className="tk-btn quiet" title={t('theme-panel.couleur-du-site-aide')} onClick={() => told('reading the colour of the site', takeSiteColor())}>
          {t('theme-panel.couleur-du-site')}
        </button>
        <button type="button" className="tk-btn primary" onClick={close}>
          {t('templates.termine')}
        </button>
      </div>
      <p className="tp-esc">{t('theme-panel.echap-annule')}</p>
    </div>
  )
}
