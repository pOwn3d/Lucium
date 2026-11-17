// Settings › Apparence › Taille des fenêtres et des panneaux: the size of the panels that open over a window and of the windows of their own, for the screen the
// window is on. A control with five notches (Automatique, then four sizes), a preview that draws the Notes panel in a window to the scale of the screen with a
// slider, and the list of the screens that are known with their choice. The windows that are open follow when a choice is made (the main process does the
// scaling: shared/panel-scale.ts, shell/panel-scaling.ts). The slider only draws the preview while it is dragged, and chooses when it is let go: the window of
// Settings is itself one of those that follow, and a control that moves under the pointer cannot be dragged.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Settings } from '@shared/model'
import { autoPercent, committedPercent, knownScreens, PANEL_PERCENT_MAX, PANEL_PERCENT_MIN, PANEL_PERCENT_STEP, PANEL_PRESETS, previewOf, type PanelPreset, type ScreenInfo, type ScreenView } from '@shared/panel-scale'
import { t } from '@shared/i18n'
import { api } from './api'
import { loadScreens } from './panel-screens'
import { Row, type DrawsRows } from './settings-parts'

/** The width the preview is worked out at: the values come back as shares of the stage, whatever width it is drawn at. */
const STAGE = 1000

const PRESET_NAME: Record<PanelPreset, () => string> = {
  compact: () => t('panel-size.compacte'),
  normal: () => t('panel-size.normale'),
  large: () => t('panel-size.grande'),
  xlarge: () => t('panel-size.tres-grande')
}

/** The name of a screen: its own, or what it is when the system gives it none. */
export function screenName(screen: Pick<ScreenInfo, 'label' | 'internal'>): string {
  return screen.internal ? t('panel-size.ecran-integre') : screen.label !== '' ? screen.label : t('panel-size.ecran-sans-nom')
}

const screenText = (screen: ScreenInfo): string => t('panel-size.ecran-detail', { name: screenName(screen), width: screen.width, height: screen.height })

/** The fields that make a screen, as the main process wants them (it rebuilds the key from them). */
const infoOf = (screen: ScreenInfo): ScreenInfo => ({ key: screen.key, label: screen.label, internal: screen.internal, width: screen.width, height: screen.height, scaleFactor: screen.scaleFactor })

const share = (value: number, whole: number): string => `${Math.round((value / Math.max(1, whole)) * 10000) / 100}%`

/** The screens that are connected, asked of the main process when the pane is drawn and again when the window takes the focus or changes size (it may have moved to another screen). */
function useScreens(): ScreenView[] {
  const [screens, setScreens] = useState<ScreenView[]>([])
  useEffect(() => {
    let live = true
    const load = () =>
      void loadScreens(
        () => api().panelScreens(),
        (list) => live && setScreens(list),
        (message, error) => console.error(message, error)
      )
    load()
    window.addEventListener('focus', load)
    window.addEventListener('resize', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
      window.removeEventListener('resize', load)
    }
  }, [])
  return screens
}

export function PanelSizeRows({ settings }: { settings: Settings }) {
  return <PanelSizeView settings={settings} screens={useScreens()} />
}

/** What the pane draws for the screens it was given (the test draws it with screens of its own). */
export function PanelSizeView({ settings, screens }: { settings: Settings; screens: readonly ScreenView[] }) {
  const here = screens.find((screen) => screen.current) ?? screens[0] ?? null
  const choice = here === null ? null : (settings.panelSizes[here.key]?.percent ?? null)
  const auto = here === null ? 100 : autoPercent(here)
  // The value the slider shows while it is dragged; null the rest of the time, when it shows the choice (or what Automatique gives).
  const [drag, setDrag] = useState<number | null>(null)
  const latest = useRef<number | null>(null)
  const shown = drag ?? choice ?? auto
  const choose = (percent: number | null) => {
    if (here !== null) void api().dispatch({ type: 'panel-size/set', screen: infoOf(here), percent })
  }
  const release = () => {
    const value = committedPercent(latest.current, choice ?? auto)
    latest.current = null
    setDrag(null)
    if (value !== null) choose(value)
  }
  const preset = choice === null ? null : (PANEL_PRESETS.find((one) => one.percent === choice)?.id ?? null)
  const hint = choice === null ? t('panel-size.automatique-aide') : preset === null ? t('panel-size.personnalisee', { percent: choice }) : undefined
  const preview = here === null ? null : previewOf({ screen: here, window: here.window, percent: shown, stageWidth: STAGE })
  const rows = knownScreens(settings.panelSizes, screens)

  return (
    <>
      <Row settingKey="panelSizes" className="panel-size-row" label={t('panel-size.taille-sur-cet-ecran')} hint={hint}>
        <div className="panel-seg" role="group" aria-label={t('panel-size.taille-sur-cet-ecran')}>
          <button type="button" className="panel-seg-item" aria-pressed={drag === null && choice === null} disabled={here === null} onClick={() => choose(null)}>
            {t('panel-size.automatique')}
          </button>
          {PANEL_PRESETS.map((one) => (
            <button key={one.id} type="button" className="panel-seg-item" aria-pressed={drag === null && preset === one.id} disabled={here === null} onClick={() => choose(one.percent)}>
              {PRESET_NAME[one.id]()}
            </button>
          ))}
        </div>
      </Row>

      <div className="pref-row panel-preview">
        <div className="panel-preview-head">
          <span className="pref-title-line">{t('panel-size.apercu')}</span>
          {here !== null && <span className="panel-screen-pill">{t('panel-size.ecran', { name: screenText(here) })}</span>}
        </div>
        {preview !== null && (
          <div className="panel-stage" role="img" aria-label={t('panel-size.apercu-alt', { percent: shown })} style={{ '--ratio': Math.round((preview.screen.width / Math.max(1, preview.screen.height)) * 10000) / 10000 } as CSSProperties}>
            <div className="panel-stage-screen">
              <div className="panel-stage-window" style={{ left: share(preview.window.x, preview.screen.width), top: share(preview.window.y, preview.screen.height), width: share(preview.window.width, preview.screen.width), height: share(preview.window.height, preview.screen.height) }} />
              <div className="panel-stage-panel" style={{ left: share(preview.panel.x, preview.screen.width), top: share(preview.panel.y, preview.screen.height), width: share(preview.panel.width, preview.screen.width), height: share(preview.panel.height, preview.screen.height) }}>
                <span className="panel-stage-title">{t('notes.notes')}</span>
                <span className="panel-stage-line" style={{ width: '90%' }} />
                <span className="panel-stage-line" style={{ width: '70%' }} />
                <span className="panel-stage-line" style={{ width: '80%' }} />
                <span className="panel-stage-line" style={{ width: '50%' }} />
              </div>
            </div>
          </div>
        )}
        <div className="panel-slider">
          <span className="panel-slider-small" aria-hidden="true">
            A
          </span>
          <input
            type="range"
            className="panel-slider-input"
            aria-label={t('panel-size.curseur')}
            aria-valuetext={t('panel-size.pourcentage', { percent: shown })}
            min={PANEL_PERCENT_MIN}
            max={PANEL_PERCENT_MAX}
            step={PANEL_PERCENT_STEP}
            value={shown}
            disabled={here === null}
            onChange={(e) => {
              const value = Number(e.currentTarget.value)
              latest.current = value
              setDrag(value)
            }}
            onPointerUp={release}
            onKeyUp={release}
            onBlur={release}
          />
          <span className="panel-slider-large" aria-hidden="true">
            A
          </span>
          <span className="panel-slider-value" aria-live="polite">
            {t('panel-size.pourcentage', { percent: shown })}
          </span>
        </div>
        <div className="pref-hint">{choice === null && drag === null && here !== null ? t('panel-size.automatique-donne', { percent: auto }) : t('panel-size.apercu-aide')}</div>
      </div>

      {rows.length > 0 && (
        <div className="panel-screens">
          <div className="panel-screens-title">{t('panel-size.ecrans')}</div>
          {rows.map((row) => (
            <div key={row.screen.key} className="pref-row panel-screen-row">
              <div className="pref-label">
                {screenText(row.screen)}
                {!row.connected && <span className="pref-hint"> · {t('panel-size.non-branche')}</span>}
              </div>
              <div className="pref-control">
                <span className="panel-screen-choice">{row.percent === null ? t('panel-size.automatique') : t('panel-size.pourcentage', { percent: row.percent })}</span>
                {row.percent !== null && (
                  <button type="button" className="link-button" aria-label={t('settings.retirer-name', { name: screenText(row.screen) })} onClick={() => void api().dispatch({ type: 'panel-size/set', screen: infoOf(row.screen), percent: null })}>
                    {t('settings.retirer')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
;(PanelSizeRows as DrawsRows).rows = ['panelSizes']
