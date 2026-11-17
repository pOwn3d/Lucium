// The Profiles pane (Settings): the list of profiles on the left, the settings of the picked one on the right. The rows a profile keeps on
// its own (the engine, the archive delay, the download folder, the clearing of its data) are those of CurrentProfileSettings.tsx, drawn here for the
// profile picked in the list; the categories draw them for the profile of the space on screen.

import { useState } from 'react'
import { eraseFailureText } from '@shared/history-scope'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { PROFILE_NAME_LIMIT, knownProfiles, planProfileCreation, profileLabel, profileLabels, profileRecordsHistory, validateProfileName } from '@shared/profiles'
import { finishPurge, purgePrompt, startPurge } from '@shared/profile-purge'
import { proxyOfProfile } from '@shared/proxy'
import { api } from './api'
import { ProxyEditor } from './ProxyEditor'
import { ArcDialog } from './ArcDialog'
import { ArchiveRow, ClearDataRow, DownloadDirRow, EngineRows, profileEditor } from './CurrentProfileSettings'
import { Check, Dialog, Group, MINUS, PLUS, RENAME, Row } from './settings-parts'
import { t, tp } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'
import { settingsPaneLabel } from '@shared/settings-catalog'

interface PaneProps {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

/** Creating a profile, in two steps: a name, then the spaces that will use the profile. */
function NewProfileDialog({ snapshot, onClose, onCreated }: { snapshot: UiSnapshot; onClose: () => void; onCreated: (id: string) => void }) {
  const { state } = snapshot
  const [step, setStep] = useState<'name' | 'spaces'>('name')
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  /** Why « Créer le profil » did nothing, when its request failed. */
  const [failure, setFailure] = useState('')
  const problem = name === '' ? null : validateProfileName(name, profileLabels(state))
  const canContinue = name !== '' && problem === null

  const create = () => {
    const plan = planProfileCreation(state, name, chosen)
    if (!plan.ok) return setStep('name')
    setFailure('')
    // Sent in their order (the name, then the spaces). The box closes on the new profile once they are done; a failure leaves it open and says so.
    Promise.all(plan.actions.map((action) => api().dispatch(action))).then(
      () => onCreated(plan.id),
      (error: unknown) => {
        console.warn('[profiles] the profile could not be created:', error)
        setFailure(t('settings-profiles.profil-non-cree'))
      }
    )
  }

  if (step === 'name') {
    return (
      <Dialog
        key="name"
        title={t('settings-profiles.creer-un-profil')}
        onClose={onClose}
        actions={
          <>
            <button className="button" onClick={onClose}>
              {t('settings-profiles.annuler')}
            </button>
            <button className="button primary" disabled={!canContinue} onClick={() => setStep('spaces')}>
              {t('settings-profiles.continuer')}
            </button>
          </>
        }
      >
        <label className="dialog-field">
          {t('settings-profiles.comment-voulez-vous-appeler-ce-profil')}
          <input
            className="field"
            placeholder={t('settings-profiles.nom-du-profil')}
            maxLength={PROFILE_NAME_LIMIT}
            aria-invalid={problem !== null}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canContinue && setStep('spaces')}
          />
        </label>
        {problem && (
          <p className="dialog-error" role="alert">
            {problem}
          </p>
        )}
      </Dialog>
    )
  }

  return (
    <Dialog
      key="spaces"
      title={t('settings-profiles.profil-label', { label: name.trim() })}
      onClose={onClose}
      actions={
        <>
          <button className="button" onClick={() => setStep('name')}>
            {t('settings-profiles.retour')}
          </button>
          <button className="button primary" onClick={create}>
            {t('settings-profiles.creer-le-profil')}
          </button>
        </>
      }
    >
      <div className="dialog-field">{t('settings-profiles.quels-espaces-doivent-utiliser-ce-profil')}</div>
      <div className="dialog-spaces" role="group" aria-label={t('settings-profiles.espaces-du-profil')}>
        {state.spaces.map((space) => (
          <label key={space.id} className="dialog-space">
            <input type="checkbox" checked={chosen.includes(space.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, space.id] : chosen.filter((id) => id !== space.id))} />
            <span>
              {space.emoji} {space.name}
            </span>
            <span className="muted">{profileLabel(state.settings, space.profileId)}</span>
          </label>
        ))}
      </div>
      {failure && (
        <p className="dialog-error" role="alert">
          {failure}
        </p>
      )}
      <p className="dialog-note">{t('settings-profiles.chaque-profil-a-ses-propres-donnees')}</p>
    </Dialog>
  )
}

/** Renaming a profile: the name of a profile, never the names of its spaces. */
function RenameProfileDialog({ snapshot, profileId, onClose }: { snapshot: UiSnapshot; profileId: string; onClose: () => void }) {
  const { settings } = snapshot.state
  const [name, setName] = useState(profileLabel(settings, profileId))
  const trimmed = name.trim()
  const unchanged = trimmed === profileLabel(settings, profileId)
  const problem = trimmed === '' || unchanged ? null : validateProfileName(trimmed, profileLabels(snapshot.state, profileId))
  const canSave = trimmed !== '' && !unchanged && problem === null
  const save = () => {
    if (!canSave) return
    void api().dispatch({ type: 'settings/update', patch: { profileNames: { ...settings.profileNames, [profileId]: trimmed } } })
    onClose()
  }
  return (
    <Dialog
      title={t('settings-profiles.renommer-votre-profil')}
      onClose={onClose}
      actions={
        <>
          <button className="button" onClick={onClose}>
            {t('settings-profiles.annuler')}
          </button>
          <button className="button primary" disabled={!canSave} onClick={save}>
            {t('settings-profiles.renommer')}
          </button>
        </>
      }
    >
      <label className="dialog-field">
        {t('settings-profiles.nom-du-profil')}
        {/* Named by its label: a name of its own carried the technical identifier of the profile, which a screen reader then read. */}
        <input className="field" maxLength={PROFILE_NAME_LIMIT} aria-invalid={problem !== null} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </label>
      {problem && (
        <p className="dialog-error" role="alert">
          {problem}
        </p>
      )}
      <p className="dialog-note">{t('settings-profiles.cela-ne-change-pas-le-nom-des-espaces-associes')}</p>
    </Dialog>
  )
}

/** "Nettoyer": the unused profiles are named, with what goes with them, before any of it is erased. */
function PurgeDialog({ names, onCancel, onConfirm }: { names: string[]; onCancel: () => void; onConfirm: () => void }) {
  const prompt = purgePrompt(names)
  return <ArcDialog title={prompt.title} message={prompt.message} items={prompt.items} confirmLabel={prompt.confirm} cancelLabel={t('confirm-box.annuler')} onCancel={onCancel} onConfirm={onConfirm} />
}

export function ProfilesPane({ snapshot, update }: PaneProps) {
  const { settings, spaces } = snapshot.state
  const ids = knownProfiles(snapshot.state)
  const [selected, setSelected] = useState('default')
  const [dialog, setDialog] = useState<'create' | 'rename' | 'delete' | null>(null)
  const [message, setMessage] = useState('')
  // The unused profiles "Nettoyer" found, while the box that asks whether to erase them is open: nothing is erased before its confirmation.
  const [purging, setPurging] = useState<string[] | null>(null)
  const setProfile = profileEditor(snapshot, update)

  const id = ids.includes(selected) ? selected : 'default'
  const using = spaces.filter((s) => s.profileId === id)
  const own = settings.profiles[id] ?? {}
  const inherits = id !== 'default'
  const label = profileLabel(settings, id)
  const cannotDelete = id === 'default' || using.length > 0

  const remove = () => {
    setDialog(null)
    // The main process erases everything, then forgets the name and retires the id (shared/profile-retire.ts). The profile stays listed if its data
    // could not all be erased: the message says why.
    void api()
      .deleteProfile(id)
      .catch((error: unknown) => setMessage(eraseFailureText(error)))
    setSelected('default')
  }

  return (
    <>
      <p className="pref-intro">{t('settings-profiles.les-profils-separent-vos-donnees')}</p>
      <div className="profiles-layout" data-setting="profileNames profiles">
        <div className="profile-box">
          <div className="profile-box-head">{t('settings-profiles.vos-profils')}</div>
          {/* Buttons, each reached with Tab and saying whether it is the one shown: a list of options promised arrows and one stop of Tab, which it did not have. */}
          <div className="profile-list" role="group" aria-label={t('settings.pane-profiles')}>
            {ids.map((profile) => {
              const count = spaces.filter((s) => s.profileId === profile).length
              return (
                <button key={profile} aria-pressed={profile === id} className={profile === id ? 'current' : ''} onClick={() => setSelected(profile)}>
                  <span>{profileLabel(settings, profile)}</span>
                  <span className="muted">{count === 0 ? t('settings-profiles.aucun-espace') : tp('settings-profiles.espaces', count)}</span>
                </button>
              )
            })}
          </div>
          <div className="profile-box-foot">
            <button title={t('settings-profiles.ajouter-un-profil')} onClick={() => setDialog('create')}>
              {PLUS}
              <span className="sr-only">{t('settings-profiles.ajouter-un-profil')}</span>
            </button>
            <button
              disabled={cannotDelete}
              title={id === 'default' ? t('settings-profiles.le-profil-par-defaut-ne-peut-pas-etre-supprime') : using.length > 0 ? t('settings-profiles.seuls-les-profils-qu-aucun-espace-n-utilise') : t('settings-profiles.supprimer-le-profil-et-ses-donnees')}
              onClick={() => setDialog('delete')}
            >
              {MINUS}
              <span className="sr-only">{t('settings-profiles.supprimer-le-profil')}</span>
            </button>
            <button title={t('settings-profiles.renommer-le-profil')} onClick={() => setDialog('rename')}>
              {RENAME}
              <span className="sr-only">{t('settings-profiles.renommer-le-profil')}</span>
            </button>
          </div>
        </div>

        <div className="profile-details" role="group" aria-label={t('settings-profiles.profil-label', { label })}>
          <Group title={t('settings-profiles.profil-label', { label })}>
            <EngineRows key={`engine-${id}`} snapshot={snapshot} update={update} profileId={id} place="profiles" />
            <ArchiveRow key={`archive-${id}`} snapshot={snapshot} update={update} profileId={id} place="profiles" />
            <DownloadDirRow snapshot={snapshot} update={update} profileId={id} place="profiles" />
          </Group>

          <Group title={t('settings-profiles.historique-et-reseau')} footnote={t('settings-profiles.historique-et-reseau-note', { page: settingsPaneLabel('protection') })}>
            <Check
              label={t('settings-profiles.garder-l-historique-de-ce-profil')}
              info={t('settings-profiles.garder-l-historique-de-ce-profil-info')}
              hint={inherits && own.historyOff === undefined ? t('settings-profiles.comme-le-profil-par-defaut') : undefined}
              // Said in the affirmative, as the same setting is on its page (« Garder l’historique des pages visitées »): on while the history is kept, which is
              // the stored setting `historyOff` turned around.
              checked={profileRecordsHistory(settings, id)}
              onChange={(keep) => setProfile(id, { historyOff: !keep })}
            />
            {inherits && own.historyOff !== undefined && (
              <Row label="">
                <button className="link-button pref-inherit" onClick={() => setProfile(id, { historyOff: undefined })}>
                  {t('settings-profiles.comme-le-defaut')}
                </button>
              </Row>
            )}
            {settings.proxyEnabled ? (
              <>
                <ProxyEditor key={id} name={label} value={proxyOfProfile(settings, id)} onChange={(proxy) => setProfile(id, { proxy })} />
                {inherits && own.proxy !== undefined && (
                  <Row label="">
                    <button className="link-button pref-inherit" onClick={() => setProfile(id, { proxy: undefined })}>
                      {t('settings-profiles.comme-le-defaut')}
                    </button>
                  </Row>
                )}
              </>
            ) : (
              <Row label={t('settings-profiles.proxy')} hint={t('settings-profiles.proxy-hint', { settingsPath: settingsPath('proxy') })} />
            )}
          </Group>

          <Group title={t('settings-profiles.vos-donnees-et-reglages')} footnote={t('settings-profiles.les-donnees-d-un-profil-inutilise-restent')}>
            <ClearDataRow key={`clear-${id}`} snapshot={snapshot} profileId={id} place="profiles" />
            <Row label={t('settings-profiles.effacer-les-donnees-des-profils-inutilises')} hint={t('settings-profiles.efface-les-donnees-des-profils-inutilises')} searchKey="purgeProfiles">
              <button
                className="button"
                onClick={() => {
                  setMessage('')
                  void startPurge(api(), { ask: setPurging, say: setMessage })
                }}
              >
                {t('settings-profiles.nettoyer')}
              </button>
            </Row>
            {message && (
              <div className="pref-row pref-message" role="status">
                {message}
              </div>
            )}
          </Group>
        </div>
      </div>

      {dialog === 'create' && (
        <NewProfileDialog
          snapshot={snapshot}
          onClose={() => setDialog(null)}
          onCreated={(created) => {
            setSelected(created)
            setDialog(null)
          }}
        />
      )}
      {dialog === 'rename' && <RenameProfileDialog snapshot={snapshot} profileId={id} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <ArcDialog title={t('settings-profiles.supprimer-le-profil-label', { label })} message={t('settings-profiles.ses-cookies-connexions-seront-effaces')} cancelLabel={t('settings-profiles.annuler')} confirmLabel={t('settings-profiles.confirmer-la-suppression')} onCancel={() => setDialog(null)} onConfirm={remove} />
      )}
      {purging !== null && (
        <PurgeDialog
          names={purging.map((profile) => profileLabel(settings, profile))}
          onCancel={() => setPurging(null)}
          onConfirm={() => {
            setPurging(null)
            void finishPurge(api(), purging, { say: setMessage })
          }}
        />
      )}
    </>
  )
}
