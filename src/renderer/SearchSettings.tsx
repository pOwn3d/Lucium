// Settings › Recherche (`SearchSettings`): the search engine of the profile on screen (each profile has its own: CurrentProfileSettings.tsx), then where
// the propositions of the command bar come from. Settings › Barre de commandes (`CommandBarSettings`): the size and the shape of the command bar's card,
// the quick searches (the "!" keywords, the calculator, the search engines pages offer), the regular-expression search in a page, the keyword of a
// site, and the keywords of the extensions. These rows used to be in the box "Réglages de la recherche" of the Profiles pane.

import { useState } from 'react'
import { BUILTIN_BANGS } from '@shared/bangs'
import type { UiSnapshot } from '@shared/ipc'
import { COMMAND_BAR_SHAPES, COMMAND_BAR_SIZES, type CommandBarShape, type CommandBarSize, type Settings, type SiteSearch } from '@shared/model'
import { activeProfileId } from '@shared/profiles'
import { restoreDefaultSiteSearches, sameSiteSearches, siteSearchProblem, siteSearchProblemText } from '@shared/site-search'
import { ArcDialog } from './ArcDialog'
import { EngineRows } from './CurrentProfileSettings'
import { OmniboxKeywordSettings } from './KeyExtSettings'
import { Check, Group, Row, Subpage, SubpageEntry } from './settings-parts'
import { t, tp } from '@shared/i18n'

interface PaneProps {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

/** The arrow of « Rétablir », in the box that asks before the default searches come back (the box's own glyph is a bin, for what deletes). */
const RESTORE_ICON = (
  <svg viewBox="0 0 34 34" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 13a10 10 0 1 1-1 8M8 6v7h7" />
  </svg>
)

/**
 * « Rétablir les recherches par défaut », under the list of the searches of a site: after a question, the default searches that are not in the list come
 * back at its end (`restoreDefaultSiteSearches`); the user's own stay. « Annuler » in the line that follows gives the list of before, while the list is still
 * the one the restore made. Grey when nothing is missing.
 */
export function DefaultSiteSearches({ list, update }: { list: readonly SiteSearch[]; update: (patch: Partial<Settings>) => void }) {
  const [asking, setAsking] = useState(false)
  const [done, setDone] = useState<{ before: SiteSearch[]; after: SiteSearch[]; added: number } | null>(null)
  const plan = restoreDefaultSiteSearches(list)
  const restore = () => {
    setAsking(false)
    if (plan.added === 0) return
    setDone({ before: [...list], after: plan.list, added: plan.added })
    update({ siteSearches: plan.list })
  }
  const undo = done && sameSiteSearches(list, done.after) ? done : null
  return (
    <>
      <Row label={plan.added === 0 ? t('search-settings.recherches-par-defaut-toutes-la') : tp('search-settings.recherches-par-defaut-manquantes', plan.added)}>
        <button className="button" disabled={plan.added === 0} onClick={() => setAsking(true)}>
          {t('search-settings.retablir-les-recherches-par-defaut')}
        </button>
      </Row>
      {undo && (
        <div className="pref-row pref-message" role="status">
          {tp('search-settings.recherches-par-defaut-retablies', undo.added)}{' '}
          <button
            className="link-button"
            onClick={() => {
              update({ siteSearches: undo.before })
              setDone(null)
            }}
          >
            {t('settings.annuler')}
          </button>
        </div>
      )}
      {asking && (
        <ArcDialog
          title={t('search-settings.retablir-les-recherches-par-defaut-titre')}
          message={tp('search-settings.retablir-les-recherches-par-defaut-message', plan.added)}
          icon={RESTORE_ICON}
          danger={false}
          confirmLabel={t('search-settings.retablir')}
          onCancel={() => setAsking(false)}
          onConfirm={restore}
        />
      )}
    </>
  )
}

/** The names of the sizes and of the shapes of the command bar's card, as the menus show them (the order is that of the lists of the model). */
const BAR_SIZE_NAME: Record<CommandBarSize, () => string> = {
  s: () => t('search-settings.petite-s'),
  m: () => t('search-settings.moyenne-m'),
  l: () => t('search-settings.grande-l'),
  xl: () => t('search-settings.tres-grande-xl')
}
const BAR_SHAPE_NAME: Record<CommandBarShape, () => string> = {
  balanced: () => t('search-settings.equilibree'),
  wide: () => t('search-settings.large'),
  tall: () => t('search-settings.haute')
}

export function SearchSettings({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <>
      <Group id="engine" title={t('settings-profiles.moteur-de-recherche')}>
        <EngineRows snapshot={snapshot} update={update} profileId={activeProfileId(snapshot.state)} place="category" />
      </Group>

      {/* What the command bar and the find bar do with what is typed. Each line is a switch; the defaults keep the usual behaviour of the bar, except where a line says otherwise. */}
      <Group title={t('settings-profiles.propositions-de-la-barre-de-commandes')}>
        <Check settingKey="suggestHistory" label={t('settings-profiles.pages-de-l-historique')} checked={settings.suggestHistory} onChange={(suggestHistory) => update({ suggestHistory })} />
        <Check settingKey="suggestTabs" label={t('settings-profiles.onglets-ouverts')} checked={settings.suggestTabs} onChange={(suggestTabs) => update({ suggestTabs })} />
        <Check settingKey="goToOpenTab" label={t('settings-profiles.aller-a-l-onglet-deja-ouvert')} checked={settings.goToOpenTab} onChange={(goToOpenTab) => update({ goToOpenTab })} hint={t('settings-profiles.entree-va-a-l-onglet-deja-ouvert-plutot-que')} more={t('settings-profiles.dans-la-barre-ouverte-par-nouvel-onglet-entree-va-a')} />
        <Check settingKey="suggestArchive" label={t('settings-profiles.onglets-archives')} checked={settings.suggestArchive} onChange={(suggestArchive) => update({ suggestArchive })} />
        <Check settingKey="suggestReadLater" label={t('settings-profiles.pages-a-lire-plus-tard')} checked={settings.suggestReadLater} onChange={(suggestReadLater) => update({ suggestReadLater })} />
      </Group>
    </>
  )
}

/** Settings › Barre de commandes: the card of the bar, the quick searches, the search in the page, the keyword of a site, the keywords of the extensions. */
export function CommandBarSettings({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  const [draft, setDraft] = useState({ keyword: '', name: '', url: '' })
  // Said under the form while the button is grey: the user had to guess that the address needed `%s`.
  const problem = draft.keyword === '' && draft.name === '' && draft.url === '' ? null : siteSearchProblem(draft, settings.siteSearches)
  const valid = siteSearchProblem(draft, settings.siteSearches) === null
  const add = () => {
    if (!valid) return
    update({ siteSearches: [...settings.siteSearches, { keyword: draft.keyword.toLowerCase(), name: draft.name.trim(), url: draft.url }] })
    setDraft({ keyword: '', name: '', url: '' })
  }

  return (
    <>
      {/* The card of the bar, at the size and in the shape one wants: the bar reads them when it opens (shared/command-bar.ts, `barBox`) and never goes beyond the window. */}
      <Group title={t('search-settings.apparence-de-la-barre-de-commandes')}>
        <Row settingKey="commandBarSize" label={t('search-settings.taille')} hint={t('search-settings.agrandit-ou-reduit-la-barre-de-commandes')} more={t('search-settings.hint-taille')}>
          <select className="field pop" aria-label={t('search-settings.taille-de-la-barre-de-commandes')} value={settings.commandBarSize} onChange={(e) => update({ commandBarSize: e.target.value as CommandBarSize })}>
            {COMMAND_BAR_SIZES.map((size) => (
              <option key={size} value={size}>
                {BAR_SIZE_NAME[size]()}
              </option>
            ))}
          </select>
        </Row>
        <Row settingKey="commandBarShape" label={t('search-settings.forme')} hint={t('search-settings.hint-forme')}>
          <select className="field pop" aria-label={t('search-settings.forme-de-la-barre-de-commandes')} value={settings.commandBarShape} onChange={(e) => update({ commandBarShape: e.target.value as CommandBarShape })}>
            {COMMAND_BAR_SHAPES.map((shape) => (
              <option key={shape} value={shape}>
                {BAR_SHAPE_NAME[shape]()}
              </option>
            ))}
          </select>
        </Row>
        <SubpageEntry id="sitesearches" snapshot={snapshot} />
      </Group>

      <Group title={t('settings-profiles.recherche-rapide')} footnote={t('search-settings.lucium-connait-deja-des-mots-cles-comme-w')} more={t('search-settings.builtin-bangs', { list: BUILTIN_BANGS.map((b) => `!${b.keyword} ${b.name}`).join(' · ') })}>
        <Check settingKey="searchBangs" label={t('settings-profiles.mots-cles-avec-w-planete')} checked={settings.searchBangs} onChange={(searchBangs) => update({ searchBangs })} hint={t('search-settings.w-planete-cherche-dans-wikipedia-w-seul')} more={t('search-settings.info-bangs')} />
        <Check settingKey="commandBarCalc" label={t('settings-profiles.calculatrice-12-3-4')} checked={settings.commandBarCalc} onChange={(commandBarCalc) => update({ commandBarCalc })} hint={t('search-settings.un-calcul-tape-dans-la-barre-de-commandes')} more={t('search-settings.info-calc')} />
        <Check settingKey="searchDiscovery" label={t('settings-profiles.proposer-d-ajouter-la-recherche-d-un-site')} checked={settings.searchDiscovery} onChange={(searchDiscovery) => update({ searchDiscovery })} hint={t('search-settings.quand-un-site-a-sa-propre-recherche-une')} more={t('search-settings.info-discovery')} />
      </Group>

      <Subpage id="sitesearches">
      <Group title={t('search-settings.recherche-dans-un-site')} keys={['siteSearches']} footnote={t('settings-profiles.tapez-le-mot-cle-seul-pour-ouvrir-le-site-ou')} more={t('settings-profiles.recherche-dans-un-site-tapez-le-mot-cle-puis')}>
        {settings.siteSearches.length === 0 && <div className="pref-row pref-message">{t('settings-profiles.aucune-recherche')}</div>}
        {settings.siteSearches.map((site) => (
          <Row
            key={site.keyword}
            label={
              <>
                <code>{site.keyword}</code> {site.name}
              </>
            }
          >
            <button className="link-button" aria-label={t('settings.retirer-name', { name: site.name })} onClick={() => update({ siteSearches: settings.siteSearches.filter((x) => x.keyword !== site.keyword) })}>
              {t('settings.retirer')}
            </button>
          </Row>
        ))}
        <div className="pref-row pref-form">
          <input className="field narrow" placeholder={t('search-settings.mot-cle')} aria-label={t('settings-profiles.mot-cle')} value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} />
          <input className="field narrow" placeholder={t('search-settings.nom')} aria-label={t('settings-profiles.nom')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="field" placeholder={t('search-settings.adresse')} aria-label={t('settings-profiles.adresse')} value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="button" disabled={!valid} onClick={add}>
            {t('settings.ajouter')}
          </button>
        </div>
        <div className="pref-row pref-message" role="status">
          {problem ? siteSearchProblemText(problem) : t('settings-profiles.raccourci-aide')}
        </div>
        <DefaultSiteSearches list={settings.siteSearches} update={update} />
      </Group>
      </Subpage>

      <OmniboxKeywordSettings snapshot={snapshot} update={update} />
    </>
  )
}
