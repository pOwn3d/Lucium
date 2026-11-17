// « Plus de réglages »: the one fold at the foot of a page of the Settings, which holds every row that is not at the top (shared/settings-placement.ts).
// Its line says what it holds before it is opened: the sections, by their titles, and how many settings, with a dot when one of them is not at its
// default. It is a button that says whether it is open (`aria-expanded`) and a region it controls; Return and Space open it, as any button.
//
// What it holds is read from the rows it draws, after each draw (as the search reads the rows it filters): one list of the groups, the panes, says it
// all, and the line never names a section the fold does not hold.

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Settings } from '@shared/model'
import { isModified, type SettingKey } from '@shared/settings-catalog'
import { t, tp } from '@shared/i18n'

/** What the fold holds: the titles of its sections in the order drawn, and the settings of its rows (a mirror is not counted twice). */
export interface FoldContents {
  sections: string[]
  keys: string[]
}

/** The sections and settings drawn under `body`. */
export function foldContentsOf(body: ParentNode): FoldContents {
  const sections: string[] = []
  for (const title of Array.from(body.querySelectorAll('.pref-section > h3 .pref-title'))) {
    const text = title.textContent?.trim() ?? ''
    if (text !== '' && !sections.includes(text)) sections.push(text)
  }
  const keys = new Set<string>()
  for (const holder of Array.from(body.querySelectorAll<HTMLElement>('[data-setting]:not([data-mirror])'))) for (const key of (holder.dataset['setting'] ?? '').split(' ')) if (key) keys.add(key)
  return { sections, keys: [...keys] }
}

const same = (a: FoldContents, b: FoldContents): boolean => a.sections.join('\n') === b.sections.join('\n') && a.keys.join(' ') === b.keys.join(' ')

/** The line of the fold, under its name: what it contains. Empty until the rows are drawn (the first draw, a static render). */
export const foldLine = (contents: FoldContents): string => (contents.sections.length === 0 ? '' : t('settings.plus-contient', { sections: contents.sections.join(' · ') }))

export function MoreSettings({ settings, open, onToggle, children }: { settings: Settings; open: boolean; onToggle: (open: boolean) => void; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null)
  const id = useId()
  const [contents, setContents] = useState<FoldContents>({ sections: [], keys: [] })
  // Read after every draw: a switch that is turned on may draw rows that wait here. Set only when it changes, so that it draws again once, not for ever.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- read after every draw on purpose: what the panes draw changes with the settings
  useLayoutEffect(() => {
    if (!body.current) return
    const read = foldContentsOf(body.current)
    setContents((previous) => (same(previous, read) ? previous : read))
  })
  const changed = contents.keys.filter((key) => isModified(settings, key as SettingKey)).length
  const empty = contents.keys.length === 0 && contents.sections.length === 0
  const line = foldLine(contents)
  return (
    // Drawn before it is known to hold anything (the rows are read after the draw), hidden once it is known to hold nothing.
    <div className="more-settings" data-empty={empty ? '' : undefined}>
      <h2 className="more-settings-head">
        <button type="button" className="more-settings-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => onToggle(!open)}>
          <span className="more-settings-title">{t('settings.plus-de-reglages')}</span>
          {contents.keys.length > 0 && <span className="more-settings-count">{tp('settings.count-settings', contents.keys.length)}</span>}
          {changed > 0 && (
            <span className="pref-changed" title={t('settings.modifie')}>
              <span className="sr-only">{tp('settings.plus-modifies', changed)}</span>
            </span>
          )}
          {line !== '' && <span className="more-settings-what">{line}</span>}
        </button>
      </h2>
      <div ref={body} id={`${id}-body`} className="more-settings-body" hidden={!open}>
        {children}
      </div>
    </div>
  )
}
