// The presets in the Settings window (shared/settings-presets.ts): a choice among a few options that writes several settings at once, the line of
// what the option does under it, « Personnalisé » when the settings are none of the options, and after a choice a notice that says how many settings
// changed, with « Annuler » for ACTION_NOTICE_MS (it waits while the pointer or the focus is on it). The rows that changed are lit once (`pref-flash`,
// still when the motion is reduced). Nothing runs before a choice: one timer for the notice, one for the light, both cleared with the component.

import { useEffect, useId, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { Settings } from '@shared/model'
import { undoPatch } from '@shared/settings-guide'
import { inFold } from '@shared/settings-placement'
import { PRESETS, presetChange, presetKeys, presetNotice, presetNoticeText, presetOf, type PresetId, type PresetRecord } from '@shared/settings-presets'
import { useActionNotice } from './notice-hold'
import { radioGroupKeys } from './radio-keys'
import { FLASH_MS } from './settings-anchor'
import { Row } from './settings-parts'
import './settings-presets.css'

export interface PresetProps {
  preset: PresetId
  settings: Settings
  update: (patch: Partial<Settings>) => void
  /** Whether the row of a setting is out of sight on this page (under « Plus de réglages »): the notice counts those apart. */
  isFolded?: (key: keyof Settings) => boolean
}

interface Notice {
  text: string
  /** What « Annuler » puts back; absent once it was used (the notice then says the settings are back). */
  record?: PresetRecord
}

/** Lights the rows of these settings that the page shows, once, and answers how to stop early. */
export function lightRows(root: ParentNode, keys: readonly string[], timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis): () => void {
  const rows = [...new Set(keys.flatMap((key) => [...root.querySelectorAll<HTMLElement>(`[data-setting~="${key}"]`)]))]
  for (const row of rows) {
    // A row still lit from the choice before starts again: the class is taken off and put back after a reflow.
    row.classList.remove('pref-flash')
    void row.offsetWidth
    row.classList.add('pref-flash')
  }
  const timer = timers.setTimeout(() => rows.forEach((row) => row.classList.remove('pref-flash')), FLASH_MS)
  return () => {
    timers.clearTimeout(timer)
    rows.forEach((row) => row.classList.remove('pref-flash'))
  }
}

/**
 * The control of a preset, for a row that already has its name (the sleep in Onglets): the buttons or the menu, the line of the option, the notice.
 * `label` names the group for a screen reader.
 */
export function PresetControl({ preset: id, settings, update, isFolded, label }: PresetProps & { label?: string }) {
  const preset = PRESETS[id]
  const effectId = useId()
  const name = label ?? t(preset.label)
  // What was written and is not back from the main process yet: the next choice is computed from it, and the control shows it at once.
  const pending = useRef<{ from: Settings; now: Settings } | null>(null)
  const current = pending.current !== null && pending.current.from === settings ? pending.current.now : settings
  const latest = useRef(current)
  latest.current = current
  const [notice, setNotice] = useState<Notice | null>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const unlight = useRef<(() => void) | null>(null)
  const chosen = presetOf(preset, current)
  const option = preset.options.find((candidate) => candidate.id === chosen)

  const write = (patch: Partial<Settings>) => {
    update(patch)
    pending.current = { from: settings, now: { ...latest.current, ...patch } }
  }
  // The notice goes by itself after ACTION_NOTICE_MS, and waits while the pointer or the focus is on it (on « Annuler »).
  const timing = useActionNotice(notice, () => setNotice(null))
  useEffect(() => () => unlight.current?.(), [])

  const choose = (optionId: string) => {
    const change = presetChange(preset, latest.current, optionId, notice?.record ?? null)
    if (!change) return
    write(change.patch)
    const counted = presetNotice(change.record, pending.current!.now, isFolded)
    setNotice(counted.count > 0 ? { text: presetNoticeText(counted), record: change.record } : null)
    unlight.current?.()
    unlight.current = lightRows(groupRef.current?.ownerDocument ?? document, counted.keys)
  }
  const undo = () => {
    if (!notice?.record) return
    const patch = undoPatch(notice.record, latest.current)
    if (Object.keys(patch).length > 0) write(patch)
    setNotice({ text: t('guide.remis') })
    // The button goes with the notice: the focus goes back to the choice.
    requestAnimationFrame(() => (selectRef.current ?? groupRef.current?.querySelector<HTMLElement>('[aria-checked="true"], [role="radio"]'))?.focus())
  }

  return (
    <div className="preset" ref={groupRef}>
      {preset.control === 'buttons' ? (
        <div className="preset-buttons" role="radiogroup" aria-label={name} aria-describedby={effectId} onKeyDown={radioGroupKeys}>
          {preset.options.map((candidate, index) => {
            const on = candidate.id === chosen
            return (
              <button key={candidate.id} type="button" role="radio" aria-checked={on} tabIndex={on || (chosen === null && index === 0) ? 0 : -1} data-option={candidate.id} onClick={() => choose(candidate.id)}>
                {t(candidate.label)}
              </button>
            )
          })}
        </div>
      ) : (
        <select ref={selectRef} className="field pop preset-menu" aria-label={name} aria-describedby={effectId} value={chosen ?? 'custom'} onChange={(e) => choose(e.target.value)}>
          {chosen === null && (
            <option value="custom" disabled>
              {t('settings.personnalise')}
            </option>
          )}
          {preset.options.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {t(candidate.label)}
            </option>
          ))}
        </select>
      )}
      <p className="preset-effect" id={effectId}>
        {option ? (
          t(option.effect)
        ) : (
          <>
            <span className="preset-custom">{t('settings.personnalise')}</span> {t(preset.customEffect)}
          </>
        )}
      </p>
      <div className="preset-notice" role="status" {...timing.props}>
        {notice && (
          <>
            <span>{notice.text}</span>
            {notice.record && (
              <button type="button" className="link-button" title={t('guide.annuler-aide')} onClick={undo}>
                {t('presets.annuler')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The row of a preset: its name, then its control under it, in its category and again on « Pour commencer » (`mirror`). The row stands for the setting
 * its options tell apart, or carries a search id (`Preset.row`); its dot and its « Rétablir » are those of every setting it writes, so that the preset of
 * a new profile shows no change and « Rétablir » brings the whole of it back. Its notice counts apart the rows that wait in « Plus de réglages » on
 * their page (`inFold`, the table of shared/settings-placement.ts).
 */
export function PresetRow({ mirror, more, isFolded = inFold, ...props }: PresetProps & { mirror?: boolean; more?: string }) {
  const preset = PRESETS[props.preset]
  return (
    <Row className="preset-row" {...preset.row} changeKeys={presetKeys(preset)} mirror={mirror} label={t(preset.label)} more={more}>
      <PresetControl {...props} isFolded={isFolded} />
    </Row>
  )
}
