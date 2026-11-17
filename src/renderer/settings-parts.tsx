// Building blocks of the Settings window: the cards, the rows, the switch and the pictograms (drawn here, one stroke weight throughout).
//
// A row that stands for a setting says which (`settingKey`): the window then marks it when it is not at its default, offers the animated card of the few
// settings that have one (shared/settings-illustrations.ts), gives it its place (shared/settings-placement.ts: at the top of its page or in « Plus de
// réglages »), and the test of the structure finds it by its `data-setting`. What a feature costs is said in « Fonctions en option » only, in a sentence
// (`FeatureCheck`): the rows of the preferences carry no mark of it. A list or an editor is a subpage (`Subpage`, shared/settings-subpages.ts), which its
// page says by the row that opens it (`SubpageEntry`).

import { Children, cloneElement, Fragment, isValidElement, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { FEATURES, type Feature } from '@shared/features'
import { illustrationOf } from '@shared/settings-illustrations'
import type { SettingsSubpage, UiSnapshot } from '@shared/ipc'
import { isModified, settingsPaneLabel, type SettingKey } from '@shared/settings-catalog'
import { placementOf, type RowPlacement } from '@shared/settings-placement'
import { subpageById, subpageSummary, subpageTitle } from '@shared/settings-subpages'
import { foldText } from '@shared/settings-search'
import type { SearchId } from '@shared/settings-synonyms'
import { t } from '@shared/i18n'
import { FoldPassContext, GroupContext, IllustrationContext, MirrorsContext, PaneContext, ResetContext, SearchingContext, SettingsStateContext, SubpageContext, subpageOfPass } from './settings-context'
import { SettingIllustration } from './SettingIllustration'

/** The settings whose change a row shows and puts back: the ones it says (`changeKeys`), else its own. */
const changeKeysOf = (settingKey: SettingKey | undefined, changeKeys: readonly SettingKey[] | undefined): readonly SettingKey[] => changeKeys ?? (settingKey === undefined ? [] : [settingKey])

/**
 * Whether a row shows that its settings are not at their default (one of them is enough): never for a row that shows the own value of a profile other
 * than the default one (`scope`), whose way back is « Comme le défaut » in Profils.
 */
function useChanged(keys: readonly SettingKey[], scope: RowScope | undefined): boolean {
  const settings = useContext(SettingsStateContext)
  return settings !== null && scope !== 'profile' && keys.some((key) => isModified(settings, key))
}

/** The dot that says "not at its default", read by a screen reader as a word. */
function ChangedMark({ keys, scope }: { keys: readonly SettingKey[]; scope?: RowScope }) {
  if (!useChanged(keys, scope)) return null
  return (
    <span className="pref-changed" title={t('settings.modifie')}>
      <span className="sr-only">{t('settings.modifie')}</span>
    </span>
  )
}

/**
 * « Rétablir », on a row that is not at its default and on it only: puts its settings back (the window says so and offers to undo it), every one a
 * preset writes. Its name says which row. Inside the label of a switch, a browser leaves the click to the button: the switch does not flip.
 */
function ResetButton({ keys, label, scope }: { keys: readonly SettingKey[]; label: string | undefined; scope?: RowScope }) {
  const reset = useContext(ResetContext)
  const changed = useChanged(keys, scope)
  if (!reset || !changed) return null
  return (
    <button
      type="button"
      className="pref-reset"
      aria-label={label ? t('settings.retablir-name', { name: label }) : t('settings.retablir')}
      onClick={() => reset(keys, label)}
    >
      {t('settings.retablir')}
    </button>
  )
}

/** The "Voir l'effet" button of a setting that has a card, and the card under its row. Null for any other setting, or outside the window. */
function useIllustration(settingKey: string | undefined, label: string) {
  const state = useContext(IllustrationContext)
  const illustration = illustrationOf(settingKey)
  const panel = useId()
  if (!state || !illustration) return null
  const open = state.open === illustration.key
  return {
    open,
    button: (
      <button type="button" className="pref-illus-button" aria-expanded={open} aria-controls={panel} aria-label={t('settings-illustrations.voir-l-effet-de-name', { name: label })} onClick={() => state.toggle(illustration.key)}>
        {t('settings-illustrations.voir-l-effet')}
      </button>
    ),
    card: open ? (
      <div className="pref-illus" id={panel}>
        <SettingIllustration illustration={illustration} name={label} />
      </div>
    ) : null
  }
}

// ---------- the top of a page, and « Plus de réglages » ----------

/** The rows of a group, one after the other: an array is spread, a Fragment is looked into (a pane often wraps a few rows in one), each with a key of its own. */
function flatRows(children: ReactNode, prefix = ''): ReactNode[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child) || child.type !== Fragment) return [child]
    const inner = (child.props as { children?: ReactNode }).children
    return flatRows(inner, `${prefix}${String(child.key ?? '')}`).map((row, index) => (isValidElement(row) ? cloneElement(row, { key: `${prefix}${String(child.key ?? '')}${String(row.key ?? index)}` }) : row))
  })
}

/** What a row of a group says of its place: the key it stands for (`settingKey`, `data-setting`, or the feature of a `FeatureSwitch`), or a place given outright. */
interface RowPlace {
  placement: RowPlacement
  key?: SettingKey
}

/**
 * A component that draws several rows of settings at once (the rows of a profile, CurrentProfileSettings.tsx) says their keys here, so that the group
 * counts them and sends the component whole to « Plus de réglages » when every one of them waits there.
 */
export interface DrawsRows {
  rows?: readonly SettingKey[]
}

const isPlacement = (value: unknown): value is RowPlacement => value === 'page' || value === 'more'

/**
 * The settings a child of a Group stands for, with their place: none for what is not a setting (a message, an entry of a list, a form, a button), which
 * goes with its group; one for a row; several for a component that draws several rows (`rows`).
 */
function rowPlaces(node: ReactNode): RowPlace[] {
  if (!isValidElement(node)) return []
  const props = node.props as Record<string, unknown>
  // The row that opens a subpage stands for the settings the subpage holds, at the place the map gives it.
  if (node.type === SubpageEntry) {
    const subpage = subpageById(props['id'] as SettingsSubpage)
    return subpage.keys.map((key) => ({ placement: subpage.at, key }))
  }
  const key = typeof props['settingKey'] === 'string' ? (props['settingKey'] as SettingKey) : typeof props['data-setting'] === 'string' ? (props['data-setting'].split(' ')[0] as SettingKey) : undefined
  if (isPlacement(props['placement'])) return [{ placement: props['placement'], key }]
  if (isPlacement(props['data-placement'])) return [{ placement: props['data-placement'], key }]
  if (key !== undefined) return [{ placement: placementOf(key), key }]
  if (typeof node.type === 'function') {
    const rows = (node.type as DrawsRows).rows
    if (rows) return rows.map((one) => ({ placement: placementOf(one), key: one }))
    // The switch of a feature that has no row of its own (FeaturesSettings.tsx) is an element given the feature's id: its place is the one of the feature's setting.
    if (typeof props['id'] === 'string') {
      const feature = (FEATURES as readonly Feature[]).find((candidate) => candidate.id === props['id'])
      if (feature) return [{ placement: placementOf(feature.key), key: feature.key }]
    }
  }
  return []
}

/** The place of a child as a whole: in the fold when it stands for settings that all wait there, at the top when one of them is, null for what is no setting. */
const childPlacement = (places: readonly RowPlace[]): RowPlacement | null => (places.length === 0 ? null : places.every((row) => row.placement === 'more') ? 'more' : 'page')

/** The id of the section of a group: the one given, else one made of the category and the title (a result with no key of its own scrolls to it). */
const groupId = (pane: string | null, title: string | undefined, id: string | undefined): string | undefined => id ?? (title ? `g-${pane ?? 'pane'}-${foldText(title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : undefined)

/**
 * A group of rows: its title (17 px, a rule, the count of its settings), its card, its footnote. `keys`: the settings the group as a whole stands for (a list
 * and its form). `placement`: given outright for a group whose rows say nothing of theirs; otherwise the group waits in « Plus de réglages » when every
 * setting it holds does. A page is drawn twice (FoldPassContext): at its top a group draws the rows placed there, and in the fold the others, under the
 * same title; a group draws nothing in a part where it has no row. Drawn alone (a test, a search) it draws every row.
 */
export function Group({ title, footnote, more, children, className, keys, id, placement, searchKey }: { title?: string; footnote?: ReactNode; more?: MoreParagraphs; children: ReactNode; className?: string; keys?: readonly SettingKey[]; id?: string; placement?: RowPlacement; searchKey?: SearchId }) {
  const titleId = `${useId()}-title`
  const pass = useContext(FoldPassContext)
  const pane = useContext(PaneContext)
  const subpage = useContext(SubpageContext)
  // A subpage drawn alone draws nothing of the page around it: a group of the page is not on it (a group of the subpage is drawn by `Subpage`).
  if (subpageOfPass(pass) !== null) return null
  const drawnRows = flatRows(children)
  // Drawn whole (a search, « Réglages modifiés », a test), a page shows what its subpages hold where they are, not the rows that open them: a group
  // made only of such rows has nothing to show then.
  const rows = pass === 'all' ? drawnRows.filter((row) => !isSubpageEntry(row)) : drawnRows
  if (pass === 'all' && rows.length === 0 && drawnRows.length > 0) return null
  const placesOf = rows.map(rowPlaces)
  const childPlaces = placesOf.map(childPlacement)
  const flat = placesOf.flat()
  const placed = [...flat.map((row) => row.placement), ...(keys ?? []).map(placementOf)]
  const groupPlacement: RowPlacement = placement ?? (placed.length > 0 && placed.every((one) => one === 'more') ? 'more' : 'page')
  // A group that waits in the fold goes there whole (its messages and buttons with it); a group at the top sends there only its rows that wait.
  const waits = (index: number): boolean => groupPlacement === 'more' || childPlaces[index] === 'more'
  const part: RowPlacement | null = pass === 'page' || pass === 'more' ? pass : null
  const shown = part === null ? rows : rows.filter((_, index) => waits(index) === (part === 'more'))
  // An empty group (a list with nothing in it yet) keeps its title where it is placed.
  if (part !== null && (rows.length === 0 ? groupPlacement !== part : shown.length === 0)) return null
  const shownPlaces = part === null ? flat : placesOf.filter((_, index) => waits(index) === (part === 'more')).flat()
  // The settings the group stands for as a whole go with the part that draws them: a key that waits stays at the top while no row of the group waits.
  const foldDrawn = groupPlacement === 'more' || rows.some((_, index) => waits(index))
  const keyPart = (key: SettingKey): RowPlacement => (groupPlacement === 'more' || (placementOf(key) === 'more' && foldDrawn) ? 'more' : 'page')
  const ownKeys = (keys ?? []).filter((key) => part === null || keyPart(key) === part)
  const counted = new Set<string>([...shownPlaces.flatMap((row) => (row.key ? [row.key] : [])), ...ownKeys])
  const count = counted.size + shownPlaces.filter((row) => row.key === undefined).length
  // The anchor of a group that is split between the top and the fold is its part at the top: a link lands where the group starts.
  const sectionId = part === 'more' && groupPlacement === 'page' ? undefined : groupId(pane, title, id)
  const context = { title, id: sectionId }
  // The note of a group says one line; the rest of what it told waits behind « En savoir plus », under it.
  const noteShown = part !== 'more' || groupPlacement === 'more'
  // The button is named with the title of the group, which a hidden copy of it lends (the title itself keeps its markup).
  const noteMore = noteShown && paragraphsOf(more).length > 0 && (
    <div className="pref-note pref-note-more">
      {title && (
        <span id={titleId} hidden>
          {title}
        </span>
      )}
      <MoreText more={more} name={title ? titleId : undefined} />
    </div>
  )
  const note = footnote && noteShown && <p className="pref-note">{footnote}</p>
  // On a subpage the window shows, a group named as the subpage has no title of its own: the head of the subpage says it once.
  const repeated = subpage.alone && subpage.current !== null && title === subpageTitle(subpage.current)
  return (
    <GroupContext.Provider value={context}>
      <section className="pref-section" id={sectionId} data-setting={ownKeys.length > 0 ? ownKeys.join(' ') : undefined} data-search={part === 'more' && groupPlacement === 'page' ? undefined : searchKey} data-placement={groupPlacement}>
        {title && !repeated && (
          <h3>
            <span className="pref-title">{title}</span>
            {count > 0 && <span className="pref-count">{count}</span>}
          </h3>
        )}
        <div className={`pref-group ${className ?? ''}`}>{shown}</div>
        {note}
        {noteMore}
      </section>
    </GroupContext.Provider>
  )
}

/**
 * What a page holds that is no group of rows (an editor, a callout, a component whose groups all go to one place): drawn whole at the top of the page
 * (`at="page"`) or in « Plus de réglages » (`at="more"`), and only there (not on a subpage drawn alone). Drawn alone (a test, a search) it is drawn
 * where it is.
 */
export function Place({ at, children }: { at: RowPlacement; children: ReactNode }) {
  const pass = useContext(FoldPassContext)
  // Drawn whole already (a search, a test, a part drawn whole), it stays so; in its own part of the page, it is drawn whole, its subpages by their rows.
  if (pass === 'all' || pass === 'whole') return <>{children}</>
  if (pass !== at) return null
  return <FoldPassContext.Provider value="whole">{children}</FoldPassContext.Provider>
}

// ---------- the subpages ----------

const CHEVRON_RIGHT = (
  <svg className="subpage-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.500" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3.500 10.500 8 6 12.500" />
  </svg>
)
export const CHEVRON_LEFT = (
  <svg className="subpage-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.500" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 3.500 5.500 8 10 12.500" />
  </svg>
)

/**
 * The row that opens a subpage (shared/settings-subpages.ts), in a group of its page: its name, its state at its right (« 3 sites », « Automatique »),
 * a chevron, and the dot of a setting it holds that is not at its default. It stands for those settings (`data-setting`): « Plus de réglages » counts
 * them when the row waits there, and nothing they are is hidden without being said. A button: Return and Space open the subpage, as a click does.
 * Drawn on the page and in its fold only (in a part drawn whole there too, the catalogue of « Fonctions en option »); a page drawn whole (a search,
 * « Réglages modifiés ») shows what the subpage holds instead.
 */
export function SubpageEntry({ id, snapshot, summary }: { id: SettingsSubpage; snapshot: UiSnapshot; summary?: string }) {
  const pass = useContext(FoldPassContext)
  const { open } = useContext(SubpageContext)
  if (pass !== 'page' && pass !== 'more' && pass !== 'whole') return null
  const subpage = subpageById(id)
  const state = summary ?? subpageSummary(id, { settings: snapshot.state.settings, sitePermissions: snapshot.state.sitePermissions })
  return (
    <div className="pref-row subpage-entry" data-setting={subpage.keys.length > 0 ? subpage.keys.join(' ') : undefined} data-placement={subpage.at} data-subpage-entry={id}>
      <button type="button" className="subpage-open" onClick={() => open(id)}>
        <span className="pref-label">
          {t(subpage.title)}
          <ChangedMark keys={subpage.keys} />
        </span>
        {state !== '' && <span className="subpage-state">{state}</span>}
        {CHEVRON_RIGHT}
      </button>
    </div>
  )
}

/** Whether a child of a group is the row that opens a subpage. */
const isSubpageEntry = (node: ReactNode): boolean => isValidElement(node) && node.type === SubpageEntry

/**
 * What a subpage holds (its groups, its list, its editor), written in the pane where it belongs, beside the groups of the page and never inside one.
 * Drawn only when the window shows that subpage, and when the page is drawn whole (a search, « Réglages modifiés », a test), where it is: its rows are
 * found and marked like any other, and the way to them opens the subpage. Several parts of a pane may hold the same subpage: they are drawn in order.
 * Never inside a `Place`, which a subpage drawn alone does not draw.
 */
export function Subpage({ id, children }: { id: SettingsSubpage; children: ReactNode }) {
  const pass = useContext(FoldPassContext)
  const navigation = useContext(SubpageContext)
  const alone = subpageOfPass(pass)
  if (pass === 'page' || pass === 'more' || pass === 'whole' || (alone !== null && alone !== id)) return null
  return (
    <FoldPassContext.Provider value="all">
      <SubpageContext.Provider value={{ ...navigation, current: id, alone: alone === id }}>
        <div className="subpage-content" data-subpage={id} data-subpage-label={subpageTitle(id)}>
          {children}
        </div>
      </SubpageContext.Provider>
    </FoldPassContext.Provider>
  )
}

/** The mark of a row that is set for the profile of the space on screen ("profil « Perso »"): the other profiles are set in Profils. */
function ProfileChip({ name }: { name: string }) {
  return (
    <span className="pref-profile" title={t('settings.profile-chip-title')}>
      {t('settings.profile-chip', { name })}
    </span>
  )
}

/** In the results of a search, the way to the row where it lives: "Ouvrir dans Vie privée › Bloqueur". Null outside a search, or outside a category. */
function OpenIn({ settingKey }: { settingKey?: string }) {
  const { searching, jump } = useContext(SearchingContext)
  const pane = useContext(PaneContext)
  const group = useContext(GroupContext)
  const { current: sub } = useContext(SubpageContext)
  if (!searching || pane === null) return null
  // On a subpage the path names it, and the group only when it is not called the same: « Vie privée et sécurité › Exceptions par site › Sites sans blocage ».
  const subTitle = sub === null ? null : subpageTitle(sub)
  const path = [settingsPaneLabel(pane), subTitle, group?.title && group.title !== subTitle ? group.title : null].filter((part): part is string => !!part).join(' › ')
  const place = sub === null ? { pane } : { pane, sub }
  const target = settingKey !== undefined ? { ...place, key: settingKey } : group?.id !== undefined ? { ...place, group: group.id } : place
  return (
    <button
      type="button"
      className="pref-open"
      onClick={(e) => {
        e.preventDefault()
        jump(target)
      }}
    >
      {t('settings.open-in', { path })}
    </button>
  )
}

/** `profile`: the row shows the own value of a profile other than the default one (CurrentProfileSettings.tsx), not the setting of every profile. */
export type RowScope = 'profile'

/** What a row says of itself to the window: its key, its place on the page, the row it is a search alias of, and whether it mirrors a row of another category (Profils). */
interface RowMarks {
  settingKey?: SettingKey
  /**
   * The settings whose change the row marks (its dot) and puts back (« Rétablir »), when they are not its own key alone: every setting a preset writes
   * (settings-presets.ts); or, on a row that leaves its key to the preset standing for it (the switch of the windows of the last session), that setting.
   */
  changeKeys?: readonly SettingKey[]
  placement?: RowPlacement
  searchKey?: SearchId
  mirror?: boolean
  /** The row is set for this profile (the one of the space on screen): the mark says so. */
  profile?: string
  scope?: RowScope
}

const rowAttributes = ({ settingKey, placement, searchKey, mirror, scope }: RowMarks) => ({
  'data-setting': settingKey,
  'data-placement': placement ?? (settingKey ? placementOf(settingKey) : undefined),
  'data-search': searchKey,
  'data-mirror': mirror ? '' : undefined,
  'data-scope': scope
})

/** What a row or a note tells behind « En savoir plus »: one text, or a paragraph each. */
export type MoreParagraphs = string | readonly string[]

const paragraphsOf = (more: MoreParagraphs | undefined): readonly string[] => (more === undefined ? [] : typeof more === 'string' ? [more] : more).filter((text) => text !== '')

/**
 * « En savoir plus »: the button that unfolds the whole text of a row, of a feature or of the note of a group (the mechanism, the limits, the cases
 * apart), under its one line of help. One mechanism for every line of the window. `name`: the id of what the button is about, read with it by a screen
 * reader (« En savoir plus, Arbre d’onglets »). The search reads the text even folded (settings-filter.ts, as the long text of the row), never the button.
 * A click is kept from the label around it, so that it never flips the switch of the row.
 */
export function MoreText({ more, name }: { more: MoreParagraphs | undefined; name?: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const paragraphs = paragraphsOf(more)
  if (paragraphs.length === 0) return null
  const [buttonId, textId] = [`${id}-more-button`, `${id}-more`]
  return (
    <>
      <button
        type="button"
        className="pref-more-toggle"
        id={buttonId}
        aria-expanded={open}
        aria-controls={textId}
        aria-labelledby={name ? `${buttonId} ${name}` : undefined}
        onClick={(event) => {
          event.preventDefault()
          setOpen(!open)
        }}
      >
        {t('settings.en-savoir-plus')}
      </button>
      <div className="pref-more-text" id={textId} hidden={!open}>
        {paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
    </>
  )
}

/**
 * The « i » of a row: a sentence more about the setting. The pointer reads it in the bubble of its `title`; the keyboard reaches it with Tab, and
 * the sentence is then drawn under it (settings.css, from `data-tip`). `id` lets the control of the row name it as its description.
 */
export function InfoTip({ text, id }: { text: string; id?: string }) {
  return (
    <span className="pref-info" id={id} title={text} data-tip={text} role="img" aria-label={text} tabIndex={0}>
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.100" strokeLinecap="round" aria-hidden="true">
        <circle cx="7" cy="7" r="5.800" />
        <path d="M7 6.200v3.400" />
        <circle cx="7" cy="4.200" r="0.350" fill="currentColor" />
      </svg>
    </span>
  )
}

/** The elements of the page that are controls: what a row describes with its hint and its « i ». */
const CONTROL_TAGS = new Set(['select', 'input', 'button', 'textarea'])

/**
 * The controls of a row with the hint and the « i » of the row for description (`aria-describedby`), so that a screen reader says them with the
 * control and not only when its cursor walks over the text. Reaches the controls written in the row itself, inside plain elements or not, and the
 * menus drawn with `Choice`; a control that already says what describes it keeps its own answer.
 */
export function describedControls(children: ReactNode, describedBy: string | undefined): ReactNode {
  // The children are walked the same way whether there is a description or not: a hint that comes and goes (it follows the value of the control)
  // must not change the keys of the controls, which would draw them anew and take the focus away.
  return Children.map(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; 'aria-describedby'?: string }>(child)) return child
    if (child.type === Fragment) return <Fragment key={child.key}>{describedControls(child.props.children, describedBy)}</Fragment>
    if ((typeof child.type === 'string' && CONTROL_TAGS.has(child.type)) || child.type === Choice) return child.props['aria-describedby'] || !describedBy ? child : cloneElement(child, { 'aria-describedby': describedBy })
    if (typeof child.type === 'string' && child.props.children !== undefined) return cloneElement(child, undefined, describedControls(child.props.children, describedBy))
    return child
  })
}

/** The ids of the hint and of the « i » of a row, and what its control gives as `aria-describedby`: the two that exist. */
function useDescription(hint: string | undefined, info: string | undefined): { hintId: string | undefined; infoId: string | undefined; describedBy: string | undefined } {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const infoId = info ? `${id}-info` : undefined
  return { hintId, infoId, describedBy: [infoId, hintId].filter(Boolean).join(' ') || undefined }
}

export function Row({ label, hint, info, more, icon, children, className, settingKey, changeKeys, placement, searchKey, mirror, profile, scope }: { label: ReactNode; hint?: string; info?: string; more?: MoreParagraphs; icon?: ReactNode; children?: ReactNode; className?: string } & RowMarks) {
  // The card of a row is named by its label when that is a text (a row whose label is a node has no card).
  const illustration = useIllustration(settingKey, typeof label === 'string' ? label : '')
  const { hintId, infoId, describedBy } = useDescription(hint, info)
  const nameId = `${useId()}-name`
  const hasMore = paragraphsOf(more).length > 0
  const keys = changeKeysOf(settingKey, changeKeys)
  const reset = <ResetButton keys={keys} label={typeof label === 'string' ? label : undefined} scope={scope} />
  const changed = useChanged(keys, scope)
  const mirrors = useContext(MirrorsContext)
  if (mirror && !mirrors) return null
  return (
    <>
      <div className={`pref-row ${className ?? ''}`} {...rowAttributes({ settingKey, placement, searchKey, mirror, scope })}>
        {icon}
        <div className="pref-label">
          {hasMore ? <span id={nameId}>{label}</span> : label}
          {info && <InfoTip text={info} id={infoId} />}
          <ChangedMark keys={keys} scope={scope} />
          {profile && <ProfileChip name={profile} />}
          {hint && (
            <div className="pref-hint" id={hintId}>
              {hint}
            </div>
          )}
          {hasMore && <MoreText more={more} name={nameId} />}
          <OpenIn settingKey={settingKey ?? searchKey} />
        </div>
        {(children || illustration || changed) && (
          <div className="pref-control">
            {reset}
            {illustration?.button}
            {describedControls(children, describedBy)}
          </div>
        )}
      </div>
      {illustration?.card}
    </>
  )
}

export function Check({ label, hint, info, more, icon, checked, disabled, onChange, settingKey, changeKeys, placement, searchKey, mirror, profile, scope }: { label: string; hint?: string; info?: string; more?: MoreParagraphs; icon?: ReactNode; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void } & RowMarks) {
  const id = useId()
  const illustration = useIllustration(settingKey, label)
  const { hintId, infoId, describedBy } = useDescription(hint, info)
  const keys = changeKeysOf(settingKey, changeKeys)
  const text = (
    <>
      {label}
      {info && <InfoTip text={info} id={infoId} />}
      <ChangedMark keys={keys} scope={scope} />
      {profile && <ProfileChip name={profile} />}
      {hint && (
        <div className="pref-hint" id={hintId}>
          {hint}
        </div>
      )}
    </>
  )
  const open = <OpenIn settingKey={settingKey ?? searchKey} />
  const attributes = rowAttributes({ settingKey, placement, searchKey, mirror, scope })
  const reset = <ResetButton keys={keys} label={label} scope={scope} />
  const mirrors = useContext(MirrorsContext)
  if (mirror && !mirrors) return null
  const input = <input id={illustration || paragraphsOf(more).length > 0 ? id : undefined} type="checkbox" role="switch" aria-label={label} aria-describedby={describedBy} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
  // A row with a text behind « En savoir plus » is laid out as a line of « Fonctions en option »: the name alone is the label of the switch, so that the
  // button and the text it unfolds never flip it.
  if (paragraphsOf(more).length > 0)
    return (
      <>
        <div className="pref-row pref-check pref-check-split" {...attributes}>
          {icon}
          <div className="pref-label">
            <label htmlFor={id} id={`${id}-name`}>
              {label}
            </label>
            {info && <InfoTip text={info} id={infoId} />}
            <ChangedMark keys={keys} scope={scope} />
            {profile && <ProfileChip name={profile} />}
            {hint && (
              <div className="pref-hint" id={hintId}>
                {hint}
              </div>
            )}
            <MoreText more={more} name={`${id}-name`} />
            {open}
          </div>
          <div className="pref-control">
            {reset}
            {illustration?.button}
            {input}
          </div>
        </div>
        {illustration?.card}
      </>
    )
  // A row with a card keeps its button out of the label (a button inside one would take the click meant for the switch): the text is a label of its own.
  if (illustration)
    return (
      <>
        <div className="pref-row pref-check pref-check-split" {...attributes}>
          {icon}
          <label className="pref-label" htmlFor={id}>
            {text}
          </label>
          {open}
          <div className="pref-control">
            {reset}
            {illustration.button}
            {input}
          </div>
        </div>
        {illustration.card}
      </>
    )
  // The button of a result sits inside the label: a browser leaves a click on an interactive descendant to it, so the switch does not flip (OpenIn prevents the default too).
  return (
    <label className="pref-row pref-check" {...attributes}>
      {icon}
      <div className="pref-label">
        {text}
        {open}
      </div>
      {reset}
      {input}
    </label>
  )
}

/**
 * The line of a feature in « Fonctions en option »: its switch, the first sentence of what it does (`hint`), what it costs said in a sentence (`cost`),
 * and « En savoir plus », which unfolds the whole text (`more`, a paragraph each) under them. The name alone is the label of the switch, so that a click on the texts or on
 * the button leaves it as it is; the search reads the name as the row's name, the first sentence as its help, the whole text with the rest, and never
 * the words of the cost or of the button (settings-filter.ts), which every line has.
 */
export function FeatureCheck({ label, hint, cost, more, checked, disabled, onChange, settingKey }: { label: string; hint: string; cost: string; more?: readonly string[]; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; settingKey: SettingKey }) {
  const id = useId()
  const illustration = useIllustration(settingKey, label)
  const keys = [settingKey]
  const [nameId, hintId, costId] = ['name', 'hint', 'cost'].map((part) => `${id}-${part}`)
  return (
    <>
      <div className="pref-row pref-check pref-check-split pref-feature" {...rowAttributes({ settingKey })}>
        <div className="pref-label">
          <label htmlFor={id} id={nameId}>
            {label}
          </label>
          <ChangedMark keys={keys} />
          <div className="pref-hint" id={hintId}>
            {hint}
          </div>
          <div className="pref-cost" id={costId}>
            {cost}
          </div>
          <MoreText more={more} name={nameId} />
          <OpenIn settingKey={settingKey} />
        </div>
        <div className="pref-control">
          <ResetButton keys={keys} label={label} />
          {illustration?.button}
          <input id={id} type="checkbox" role="switch" aria-label={label} aria-describedby={`${hintId} ${costId}`} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        </div>
      </div>
      {illustration?.card}
    </>
  )
}

export function Choice({ value, choices, onChange, label, className, disabled, 'aria-describedby': describedBy }: { value: number; choices: Array<[number, string]>; onChange: (value: number) => void; label?: string; className?: string; disabled?: boolean; 'aria-describedby'?: string }) {
  // A value the menu does not list (a file of an older build, one edited by hand) is shown as it is: a menu with no matching entry would show its
  // first choice instead ("Jamais", "100 %"), which is not what the application does.
  const listed = choices.some(([v]) => v === value)
  return (
    <select className={`field ${className ?? ''}`} aria-label={label} aria-describedby={describedBy} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
      {!listed && <option value={value}>{value}</option>}
      {choices.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  )
}

/** A coloured square carrying a pictogram, the way the Advanced and Profiles panes label their rows. */
export function RowIcon({ color, children }: { color: 'blue' | 'green' | 'red' | 'purple' | 'yellow' | 'orange'; children: ReactNode }) {
  return (
    <span className={`pref-icon ${color}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.400" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  )
}

// Pictograms of the coloured row icons, on a 16 px grid.
export const ROW_ICONS = {
  speaker: <path d="M2.500 6.200h2.300L8 3.500v9L4.800 9.800H2.500zM10.500 5.800a3.300 3.300 0 0 1 0 4.400M12.300 4a5.800 5.800 0 0 1 0 8" />,
  restore: <path d="M2.500 4.500h11v7.500h-11zM2.500 7h11" />,
  drag: <path d="M2.500 3.800h11v8.400h-11zM2.500 6.300h11M6 9.600h4" />,
  url: <path d="M2.500 4.800h11v6.400h-11zM5 8h.01M8 8h.01M11 8h.01" strokeWidth="1.800" />,
  quotes: <path d="M3.800 9.800c0-2.400.9-3.800 2.700-4.300M9.300 9.800c0-2.400.9-3.800 2.700-4.300M3.600 9.200h2.200v2.400H3.600zM9.100 9.200h2.200v2.400H9.100z" />,
  pip: <path d="M2.500 3.800h11v8.400h-11zM6.500 6l3 2-3 2z" />,
  palette: <path d="M8 2.500a5.500 5.500 0 1 0 0 11c1 0 1.500-.7 1.200-1.500-.3-.9.300-1.700 1.300-1.700h1a2 2 0 0 0 2-2C13.500 4.500 11 2.500 8 2.500zM5.200 7.600h.01M7 5.200h.01M9.800 5.200h.01" strokeWidth="1.700" />,
  boost: <path d="M3 13 9.200 6.800M8.500 3.200l.7 1.500 1.500.7-1.500.7-.7 1.500-.7-1.500-1.500-.7 1.500-.7zM12 8.500l.4.9.9.4-.9.4-.4.9-.4-.9-.9-.4.9-.4z" />,
  lock: <path d="M4.500 7.200h7v5.800h-7zM5.800 7.200V5.600a2.200 2.200 0 0 1 4.400 0v1.600" />,
  key: <path d="M9.800 5.800a2.600 2.600 0 1 1-1.700-2.400M8 6.400 3.200 11.200l1.400 1.400M5.800 9.400l1.400 1.400" />,
  card: <path d="M2.500 4.800h11v6.600h-11zM2.500 7.200h11M4.500 10h2.500" />,
  bell: <path d="M4 11.200V8a4 4 0 0 1 8 0v3.200l1 1.200H3zM6.800 13.800h2.400" />,
  trash: <path d="M3 4.500h10M6.200 4.500V3h3.600v1.500M4.200 4.500l.6 8.300h6.400l.6-8.300M6.700 7v3.600M9.300 7v3.600" />
} as const

export const ARROW_RIGHT = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.300" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 8h11M9 4l4 4-4 4" />
  </svg>
)
export const PLUS = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.200" strokeLinecap="round" aria-hidden="true">
    <path d="M8 3v10M3 8h10" />
  </svg>
)
export const MINUS = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.200" strokeLinecap="round" aria-hidden="true">
    <path d="M3 8h10" />
  </svg>
)
export const RENAME = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.100" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.800 4.200H3.300a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h8.400a1 1 0 0 0 1-1V8.500M4.800 8h.01M7 8h.01M9.200 8h.01M10.500 7.200 14 3.700" strokeWidth="1.300" />
  </svg>
)
export const SEARCH = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.300" strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.600" />
    <path d="m10.500 10.500 3 3" />
  </svg>
)
export const COMMAND = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.300" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6V4.200A1.700 1.700 0 1 0 4.300 5.900H6zm0 0h4m-4 0v4m4-4V4.200a1.700 1.700 0 1 1 1.700 1.700H10zm0 0v4M6 10H4.300A1.700 1.700 0 1 0 6 11.800zm0 0h4m0 0v1.800a1.700 1.700 0 1 0 1.700-1.800z" />
  </svg>
)
export const DOTS = (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.500" cy="8" r="1.200" />
    <circle cx="8" cy="8" r="1.200" />
    <circle cx="12.500" cy="8" r="1.200" />
  </svg>
)

/**
 * What takes the focus when a box opens: its first field; in a box with no field, the first button of its foot (« Annuler » where there is one,
 * so that Return typed at once changes nothing), then any button. Never the first button whatever it is: in a box that lists rows before its
 * field, that was « Retirer » of the first row, which Return then pressed.
 */
export function dialogFirstFocus(box: Pick<HTMLElement, 'querySelector'>): HTMLElement | null {
  return (
    box.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ??
    box.querySelector<HTMLElement>('.dialog-actions button:not(:disabled)') ??
    box.querySelector<HTMLElement>('button:not(:disabled)')
  )
}

/** A small modal box inside the window (Escape or a click outside cancels). The cursor starts on its first field, or on the first button of its foot (`dialogFirstFocus`). */
export function Dialog({ title, children, actions, onClose }: { title: string; children: ReactNode; actions: ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // The focus comes back to what opened the box when it closes, and Tab stays inside it while it is open (it is modal).
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (box.current) dialogFirstFocus(box.current)?.focus()
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !box.current) return
      const stops = [...box.current.querySelectorAll<HTMLElement>('input, select, textarea, button, [tabindex]:not([tabindex="-1"])')].filter((el) => !(el as HTMLInputElement).disabled && el.offsetParent !== null)
      if (stops.length === 0) return
      const first = stops[0]!
      const last = stops[stops.length - 1]!
      const inside = box.current.contains(document.activeElement)
      if (!inside || (e.shiftKey && document.activeElement === first)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onTab)
    return () => {
      window.removeEventListener('keydown', onTab)
      if (opener?.isConnected) opener.focus()
    }
  }, [])
  // Heard on the window: removing a row takes the focused button with it, and Escape must still close the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  )
}
