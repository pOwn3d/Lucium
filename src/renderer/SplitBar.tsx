// The layout bar under the panes of a split view of two: 30 / 70, 50 / 50, 70 / 30, "Échanger" and, while the setting that
// offers it is on, "Défilement synchronisé". It sits in the strip the shell keeps free under the panes (shared/split.ts, `splitPaneStage`): a native page
// is never drawn under it. What it shows and what each button does is decided in shared/split-bar.ts.

import type { CSSProperties } from 'react'
import type { SplitView } from '@shared/model'
import { t } from '@shared/i18n'
import { presetLabel, splitBarAction, splitBarItems, type SplitBarItem } from '@shared/split-bar'
import { api } from './api'
import './split-bar.css'

const GLYPH = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

/** The icons of the two buttons that have one (16 px, 1.5 px stroke). */
export function SwapGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...GLYPH}>
      <path d="M3 5.500h10m-3-3 3 3-3 3M13 10.500H3m3-3-3 3 3 3" />
    </svg>
  )
}

export function SyncGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...GLYPH}>
      <path d="M5.500 3v10M3 10.500 5.500 13 8 10.500M10.500 13V3M8 5.500 10.500 3 13 5.500" />
    </svg>
  )
}

export function SplitBar({ split, scrollSync, synced, style }: { split: SplitView; scrollSync: boolean; synced: boolean; style: CSSProperties }) {
  const items = splitBarItems(split, { scrollSync, synced })
  if (items.length === 0) return null

  const run = (item: SplitBarItem) => {
    if (item.kind === 'sync') return api().setScrollSynced(split.id, !synced)
    const action = splitBarAction(split, item)
    if (action) void api().dispatch(action)
  }

  return (
    <div className="split-bar-row" style={style}>
      <div className="split-bar" role="group" aria-label={t('split-bar.disposition-des-volets')}>
        {items.map((item) => {
          if (item.kind === 'ratio') {
            return (
              <button key={`ratio-${item.first}`} type="button" className="sb-btn num" aria-pressed={item.pressed} onClick={() => run(item)}>
                {presetLabel(item.first)}
              </button>
            )
          }
          if (item.kind === 'swap') {
            return (
              <span key="swap" className="sb-group">
                <span className="sb-sep" aria-hidden="true" />
                <button type="button" className="sb-btn" onClick={() => run(item)}>
                  <SwapGlyph />
                  {t('split-bar.echanger')}
                </button>
              </span>
            )
          }
          return (
            <button key="sync" type="button" className="sb-btn" aria-pressed={item.pressed} title={t('split-bar.les-deux-volets-defilent-ensemble')} onClick={() => run(item)}>
              <SyncGlyph />
              {t('split-bar.defilement-synchronise')}
            </button>
          )
        })}
      </div>
    </div>
  )
}
