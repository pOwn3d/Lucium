import type { ReactNode } from 'react'
import { ARC_GUIDE_PLACES, importedParts, type ArcGuidePlace, type ArcImported } from '@shared/arc-guide'
import { t } from '@shared/i18n'
import { effectiveAccelerator, formatAccelerator } from '@shared/keybindings'
import { platformOf } from '@shared/platform'
import type { SettingsPane } from '@shared/ipc'
import { settingsPaneLabel } from '@shared/settings-catalog'
import { api, useSnapshot } from './api'
import { InfoGlyph, Sheet, useSpaceHue } from './templates'
import './arc-guide.css'

/** A button of a row: what it says and the place it opens. */
interface Action {
  label: string
  place: ArcGuidePlace
}

/** « Réglages › Navigation et recherche »: the label of a button that opens a category of the Settings. */
const settingsLabel = (pane: SettingsPane): string => t('cmd.settings-pane', { pane: settingsPaneLabel(pane) })

/**
 * « Vous venez d’Arc ? »: where the things known from Arc are in Lucium, name by name (shared/arc-guide.ts holds the places the buttons lead to). It opens by
 * itself, once, when the sheet of an import from Arc is left (`imported` is what that import brought), and from Aide › Vous venez d’Arc ? (no `imported`).
 * Every name that changed has its row (the old name, the new one, a line, a button that opens it); then what is the same, then what Lucium does not have, and why.
 * It sits in the template of the small editors (templates/Sheet.tsx): Escape and « Fermer » leave it.
 */
export function ArcGuide({ imported }: { imported?: ArcImported }) {
  const act = api()
  const snapshot = useSnapshot()
  const hue = useSpaceHue()
  if (!snapshot) return null
  const { settings } = snapshot.state

  const close = () => act.closeOverlay()
  /** Leaves the guide for the place: a panel replaces it, the Settings window opens beside the window. */
  const go = (place: ArcGuidePlace) => {
    act.closeOverlay()
    act.openOverlay(ARC_GUIDE_PLACES[place])
  }

  const platform = platformOf(snapshot.platform)
  const accelerator = effectiveAccelerator('newLittleArc', settings.keyBindings, platform)
  const menu = `${t('menu.fichier')} › ${t('menu.nouvelle-mini-fenetre')}`
  const parts = importedParts(imported)

  const row = (id: string, oldName: string, name: string, text: ReactNode, actions: Action[]) => (
    <li key={id} className="ag-row">
      <h4 id={`ag-${id}`} className="ag-names" aria-label={t('arc-guide.nom-ancien-et-nouveau', { old: oldName, name })}>
        <span className="ag-old">{oldName}</span>
        <span aria-hidden="true">→</span>
        <b>{name}</b>
      </h4>
      <p className="ag-text">{text}</p>
      <div className="ag-actions">
        {actions.map((action) => (
          <button key={action.place} type="button" className="tk-btn" aria-describedby={`ag-${id}`} onClick={() => go(action.place)}>
            {action.label}
          </button>
        ))}
      </div>
    </li>
  )

  const excluded: Array<[string, string]> = [
    [t('arc-guide.exclu-assistant'), t('arc-guide.exclu-assistant-raison')],
    [t('arc-guide.exclu-compte'), t('arc-guide.exclu-compte-raison')],
    [t('arc-guide.exclu-favoris-vivants'), t('arc-guide.exclu-favoris-vivants-raison')],
    [t('arc-guide.exclu-easels'), t('arc-guide.exclu-easels-raison', { notes: t('features.notes-rapides') })]
  ]

  return (
    <Sheet
      className="arc-guide"
      title={t('arc-guide.vous-venez-d-arc')}
      glyph={<InfoGlyph />}
      hue={hue}
      onCancel={close}
      cancelLabel={null}
      primary={{ label: t('templates.fermer') }}
      onSubmit={close}
      footStart={<span className="muted ag-again">{t('arc-guide.rouvrir')}</span>}
    >
      <p className="muted ag-intro">{t('arc-guide.intro')}</p>
      {parts.length > 0 && (
        <p className="ag-imported">
          {t('arc-guide.repris', { parts: parts.join(', ') })}
        </p>
      )}

      <section aria-labelledby="ag-renamed">
        <h3 id="ag-renamed" className="ag-heading">
          {t('arc-guide.autre-nom')}
        </h3>
        <ul className="ag-rows">
          {row(
            'mini',
            t('arc-guide.ancien-little-arc'),
            t('little-arc-settings.mini-fenetre'),
            accelerator ? t('arc-guide.mini-fenetre-raccourci', { shortcut: formatAccelerator(accelerator, platform), menu }) : t('arc-guide.mini-fenetre-sans-raccourci', { menu }),
            [{ label: t('arc-guide.ouvrir-mini-fenetre'), place: 'miniWindow' }]
          )}
          {row(
            'tweaks',
            t('arc-guide.ancien-boosts'),
            t('site-panel.retouches'),
            <>
              {t('arc-guide.retouches-texte')} {!settings.boostsEnabled && t('arc-guide.retouches-coupees')}
            </>,
            [{ label: settingsLabel('tools'), place: 'tweaks' }]
          )}
          {row('links', t('arc-guide.ancien-air-traffic-control'), t('settings.ou-s-ouvrent-les-liens'), t('arc-guide.liens-texte'), [{ label: settingsLabel('navigation'), place: 'linkRouting' }])}
          {row(
            'glance',
            t('arc-guide.ancien-peek'),
            t('arc-guide.coup-d-oeil'),
            <>
              {t('arc-guide.coup-d-oeil-texte')} {!settings.peekWithShift && t('arc-guide.coup-d-oeil-coupe')}
            </>,
            [{ label: settingsLabel('navigation'), place: 'glance' }]
          )}
        </ul>
      </section>

      <section aria-labelledby="ag-same">
        <h3 id="ag-same" className="ag-heading">
          {t('arc-guide.meme-nom')}
        </h3>
        <ul className="ag-rows">
          <li className="ag-row">
            <h4 id="ag-spaces" className="ag-names">
              <b>{t('arc-guide.espaces-onglets-dossiers')}</b>
            </h4>
            <p className="ag-text">{t('arc-guide.espaces-onglets-dossiers-texte')}</p>
            <div className="ag-actions">
              <button type="button" className="tk-btn" aria-describedby="ag-spaces" onClick={() => go('spaces')}>
                {t('menu.espaces')}
              </button>
              <button type="button" className="tk-btn" aria-describedby="ag-spaces" onClick={() => go('archive')}>
                {t('menu.archive')}
              </button>
            </div>
          </li>
        </ul>
      </section>

      <section aria-labelledby="ag-absent">
        <h3 id="ag-absent" className="ag-heading">
          {t('arc-guide.absent-de-lucium')}
        </h3>
        <ul className="ag-absent">
          {excluded.map(([name, why]) => (
            <li key={name}>
              <b>{name}</b>
              <span>{why}</span>
            </li>
          ))}
        </ul>
      </section>
    </Sheet>
  )
}
