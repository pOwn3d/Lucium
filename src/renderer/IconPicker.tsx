// The icon of a space, chosen in one place: an emoji (the whole catalogue by category, a search that ignores accents, the recent ones), coloured
// letters, or a picture. The value is a `SpaceIconChoice` (shared/space-icon.ts): the three side by side, and which one shows. The panel that holds the picker
// applies it (the edit panel at once, the new-space sheet when it is created); a picture is the exception, because it is a file the main process makes.
//
// Keyboard: ⌘1, ⌘2, ⌘3 switch the type; in the search ↓ enters the grid, Escape clears the search first; in the grid the arrows go cell to cell (and from a
// category to the next, shared/grid-nav.ts), Return or Space chooses; Home and End go to the ends.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { getKeyPlatform, getLanguage, t, tp } from '@shared/i18n'
import { gridMove, isGridKey } from '@shared/grid-nav'
import { emojiCategories, isSpaceEmoji, isSpaceMark, searchEmojis, type EmojiEntry } from '@shared/space-emoji'
import { LETTER_COLORS, cleanIconLetter, pickerModeOfKey, readRecentEmojis, rememberEmoji, type SpaceIconChoice } from '@shared/space-icon'
import type { SpaceIconKind } from '@shared/model'
import { commandPress } from '@shared/platform'
import { SpaceMark } from './SpaceMark'
import { SearchGlyph } from './templates'
import './templates/primitives.css'
import './icon-picker.css'

/** Columns of the emoji grid (the stylesheet draws as many). */
const COLS = 8
const RECENT_KEY = 'lucium.recent-emoji'

function loadRecents(accepts: (value: unknown) => boolean): string[] {
  try {
    return readRecentEmojis(window.localStorage.getItem(RECENT_KEY), accepts)
  } catch (error) {
    console.warn('[icon picker] the recent emoji cannot be read (storage is not available):', error)
    return []
  }
}

function saveRecents(recent: readonly string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  } catch (error) {
    console.warn('[icon picker] the recent emoji cannot be kept (storage is not available):', error)
  }
}

/** What the picture tab shows and does. The picker never holds the file: the panel asks the main process, which answers with a sentence when it refuses. */
export interface PicturePart {
  /** The stored picture of the space, if it has one. */
  name?: string
  /** Why there is no picture to choose (a space that does not exist yet): the tab says it instead of disappearing. */
  reason?: string
  busy?: boolean
  /** A sentence about the last attempt ("L'image n'a pas pu être importée"). */
  message?: string
  onPick: () => void
  onClear: () => void
}

/** The picture tab of a picker that has none (`emojiOnly`): never drawn, so nothing here is called. */
const NO_PICTURE: PicturePart = { onPick: () => undefined, onClear: () => undefined }

export interface IconPickerProps {
  choice: SpaceIconChoice
  onChange: (next: SpaceIconChoice) => void
  /** Required for a space, which can wear a picture; left out with `emojiOnly`. */
  picture?: PicturePart
  /**
   * Only the emoji tab, without the type switch and its ⌘1-⌘3 keys: for what can wear an emoji and nothing else (the icon of a folder). A letter or a digit is
   * then no emoji either: the recent ones and a pasted value are checked as one emoji, not as the mark of a space. `choice.emoji` may be empty (nothing chosen yet).
   */
  emojiOnly?: boolean
  /** The drawing on the right (a SidebarThumb wearing the icon); without it the picker is one column. */
  preview?: ReactNode
  /** A class of the picker itself, for the panel that holds it. */
  className?: string
}

const KIND_LABELS: Record<SpaceIconKind, () => string> = {
  emoji: () => t('icon-picker.emoji'),
  letter: () => t('icon-picker.lettre'),
  image: () => t('space-image-picker.image')
}

const LETTER_COLOR_NAMES: ReadonlyArray<() => string> = [
  () => t('theme-colors.bleu'),
  () => t('theme-colors.corail'),
  () => t('theme-colors.orange'),
  () => t('theme-colors.vert'),
  () => t('theme-colors.lavande'),
  () => t('theme-colors.turquoise'),
  () => t('theme-colors.rose'),
  () => t('theme-colors.nuit')
]

interface Group {
  id: string
  label: string
  emojis: readonly EmojiEntry[]
}

/** The words a person can read on an emoji: its first keywords in the language of the interface. */
const titleOf = (entry: EmojiEntry): string => (getLanguage() === 'en' ? entry.en : entry.fr).slice(0, 3).join(' · ')

export function IconPicker({ choice, onChange, picture = NO_PICTURE, emojiOnly = false, preview, className }: IconPickerProps) {
  // The keys of the types are drawn for the system the window runs on (told to the texts with the snapshot); not told, no key is drawn.
  const platform = getKeyPlatform()
  const [mode, setMode] = useState<SpaceIconKind>(emojiOnly ? 'emoji' : choice.kind)
  const [query, setQuery] = useState('')
  const accepts = emojiOnly ? isSpaceEmoji : isSpaceMark
  const [recent, setRecent] = useState<string[]>(() => loadRecents(accepts))
  const [category, setCategory] = useState('')
  const [hint, setHint] = useState(false)
  // The one cell of the grid that Tab reaches (the others are reached by the arrows): the last one that had the focus.
  const [rover, setRover] = useState('')
  const opened = useRef(false)
  // What is in the letters field: it may be empty while a person types, which is not a choice (a space cannot wear no letters), so it is kept here.
  const [letters, setLetters] = useState(choice.letter)
  useEffect(() => setLetters(choice.letter), [choice.letter])
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const id = useId()

  // The type follows the choice when it changes from outside (Rétablir); the picture tab of a space that has no picture yet stays where it is, so that its button can be pressed.
  useEffect(() => {
    if (!opened.current) {
      opened.current = true
      return
    }
    if (emojiOnly) return
    setMode((was) => (was === 'image' && picture.name === undefined && choice.kind !== 'image' ? was : choice.kind))
  }, [choice.kind, picture.name, emojiOnly])

  const groups = useMemo<Group[]>(() => {
    const text = query.trim()
    if (text !== '') {
      const found = searchEmojis(text)
      // An emoji pasted in the search that the catalogue does not hold is still an emoji a space can wear, and so is one letter or one digit no keyword answers: it is offered as the one result.
      const pasted: readonly EmojiEntry[] = found.length === 0 && accepts(text) ? [{ emoji: text, en: [], fr: [], keywords: [] }] : found
      return [{ id: 'results', label: '', emojis: pasted }]
    }
    return emojiCategories().map((entry) => ({ id: entry.id, label: entry.label, emojis: entry.emojis }))
  }, [query, accepts])
  const searching = query.trim() !== ''
  // The grids that are drawn: a category with nothing in it (a search with no result) has none, and the keys count the ones there are.
  const sizes = groups.map((group) => group.emojis.length).filter((size) => size > 0)
  const cellKey = (groupId: string, index: number): string => `${groupId}:${index}`
  const firstCell = groups.find((group) => group.emojis.length > 0)
  const reachable = rover !== '' && groups.some((group) => group.emojis.some((_, index) => cellKey(group.id, index) === rover)) ? rover : firstCell ? cellKey(firstCell.id, 0) : ''

  const pickEmoji = (emoji: string): void => {
    const next = rememberEmoji(recent, emoji)
    setRecent(next)
    saveRecents(next)
    onChange({ ...choice, kind: 'emoji', emoji })
  }

  const show = (next: SpaceIconKind): void => {
    if (next === 'image') {
      setMode('image')
      setHint(picture.reason !== undefined)
      // A space with a picture wears it as soon as the tab is chosen; without one the tab only offers to choose.
      if (picture.name !== undefined) onChange({ ...choice, kind: 'image' })
      return
    }
    setHint(false)
    setMode(next)
    onChange({ ...choice, kind: next })
  }

  /** The cell buttons, in the order they are shown, grouped. */
  const cells = (): HTMLButtonElement[][] => (scroll.current ? Array.from(scroll.current.querySelectorAll<HTMLElement>('.ip-grid')).map((grid) => Array.from(grid.querySelectorAll<HTMLButtonElement>('button'))) : [])

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!isGridKey(event.key) || event.altKey || event.metaKey || event.ctrlKey) return
    const all = cells()
    const group = all.findIndex((buttons) => buttons.includes(event.target as HTMLButtonElement))
    if (group < 0) return
    const to = gridMove(sizes, { group, index: all[group]!.indexOf(event.target as HTMLButtonElement) }, event.key, COLS)
    event.preventDefault()
    if (!to) return
    const target = all[to.group]?.[to.index]
    target?.focus()
    target?.scrollIntoView?.({ block: 'nearest' })
  }

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && query !== '') {
      // The first Escape clears the search; the panel only closes at the next one.
      event.preventDefault()
      setQuery('')
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      cells()[0]?.[0]?.focus()
    }
  }

  const onRootKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const wanted = emojiOnly ? null : pickerModeOfKey(event.nativeEvent)
    if (wanted === null) return
    event.preventDefault()
    show(wanted)
  }

  const goTo = (target: string): void => {
    setCategory(target)
    if (searching) setQuery('')
    window.requestAnimationFrame(() => {
      const title = scroll.current?.querySelector<HTMLElement>(`[data-cat="${target}"]`)
      if (title && scroll.current) scroll.current.scrollTop = title.offsetTop - scroll.current.offsetTop
    })
  }

  // The tab of the category in view follows the scroll.
  const onScroll = (): void => {
    if (searching || !scroll.current) return
    const top = scroll.current.scrollTop + scroll.current.offsetTop + 8
    let active = ''
    for (const title of scroll.current.querySelectorAll<HTMLElement>('[data-cat]')) if (title.offsetTop <= top) active = title.dataset['cat'] ?? active
    setCategory(active)
  }

  const markSpace = { emoji: choice.emoji, iconKind: 'letter' as const, iconLetter: cleanIconLetter(letters) ?? cleanIconLetter(choice.letter) ?? undefined, iconColor: choice.color, iconRound: choice.round }

  return (
    <div ref={root} className={['ip', preview ? 'with-preview' : '', className].filter(Boolean).join(' ')} onKeyDown={onRootKey}>
      <div className="ip-main">
        {!emojiOnly && (
          <div className="ip-seg" role="group" aria-label={t('icon-picker.type-d-icone')}>
            {(['emoji', 'letter', 'image'] as const).map((kind) => (
              <button key={kind} type="button" aria-pressed={mode === kind} aria-disabled={kind === 'image' && picture.reason !== undefined ? true : undefined} onClick={() => show(kind)}>
                {KIND_LABELS[kind]()}
              </button>
            ))}
          </div>
        )}

        {mode === 'emoji' && (
          <div className="ip-mode">
            <div className="tk-search">
              <SearchGlyph />
              <input
                ref={search}
                className="tk-field"
                type="search"
                spellCheck={false}
                autoComplete="off"
                aria-label={t('icon-picker.rechercher-un-emoji')}
                placeholder={t('icon-picker.rechercher-parmi-tous-les-emojis')}
                value={query}
                data-autofocus
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKey}
              />
            </div>
            {!searching && recent.length > 0 && (
              <>
                <div className="ip-label" id={`${id}-recent`}>
                  {t('icon-picker.recents')}
                </div>
                <div className="ip-recents" role="group" aria-labelledby={`${id}-recent`}>
                  {recent.map((emoji) => (
                    <button key={emoji} type="button" aria-pressed={emoji === choice.emoji && choice.kind === 'emoji'} onClick={() => pickEmoji(emoji)}>
                      {emoji}
                    </button>
                  ))}
                </div>
              </>
            )}
            {!searching && (
              <div className="ip-pills" role="group" aria-label={t('icon-picker.categories')}>
                {groups.map((group) => (
                  <button key={group.id} type="button" aria-pressed={category === group.id || (category === '' && group.id === groups[0]?.id)} onClick={() => goTo(group.id)}>
                    {group.label}
                  </button>
                ))}
              </div>
            )}
            <div ref={scroll} className="ip-scroll" onKeyDown={onGridKey} onScroll={onScroll}>
              {searching && (
                <p className="ip-results" role="status">
                  {groups[0]!.emojis.length > 0 ? tp('icon-picker.resultats', groups[0]!.emojis.length, { query: query.trim() }) : t('icon-picker.aucun-emoji', { query: query.trim() })}
                </p>
              )}
              {searching && groups[0]!.emojis.length === 0 && <p className="ip-help">{t('icon-picker.aucun-emoji-aide')}</p>}
              {groups.map((group) =>
                group.emojis.length === 0 ? null : (
                  <section key={group.id}>
                    {!searching && (
                      <h3 className="ip-cat" data-cat={group.id}>
                        {group.label}
                      </h3>
                    )}
                    <div className="ip-grid" role="group" aria-label={group.label || undefined}>
                      {group.emojis.map((entry, index) => (
                        <button
                          key={entry.emoji}
                          type="button"
                          title={titleOf(entry)}
                          aria-pressed={entry.emoji === choice.emoji && choice.kind === 'emoji'}
                          tabIndex={cellKey(group.id, index) === reachable ? 0 : -1}
                          onFocus={() => setRover(cellKey(group.id, index))}
                          onClick={() => pickEmoji(entry.emoji)}
                        >
                          {entry.emoji}
                        </button>
                      ))}
                    </div>
                  </section>
                )
              )}
            </div>
          </div>
        )}

        {mode === 'letter' && (
          <div className="ip-mode">
            <div className="ip-letter">
              <SpaceMark space={markSpace} className="ip-big" />
              <label className="ip-field">
                <span>{t('icon-picker.lettres')}</span>
                <input
                  className="tk-field"
                  type="text"
                  value={letters}
                  maxLength={4}
                  spellCheck={false}
                  autoComplete="off"
                  data-autofocus
                  aria-label={t('icon-picker.lettres-de-l-icone')}
                  onChange={(event) => {
                    const typed = cleanIconLetter(event.target.value) ?? ''
                    setLetters(typed)
                    if (typed !== '') onChange({ ...choice, kind: 'letter', letter: typed })
                  }}
                />
              </label>
              <div className="ip-field">
                <span id={`${id}-shape`}>{t('icon-picker.forme')}</span>
                <div className="ip-seg" role="group" aria-labelledby={`${id}-shape`}>
                  <button type="button" aria-pressed={!choice.round} onClick={() => onChange({ ...choice, kind: 'letter', round: false })}>
                    {t('icon-picker.carre')}
                  </button>
                  <button type="button" aria-pressed={choice.round} onClick={() => onChange({ ...choice, kind: 'letter', round: true })}>
                    {t('icon-picker.rond')}
                  </button>
                </div>
              </div>
            </div>
            <div className="ip-label" id={`${id}-color`}>
              {t('icon-picker.couleur')}
            </div>
            <div className="ip-colors" role="group" aria-labelledby={`${id}-color`}>
              {LETTER_COLORS.map((color, index) => (
                <button
                  key={color}
                  type="button"
                  style={{ background: color }}
                  aria-label={LETTER_COLOR_NAMES[index]?.() ?? color}
                  title={LETTER_COLOR_NAMES[index]?.() ?? color}
                  aria-pressed={choice.color === color}
                  onClick={() => onChange({ ...choice, kind: 'letter', color })}
                />
              ))}
            </div>
            <p className="ip-help">{t('icon-picker.une-lettre-coloree-ressemble-aux-pastilles-des-favoris')}</p>
          </div>
        )}

        {mode === 'image' && (
          <div className="ip-mode">
            {hint && picture.reason && (
              <p className="ip-help" role="status">
                {picture.reason}
              </p>
            )}
            {!picture.reason && (
              <div className="ip-drop">
                <span className="ip-drop-mark" aria-hidden="true">
                  {picture.name ? <SpaceMark space={{ emoji: choice.emoji, image: picture.name, iconKind: 'image' }} className="ip-image" /> : <PictureGlyph />}
                </span>
                <b>{picture.name ? t('icon-picker.image-de-l-espace') : t('icon-picker.aucune-image')}</b>
                <span>{t('icon-picker.formats')}</span>
                <div className="ip-drop-actions">
                  <button type="button" className="tk-btn" disabled={picture.busy} onClick={picture.onPick}>
                    {picture.name ? t('icon-picker.choisir-une-autre-image') : t('icon-picker.choisir-une-image')}
                  </button>
                  {picture.name && (
                    <button type="button" className="tk-btn quiet" onClick={picture.onClear}>
                      {t('icon-picker.retirer-l-image')}
                    </button>
                  )}
                </div>
              </div>
            )}
            {picture.message && (
              <p className="ip-help ip-warn" role="status">
                {picture.message}
              </p>
            )}
          </div>
        )}

        {!emojiOnly && platform && (
          <p className="ip-keys" aria-hidden="true">
            <kbd className="tk-kbd">{commandPress('1', platform)}</kbd> {t('icon-picker.emoji')} <kbd className="tk-kbd">{commandPress('2', platform)}</kbd> {t('icon-picker.lettre')} <kbd className="tk-kbd">{commandPress('3', platform)}</kbd> {t('space-image-picker.image')}
          </p>
        )}
      </div>
      {preview && <div className="ip-side">{preview}</div>}
    </div>
  )
}

function PictureGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" focusable="false">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <circle cx="7" cy="8" r="1.5" />
      <path d="m2.5 14 4.5-4 3.5 3 2.5-2 4.5 4" />
    </svg>
  )
}
