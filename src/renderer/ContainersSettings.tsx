// « Fonctions en option » › Conteneurs d’onglets: the containers (create, rename, colour, delete with their data) and the sites that always open in one,
// on the subpage « Vos conteneurs », whose row follows the line of the feature (its switch, FeaturesPage.tsx). It shows nothing while the function is off
// and no container exists; with the function off and containers left, they can still be renamed and deleted.

import { useState } from 'react'
import { CONTAINERS_MAX, CONTAINER_COLORS, CONTAINER_NAME_MAX, containerHex, containerRuleHost, validateContainerName, type Container } from '@shared/containers'
import type { UiSnapshot } from '@shared/ipc'
import { api } from './api'
import { ArcDialog } from './ArcDialog'
import { Group, Row, Subpage } from './settings-parts'
import { t, tp } from '@shared/i18n'

interface Props {
  snapshot: UiSnapshot
}

/** The colour dot of a container, as the menus and the tabs wear it. */
function Dot({ color }: { color: string }) {
  return <span className="container-dot" style={{ background: containerHex(color) }} aria-hidden="true" />
}

function ContainerRow({ container, names, tabs, onDelete }: { container: Container; names: readonly string[]; tabs: number; onDelete: () => void }) {
  const act = api()
  const [name, setName] = useState(container.name)
  const others = names.filter((n) => n !== container.name)
  const problem = name === container.name ? null : validateContainerName(name, others)
  const commit = () => {
    if (name === container.name) return
    if (problem === null) void act.dispatch({ type: 'container/update', id: container.id, patch: { name } })
    else setName(container.name)
  }
  return (
    <Row label={<Dot color={container.color} />} hint={tabs > 0 ? tp('containers-settings.open-tabs', tabs) : undefined}>
      <input
        className="field"
        value={name}
        maxLength={CONTAINER_NAME_MAX}
        aria-label={t('containers-settings.nom-du-conteneur-name', { name: container.name })}
        aria-invalid={problem !== null}
        title={problem ?? undefined}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setName(container.name)
        }}
      />
      <select className="field" aria-label={t('containers-settings.couleur-du-conteneur-name', { name: container.name })} value={container.color} onChange={(e) => void act.dispatch({ type: 'container/update', id: container.id, patch: { color: e.target.value } })}>
        {CONTAINER_COLORS.map((color) => (
          <option key={color.id} value={color.id}>
            {color.label}
          </option>
        ))}
      </select>
      <button className="link-button" onClick={onDelete} aria-label={t('containers-settings.supprimer-le-conteneur-name', { name: container.name })}>
        {t('containers-settings.supprimer')}
      </button>
    </Row>
  )
}

export function ContainersSettings({ snapshot }: Props) {
  const { settings, tabs } = snapshot.state
  const act = api()
  const [name, setName] = useState('')
  const [site, setSite] = useState('')
  const [target, setTarget] = useState('')
  const [deleting, setDeleting] = useState<Container | null>(null)
  if (!settings.tabContainers && settings.containers.length === 0) return null

  const names = settings.containers.map((c) => c.name)
  const problem = name.trim() === '' ? null : validateContainerName(name, names)
  const full = settings.containers.length >= CONTAINERS_MAX
  const create = () => {
    if (problem !== null || name.trim() === '' || full) return
    void act.dispatch({ type: 'container/create', name })
    setName('')
  }
  const host = site.trim() === '' ? null : containerRuleHost(site)
  const chosen = settings.containers.some((c) => c.id === target) ? target : (settings.containers[0]?.id ?? '')
  const addRule = () => {
    if (host === null || chosen === '') return
    void act.dispatch({ type: 'container/rule', host, container: chosen })
    setSite('')
  }
  const inContainer = (id: string) => tabs.filter((t) => t.container === id && t.private !== true).length
  // What closing the container does to its open tabs, as the end of the sentence of the box (nothing to say when there is none).
  const openTabsClosed = (count: number): string => (count === 0 ? '' : count === 1 ? t('containers-settings.et-son-onglet-ouvert-ferme-sans-passer-par') : t('containers-settings.et-ses-count-onglets-ouverts-fermes-sans', { count }))

  return (
    <>
      {/* On the subpage « Vos conteneurs », whose row follows the line of the feature (FeaturesPage.tsx). */}
      <Subpage id="containers">
      <Group
        title={t('containers-settings.conteneurs-d-onglets')}
        keys={['containers']}
        footnote={
          settings.tabContainers
            ? t('containers-settings.un-onglet-dans-un-conteneur-a-ses-propres')
            : t('containers-settings.desactives-aucun-nouveau-conteneur-aucune-regle')
        }
        more={settings.tabContainers ? t('containers-settings.un-onglet-ouvert-dans-un-conteneur-a-ses') : undefined}
      >
        {settings.containers.length === 0 && (
          <div className="pref-row pref-message" role="status">
            {t('containers-settings.aucun-conteneur')}
          </div>
        )}
        {settings.containers.map((container) => (
          <ContainerRow key={container.id} container={container} names={names} tabs={inContainer(container.id)} onDelete={() => setDeleting(container)} />
        ))}
        {settings.tabContainers && (
          <div className="pref-row pref-form">
            <input
              className="field"
              placeholder={t('containers-settings.travail-perso-achats')}
              aria-label={t('containers-settings.nom-du-nouveau-conteneur')}
              aria-invalid={problem !== null}
              value={name}
              maxLength={CONTAINER_NAME_MAX}
              disabled={full}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <button className="button" disabled={name.trim() === '' || problem !== null || full} onClick={create}>
              {t('containers-settings.creer')}
            </button>
          </div>
        )}
        {problem !== null && (
          <div className="pref-row pref-message pref-error" role="alert">
            {problem}
          </div>
        )}
        {full && settings.tabContainers && (
          <div className="pref-row pref-message" role="status">
            {t('containers-settings.limite-de-containers-max-conteneurs-atteinte', { CONTAINERS_MAX })}
          </div>
        )}
      </Group>

      {settings.containers.length > 0 && (
        <Group title={t('containers-settings.sites-qui-s-ouvrent-toujours-dans-un-conteneur')} keys={['containerRules']} footnote={t('containers-settings.un-site-de-la-liste-couvre-aussi-ses-sous')}>
          {settings.containerRules.length === 0 && (
            <div className="pref-row pref-message" role="status">
              {t('settings.aucun-site')}
            </div>
          )}
          {settings.containerRules.map((rule) => (
            <Row key={rule.host} label={<code>{rule.host}</code>}>
              <span className="pref-hint">{settings.containers.find((c) => c.id === rule.containerId)?.name}</span>
              <button className="link-button" onClick={() => void act.dispatch({ type: 'container/rule', host: rule.host, container: null })} aria-label={t('containers-settings.retirer-la-regle-de-host', { host: rule.host })}>
                {t('settings.retirer')}
              </button>
            </Row>
          ))}
          {settings.tabContainers && (
            <div className="pref-row pref-form">
              <input
                className="field"
                placeholder={t('settings.exemple-org')}
                aria-label={t('containers-settings.site-a-ouvrir-dans-un-conteneur')}
                aria-invalid={site.trim() !== '' && host === null}
                value={site}
                onChange={(e) => setSite(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addRule()}
              />
              <select className="field" aria-label={t('containers-settings.conteneur-du-site')} value={chosen} onChange={(e) => setTarget(e.target.value)}>
                {settings.containers.map((container) => (
                  <option key={container.id} value={container.id}>
                    {container.name}
                  </option>
                ))}
              </select>
              <button className="button" disabled={host === null} onClick={addRule}>
                {t('settings.ajouter')}
              </button>
            </div>
          )}
          {site.trim() !== '' && host === null && (
            <div className="pref-row pref-message pref-error" role="alert">
              {t('containers-settings.saisissez-un-nom-de-site-comme-exemple-org')}
            </div>
          )}
        </Group>
      )}

      </Subpage>

      {deleting && (
        <ArcDialog
          title={t('containers-settings.supprimer-le-conteneur-name-2', { name: deleting.name })}
          message={t('containers-settings.ses-cookies-connexions-stockage-et', { tabs: openTabsClosed(inContainer(deleting.id)) })}
          cancelLabel={t('settings.annuler')}
          confirmLabel={t('containers-settings.confirmer-la-suppression')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            void act.dispatch({ type: 'container/delete', id: deleting.id })
            setDeleting(null)
          }}
        />
      )}
    </>
  )
}
