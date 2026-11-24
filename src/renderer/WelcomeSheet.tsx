// The welcome of the very first launch, also Aide › Premier lancement…: a short sheet with the three things worth deciding at once. What to bring from
// another browser (its data is read on this Mac: the import sheet does the work, nothing is sent anywhere), light or dark, and whether
// Lucium opens the links of other applications. "Plus tard" closes it without a question. Every choice is applied as it is made.

import { useEffect, useState } from 'react'
import type { ImportSourceInfo } from '@shared/import-sources'
import type { Settings } from '@shared/model'
import { api, useSnapshot } from './api'
import { DISCOVER_REQUEST } from '@shared/discover'
import { t } from '@shared/i18n'
import './welcome-sheet.css'

/** The browsers the sheet names: the ones people come from. The import sheet itself lists more. */
export const WELCOME_SOURCES = ['arc', 'chrome', 'safari', 'firefox'] as const

type Appearance = Settings['interfaceAppearance']
const APPEARANCES: ReadonlyArray<{ value: Appearance; label: () => string; hint: () => string }> = [
  { value: 'light', label: () => t('menu.clair'), hint: () => t('welcome.toujours-clair') },
  { value: 'dark', label: () => t('menu.sombre'), hint: () => t('welcome.toujours-sombre') },
  { value: 'auto', label: () => t('menu.automatique'), hint: () => t('welcome.suit-le-mac') }
]

interface ViewProps {
  /** The browsers found on this Mac, null while they are being looked for. */
  sources: ImportSourceInfo[] | null
  appearance: Appearance
  /** Whether Lucium already is the browser of the system, null while that is asked. */
  isDefault: boolean | null
  onImport: () => void
  onAppearance: (value: Appearance) => void
  onDefault: () => void
  onClose: () => void
  /** Opens « Découvrir Lucium »; without it (the sheet drawn alone) the sheet has no such button. */
  onDiscover?: () => void
}

/** The sheet as it is drawn from what it is given (the container below fetches it). */
export function WelcomeView({ sources, appearance, isDefault, onImport, onAppearance, onDefault, onClose, onDiscover }: ViewProps) {
  const found = (sources ?? []).filter((source) => (WELCOME_SOURCES as readonly string[]).includes(source.id) && source.found)
  return (
    <div className="card welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-lead">
      <h2 id="welcome-title">{t('welcome.bienvenue-dans-lucium')}</h2>
      <p className="muted welcome-lead" id="welcome-lead">
        {t('welcome.reprenez-vos-donnees-d-un-autre-navigateur-ou')}
      </p>

      <section className="welcome-block" aria-labelledby="welcome-data">
        <h3 id="welcome-data">{t('welcome.reprendre-vos-donnees')}</h3>
        <p className="welcome-found" role="status">
          {sources === null ? t('import-sheet.recherche-des-navigateurs') : found.length > 0 ? t('welcome.trouves-sur-ce-mac-names', { names: found.map((source) => source.name).join(', ') }) : t('welcome.aucun-autre-navigateur-trouve-sur-ce-mac')}
        </p>
        <button type="button" className="button" onClick={onImport}>
          {t('welcome.importer-mes-donnees')}
        </button>
        <p className="muted welcome-fine">{t('welcome.non-repris-mots-de-passe-et-cookies-vous-vous')}</p>
      </section>

      <section className="welcome-block" aria-labelledby="welcome-look">
        <h3 id="welcome-look">{t('welcome.apparence')}</h3>
        <div className="welcome-looks" role="radiogroup" aria-labelledby="welcome-look">
          {APPEARANCES.map((look) => (
            <label key={look.value} className={`welcome-look ${look.value === appearance ? 'chosen' : ''}`}>
              <input type="radio" name="welcome-look" value={look.value} checked={look.value === appearance} onChange={() => onAppearance(look.value)} />
              <b>{look.label()}</b>
              <small>{look.hint()}</small>
            </label>
          ))}
        </div>
      </section>

      <section className="welcome-block" aria-labelledby="welcome-default">
        <h3 id="welcome-default">{t('welcome.navigateur-par-defaut')}</h3>
        {isDefault === true ? (
          <p className="welcome-found" role="status">
            {t('welcome.lucium-est-votre-navigateur-par-defaut')}
          </p>
        ) : (
          <button type="button" className="button" disabled={isDefault === null} onClick={onDefault}>
            {t('settings.definir-lucium-par-defaut')}
          </button>
        )}
      </section>

      <div className="row end">
        <span className="muted welcome-again">{t('welcome.aide-premier-lancement-rouvre-cette-feuille')}</span>
        {onDiscover && (
          <button type="button" className="button" onClick={onDiscover}>
            {t('discover.lien-bienvenue')}
          </button>
        )}
        <button type="button" className="button" onClick={onClose}>
          {t('welcome.plus-tard')}
        </button>
        <button type="button" className="button primary" onClick={onClose} autoFocus>
          {t('welcome.c-est-pret')}
        </button>
      </div>
    </div>
  )
}

export function WelcomeSheet() {
  const act = api()
  const snapshot = useSnapshot()
  const [sources, setSources] = useState<ImportSourceInfo[] | null>(null)
  const [isDefault, setIsDefault] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    act.importSources().then(
      (list) => live && setSources(list),
      (error: unknown) => {
        console.warn('[welcome] cannot list the browsers:', error)
        if (live) setSources([])
      }
    )
    const ask = (): void =>
      void act.defaultBrowser().then(
        (value) => live && setIsDefault(value === true),
        (error: unknown) => {
          console.warn('[welcome] cannot tell whether Lucium is the default browser:', error)
          if (live) setIsDefault(false)
        }
      )
    ask()
    // Windows leaves the choice to its own Settings: ask again when the user comes back from there.
    window.addEventListener('focus', ask)
    return () => {
      live = false
      window.removeEventListener('focus', ask)
    }
  }, [act])

  const setDefault = () => {
    setIsDefault(null)
    // One handler for both requests: the question asked after the change can fail too, and the button must not stay greyed.
    void act
      .setDefaultBrowser()
      .then(() => act.defaultBrowser())
      .then((value) => setIsDefault(value === true), (error: unknown) => {
        console.warn('[welcome] cannot make Lucium the default browser:', error)
        setIsDefault(false)
      })
  }

  return (
    <WelcomeView
      sources={sources}
      appearance={snapshot?.state.settings.interfaceAppearance ?? 'auto'}
      isDefault={isDefault}
      onImport={() => act.openOverlay({ panel: 'import' })}
      onAppearance={(interfaceAppearance) => void act.dispatch({ type: 'settings/update', patch: { interfaceAppearance } })}
      onDefault={setDefault}
      onClose={() => act.closeOverlay()}
      onDiscover={() => act.openOverlay(DISCOVER_REQUEST)}
    />
  )
}
