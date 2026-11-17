// Sharing Tweaks (Settings › Extensions et outils › Plus de réglages): bring one in from a file or a link, and what happens to the script of a Tweak that comes in.
// Rendered by the Advanced pane (SettingsWindow.tsx), before the About group. No account and no server: a file, or a text to paste.

import { useState } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import type { BoostShareRequest } from '@shared/boost-share'
import type { BoostScriptImport, Settings } from '@shared/model'
import { api } from './api'
import { Check, Group, Row } from './settings-parts'
import { t } from '@shared/i18n'
import { actionName } from './action-name'

// (A function and getters, not constants: the texts are looked up when the pane draws, in the language chosen then.)
const scriptChoices = (): Array<[BoostScriptImport, string]> => [
  ['ask', t('boost-share-settings.toujours-demander-le-script-arrive')],
  ['never', t('boost-share-settings.ne-jamais-l-importer')]
]

const SCRIPT_HINTS: Record<BoostScriptImport, string> = {
  get ask() { return t('boost-share-settings.le-script-arrive-desactive-il-ne-s-execute') },
  get never() { return t('boost-share-settings.le-script-d-une-retouche-importee-est-retire') }
}

export function BoostShareSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  // A private window keeps no Tweak: its Settings can show the group, but not use it.
  const unavailable = snapshot.private === true || !settings.boostSharing
  const [note, setNote] = useState('')
  const [pickedId, setPickedId] = useState('')
  // The list of the Tweaks, to send one out (the button of a Tweak in the site panel is the other way in): the first one until the person picks.
  const boosts = snapshot.state.boosts
  const picked = boosts.find((b) => b.id === pickedId) ?? boosts[0]
  const run = (request: BoostShareRequest) => {
    setNote('')
    void api()
      .boostShare(request)
      .then((reply) => setNote(reply.ok ? reply.message : reply.shown || reply.cancelled ? '' : reply.message))
      .catch((error: unknown) => {
        console.error('[boost] sharing failed:', error)
        setNote(t('boost-share-settings.le-partage-a-echoue'))
      })
  }
  return (
    <Group
      title={t('boost-share-settings.partage-des-retouches')}
      footnote={
        <>
          {t('boost-share-settings.sans-compte-ni-serveur-rien-n-est-envoye-ni')}
          {note && <span role="status"> {note}</span>}
        </>
      }
      more={t('boost-share-settings.un-boost-se-partage-par-un-fichier')}
    >
      <Check
        settingKey="boostSharing"
        label={t('boost-share-settings.activer-le-partage-de-retouches-et-de-themes')}
        hint={t('boost-share-settings.partagez-une-retouche-ou-un-theme-par-un')} more={t('boost-share-settings.fichier-ou-lien-depuis-l-editeur-d-un')}
        checked={settings.boostSharing}
        onChange={(boostSharing) => update({ boostSharing })}
      />
      {/* Every Tweak of the profile, with its switch and its editor: the list the export below sends to a file. */}
      <div className="pref-row pref-message" role="status">
        {t('boost-share-settings.toutes-mes-retouches')} · {boosts.length}
      </div>
      {boosts.length === 0 && <div className="pref-row pref-message">{t('boost-share-settings.aucune-retouche-pour-le-moment')}</div>}
      {boosts.map((boost) => (
        <div key={boost.id} className="pref-row">
          <div className="pref-label">
            {boost.name}
            <div className="pref-hint">{boost.host}</div>
          </div>
          <div className="pref-control">
            <button className="link-button" aria-label={actionName(boost.enabled ? t('boost-share-settings.desactiver') : t('boost-share-settings.activer'), boost.name)} onClick={() => void api().dispatch({ type: 'boost/save', boost: { ...boost, enabled: !boost.enabled } })}>
              {boost.enabled ? t('boost-share-settings.desactiver') : t('boost-share-settings.activer')}
            </button>
            <button className="link-button" aria-label={actionName(t('boost-share-settings.modifier'), boost.name)} onClick={() => api().openOverlay({ panel: 'boost', host: boost.host, id: boost.id })}>
              {t('boost-share-settings.modifier')}
            </button>
          </div>
        </div>
      ))}
      <Row label={t('boostshare.importer-une-retouche')} hint={t('boost-share-settings.un-fichier-choisi-dans-une-fenetre-ou-le')}>
        <button className="button" disabled={unavailable} onClick={() => run({ kind: 'import-file' })}>
          {t('boost-share-settings.importer-une-retouche')}
        </button>
        <button className="button" disabled={unavailable} onClick={() => run({ kind: 'import-link' })}>
          {t('boost-share-settings.coller-une-retouche')}
        </button>
      </Row>
      <Row label={t('boost-share-settings.exporter-des-retouches')} hint={boosts.length === 0 ? t('boostshare.aucune-retouche-a-exporter') : t('boost-share-settings.une-retouche-ou-toutes-dans-un-seul-fichier')}>
        <select className="field pop" aria-label={t('boost-share-settings.retouche-a-exporter')} value={picked?.id ?? ''} disabled={unavailable || boosts.length === 0} onChange={(e) => setPickedId(e.target.value)}>
          {boosts.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} · {b.host}
            </option>
          ))}
        </select>
        <button className="button" disabled={unavailable || !picked} onClick={() => picked && run({ kind: 'export-file', boostId: picked.id })}>
          {t('boost-share-settings.exporter')}
        </button>
        <button className="button" disabled={unavailable || boosts.length === 0} onClick={() => run({ kind: 'export-all' })}>
          {t('boost-share-settings.tout-exporter')}
        </button>
      </Row>
      <Row settingKey="boostScriptImport" label={t('boost-share-settings.importer-une-retouche-qui-contient-du-javascript')} hint={SCRIPT_HINTS[settings.boostScriptImport]} more={settings.boostScriptImport === 'ask' ? t('boost-share-settings.l-apercu-montre-le-debut-du-script-il-est') : undefined}>
        <select className="field pop" aria-label={t('boost-share-settings.importer-une-retouche-qui-contient-du-javascript')} value={settings.boostScriptImport} disabled={!settings.boostSharing} onChange={(e) => update({ boostScriptImport: e.target.value === 'never' ? 'never' : 'ask' })}>
          {scriptChoices().map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </Row>
    </Group>
  )
}
