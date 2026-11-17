// "Nouvel espace": one sheet with a preview that takes the name as it is typed, the name, an icon proposed from the name (with all
// the emoji, letters, one click away), a named colour, and the profile explained. "Créer l'espace" is a single `space/create` action; it stays off until the
// name is free, and the foot says why. "Personnaliser…" only asks for the theme panel to open once the space exists.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { t } from '@shared/i18n'
import { PROFILE_NAME_LIMIT, knownProfiles, profileLabel } from '@shared/profiles'
import { NEW_PROFILE, createBlock, defaultSpaceEmoji, draftTheme, emojiForName, newDraft, newProfileProblem, spaceCreateAction, spaceNameTaken, suggestionRow, type CreateBlock, type SpaceDraft } from '@shared/space-creation'
import { cleanIconLetter, initialsOf, type SpaceIconChoice } from '@shared/space-icon'
import { NAMED_COLORS, namedColorOf } from '@shared/theme-colors'
import type { SidebarState } from '@shared/model'
import { api, useSnapshot } from './api'
import { IconPicker } from './IconPicker'
import { SidebarThumb, thumbStyle } from './SidebarThumb'
import { SpaceMark } from './SpaceMark'
import { Sheet, SheetField, activeSpaceHue } from './templates'
import './spacecreate.css'
import { useSystemDark } from './system-dark'

/** Waits for the first snapshot: the sheet's starting icon depends on how many spaces there already are. */
export function SpaceCreate() {
  const snapshot = useSnapshot()
  if (!snapshot) return null
  return <SpaceSheet state={snapshot.state} />
}

/** What the foot of the sheet says while "Créer l'espace" is off. */
const HINTS: Record<CreateBlock, () => string> = {
  name: () => t('space-create.hint-nom'),
  'name-taken': () => t('space-create.hint-nom-pris'),
  letters: () => t('space-create.hint-lettres'),
  'profile-name': () => t('space-create.hint-profil-nom'),
  'profile-problem': () => t('space-create.hint-profil-probleme'),
  'profile-unknown': () => t('space-create.hint-profil-inconnu')
}

function SpaceSheet({ state }: { state: SidebarState }) {
  const systemDark = useSystemDark()
  const [draft, setDraft] = useState<SpaceDraft>(() => newDraft(state.spaces.length))
  // The icon follows the name until a person has chosen one.
  const [chosen, setChosen] = useState(false)
  const [view, setView] = useState<'form' | 'icon'>('form')
  const [customize, setCustomize] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const act = api()

  const theme = draftTheme(draft, state.spaces.length)
  const taken = spaceNameTaken(draft.name, state)
  const block = createBlock(draft, state)
  const problem = newProfileProblem(draft, state)
  const ready = block === null && !busy
  const patch = (next: Partial<SpaceDraft>) => setDraft((d) => ({ ...d, ...next }))
  const setIcon = (icon: SpaceIconChoice, byPerson = true) => {
    if (byPerson) setChosen(true)
    patch({ icon })
  }

  const rename = (name: string) => {
    const icon = { ...draft.icon, emoji: emojiForName(name, draft.icon.emoji, chosen, defaultSpaceEmoji(state.spaces.length)) }
    // The letters follow the name too, until they are typed by hand.
    patch({ name, icon: draft.icon.kind === 'letter' && !chosen ? { ...icon, letter: initialsOf(name) } : icon })
  }

  const create = async () => {
    const action = spaceCreateAction(draft, state)
    if (!action || busy) return
    setBusy(true)
    setFailed(false)
    let fresh: typeof state
    try {
      await act.dispatch(action)
      fresh = (await act.getSnapshot()).state
    } catch (error) {
      // The request itself failed: the sheet must not stay on « Création… » with its button held.
      console.error('[space] the new space could not be created:', error)
      setBusy(false)
      setFailed(true)
      return
    }
    // The reducer refuses what changed under the sheet (a profile name taken meanwhile): stay open rather than edit the wrong space.
    if (fresh.spaces.length !== state.spaces.length + 1) {
      setBusy(false)
      setFailed(true)
      return
    }
    if (customize) act.openOverlay({ panel: 'theme', spaceId: fresh.activeSpaceId })
    else act.closeOverlay()
  }

  // ⌘↩ creates from anywhere in the sheet. The listener follows `view` only: `create` is read through a ref, so that the listener is not
  // removed and added again at each keystroke of the form.
  const createLatest = useRef(create)
  createLatest.current = create
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !event.metaKey || view !== 'form') return
      event.preventDefault()
      void createLatest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  // Going to the picker, and coming back, puts the cursor where the work is.
  useEffect(() => {
    document.querySelector<HTMLElement>('.spacecreate [data-autofocus]')?.focus()
  }, [view])

  const row = useMemo(() => suggestionRow(draft.name, draft.icon.emoji), [draft.name, draft.icon.emoji])
  const named = namedColorOf(draft.color ?? undefined)
  const preview = thumbStyle(theme, systemDark)
  const iconMark = { emoji: draft.icon.emoji, iconKind: draft.icon.kind === 'letter' ? ('letter' as const) : ('emoji' as const), iconLetter: cleanIconLetter(draft.icon.letter) ?? undefined, iconColor: draft.icon.color, iconRound: draft.icon.round }
  const hue = activeSpaceHue(state.spaces, state.activeSpaceId)

  if (view === 'icon') {
    return (
      <Sheet
        className="spacecreate spacecreate-icons"
        title={t('space-create.icone-du-nouvel-espace')}
        context={draft.name.trim()}
        hue={hue}
        onCancel={() => setView('form')}
        cancelLabel={t('space-create.retour')}
        primary={{ label: t('templates.termine') }}
        onSubmit={() => setView('form')}
      >
        <IconPicker
          choice={draft.icon}
          onChange={(icon) => setIcon(icon.kind === 'letter' && draft.icon.kind !== 'letter' && icon.letter === '' ? { ...icon, letter: initialsOf(draft.name) } : icon)}
          picture={{ reason: t('space-create.image-apres-creation'), onPick: () => undefined, onClear: () => undefined }}
          preview={
            <SidebarThumb
              theme={theme}
              name={draft.name.trim() || t('space-create.nom-de-l-espace')}
              mark={<SpaceMark space={iconMark} className="thumb" />}
              footer={[...state.spaces.map((space) => <SpaceMark key={space.id} space={space} className="thumb" />), <SpaceMark key="new" space={iconMark} className="thumb" />]}
              current={state.spaces.length}
              caption={t('icon-picker.apercu')}
              systemDark={systemDark}
            />
          }
        />
      </Sheet>
    )
  }

  return (
    <Sheet
      className="spacecreate"
      title={t('cmd.nouvel-espace')}
      hue={hue}
      onCancel={() => act.closeOverlay()}
      primary={{ label: busy ? t('space-create.creation') : t('space-create.creer-l-espace'), disabled: !ready, busy }}
      onSubmit={() => void create()}
      footStart={
        <span className="sc-hint" role="status" aria-live="polite">
          {block === null ? (
            <>
              <kbd className="tk-kbd">⌘↩</kbd> {t('space-create.hint-creer')} <kbd className="tk-kbd">{t('space-create.touche-echap')}</kbd> {t('space-create.hint-fermer')}
            </>
          ) : (
            HINTS[block]()
          )}
        </span>
      }
    >
      <p className="sc-desc">{t('space-create.description')}</p>

      <div className="spacecreate-preview" style={preview} aria-hidden="true">
        <div className="spacecreate-header">
          <span className="spacecreate-icon">
            <SpaceMark space={iconMark} className="header" />
          </span>
          <span className={`spacecreate-title${draft.name.trim() ? '' : ' placeholder'}`}>{draft.name.trim() || t('space-create.nom-de-l-espace')}</span>
        </div>
        <div className="spacecreate-ghost" />
        <div className="spacecreate-ghost short" />
      </div>

      <SheetField label={t('space-create.nom')} error={taken ? t('space-create.nom-pris', { name: taken }) : undefined}>
        {(field) => <input {...field} className="tk-field" data-autofocus autoComplete="off" spellCheck={false} placeholder={t('space-create.exemples-de-noms')} value={draft.name} onChange={(e) => rename(e.target.value)} />}
      </SheetField>

      <div className="sc-group">
        <div className="sc-label" id="sc-icon-label">
          {t('space-create.icone')}
          <button type="button" className="sc-link" onClick={() => setView('icon')}>
            {t('space-create.tous-les-emojis')}
          </button>
        </div>
        <div className="sc-emoji" role="group" aria-labelledby="sc-icon-label">
          {draft.icon.kind === 'letter' && (
            <button type="button" aria-pressed="true" aria-label={cleanIconLetter(draft.icon.letter) ?? ''} onClick={() => setView('icon')}>
              <SpaceMark space={iconMark} className="header" />
            </button>
          )}
          {row.map((emoji) => (
            <button key={emoji} type="button" aria-pressed={draft.icon.kind === 'emoji' && draft.icon.emoji === emoji} onClick={() => setIcon({ ...draft.icon, kind: 'emoji', emoji })}>
              {emoji}
            </button>
          ))}
        </div>
        <p className="sc-help">{t('space-create.icones-proposees')}</p>
      </div>

      <div className="sc-group">
        <div className="sc-label" id="sc-color-label">
          {t('space-create.couleur')}
          <span className="sc-val">{named ? named.name() : t('space-create.couleur-auto')}</span>
          <button type="button" className="sc-link" aria-pressed={customize} onClick={() => setCustomize(!customize)}>
            {t('space-create.personnaliser-2')}
          </button>
        </div>
        <div className="sc-swatches" role="group" aria-labelledby="sc-color-label">
          {NAMED_COLORS.map((color) => (
            <button
              key={color.id}
              type="button"
              className="spacecreate-swatch"
              style={{ '--c': color.hex } as CSSProperties}
              title={color.name()}
              aria-label={color.name()}
              aria-pressed={draft.color === color.hex}
              onClick={() => patch({ color: draft.color === color.hex ? null : color.hex })}
            />
          ))}
        </div>
        {customize && <p className="sc-help">{t('space-create.l-editeur-de-theme-s-ouvrira-apres-la-creation')}</p>}
      </div>

      <SheetField label={t('space-create.profil')} help={draft.profile === NEW_PROFILE ? undefined : t('space-create.profil-aide')}>
        {(field) => (
          <select {...field} className="tk-field" value={draft.profile} onChange={(e) => patch({ profile: e.target.value })}>
            {knownProfiles(state).map((id) => (
              <option key={id} value={id}>
                {profileLabel(state.settings, id)}
              </option>
            ))}
            <option value={NEW_PROFILE}>{t('ctx.nouveau-profil')}</option>
          </select>
        )}
      </SheetField>
      {draft.profile === NEW_PROFILE && (
        <SheetField label={t('space-create.nom-du-nouveau-profil')} help={t('space-create.profil-aide')} error={draft.newProfileName !== '' && problem ? problem : undefined}>
          {(field) => <input {...field} className="tk-field new-profile" autoFocus autoComplete="off" placeholder={t('settings-profiles.nom-du-profil')} maxLength={PROFILE_NAME_LIMIT} value={draft.newProfileName} onChange={(e) => patch({ newProfileName: e.target.value })} />}
        </SheetField>
      )}
      {failed && (
        <p className="sh-error" role="alert">
          {t('space-create.echec')}
        </p>
      )}
    </Sheet>
  )
}
