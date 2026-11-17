import { useState } from 'react'
import { AUTO_RELOAD_DEFAULT_SECONDS, INTERVAL_UNITS, isAutoReloadable, parseAutoReloadInterval, splitInterval, type IntervalUnit } from '@shared/auto-reload'
import type { TabItem } from '@shared/model'
import type { PlusAnchor } from '@shared/plus-menu'
import { t } from '@shared/i18n'
import { api, useSnapshot } from './api'
import { ReloadGlyph, Sheet, SheetField, useSpaceHue } from './templates'
import './auto-reload.css'

/** Waits for the first snapshot: the field starts from the tab's own interval. */
export function AutoReloadPanel({ tabId, anchor }: { tabId: string; anchor?: PlusAnchor }) {
  const snapshot = useSnapshot()
  const tab = snapshot?.state.tabs.find((t) => t.id === tabId)
  if (!tab) return null
  return <AutoReloadSheet tab={tab} anchor={anchor} />
}

/**
 * "Recharger automatiquement ▸ Personnalisé…": the interval of one tab typed in, in seconds, minutes or hours. The button is the
 * confirmation; the panel says what is wrong (too short, too long, not a number) rather than correcting the number silently.
 * A sheet of the small editors, hung from the row of the tab when the request knows it (`anchor`).
 */
function AutoReloadSheet({ tab, anchor }: { tab: TabItem; anchor?: PlusAnchor }) {
  const act = api()
  const hue = useSpaceHue()
  const start = splitInterval(tab.autoReload?.seconds ?? AUTO_RELOAD_DEFAULT_SECONDS)
  const [text, setText] = useState(start.value)
  const [unit, setUnit] = useState<IntervalUnit>(start.unit)
  const reloadable = isAutoReloadable(tab.url)
  const parsed = parseAutoReloadInterval(text, unit)
  const error = 'error' in parsed ? parsed.error : null

  const apply = () => {
    if ('seconds' in parsed && reloadable) void act.dispatch({ type: 'tab/auto-reload', id: tab.id, seconds: parsed.seconds })
    act.closeOverlay()
  }
  const stop = () => {
    void act.dispatch({ type: 'tab/auto-reload', id: tab.id, seconds: null })
    act.closeOverlay()
  }

  return (
    <Sheet
      className="auto-reload"
      title={t('menu.recharger-automatiquement')}
      context={tab.title}
      glyph={<ReloadGlyph />}
      hue={hue}
      anchor={anchor}
      side="right"
      onCancel={() => act.closeOverlay()}
      primary={{ label: tab.autoReload ? t('auto-reload-panel.appliquer') : t('auto-reload-panel.activer'), disabled: error !== null || !reloadable }}
      onSubmit={apply}
      footStart={
        <button type="button" className="tk-btn quiet danger" disabled={!tab.autoReload} onClick={stop}>
          {t('auto-reload-panel.desactiver')}
        </button>
      }
    >
      <p className="sh-help">{t('auto-reload-panel.aide')}</p>
      <SheetField label={t('auto-reload-panel.toutes-les')} error={error ?? (reloadable ? undefined : t('auto-reload-panel.page-non-rechargeable'))}>
        {(field) => (
          <span className="auto-reload-fields">
            <input className="tk-field" {...field} data-autofocus spellCheck={false} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
            <select className="tk-field" aria-label={t('auto-reload-panel.unite')} value={unit} onChange={(e) => setUnit(e.target.value as IntervalUnit)}>
              {INTERVAL_UNITS.map((u) => (
                <option key={u.unit} value={u.unit}>
                  {u.label}
                </option>
              ))}
            </select>
          </span>
        )}
      </SheetField>
    </Sheet>
  )
}
