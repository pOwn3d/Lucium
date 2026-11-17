import { Fragment, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { shortcutSheet, type HelpContext } from '@shared/shortcut-help'
import { isLeaveKey } from '@shared/panel-keys'
import { api, useSnapshot } from './api'
import { SearchGlyph, activeSpaceHue, hueProps, useFocusScope } from './templates'
import './shortcut-help.css'
import { settingsPath } from '@shared/settings-path'

/** The small picture before the title of a context, in the family of the panel templates (a 1.5 px stroke on a 16 grid). */
const GLYPH: Record<HelpContext, ReactNode> = {
  tabs: <path d="M2.500 4.500h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1ZM1.500 7h13" />,
  spaces: <><rect x="2" y="2" width="5" height="5" rx="1.200" /><rect x="9" y="2" width="5" height="5" rx="1.200" /><rect x="2" y="9" width="5" height="5" rx="1.200" /><rect x="9" y="9" width="5" height="5" rx="1.200" /></>,
  page: <path d="M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 11h4" />,
  window: <path d="M2 3.500h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM1 6.500h14" />,
  bar: <path d="m4 6 3 2-3 2M8 11h4" />
}

/** Highlights the part of a label the search matched (case and accents ignored), without ever writing the label as HTML. */
function marked(label: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return label
  const plain = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  // The folded text has the length of the original only when no letter lost or gained a mark; otherwise the label is shown whole.
  const folded = plain(label)
  const at = folded.length === label.length ? folded.indexOf(plain(needle)) : -1
  if (at < 0) return label
  return (
    <>
      {label.slice(0, at)}
      <mark>{label.slice(at, at + needle.length)}</mark>
      {label.slice(at + needle.length)}
    </>
  )
}

/**
 * The sheet of the shortcuts (⌘/): the thirty or so keys worth knowing, by context, with a search. A key the user changed in Réglages is marked with
 * a dot and its default crossed out (the colour is never the only sign); a key whose function is switched off says so. The list is read from the bindings
 * in force (`shared/shortcut-help.ts`), so it cannot give a key that is no longer the one.
 */
export function ShortcutHelp() {
  const snapshot = useSnapshot()
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusScope(root, { trap: true })
  const settings = snapshot?.state.settings
  const sheet = useMemo(
    () => (settings ? shortcutSheet(settings.keyBindings, { tabSearch: settings.tabSearch, shortcutHelp: settings.shortcutHelp, tabCycleRecent: settings.tabCycleRecent, notes: settings.notes }, query) : null),
    [settings, query]
  )
  if (!snapshot || !sheet) return null
  const { className: hueClass, style } = hueProps(activeSpaceHue(snapshot.state.spaces, snapshot.state.activeSpaceId))

  const leave = (): void => api().closeOverlay()
  // Escape empties the search first, then closes the sheet; the sheet owns the key (the host must not close it a second time).
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!isLeaveKey(e.nativeEvent)) return
    e.stopPropagation()
    if (query) setQuery('')
    else leave()
  }
  const edit = (): void => {
    api().closeOverlay()
    api().openOverlay({ panel: 'settings', pane: 'keyboard', anchor: 'shortcuts' })
  }

  return (
    <div ref={root} className={`sk tk-panel ${hueClass}`.trim()} style={style} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <header className="sk-head">
        <h2 id={titleId}>{t('shortcut-help.raccourcis-clavier')}</h2>
        <div className="tk-search sk-search">
          <SearchGlyph />
          <input className="tk-field" type="search" data-autofocus value={query} placeholder={t('shortcut-help.rechercher-un-raccourci')} aria-label={t('shortcut-help.rechercher-un-raccourci-2')} autoComplete="off" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="button" className="tk-btn" onClick={edit}>
          {t('shortcut-help.modifier')}
        </button>
        <button type="button" className="tk-btn quiet icon" aria-label={t('shortcut-help.fermer-echap')} title={t('shortcut-help.fermer-echap')} onClick={leave}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      {/* One stop of Tab for the whole list, which the arrows then scroll: a row does nothing, so it is not a stop. */}
      <div className="sk-cols" tabIndex={0} role="group" aria-labelledby={titleId}>
        {sheet.groups.map((group) => (
          <section key={group.context} className="sk-group" aria-labelledby={`${titleId}-${group.context}`}>
            <h3 id={`${titleId}-${group.context}`}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                {GLYPH[group.context]}
              </svg>
              {group.title}
            </h3>
            <ul>
              {group.rows.map((row) => (
                <li key={row.id} className={`sk-row${row.custom ? ' custom' : ''}${row.note && !row.custom ? ' note' : ''}`}>
                  <span className="sk-label">
                    {marked(row.label, query)}
                    {row.note && <small>{row.note}</small>}
                  </span>
                  {row.custom && (
                    <>
                      <span className="sk-dot" aria-hidden="true" />
                      {row.was && <del className="sk-was">{row.was}</del>}
                      <span className="sk-sr">{row.was ? t('shortcut-help.personnalise-avant', { keys: row.was }) : t('shortcut-help.personnalise')}</span>
                    </>
                  )}
                  <span className="sk-keys">
                    {row.keys.map((key, i) => (
                      <Fragment key={`${key}${i}`}>{key === '…' ? <span className="sk-gap">…</span> : <kbd className="tk-kbd">{key}</kbd>}</Fragment>
                    ))}
                  </span>
                  {row.also.length > 0 && (
                    <>
                      <span className="sk-or">{t('shortcut-help.ou')}</span>
                      <span className="sk-keys sk-also">
                        {row.also.map((key, i) => (
                          <Fragment key={`${key}${i}`}>{key === '…' ? <span className="sk-gap">…</span> : <kbd className="tk-kbd">{key}</kbd>}</Fragment>
                        ))}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {sheet.shown === 0 && (
          <div className="tk-empty sk-empty">
            <b>{t('shortcut-help.aucun-raccourci-pour', { query: query.trim() })}</b>
            <p>{t('shortcut-help.essayez-un-autre-mot')}</p>
            <button type="button" className="tk-btn" onClick={edit}>
              {t('shortcut-help.voir-les-n-raccourcis', { count: sheet.total })}
            </button>
          </div>
        )}
      </div>
      <footer className="sk-foot">
        <span className="sk-legend">
          <i className="sk-dot" aria-hidden="true" /> {t('shortcut-help.modifie-dans-reglages', { settingsPath: settingsPath('shortcuts') })}
        </span>
        <span className="sk-legend off">{t('shortcut-help.depend-d-un-reglage')}</span>
        <span className="sk-spacer" />
        <span>
          <kbd className="tk-kbd">{t('cmd.echap')}</kbd> {t('shortcut-help.fermer')}
        </span>
      </footer>
    </div>
  )
}
