// "Personnaliser l'espace": the one panel for everything about a space. It merges the three that used to share the job (the editor of the
// name, icon and profile; the panel of the theme; the picture of the space): icon and name at the top, then Couleur et apparence, Icône and Profil as sections that
// say where the space stands before they are opened. Every change applies at once (the sidebar behind is the preview); "Rétablir" goes back to how the space was
// when the panel opened. Archiving and deleting are at the bottom, away from "Terminé".

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { t, tp } from '@shared/i18n'
import { TEXT_COLORS, VEIL_COLORS, withVeilShape, type SpaceBackground } from '@shared/space-media'
import { builtinBackground } from '@shared/builtin-backgrounds'
import { byHand, isUserFile, userFileBackground, withAutoVeil } from '@shared/auto-veil'
import type { SpaceEditorFocus } from '@shared/ipc'
import type { Action } from '@shared/sidebar'
import { PROFILE_NAME_LIMIT, knownProfiles, planProfileCreation, profileLabel, profileLabels, validateProfileName } from '@shared/profiles'
import { asideRefusal } from '@shared/sessions'
import { appearanceLabel, changedSince, colorSummary, iconSummary, pictureNote, revertPatch, snapshotOf, swatchName, type CustomizeSnapshot } from '@shared/space-customize'
import { choiceOf, choicePatch, spaceIconKind, type SpaceIconChoice } from '@shared/space-icon'
import { themeHue, withColorAt, type Appearance } from '@shared/theme'
import { radioGroupKeys } from './radio-keys'
import { NAMED_COLORS } from '@shared/theme-colors'
import { api, useSnapshot } from './api'
import { IconPicker } from './IconPicker'
import { SpaceMediaPanel } from './SpaceMediaPanel'
import { measureBackgroundFile } from './background-probe'
import { SpaceMark } from './SpaceMark'
import { Sheet } from './templates'
import './space-customize.css'
import { useTransient } from './transient'

const NEW_PROFILE = '__new__'
/** How long the sheet says that the changes were undone. */
const SAID_MS = 3000
const APPEARANCES: readonly Appearance[] = ['auto', 'light', 'dark']

export type Section = 'color' | 'icon' | 'profile'

/** A section follows what the browser says of its `<details>`. The answer is read when the event comes: React runs the update later, when the event has lost its target. */
export function sectionToggle(setOpen: (update: (was: Record<Section, boolean>) => Record<Section, boolean>) => void, section: Section) {
  return (event: { currentTarget: { open: boolean } }) => {
    const isOpen = event.currentTarget.open
    setOpen((was) => (was[section] === isOpen ? was : { ...was, [section]: isOpen }))
  }
}

/** `openedAs` is how the space was when the panel opened: the panel reads it itself, and a test says it to draw the panel after a change. */
export function SpaceCustomize({ spaceId, focus = 'name', openedAs }: { spaceId: string; focus?: SpaceEditorFocus; openedAs?: CustomizeSnapshot }) {
  const snapshot = useSnapshot()
  const space = snapshot?.state.spaces.find((s) => s.id === spaceId)
  // How the space was when the panel opened: "Rétablir" goes back to it.
  const original = useRef<CustomizeSnapshot | null>(null)
  if (space && !original.current) original.current = openedAs ?? snapshotOf(space)
  const [name, setName] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<Section, boolean>>({ color: focus === 'color' || focus === 'name', icon: focus === 'icon', profile: focus === 'profile' })
  const [profileChoice, setProfileChoice] = useState<string | null>(focus === 'profile' ? NEW_PROFILE : null)
  const [newProfile, setNewProfile] = useState('')
  /** Why « Créer le profil » did nothing, when its request failed. */
  const [profileFailure, setProfileFailure] = useState('')
  const [pictureMessage, setPictureMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [said, say] = useTransient('', SAID_MS)
  /** « Revenir au réglage automatique » is measuring the file again; what to say when it could not. */
  const [measuring, setMeasuring] = useState(false)
  const [veilNote, setVeilNote] = useState('')
  // The background as it is now, for a measure that answers after the space changed.
  const latestBackground = useRef(space?.background)
  latestBackground.current = space?.background
  const act = api()
  const ready = !!space

  // The sidebar behind the panel is the live preview, so the panel works on the space that is shown.
  useEffect(() => {
    if (snapshot && space && snapshot.state.activeSpaceId !== space.id) void act.dispatch({ type: 'space/select', id: space.id })
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // The cursor goes where the entry that opened the panel promised: the name, the icons, the new profile, the colours.
  useEffect(() => {
    if (!ready) return
    const root = document.querySelector<HTMLElement>('.sc-edit')
    const target = focus === 'icon' ? root?.querySelector<HTMLElement>('.ip [data-autofocus], .ip button') : focus === 'profile' ? root?.querySelector<HTMLElement>('.new-profile') : focus === 'color' ? root?.querySelector<HTMLElement>('.sc-swatches button') : null
    target?.focus()
    target?.scrollIntoView?.({ block: 'nearest' })
  }, [ready, focus])

  if (!snapshot || !space || !original.current) return null
  const state = snapshot.state
  const update = (patch: Parameters<typeof updateAction>[1]) => void act.dispatch(updateAction(space.id, patch))
  const profiles = knownProfiles(state)
  const tabCount = state.tabs.filter((tab) => tab.spaceId === space.id).length
  const profileValue = profileChoice ?? (profiles.includes(space.profileId) ? space.profileId : NEW_PROFILE)
  const profileProblem = newProfile.trim() === '' ? null : validateProfileName(newProfile, profileLabels(state))
  // Another profile chosen for a space that has tabs: every one of them is loaded again, signed out of its sites, and what was being typed in them
  // is lost. The choice waits for a yes; a slip in the menu (or a letter typed on it) used to do it at once.
  const askedProfile = profileChoice !== null && profileChoice !== NEW_PROFILE && profileChoice !== space.profileId && tabCount > 0 ? profileChoice : null
  const chooseProfile = (value: string) => {
    setProfileChoice(value)
    setProfileFailure('')
    if (value !== NEW_PROFILE && value !== space.profileId && tabCount === 0) update({ profileId: value })
  }
  const changed = changedSince(original.current, space)
  const refusal = asideRefusal(state, space.id)
  const isLast = state.spaces.length <= 1
  const choice = choiceOf(space)
  const kind = spaceIconKind(space)
  const swatch = space.theme.baseColors[0]?.toLowerCase()

  const commitName = () => {
    if (name !== null && name.trim() && name !== space.name) update({ name })
    setName(null)
  }
  const changeName = (value: string) => {
    setName(value)
    // The sidebar follows each letter; a name with nothing in it changes nothing (the last good one stays).
    if (value.trim()) update({ name: value })
  }
  const toggle = (section: Section) => sectionToggle(setOpen, section)

  const pickPicture = () => {
    setBusy(true)
    setPictureMessage('')
    // An empty note is a dialog the user closed: nothing to say.
    void pictureNote(act.spaceImage({ op: 'pick', spaceId: space.id }), t('space-image-picker.l-image-n-a-pas-pu-etre-importee'))
      .then(setPictureMessage)
      .finally(() => setBusy(false))
  }
  const clearPicture = () => {
    setPictureMessage('')
    void pictureNote(act.spaceImage({ op: 'clear', spaceId: space.id }), t('space-image-picker.l-image-n-a-pas-pu-etre-retiree')).then(setPictureMessage)
  }
  const changeIcon = (next: SpaceIconChoice) => update(choicePatch(next))
  /** A change of the look made by hand: it is no longer the measured one (`veilAuto` goes). */
  const lookByHand = (background: SpaceBackground) => update({ background: byHand(background) })
  /** « Revenir au réglage automatique »: the file is measured again, and its look replaces the one set by hand, if the space still has that file. */
  const restoreAutoVeil = () => {
    const background = space.background
    if (!background || !isUserFile(background) || background.veilAuto === true || measuring) return
    setMeasuring(true)
    setVeilNote('')
    void measureBackgroundFile(background.value)
      .then(({ look, measured }) => {
        const now = latestBackground.current
        if (now?.value === background.value) update({ background: withAutoVeil(now, look) })
        if (!measured) setVeilNote(t('space-media.veil-auto-failed'))
      })
      .finally(() => setMeasuring(false))
  }

  const revert = () => {
    update(revertPatch(original.current!))
    setName(null)
    setProfileChoice(null)
    setNewProfile('')
    say(t('space-customize.modifications-annulees'))
  }
  const archive = () => {
    void act.dispatch({ type: 'space/aside', id: space.id })
    act.closeOverlay()
  }
  const remove = () => {
    void act.dispatch({ type: 'space/delete', id: space.id })
    act.closeOverlay()
  }
  const createProfile = () => {
    const plan = planProfileCreation(state, newProfile, [space.id])
    if (!plan.ok) return
    setProfileFailure('')
    // Sent in their order (the name, then the space); the name typed is kept until they are done, so that a failure leaves it to try again.
    Promise.all(plan.actions.map((action) => act.dispatch(action))).then(
      () => {
        setNewProfile('')
        setProfileChoice(null)
      },
      (error: unknown) => {
        console.warn('[space] the profile could not be created:', error)
        setProfileFailure(t('settings-profiles.profil-non-cree'))
      }
    )
  }

  const finish = () => {
    commitName()
    act.closeOverlay()
  }

  return (
    <Sheet
      className="sc-edit"
      title={t('space-customize.personnaliser-l-espace')}
      hue={themeHue(space.theme)}
      onCancel={finish}
      cancelLabel={null}
      primary={{ label: t('templates.termine') }}
      onSubmit={finish}
      footStart={
        <span className="sc-foot">
          <span className="sc-hint" role="status" aria-live="polite">
            {said || (
              <>
                <kbd className="tk-kbd">{t('space-create.touche-echap')}</kbd> {t('space-create.hint-fermer')}
              </>
            )}
          </span>
          {changed && (
            <button type="button" className="tk-btn quiet" onClick={revert}>
              {t('space-customize.retablir')}
            </button>
          )}
        </span>
      }
    >
      <p className="sc-desc">{t('space-customize.description')}</p>

      <div className="sc-head">
        <button
          type="button"
          className="sc-iconbtn"
          aria-label={t('space-customize.changer-l-icone')}
          title={t('space-customize.changer-l-icone')}
          onClick={() => {
            setOpen((was) => ({ ...was, icon: true }))
            window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.sc-edit .ip button[aria-pressed="true"]')?.focus())
          }}
        >
          <SpaceMark space={space} className="header" />
          <span className="sc-badge" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="11" height="11" focusable="false">
              <path d="M10.5 2.5a1.4 1.4 0 0 1 2 2L5 12l-2.5.5L3 10z" />
            </svg>
          </span>
        </button>
        <input
          className="tk-field sc-name"
          aria-label={t('space-customize.nom-de-l-espace')}
          value={name ?? space.name}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          data-autofocus={focus === 'name' ? true : undefined}
          onChange={(event) => changeName(event.target.value)}
          onBlur={commitName}
        />
      </div>

      <div className="sc-sections">
        <Details title={t('space-customize.couleur-et-apparence')} status={colorSummary(space.theme)} open={open.color} onToggle={toggle('color')}>
          <div className="sc-swatches" role="group" aria-label={t('space-create.couleur')}>
            {NAMED_COLORS.map((color) => (
              <button
                key={color.id}
                type="button"
                className="spacecreate-swatch"
                style={{ '--c': color.hex } as CSSProperties}
                title={color.name()}
                aria-label={color.name()}
                aria-pressed={swatch === color.hex}
                onClick={() => update({ theme: withColorAt(space.theme, 0, color.hex) ?? {} })}
              />
            ))}
          </div>
          <div className="sc-colorrow">
            <div className="ip-seg" role="group" aria-label={t('menu.apparence')}>
              {APPEARANCES.map((appearance) => (
                <button key={appearance} type="button" aria-pressed={space.theme.appearance === appearance} onClick={() => update({ theme: { appearance } })}>
                  {appearanceLabel(appearance)}
                </button>
              ))}
            </div>
            <button type="button" className="sc-link" onClick={() => act.openOverlay({ panel: 'theme', spaceId: space.id, from: 'space' })}>
              {t('space-customize.couleurs-avancees-et-themes-prets')}
            </button>
          </div>
          <SpaceMediaPanel
            space={space}
            onMediaChange={(media) => {
              if (media) {
                // A video of Lucium comes with its look (veil, text colour, shadow); a file of the user's with the look measured from it, or the one set by hand it replaces.
                update({ background: builtinBackground(media.filename) ?? userFileBackground(space.background, media) })
                setVeilNote('')
              } else {
                update({ background: undefined })
              }
            }}
            onBackgroundChange={(background) => update({ background })}
            onPositionChange={(x, y) => void act.dispatch({ type: 'space/background-position', id: space.id, x, y })}
            forceReduceMotion={state.settings.forceReduceMotion}
            disabled={busy}
          />
          {/* The veil over the picture first (its colour, how strong, what shape), then the text that reads over it. */}
          {space?.background && space.background.type !== 'color' && (
            <div className="space-tone" role="radiogroup" onKeyDown={radioGroupKeys} aria-label={t('space-media.voile')}>
              <span>{t('space-media.voile')}</span>
              <div className="space-veil-swatches">
                <button type="button" role="radio" aria-checked={!space.background.veilColor} className={`space-veil-swatch none${!space.background.veilColor ? ' on' : ''}`} onClick={() => lookByHand({ ...space.background!, veilColor: undefined, tone: undefined })}>
                  {t('space-media.aucun')}
                </button>
                {VEIL_COLORS.map((hex) => (
                  <button key={hex} type="button" role="radio" aria-checked={space.background!.veilColor === hex} aria-label={swatchName(hex)} className={`space-veil-swatch${space.background!.veilColor === hex ? ' on' : ''}`} style={{ background: hex }} onClick={() => lookByHand({ ...space.background!, veilColor: hex })} />
                ))}
              </div>
            </div>
          )}
          {space?.background && space.background.type !== 'color' && space.background.veilColor !== undefined && (
            <label className="space-tone">
              <span>{t('space-media.veil-label', { percent: space.background.veil ?? 70 })}</span>
              <input type="range" min={0} max={100} step={5} value={space.background.veil ?? 70} aria-label={t('space-media.veil-label', { percent: space.background.veil ?? 70 })} onChange={(e) => lookByHand({ ...space.background!, veil: Number(e.target.value) })} />
            </label>
          )}
          {/* Whether the look was measured from the file (auto-veil.ts) or set by hand, and the way back to the measure. The button stays in place (and in
              the order of the keyboard) once the look is measured again: it then says so and does nothing. */}
          {space?.background && isUserFile(space.background) && (
            <div className="space-veil-auto">
              <span role="status">{measuring ? t('space-media.veil-auto-measuring') : veilNote || (space.background.veilAuto ? t('space-media.veil-auto-on') : t('space-media.veil-auto-off'))}</span>
              <button type="button" className="space-veil-swatch none" aria-disabled={space.background.veilAuto === true || measuring} onClick={restoreAutoVeil}>
                {t('space-media.veil-auto-restore')}
              </button>
            </div>
          )}
          {/* Even, or darkest under the text and almost bare at the right edge: the picture stays in view where no text is (sidebar.css `.veil-text`). Shown without a veil colour too: the text side then brings the darkest veil (`withVeilShape`). */}
          {space?.background && space.background.type !== 'color' && (
            <div className="space-tone" role="radiogroup" onKeyDown={radioGroupKeys} aria-label={t('space-media.forme-du-voile')}>
              <span>{t('space-media.forme-du-voile')}</span>
              <div className="space-veil-swatches">
                {(['even', 'text'] as const).map((shape) => {
                  const on = (space.background!.veilShape ?? 'even') === shape
                  return (
                    <button key={shape} type="button" role="radio" aria-checked={on} className={`space-veil-swatch none${on ? ' on' : ''}`} onClick={() => lookByHand(withVeilShape(space.background!, shape))}>
                      {shape === 'even' ? t('space-media.voile-uniforme') : t('space-media.voile-cote-texte')}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {space?.background && space.background.type !== 'color' && (
            <div className="space-tone" role="radiogroup" onKeyDown={radioGroupKeys} aria-label={t('space-media.text-color')}>
              <span>{t('space-media.text-color')}</span>
              <div className="space-veil-swatches">
                {(['auto', 'light', 'dark'] as const).map((tone) => (
                  <button key={tone} type="button" role="radio" aria-checked={(space.background!.tone ?? 'auto') === tone} className={`space-veil-swatch none${(space.background!.tone ?? 'auto') === tone ? ' on' : ''}`} onClick={() => lookByHand({ ...space.background!, tone: tone === 'auto' ? undefined : tone, textColor: undefined })}>
                    {tone === 'auto' ? t('space-media.tone-auto') : tone === 'light' ? t('space-media.tone-light') : t('space-media.tone-dark')}
                  </button>
                ))}
              </div>
            </div>
          )}
          {space?.background && space.background.type !== 'color' && (
            <div className="space-tone" role="radiogroup" onKeyDown={radioGroupKeys} aria-label={t('space-media.text-palette')}>
              <span>{t('space-media.text-palette')}</span>
              <div className="space-veil-swatches">
                <button type="button" role="radio" aria-checked={!space.background.textColor} className={`space-veil-swatch none${!space.background.textColor ? ' on' : ''}`} onClick={() => lookByHand({ ...space.background!, textColor: undefined })}>
                  {t('space-media.veil-none')}
                </button>
                {TEXT_COLORS.map((hex) => (
                  <button key={`text-${hex}`} type="button" role="radio" aria-checked={space.background!.textColor === hex} aria-label={swatchName(hex)} className={`space-veil-swatch${space.background!.textColor === hex ? ' on' : ''}`} style={{ background: hex }} onClick={() => lookByHand({ ...space.background!, textColor: hex, tone: undefined })} />
                ))}
              </div>
              <label className="space-halo">
                <input type="checkbox" checked={space.background.textHalo === true} onChange={(e) => lookByHand({ ...space.background!, textHalo: e.target.checked ? true : undefined })} />
                <span>{t('space-media.text-halo')}</span>
              </label>
            </div>
          )}
        </Details>

        <Details title={t('space-create.icone')} status={iconSummary(kind)} open={open.icon} onToggle={toggle('icon')}>
          <IconPicker choice={choice} onChange={changeIcon} picture={{ ...(space.image ? { name: space.image } : {}), busy, ...(pictureMessage ? { message: pictureMessage } : {}), onPick: pickPicture, onClear: clearPicture }} />
        </Details>

        <Details title={t('space-create.profil')} status={`${profileLabel(state.settings, space.profileId)} · ${tp('space-customize.onglets', tabCount)}`} open={open.profile} onToggle={toggle('profile')}>
          <select
            className="tk-field"
            aria-label={t('space-create.profil')}
            value={profileValue}
            onChange={(event) => chooseProfile(event.target.value)}
          >
            {profiles.map((id) => (
              <option key={id} value={id}>
                {profileLabel(state.settings, id)}
              </option>
            ))}
            <option value={NEW_PROFILE}>{t('ctx.nouveau-profil')}</option>
          </select>
          {profileValue === NEW_PROFILE && (
            <>
              <div className="sc-inline">
                <input
                  className="tk-field new-profile"
                  aria-label={t('space-create.nom-du-nouveau-profil')}
                  placeholder={t('settings-profiles.nom-du-profil')}
                  maxLength={PROFILE_NAME_LIMIT}
                  aria-invalid={profileProblem !== null || undefined}
                  value={newProfile}
                  autoComplete="off"
                  onChange={(event) => setNewProfile(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    if (newProfile.trim() !== '' && profileProblem === null) createProfile()
                  }}
                />
                <button type="button" className="tk-btn" disabled={newProfile.trim() === '' || profileProblem !== null} onClick={createProfile}>
                  {t('space-customize.creer-le-profil')}
                </button>
              </div>
              {(profileProblem ?? profileFailure) && (
                <p className="sh-error" role="alert">
                  {profileProblem ?? profileFailure}
                </p>
              )}
            </>
          )}
          {askedProfile !== null ? (
            <div className="sc-confirm" role="group" aria-label={t('space-customize.confirmation')}>
              <b>{t('space-customize.changer-le-profil-de-name', { name: space.name })}</b>
              <span>{tp('space-customize.profil-recharge', tabCount)}</span>
              <div className="sc-confirm-actions">
                <button type="button" className="tk-btn" onClick={() => setProfileChoice(null)}>
                  {t('templates.annuler')}
                </button>
                <button
                  type="button"
                  className="tk-btn primary"
                  onClick={() => {
                    update({ profileId: askedProfile })
                    setProfileChoice(null)
                  }}
                >
                  {t('space-customize.changer-de-profil')}
                </button>
              </div>
            </div>
          ) : (
            <p className="sc-help">{tabCount > 0 ? tp('space-customize.profil-recharge', tabCount) : t('space-create.profil-aide')}</p>
          )}
        </Details>

      </div>

      {confirming ? (
        <div className="sc-confirm" role="group" aria-label={t('space-customize.confirmation')}>
          <b>{t('space-customize.supprimer-l-espace-name', { name: space.name })}</b>
          <span>{tp('space-customize.onglets-fermes', tabCount)}</span>
          <div className="sc-confirm-actions">
            <button type="button" className="tk-btn" data-autofocus onClick={() => setConfirming(false)}>
              {t('templates.annuler')}
            </button>
            <button type="button" className="tk-btn primary danger" onClick={remove}>
              {t('translate.remove')}
            </button>
          </div>
        </div>
      ) : (
        <div className="sc-danger">
          <span>{t('space-customize.mettre-de-cote-garde-les-onglets-supprimer-les-ferme')}</span>
          <button type="button" className="tk-btn quiet" disabled={refusal !== null} title={refusal ?? t('space-customize.mettre-de-cote-aide')} onClick={archive}>
            {t('space-customize.mettre-de-cote')}
          </button>
          <button type="button" className="tk-btn quiet danger" disabled={isLast} title={isLast ? t('space-customize.le-dernier-espace-ne-peut-pas-etre-supprime') : undefined} onClick={() => setConfirming(true)}>
            {t('space-customize.supprimer')}
          </button>
        </div>
      )}
    </Sheet>
  )
}

/** A section that says where the space stands on its right before it is opened. */
function Details({ title, status, open, onToggle, children }: { title: string; status: string; open: boolean; onToggle: (event: { currentTarget: HTMLDetailsElement }) => void; children: ReactNode }) {
  return (
    <details className="sc-sec" open={open} onToggle={onToggle}>
      <summary>
        <svg className="sc-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="m6 3.5 4.5 4.5L6 12.500" />
        </svg>
        {title}
        <span className="sc-status">{status}</span>
      </summary>
      <div className="sc-inner">{children}</div>
    </details>
  )
}

function updateAction(id: string, patch: Extract<Action, { type: 'space/update' }>['patch']) {
  return { type: 'space/update', id, patch } as const
}
