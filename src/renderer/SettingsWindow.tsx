// The Settings window: a sidebar of 204 px (the search; « Pour commencer »; the 8 categories; « Fonctions en option » and « À propos et mises à jour »;
// « Réglages modifiés » at its foot), and the page: the rows that matter at its top, the rest in its one fold « Plus de réglages » (SettingsMore.tsx),
// and under it "Rétablir" for that category. A list or an editor is on a subpage of its page (shared/settings-subpages.ts), which its row opens and
// whose way back (or Escape) returns to that row. Nothing is hidden without being said. The window is 780 x 760 inside; the page scrolls, the window does
// not move. Its title bar says "Réglages"; the name of the page is written once, in its head. The rows are the ones of the old panes
// (SettingsCategories.tsx says where each one went), so every setting is still there, with the same words.

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { SETTINGS_PAGES, type SettingsPage, type SettingsSubpage, type UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { getLanguage, t, tp } from '@shared/i18n'
import { allModifiedKeys, categoryResetPlan, modifiedKeys, resetPlanOf, resolveSettingsTarget, SETTINGS_CATEGORIES, settingsPaneLabel, settingsPaneShortLabel, type SettingKey } from '@shared/settings-catalog'
import { activeProfileId } from '@shared/profiles'
import { matchesWords, queryWords, searchSuggestions } from '@shared/settings-search'
import { settingsAnswer } from '@shared/settings-answers'
import { platformOf } from '@shared/platform'
import { api, useSnapshot } from './api'
import { CategoryContent, type CategoryProps } from './SettingsCategories'
import { CategoryGlyph } from './settings-icons'
import { FeatureFilterContext, FoldPassContext, IllustrationContext, MirrorsContext, PaneContext, ResetContext, SearchingContext, SettingsStateContext, SubpageContext, type FeatureFilter, type JumpTarget } from './settings-context'
import { useActionNotice } from './notice-hold'
import { subpageAt, subpageById, subpageOfKey } from '@shared/settings-subpages'
import { CHEVRON_LEFT } from './settings-parts'
import { applySearch, clearHighlight } from './settings-filter'
import { BestResultLine, bestResultOf, openBestResult, sameBestResult, SearchAnswer, type BestResult } from './SettingsSearchHead'
import { GUIDED_SETUP_REQUEST, undoPatch, type GuidePlan, type GuideRecord } from '@shared/settings-guide'
import { GuideCard, GuideFlow, GuideSearchResult, type GuideScope } from './GuideSettings'
import { FLASH_MS, focusLanding, inClosedFold, landOnGroup, landingRow, typingIn } from './settings-anchor'
import { MoreSettings } from './SettingsMore'
import { showModifiedOnly } from './settings-modified-view'
import { useWindowTitle } from './window-title'

/** "#privacy/permissions": the page, then the group to scroll to. Anything else opens « Pour commencer »; an old pane leads to the page that took its place. */
const parseHash = (): { pane: SettingsPage; anchor: string } => {
  const [name = '', anchor = ''] = location.hash.replace(/^#/, '').split('/')
  const target = resolveSettingsTarget(name, anchor)
  return { pane: target?.pane ?? 'home', anchor: target?.anchor ?? '' }
}

/** The page shown when the address names none: « Pour commencer » (an empty address is the window opened with no place). */
const HOME: SettingsPage = 'home'


/** The address that opens the complete configuration (`#general/guide`, shared/settings-guide.ts). */
const isGuideAddress = (target: { anchor: string }): boolean => target.anchor === GUIDED_SETUP_REQUEST.anchor

/**
 * Once the complete configuration has opened, the address says the category again without the anchor (no `hashchange`): the menu, which sets the
 * same address, opens it again the next time.
 */
function forgetGuideAddress(): void {
  if (typeof history !== 'undefined' && typeof history.replaceState === 'function') history.replaceState(null, '', `#${GUIDED_SETUP_REQUEST.pane}`)
}

/** The words offered when a search finds nothing and a name of a category is not one. */
const suggestedWords = (): string[] => [t('settings.suggestion-veille'), t('settings.suggestion-cookies'), t('settings.suggestion-raccourci'), t('settings.suggestion-mini'), t('settings.suggestion-sombre'), t('settings.suggestion-bloquer'), t('settings.suggestion-telecharger'), t('settings.suggestion-proxy'), t('settings.suggestion-verrou')]


/** Under a category: how many of its settings are not at their default, and the button that puts them back (the notice offers to undo it). */
function ResetBar({ count, onReset }: { count: number; onReset: () => void }) {
  return (
    <div className="reset-bar">
      <span id="reset-info">{count === 0 ? t('settings.reset-none') : tp('settings.reset-some', count)}</span>
      <button className="button" type="button" disabled={count === 0} aria-describedby="reset-info" onClick={onReset} title={t('settings.reset-kept')}>
        {t('settings.reset-button')}
      </button>
    </div>
  )
}

/**
 * The head of a subpage: the way back to its page (« ‹ Vie privée et sécurité »), its name, which takes the focus when it opens (tabIndex -1: reached by
 * the script, not by Tab), and one line of what it holds.
 */
function SubpageHead({ pane, id, onBack }: { pane: SettingsPage; id: SettingsSubpage; onBack: () => void }) {
  const subpage = subpageById(id)
  return (
    <div className="settings-pane-head subpage-head">
      <div>
        <button type="button" className="subpage-back" aria-label={t('settings.sub-back', { name: settingsPaneLabel(pane) })} onClick={onBack}>
          {CHEVRON_LEFT}
          <span>{settingsPaneLabel(pane)}</span>
        </button>
        <h2 className="settings-pane-title" id="pane-heading" tabIndex={-1}>
          {t(subpage.title)}
        </h2>
        <p className="settings-blurb">{t(subpage.intro)}</p>
      </div>
    </div>
  )
}

interface Notice {
  text: string
  undo?: () => void
  /** The control that made it goes away with what it did (« Rétablir » of a row, of a page, « Tout rétablir »): its « Annuler » takes the focus. */
  focus?: boolean
}

/** What can take the focus in a row of the Settings. */
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * Where the focus goes once « Annuler » of a reset has put the settings back (its notice, and the button, go): the row it was for when it is still on
 * screen (in « Réglages modifiés » it is hidden until the snapshot says it is changed again), else the content of the window.
 */
export function focusAfterUndo(row: HTMLElement | null, content: HTMLElement | null): void {
  const control = row?.isConnected && row.closest('[hidden]') === null ? row.querySelector<HTMLElement>(FOCUSABLE) : null
  ;(control ?? content)?.focus({ preventScroll: true })
}

/**
 * The window, once the first snapshot has come. `initialQuery`, `initialOpen`, `initialGuide`, `initialGuideRecord` and `initialView`: the search, the card,
 * the questions, the answers applied last and the view (« Réglages modifiés ») it opens on (a test or a capture draws them without typing or clicking).
 */
export function SettingsWindow() {
  const snapshot = useSnapshot()
  // The title of the window (the Window menu, Mission Control) in the language the snapshot set: the page's own <title> is only the application's name.
  useWindowTitle(snapshot ? t('settings.reglages') : null)
  return snapshot ? <SettingsView snapshot={snapshot} /> : null
}

/** What the content shows: a page (a category), or « Réglages modifiés », every setting not at its default. */
export type SettingsViewName = 'page' | 'modified'

export function SettingsView({ snapshot, initialQuery = '', initialOpen = null, initialGuide = null, initialGuideRecord = null, initialView = 'page' }: {
  snapshot: UiSnapshot
  initialQuery?: string
  initialOpen?: SettingKey | null
  initialGuide?: GuideScope | null
  initialGuideRecord?: GuideRecord | null
  initialView?: SettingsViewName
}) {
  const [{ pane, anchor }, setLocation] = useState(parseHash)
  // The subpage the address shows (`#protection/filterlists`), or none: the page.
  const sub = subpageAt(pane, anchor || undefined)
  // The subpage just left by its way back (or Escape): its row on the page takes the focus once the page is drawn.
  const returnTo = useRef<SettingsSubpage | null>(null)
  // Counts the arrivals at an address: a link to the place the window is already at (the hash does not change) takes it there again.
  const [visit, setVisit] = useState(0)
  const [query, setQuery] = useState(initialQuery)
  const [open, setOpen] = useState<SettingKey | null>(initialOpen)
  const [notice, setNotice] = useState<Notice | null>(null)
  const undoButton = useRef<HTMLButtonElement>(null)
  // The questions open in the pane (a category, or all of them), and what the answers applied last changed, until the window closes or others are applied.
  const [guide, setGuide] = useState<GuideScope | null>(() => initialGuide ?? (isGuideAddress(parseHash()) ? 'all' : null))
  const [guideRecord, setGuideRecord] = useState<GuideRecord | null>(initialGuideRecord)
  // The row a result leads to, until the category it lives in is drawn and the row is on screen.
  const [pending, setPending] = useState<JumpTarget | null>(null)
  const [view, setView] = useState<SettingsViewName>(initialView)
  // Which pages have « Plus de réglages » open: closed at first, as each was left while the window stays open.
  const [moreOpen, setMoreOpen] = useState<Partial<Record<SettingsPage, boolean>>>({})
  const openMore = useCallback((at: SettingsPage, open = true) => setMoreOpen((current) => (current[at] === open ? current : { ...current, [at]: open })), [])
  // The filter of « Fonctions en option » (« Toutes / Allumées / Coupées »): kept while one goes to its subpages and back, put back to « Toutes » by any
  // other arrival (another page, a result, the page chosen again), so that nothing a link leads to is filtered out.
  const [featureFilter, setFeatureFilter] = useState<FeatureFilter>('all')
  const featureFilterHeld = useMemo(() => ({ filter: featureFilter, choose: setFeatureFilter }), [featureFilter])
  const shownPane = useRef(pane)
  shownPane.current = pane
  // The arrival the window has landed already (the category, its anchor, the visit, the search): a fold opened by hand afterwards does not land again.
  const landed = useRef('')
  const content = useRef<HTMLElement>(null)
  const results = useRef<HTMLDivElement>(null)
  const changedRoot = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const cats = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Going to a place (a link of a pane, the menu, the command bar) leaves the search and shuts the card that was open, and the questions.
    const onHash = () => {
      const next = parseHash()
      if (next.pane !== 'features' || shownPane.current !== 'features') setFeatureFilter('all')
      setLocation(next)
      setVisit((count) => count + 1)
      setQuery('')
      setOpen(null)
      setView('page')
      setGuide(isGuideAddress(next) ? 'all' : null)
      if (isGuideAddress(next)) forgetGuideAddress()
    }
    if (isGuideAddress(parseHash())) forgetGuideAddress()
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const words = queryWords(query)
  const searching = words.length > 0
  // What the query names that is not a setting (a command, something done from the page, something Lucium does not have): said above the results.
  const answer = searching ? settingsAnswer(query) : null
  // « Réglages modifiés » shows while no search does: a search typed there takes its place, and leaves the window where it was.
  const changedView = view === 'modified' && !searching

  const arrival = `${pane}/${anchor}/${visit}/${searching ? 'search' : 'page'}`
  const paneMoreOpen = moreOpen[pane] === true

  // "#privacy/permissions" scrolls to its group once the category is drawn, opening « Plus de réglages » first when the group waits there, lights it
  // for a moment, as a result of a search lights its row, and gives the focus to its title; any other change starts the category from its top. A subpage opens at its top with the focus
  // on its name; back on the page, the row that opened the subpage takes the focus again.
  useEffect(() => {
    const el = content.current
    if (!el || searching || pending || landed.current === arrival) return
    const group = anchor && anchor !== sub ? document.getElementById(anchor) : null
    const entry = sub === null && returnTo.current !== null ? el.querySelector<HTMLElement>(`[data-subpage-entry="${returnTo.current}"]`) : null
    // The fold opens, and the window lands once it is drawn open (this runs again).
    if (group && inClosedFold(group)) return openMore(pane)
    landed.current = arrival
    const end = landOnGroup(el, group)
    if (sub !== null) document.getElementById('pane-heading')?.focus({ preventScroll: true })
    else if (group) focusLanding(group)
    if (entry) {
      entry.scrollIntoView?.({ block: 'center' })
      entry.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    }
    if (sub === null) returnTo.current = null
    return end
  }, [pane, anchor, sub, searching, pending, arrival, paneMoreOpen, openMore])

  // A result that was opened: once its category is drawn, « Plus de réglages » is opened if the row waits there, and the row is scrolled to, lit, and
  // given the focus.
  useLayoutEffect(() => {
    const root = content.current
    // The row waits for its page, and for its subpage when it lives on one.
    if (!root || !pending || searching || pending.pane !== pane || (pending.sub ?? null) !== sub) return
    const row = pending.key ? landingRow(root, pending.key) : pending.group ? document.getElementById(pending.group) : null
    if (row && inClosedFold(row)) return openMore(pane)
    setPending(null)
    if (!row) return
    landed.current = arrival
    for (let fold = row.closest('details'); fold; fold = fold.parentElement?.closest('details') ?? null) fold.open = true
    row.scrollIntoView({ block: 'center' })
    row.classList.add('pref-flash')
    setTimeout(() => row.classList.remove('pref-flash'), FLASH_MS)
    row.querySelector<HTMLElement>('input, select, button, [tabindex]')?.focus({ preventScroll: true })
  }, [pane, sub, searching, pending, arrival, paneMoreOpen, openMore])

  // ⌘F, or "/" outside a field, goes to the search; Escape closes the card that is open (the box of a pane, if one is open, takes the Escape first).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const inField = e.target instanceof HTMLElement && e.target.matches('input, select, textarea, [contenteditable]')
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !inField)) {
        e.preventDefault()
        search.current?.focus()
        search.current?.select()
        return
      }
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.dialog-backdrop')) return
      const button = document.querySelector<HTMLElement>('.pref-illus-button[aria-expanded="true"]')
      if (button) {
        setOpen(null)
        button.focus()
        return
      }
      // « Réglages modifiés » goes back to the page it was opened over, the focus to that page in the sidebar.
      if (document.querySelector('.settings-changed-link[aria-current="page"]')) {
        e.preventDefault()
        setView('page')
        requestAnimationFrame(() => cats.current?.querySelector<HTMLElement>('.settings-cat[tabindex="0"]')?.focus())
        return
      }
      // A subpage goes back to its page, as its way back does; not while a field is being typed in (Escape is the field's there).
      const back = document.querySelector<HTMLButtonElement>('.subpage-back')
      if (back && !typingIn(e.target)) {
        e.preventDefault()
        back.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The notice of a reset goes by itself after ACTION_NOTICE_MS, and waits while the pointer or the focus is on it (on its « Annuler »). A reset whose button
  // goes with it gives that « Annuler » the focus: else the focus would fall on nothing, and « Annuler » would be out of reach of the keyboard. The time is
  // declared before the effect that moves the focus: the notice is held from the first moment.
  const timing = useActionNotice(notice, () => setNotice(null))
  useEffect(() => {
    if (notice?.focus) undoButton.current?.focus({ preventScroll: true })
  }, [notice])

  // In a search every category is drawn, and the rows that do not match are hidden: applied after every draw, since a list that grew has new rows.
  const [shown, setShown] = useState(0)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [best, setBest] = useState<BestResult | null>(null)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- applied after every draw on purpose: a list that grew has new rows; the state it sets only changes when the count does
  useLayoutEffect(() => {
    const root = results.current
    if (!root || !searching) {
      clearHighlight()
      return
    }
    const outcome = applySearch(root, query, words, { answered: answer !== null })
    setShown(outcome.shown)
    const first = bestResultOf(outcome.best)
    setBest((previous) => (sameBestResult(previous, first) ? previous : first))
    // The words offered when nothing matches: set only when they change (this runs after every draw, and a new list each time would draw again, for ever).
    const offered =
      outcome.shown === 0
        ? searchSuggestions(query, suggestedWords(), SETTINGS_CATEGORIES.map((category) => settingsPaneShortLabel(category.id)), (word) => outcome.units.filter((unit) => matchesWords(unit.text, queryWords(word))).length)
        : []
    setSuggestions((previous) => (previous.join('\n') === offered.join('\n') ? previous : offered))
  })

  const toggle = useCallback((key: SettingKey) => setOpen((current) => (current === key ? null : key)), [])
  const illustration = useMemo(() => ({ open, toggle }), [open, toggle])

  const { settings } = snapshot.state
  // The profile of the space on screen: the rows each profile keeps on its own show its values (settings-catalog.ts, `modifiedKeys`).
  const profileId = activeProfileId(snapshot.state)
  // « Annuler » of the answers reads the settings of the moment, not those of the draw that made the notice.
  const latest = useRef(settings)
  latest.current = settings
  const update = (patch: Partial<Settings>) => void api().dispatch({ type: 'settings/update', patch })
  // « Rétablir » on a row: its settings go back to their default (every one of a preset), and the notice offers to undo it.
  const resetOne = useCallback((keys: readonly SettingKey[], label?: string) => {
    const plan = resetPlanOf(keys, latest.current)
    if (!plan) return
    // The row of the « Rétablir » pressed, where the focus comes back after « Annuler ».
    const row = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-setting]') : null
    void api().dispatch({ type: 'settings/update', patch: plan.patch })
    setNotice({
      text: label ? t('settings.retabli', { name: label }) : t('settings.retabli-sans-nom'),
      focus: true,
      undo: () => {
        void api().dispatch({ type: 'settings/update', patch: plan.undo })
        setNotice(null)
        focusAfterUndo(row, content.current)
      }
    })
  }, [])
  const changedKeys = allModifiedKeys(settings, profileId)

  // « Réglages modifiés »: every category is drawn, and the rows of the settings at their default are hidden; applied after every draw, since a row put
  // back leaves the view at once.
  useLayoutEffect(() => {
    if (changedView && changedRoot.current) showModifiedOnly(changedRoot.current, new Set(allModifiedKeys(latest.current, profileId)))
  })

  // A link of a pane: another category (or a group of it); to the one that is shown already it leaves the search, since the address does not change.
  const goTo = (target: string) => {
    if (location.hash === `#${target}`) {
      setQuery('')
      setOpen(null)
      setGuide(null)
    } else location.hash = target
  }
  // A result: the row where it lives, once its category (and the subpage it lives on) is shown. A result that says only its key (the answer of a
  // search) finds its subpage in the map.
  const jump = useCallback((target: JumpTarget) => {
    const holder = target.key === undefined ? undefined : subpageOfKey(target.key)
    const lives = target.sub ?? (holder !== undefined && holder.pane === target.pane ? holder.id : undefined)
    const where: JumpTarget = lives === undefined ? target : { ...target, sub: lives }
    const hash = lives === undefined ? target.pane : `${target.pane}/${lives}`
    setPending(where)
    setOpen(null)
    setGuide(null)
    setView('page')
    setFeatureFilter('all')
    if (location.hash === `#${hash}` || (location.hash === '' && hash === HOME)) setQuery('')
    else location.hash = hash
  }, [])
  // The row of a subpage opens it, at its address; its way back leads to the page, where the row takes the focus again.
  const openSubpage = useCallback((id: SettingsSubpage) => {
    location.hash = `${subpageById(id).pane}/${id}`
  }, [])
  const closeSubpage = useCallback(() => {
    if (sub === null) return
    returnTo.current = sub
    location.hash = pane
  }, [pane, sub])
  const subpageNavigation = useMemo(() => ({ current: null, alone: false, open: openSubpage, close: closeSubpage }), [openSubpage, closeSubpage])
  // A row of « Réglages modifiés » says where it lives, as a result of a search does.
  const searchState = useMemo(() => ({ searching: searching || changedView, jump }), [searching, changedView, jump])
  const props: CategoryProps = { snapshot, update, goTo }

  const reset = () => {
    const plan = categoryResetPlan(pane, settings, profileId)
    if (!plan) return
    update(plan.patch)
    setNotice({
      text: tp('settings.reset-done', plan.keys.length, { name: settingsPaneLabel(pane) }),
      focus: true,
      undo: () => {
        update(plan.undo)
        setNotice(null)
        focusAfterUndo(null, content.current)
      }
    })
  }

  // « Tout rétablir » of « Réglages modifiés »: every setting not at its default goes back to it, and the notice offers to undo it.
  const resetAll = () => {
    const plan = resetPlanOf(allModifiedKeys(settings, profileId), settings)
    if (!plan) return
    update(plan.patch)
    setNotice({
      text: tp('settings.tout-retabli', plan.keys.length),
      focus: true,
      undo: () => {
        update(plan.undo)
        setNotice(null)
        focusAfterUndo(null, content.current)
      }
    })
  }
  const showChanged = () => {
    setQuery('')
    setOpen(null)
    setGuide(null)
    setView('modified')
    content.current?.scrollTo?.({ top: 0 })
  }

  // The questions: started from the card of a category or from a search, they take the place of the rows; closed, the focus goes back to the card.
  const startGuide = (scope: GuideScope) => {
    setQuery('')
    setOpen(null)
    setGuide(scope)
    content.current?.scrollTo?.({ top: 0 })
  }
  const closeGuide = () => {
    setGuide(null)
    requestAnimationFrame(() => content.current?.querySelector<HTMLElement>('.guide-start')?.focus())
  }
  const undoGuide = (record: GuideRecord) => {
    const patch = undoPatch(record, latest.current)
    if (Object.keys(patch).length > 0) update(patch)
    setGuideRecord(null)
    setNotice({ text: t('guide.remis') })
  }
  const applyGuide = (plan: GuidePlan) => {
    if (guide === null || plan.count === 0) return closeGuide()
    // Written through the ordinary path: the reducer cleans the patch as it cleans any change of a row.
    update(plan.patch)
    const record: GuideRecord = { scope: guide, patch: plan.patch, undo: plan.undo, count: plan.count }
    setGuideRecord(record)
    setNotice({ text: tp('guide.applique', plan.count), undo: () => undoGuide(record) })
    closeGuide()
  }

  const select = (id: SettingsPage, focus?: boolean) => {
    setView('page')
    if (location.hash === `#${id}` || (location.hash === '' && id === HOME)) {
      // Already there: the click still leaves the search and the questions, and starts the category again from its top, unfiltered.
      setQuery('')
      setOpen(null)
      setGuide(null)
      setFeatureFilter('all')
      content.current?.scrollTo({ top: 0 })
    } else location.hash = id
    if (focus) requestAnimationFrame(() => cats.current?.querySelector<HTMLElement>(`[data-cat="${id}"]`)?.focus())
  }
  // The list of the pages is one stop of the Tab key; the arrows move inside it (and open the page they reach, as the sidebar of the system does), Home
  // and End go to its ends, and Tab goes on to the page.
  const onCategoryKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const ids = SETTINGS_PAGES
    const at = ids.indexOf((e.target as HTMLElement).dataset['cat'] as SettingsPage)
    if (at < 0) return
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown'
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp'
    const next = forward ? (at + 1) % ids.length : back ? (at - 1 + ids.length) % ids.length : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : -1
    if (next < 0) return
    e.preventDefault()
    select(ids[next]!, true)
  }
  const onSearchKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter opens the best result where it lives.
    if (e.key === 'Enter' && searching) {
      e.preventDefault()
      openBestResult(results.current)
      return
    }
    if (e.key !== 'Escape' || query === '') return
    // Escape clears the search and hands the hand back to the category that was shown; it does not close anything else.
    e.preventDefault()
    e.nativeEvent.stopPropagation()
    setQuery('')
    setOpen(null)
  }

  const category = SETTINGS_CATEGORIES.find((c) => c.id === pane)!
  /** A page drawn among the others (a search, « Réglages modifiés »), under its name; « Pour commencer » without the rows it draws again. */
  const listed = (c: (typeof SETTINGS_CATEGORIES)[number]) => (
    <PaneContext.Provider key={c.id} value={c.id}>
      <MirrorsContext.Provider value={false}>
        <div className="results-cat" data-category-label={settingsPaneLabel(c.id)} lang={getLanguage()}>
          <h3 className="results-cat-title">{settingsPaneLabel(c.id)}</h3>
          <CategoryContent pane={c.id} {...props} />
        </div>
      </MirrorsContext.Provider>
    </PaneContext.Provider>
  )

  return (
    <SettingsStateContext.Provider value={settings}>
      <SubpageContext.Provider value={subpageNavigation}>
      <ResetContext.Provider value={resetOne}>
      <IllustrationContext.Provider value={illustration}>
          <SearchingContext.Provider value={searchState}>
          <FeatureFilterContext.Provider value={featureFilterHeld}>
            <div className={`settings-shell ${searching || changedView ? 'settings-searching' : ''} ${changedView ? 'settings-changed-view' : ''}`.replace(/\s+/g, ' ').trim()}>
              <header className="settings-titlebar" lang={getLanguage()}>
                <h1 className="settings-title" id="pane-title">
                  {t('settings.reglages')}
                </h1>
              </header>
              <div className="settings-body">
                <nav className="settings-nav" lang={getLanguage()} aria-label={t('settings.categories')}>
                  <input
                    ref={search}
                    className="field settings-search"
                    type="search"
                    placeholder={t('templates.rechercher')}
                    aria-label={t('settings.rechercher-un-reglage-f-ou')}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value)
                      setOpen(null)
                      setView('page')
                    }}
                    onKeyDown={onSearchKeys}
                  />
                  <div ref={cats} className="settings-cats" onKeyDown={onCategoryKeys}>
                    {SETTINGS_CATEGORIES.map((c, index) => {
                      // A dot after the name of a page that holds a setting not at its default; a screen reader is told how many.
                      const changed = modifiedKeys(c.id, settings, profileId).length
                      const current = !searching && !changedView && c.id === pane
                      // A rule between « Pour commencer », the categories and the two pages apart.
                      const rule = index > 0 && SETTINGS_CATEGORIES[index - 1]!.place !== c.place
                      return (
                        <Fragment key={c.id}>
                          {rule && <hr className="settings-cats-sep" aria-hidden="true" />}
                          <button type="button" className="settings-cat" data-cat={c.id} aria-current={current ? 'page' : undefined} tabIndex={c.id === pane ? 0 : -1} onClick={() => select(c.id)}>
                            <CategoryGlyph icon={c.icon} />
                            <span className="settings-cat-name">{settingsPaneShortLabel(c.id)}</span>
                            {changed > 0 && (
                              <span className="pref-changed settings-cat-changed" title={t('settings.modifie')}>
                                <span className="sr-only">{tp('settings.plus-modifies', changed)}</span>
                              </span>
                            )}
                          </button>
                        </Fragment>
                      )
                    })}
                  </div>
                  <div className="settings-nav-foot">
                  <button type="button" className="settings-changed-link" aria-current={changedView ? 'page' : undefined} disabled={changedKeys.length === 0} onClick={showChanged}>
                    <span>{changedKeys.length === 0 ? t('settings.modifies-aucun-lien') : t('settings.modifies-titre')}</span>
                    {changedKeys.length > 0 && (
                      <span className="settings-changed-count" aria-hidden="true">
                        {changedKeys.length}
                      </span>
                    )}
                    {changedKeys.length > 0 && <span className="sr-only">{tp('settings.plus-modifies', changedKeys.length)}</span>}
                  </button>
                  </div>
                </nav>

                <main ref={content} className="settings-content" aria-labelledby={searching ? 'pane-title' : 'pane-heading'} tabIndex={-1} lang={getLanguage()}>
                  {searching ? (
                    <div key="results" ref={results} className="settings-results">
                      <h2 aria-live="polite">{shown > 0 ? tp('settings.results-for', shown, { query: query.trim() }) : t('settings.results-none', { query: query.trim() })}</h2>
                      {answer && <SearchAnswer answer={answer} bindings={settings.keyBindings} platform={platformOf(snapshot.platform)} onOpen={jump} />}
                      {best && shown > 1 && <BestResultLine best={best} onOpen={() => openBestResult(results.current)} />}
                      {shown === 0 && !answer && (
                        <div className="settings-empty" role="status">
                          <b>{t('settings.rien-ne-correspond', { query: query.trim() })}</b>
                          <span>{t('settings.essayez-un-de-ces-mots')}</span>
                          <div className="settings-suggestions">
                            {suggestions.map((word) => (
                              <button key={word} type="button" className="button" onClick={() => setQuery(word)}>
                                {word}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <GuideSearchResult onStart={() => startGuide('all')} />
                      {SETTINGS_CATEGORIES.map(listed)}
                    </div>
                  ) : changedView ? (
                    <div key="changed" ref={changedRoot} className="settings-results settings-changed">
                      <div className="settings-pane-head">
                        <div>
                          <h2 className="settings-pane-title" id="pane-heading">
                            {t('settings.modifies-titre')}
                          </h2>
                          <p className="settings-blurb">{changedKeys.length === 0 ? t('settings.modifies-aucun') : t('settings.modifies-intro')}</p>
                        </div>
                      </div>
                      {SETTINGS_CATEGORIES.map(listed)}
                      <div className="reset-bar">
                        <span id="changed-info">{changedKeys.length === 0 ? t('settings.modifies-aucun') : tp('settings.plus-modifies', changedKeys.length)}</span>
                        <button className="button" type="button" disabled={changedKeys.length === 0} aria-describedby="changed-info" onClick={resetAll} title={t('settings.reset-kept')}>
                          {t('settings.tout-retablir')}
                        </button>
                      </div>
                    </div>
                  ) : guide !== null ? (
                    <GuideFlow scope={guide} settings={settings} onApply={applyGuide} onClose={closeGuide} />
                  ) : sub !== null ? (
                    // A subpage: its head, then what it holds, drawn by the panes of its page and nothing else of the page.
                    <PaneContext.Provider value={pane} key={`${pane}/${sub}`}>
                      <SubpageHead pane={pane} id={sub} onBack={closeSubpage} />
                      <FoldPassContext.Provider value={`sub:${sub}`}>
                        <CategoryContent pane={pane} {...props} />
                      </FoldPassContext.Provider>
                    </PaneContext.Provider>
                  ) : (
                    <PaneContext.Provider value={pane} key={pane}>
                      <div className="settings-pane-head">
                        <div>
                          <h2 className="settings-pane-title" id="pane-heading">
                            {settingsPaneLabel(pane)}
                          </h2>
                          <p className="settings-blurb">{t(category.blurb)}</p>
                        </div>
                      </div>
                      {/* The one entry of the guide, on « Pour commencer » (the cards at the head of each category are gone). */}
                      {pane === HOME && <GuideCard pane="all" settings={settings} last={guideRecord} onStart={() => startGuide('all')} onUndo={() => guideRecord && undoGuide(guideRecord)} />}
                      <FoldPassContext.Provider value="page">
                        <CategoryContent key={pane} pane={pane} {...props} />
                      </FoldPassContext.Provider>
                      <MoreSettings key={`more-${pane}`} settings={settings} open={paneMoreOpen} onToggle={(open) => openMore(pane, open)}>
                        <FoldPassContext.Provider value="more">
                          <CategoryContent pane={pane} {...props} />
                        </FoldPassContext.Provider>
                      </MoreSettings>
                      {/* « Rétablir » of a page; « Pour commencer », made of rows drawn again, has its own in each category. */}
                      {category.place !== 'start' && <ResetBar count={modifiedKeys(pane, settings, profileId).length} onReset={reset} />}
                    </PaneContext.Provider>
                  )}
                </main>
              </div>
              {notice && (
                <div className="settings-toast" role="status" {...timing.props}>
                  <span>{notice.text}</span>
                  {notice.undo && (
                    <button ref={undoButton} type="button" className="button" onClick={notice.undo}>
                      {t('settings.annuler')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </FeatureFilterContext.Provider>
          </SearchingContext.Provider>
      </IllustrationContext.Provider>
      </ResetContext.Provider>
      </SubpageContext.Provider>
    </SettingsStateContext.Provider>
  )
}
