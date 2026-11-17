// The settings each profile keeps on its own (shared/profiles.ts: the search engine and its suggestions, the archive delay, the download folder) and
// the data a profile can clear. Each row is drawn where what it does is (the engine in Navigation, the delay in Onglets, the folder in Fichiers, the
// clearing in Vie privée), for the profile of the space on screen, with a mark that says so; and drawn again in Profils for the profile picked in its
// list (the four cross-references to Profils are gone). `place` says which of the two a row is.

import { useId, useState } from 'react'
import { fieldError } from './field-error'
import { eraseFailureText } from '@shared/history-scope'
import type { UiSnapshot } from '@shared/ipc'
import { SEARCH_ENGINES, type Settings } from '@shared/model'
import { archiveDelayNotice, archiveDelayPatch, profileArchiveHours, profileDownloadDir, profileLabel, profileSearch, profilesFollowingDefault, type ArchiveScope, type ProfileSettings } from '@shared/profiles'
import { isSearchTemplate } from '@shared/url'
import { api } from './api'
import { ArcDialog } from './ArcDialog'
import { Check, Choice, Dialog, Row, type DrawsRows } from './settings-parts'
import { t } from '@shared/i18n'

const CUSTOM_ENGINE = '__custom__'

// Functions, not constants: the words are read when the pane is drawn, in the language of the moment.
const archiveChoices = (): Array<[number, string]> => [[0, t('settings.jamais')], [6, t('settings.apres-6-heures')], [12, t('settings.apres-12-heures')], [24, t('settings.apres-1-jour')], [168, t('settings.apres-7-jours')], [720, t('settings.apres-30-jours')]]

export interface ProfileRowProps {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
  /** The profile the row sets. */
  profileId: string
  /**
   * Where the row is drawn: in the category of what it does, for the profile of the space on screen (the mark names it); on « Pour commencer », the same,
   * as a mirror; or in Profils, for the profile picked there (a mirror).
   */
  place: 'category' | 'home' | 'profiles'
}

/** Writes one setting of a profile: the default profile's values are the top-level settings, the others' are overrides. */
export function profileEditor(snapshot: UiSnapshot, update: (patch: Partial<Settings>) => void) {
  const { settings } = snapshot.state
  const patchProfile = (profileId: string, patch: ProfileSettings) => {
    const own = { ...settings.profiles[profileId] }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete own[key as keyof ProfileSettings]
      else (own as Record<string, unknown>)[key] = value
    }
    const { [profileId]: _old, ...others } = settings.profiles
    update({ profiles: Object.keys(own).length > 0 ? { ...others, [profileId]: own } : others })
  }
  /** Search engine, suggestions and archive delay of the default profile live at the top level. */
  const set = (profileId: string, patch: ProfileSettings) => {
    if (profileId !== 'default') return patchProfile(profileId, patch)
    const { searchUrlTemplate, searchSuggestions, autoArchiveHours, historyOff, proxy, ...own } = patch
    const top: Partial<Settings> = {}
    // The default profile's history and proxy are the global ones, which any profile without its own follows.
    if (historyOff !== undefined) top.historyOff = historyOff
    if (proxy !== undefined) top.proxy = proxy
    if (searchUrlTemplate !== undefined) top.searchUrlTemplate = searchUrlTemplate
    if (searchSuggestions !== undefined) top.searchSuggestions = searchSuggestions
    if (autoArchiveHours !== undefined) top.autoArchiveHours = autoArchiveHours
    if (Object.keys(top).length > 0) update(top)
    if ('downloadDir' in own) patchProfile(profileId, { downloadDir: own.downloadDir })
  }
  return set
}

/**
 * The address of a search engine of one's own. It is kept only once it is a usable search address: the settings refuse anything else, so saving at
 * every keystroke would put the field back to the previous address as soon as a half-typed one reached them (as with the server of the encrypted DNS).
 */
export function CustomEngineAddress({ value, onValid }: { value: string; onValid: (template: string) => void }) {
  const [text, setText] = useState(value)
  const invalid = text.trim() !== '' && !isSearchTemplate(text.trim())
  const error = fieldError(useId(), invalid)
  return (
    <>
      <input
        className="field"
        value={text}
        spellCheck={false}
        {...error.field}
        aria-label={t('settings-profiles.adresse-de-recherche')}
        placeholder={t('settings.exemple-adresse-de-recherche')}
        onChange={(e) => {
          setText(e.target.value)
          if (isSearchTemplate(e.target.value.trim())) onValid(e.target.value.trim())
        }}
      />
      {invalid && (
        <p className="dialog-error" {...error.message}>
          {t('settings-profiles.l-adresse-doit-commencer-par-http-s-et-contenir-s')}
        </p>
      )}
    </>
  )
}

/** "Réglages de la recherche": the address of a custom search engine (the dialog "Personnalisé" in the engine menu opens). */
function SearchEngineDialog({ snapshot, profileId, setProfile, onClose }: { snapshot: UiSnapshot; profileId: string; setProfile: (id: string, patch: ProfileSettings) => void; onClose: () => void }) {
  const search = profileSearch(snapshot.state.settings, profileId)
  const builtIn = SEARCH_ENGINES.some((e) => e.url === search.url)
  return (
    <Dialog
      title={t('settings-profiles.reglages-de-la-recherche')}
      onClose={onClose}
      actions={
        <button className="button primary" onClick={onClose}>
          {t('settings.termine')}
        </button>
      }
    >
      <label className="dialog-field">
        {t('settings.adresse-de-recherche-s-remplace-votre-saisie')}
        <CustomEngineAddress value={builtIn ? '' : search.url} onValid={(searchUrlTemplate) => setProfile(profileId, { searchUrlTemplate })} />
      </label>
    </Dialog>
  )
}

/**
 * The marks a row of a profile wears: in a category, the profile it is set for; in Profils, that it mirrors the row of a category. A profile other than
 * the default one shows its own value, which is not "changed" against the defaults of Lucium: no dot and no « Rétablir » (« Comme le défaut » instead).
 */
const marksOf = (snapshot: UiSnapshot, profileId: string, place: ProfileRowProps['place']) => ({
  ...(place === 'profiles' ? {} : { profile: profileLabel(snapshot.state.settings, profileId) }),
  ...(place === 'category' ? {} : { mirror: true }),
  ...(profileId === 'default' ? {} : { scope: 'profile' as const })
})

/** "Comme le défaut": the link that forgets a profile's own value, drawn only in Profils, for a profile that has one. */
function InheritLink({ inherits, own, onClick }: { inherits: boolean; own: boolean; onClick: () => void }) {
  if (!inherits || !own) return null
  return (
    <button className="link-button pref-inherit" onClick={onClick}>
      {t('settings.comme-le-defaut')}
    </button>
  )
}

/** The search engine of a profile and whether the engine is asked for suggestions. */
/** `engineOnly`: the engine without the row of the suggestions (« Pour commencer »). */
export function EngineRows({ snapshot, update, profileId, place, engineOnly = false }: ProfileRowProps & { engineOnly?: boolean }) {
  const { settings } = snapshot.state
  const setProfile = profileEditor(snapshot, update)
  const [custom, setCustom] = useState(false)
  const own = settings.profiles[profileId] ?? {}
  const search = profileSearch(settings, profileId)
  const engineName = SEARCH_ENGINES.find((e) => e.url === search.url)?.name ?? CUSTOM_ENGINE
  const inherits = place === 'profiles' && profileId !== 'default'
  const marks = marksOf(snapshot, profileId, place)
  return (
    <>
      <Row settingKey="searchUrlTemplate" label={t('settings-profiles.moteur-de-recherche')} hint={inherits && own.searchUrlTemplate === undefined ? t('settings-profiles.comme-le-profil-par-defaut') : undefined} {...marks}>
        <InheritLink inherits={inherits} own={own.searchUrlTemplate !== undefined} onClick={() => setProfile(profileId, { searchUrlTemplate: undefined })} />
        <select
          className="field pop"
          aria-label={t('settings-profiles.moteur-de-recherche')}
          value={engineName}
          onChange={(e) => {
            // "Personnalisé" opens the box where the address of an engine of one's own is typed.
            if (e.target.value === CUSTOM_ENGINE) return setCustom(true)
            setProfile(profileId, { searchUrlTemplate: SEARCH_ENGINES.find((x) => x.name === e.target.value)!.url })
          }}
        >
          {SEARCH_ENGINES.map((e) => (
            <option key={e.name}>{e.name}</option>
          ))}
          <option value={CUSTOM_ENGINE}>{t('menu.personnalise')}</option>
        </select>
      </Row>
      {!engineOnly && <Check settingKey="searchSuggestions" label={t('settings-profiles.inclure-les-suggestions-de-recherche')} hint={t('settings.ce-que-vous-tapez-part-vers-le-moteur-choisi')} more={t('settings.envoie-ce-que-vous-tapez-au-moteur-choisi')} checked={search.suggestions} onChange={(searchSuggestions) => setProfile(profileId, { searchSuggestions })} {...marks} />}
      {custom && <SearchEngineDialog snapshot={snapshot} profileId={profileId} setProfile={setProfile} onClose={() => setCustom(false)} />}
    </>
  )
}
// What the group around them counts (settings-parts.tsx, `DrawsRows`).
;(EngineRows as DrawsRows).rows = ['searchUrlTemplate', 'searchSuggestions']

/** The delay after which a tab of Today goes to the archive. For the default profile, the box asks whether the profiles that follow it change too. */
export function ArchiveRow({ snapshot, update, profileId, place }: ProfileRowProps) {
  const { settings } = snapshot.state
  const setProfile = profileEditor(snapshot, update)
  // A new archive delay of the default profile waits here while the user says whom it applies to.
  const [pending, setPending] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const own = settings.profiles[profileId] ?? {}
  const inherits = place === 'profiles' && profileId !== 'default'
  const label = profileLabel(settings, profileId)
  const change = (hours: number) => {
    if (hours === profileArchiveHours(settings, profileId)) return
    // The other profiles that follow the default one would change with it: the person is asked whether that is wanted.
    if (profileId === 'default' && profilesFollowingDefault(snapshot.state).length > 0) return setPending(hours)
    setProfile(profileId, { autoArchiveHours: hours })
    setNotice(archiveDelayNotice(hours, profileId === 'default' ? undefined : label))
  }
  const apply = (scope: ArchiveScope) => {
    const hours = pending
    setPending(null)
    if (hours === null) return
    update(archiveDelayPatch(snapshot.state, hours, scope))
    setNotice(archiveDelayNotice(hours, scope === 'only' ? label : undefined))
  }
  return (
    <>
      <Row settingKey="autoArchiveHours" label={t('settings-profiles.archiver-les-onglets-apres')} info={t('settings.un-onglet-du-jour-que-vous-n-avez-pas')} hint={inherits && own.autoArchiveHours === undefined ? t('settings-profiles.comme-le-profil-par-defaut') : undefined} {...marksOf(snapshot, profileId, place)}>
        <InheritLink inherits={inherits} own={own.autoArchiveHours !== undefined} onClick={() => setProfile(profileId, { autoArchiveHours: undefined })} />
        <Choice className="pop" label={t('settings-profiles.archiver-les-onglets-apres')} value={profileArchiveHours(settings, profileId)} choices={archiveChoices()} onChange={change} />
      </Row>
      {notice && (
        <div className="pref-row pref-message" role="status">
          {notice}
        </div>
      )}
      {pending !== null && (
        <Dialog
          title={t('settings-profiles.appliquer-a-tous-les-profils')}
          onClose={() => setPending(null)}
          actions={
            <>
              <button className="button" onClick={() => setPending(null)}>
                {t('settings.annuler')}
              </button>
              <button className="button" onClick={() => apply('only')}>
                {t('settings.seulement-ce-profil')}
              </button>
              <button className="button primary" onClick={() => apply('all')}>
                {t('settings.tous-les-profils')}
              </button>
            </>
          }
        >
          <p className="dialog-field">{t('settings.appliquer-a-tous-vos-profils-ou-seulement', { label })}</p>
        </Dialog>
      )}
    </>
  )
}
;(ArchiveRow as DrawsRows).rows = ['autoArchiveHours']

const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

/** The folder the downloads of a profile go to: the one of the system, or one chosen in its folder box. Not a setting of its own (it lives in `profiles`): a search finds it by its id. */
export function DownloadDirRow({ snapshot, update, profileId, place }: ProfileRowProps) {
  const setProfile = profileEditor(snapshot, update)
  const downloadDir = profileDownloadDir(snapshot.state.settings, profileId)
  /** Why « Autre… » chose nothing, when the folder box could not be opened. */
  const [problem, setProblem] = useState('')
  const choose = (value: string) => {
    setProblem('')
    if (value === 'default') setProfile(profileId, { downloadDir: undefined })
    else if (value === 'other')
      api()
        .chooseFolder()
        .then(
          (folder) => folder && setProfile(profileId, { downloadDir: folder }),
          (error: unknown) => {
            console.warn('[settings] the folder of the downloads could not be chosen:', error)
            setProblem(t('settings-profiles.dossier-non-choisi'))
          }
        )
  }
  return (
    <>
      <Row label={t('settings-profiles.dossier-de-telechargement')} hint={downloadDir} searchKey="downloadFolder" {...marksOf(snapshot, profileId, place)}>
        <span className="pop-with-icon">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.500" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 1.500v6M3.500 5.200 6 7.700l2.500-2.500M2 10.200h8" />
          </svg>
          <select className="field pop" aria-label={t('settings-profiles.dossier-de-telechargement')} value={downloadDir ? 'custom' : 'default'} onChange={(e) => choose(e.target.value)}>
            <option value="default">{t('sidebar.telechargements')}</option>
            {downloadDir && <option value="custom">{baseName(downloadDir)}</option>}
            <option value="other">{t('settings-profiles.autre')}</option>
          </select>
        </span>
      </Row>
      {problem && (
        <div className="pref-row pref-message" role="alert">
          {problem}
        </div>
      )}
    </>
  )
}

/** Clears the data of a profile and says how it went: the sentence of success, or why the main process could not (eraseFailureText). */
export function clearProfileData(clear: (profileId: string) => Promise<unknown>, profileId: string, label: string, say: (text: string) => void): Promise<void> {
  return clear(profileId).then(
    () => say(t('settings-profiles.donnees-du-profil-label-effacees', { label })),
    (error: unknown) => say(eraseFailureText(error))
  )
}

/** "Effacer les données de navigation" of a profile: cookies, sign-ins, storage, cache and history, after a confirmation; the extensions stay. */
export function ClearDataRow({ snapshot, profileId, place }: Omit<ProfileRowProps, 'update'>) {
  const [asking, setAsking] = useState(false)
  const [message, setMessage] = useState('')
  const label = profileLabel(snapshot.state.settings, profileId)
  return (
    <>
      <Row label={t('settings-profiles.effacer-les-donnees-de-navigation')} hint={t('settings-profiles.cookies-connexions-stockage-cache-et-historique', { label })} searchKey="clearProfileData" {...marksOf(snapshot, profileId, place)}>
        <button className="button" disabled={snapshot.private === true} onClick={() => setAsking(true)}>
          {t('settings.effacer')}
        </button>
      </Row>
      {message && (
        <div className="pref-row pref-message" role="status">
          {message}
        </div>
      )}
      {asking && (
        <ArcDialog
          title={t('settings-profiles.effacer-les-donnees-de-navigation-2')}
          message={t('settings-profiles.cookies-connexions-stockage-cache-et-historique', { label })}
          confirmLabel={t('settings.confirmer-l-effacement')}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false)
            void clearProfileData((id) => api().clearProfile(id), profileId, label, setMessage)
          }}
        />
      )}
    </>
  )
}
