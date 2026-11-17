// The web hardware APIs (Settings › Vie privée et sécurité › Plus de réglages): the switch for WebHID, WebUSB and Web Serial, and the list of devices pages were let use, each with
// "Retirer". Off by default. The list lives in the main process (an authorization is not a setting: it ends with its tab), so it is asked for when the
// pane opens, when the window comes back to the front, and after each removal. Rendered by the Advanced pane (SettingsWindow.tsx), before the About group.

import { useCallback, useEffect, useState } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import type { HardwareGrantRow, HardwareReply, HardwareRequest } from '@shared/web-hardware'
import { api } from './api'
import { Check, Group, Row } from './settings-parts'
import { t } from '@shared/i18n'

export function HardwareSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  const unavailable = snapshot.private === true
  const [grants, setGrants] = useState<HardwareGrantRow[]>([])
  const [status, setStatus] = useState('')

  const ask = useCallback((request: HardwareRequest) => {
    void api()
      .webHardware(request)
      .then(
        (reply: HardwareReply) => {
          setGrants(reply.grants)
          setStatus(reply.message)
        },
        (error: unknown) => {
          console.warn('[web-hardware] the list of devices could not be read:', error)
          setStatus(t('hardware-settings.la-liste-des-appareils-n-a-pas-pu-etre-lue'))
        }
      )
  }, [])

  useEffect(() => {
    if (!settings.webHardware || unavailable) return setGrants([])
    const refresh = () => ask({ kind: 'list' })
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [settings.webHardware, unavailable, ask])

  return (
    <Group
      title={t('hardware-settings.api-materielles-du-web')}
      footnote={
        <span role="status">
          {status ||
            t('hardware-settings.une-cle-de-securite-un-clavier-et-une-souris-ne')}
        </span>
      }
    >
      <Check
        settingKey="webHardware"
        label={t('hardware-settings.autoriser-les-sites-a-demander-l-acces-a-un')}
        hint={
          unavailable
            ? t('hardware-settings.indisponible-dans-une-fenetre-privee-le')
            : t('hardware-settings.un-site-peut-demander-apres-un-clic-l-acces')
        }
        more={unavailable ? undefined : t('hardware-settings.un-site-securise-https-ou-ce-poste-ne-peut-le')}
        checked={settings.webHardware}
        disabled={unavailable}
        onChange={(webHardware) => update({ webHardware })}
      />
      {settings.webHardware && !unavailable && (
        <>
          <Row label={t('hardware-settings.appareils-autorises')} hint={t('hardware-settings.une-autorisation-dure-tant-qu-un-onglet')}>
            {grants.length > 1 && (
              <button className="link-button" onClick={() => ask({ kind: 'revoke-all' })}>
                {t('hardware-settings.tout-retirer')}
              </button>
            )}
          </Row>
          {grants.length === 0 && <Row label={<span className="muted">{t('hardware-settings.aucun-appareil-autorise')}</span>} />}
          {grants.map((grant) => (
            <Row key={grant.id} label={<span>{grant.device}</span>} hint={`${grant.kindName} · ${grant.site}`}>
              <button className="link-button" onClick={() => ask({ kind: 'revoke', id: grant.id })}>
                {t('settings.retirer')}
              </button>
            </Row>
          ))}
        </>
      )}
    </Group>
  )
}
