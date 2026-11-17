// Settings › À propos et mises à jour › Plus de réglages › État de Lucium (the anchor `#about/status`, which Aide › État de Lucium… opens): the versions,
// the platform, the lists of the blocker, a few counts and the journal of errors, and a report in plain text to copy. Read once when the pane is shown (and again on "Actualiser"): nothing runs in the background, and nothing leaves the
// machine. The report holds no address, no title and no name (shared/engine-status.ts); the journal, which can name sites, is apart and has its own button.

import { useCallback, useEffect, useState } from 'react'
import type { SettingsAnchor, UiSnapshot } from '@shared/ipc'
import { buildReport, formatWhen, listsText, number, platformName, summarizeLists, variantName, widevineText, type EngineHost } from '@shared/engine-status'
import { defaultSettings } from '@shared/model'
import { isModified, type SettingKey } from '@shared/settings-catalog'
import { api } from './api'
import { Group, Row } from './settings-parts'
import { t, tp } from '@shared/i18n'
import './insight.css'

/** The anchor of the group (shared/ipc.ts `SETTINGS_ANCHORS`): Aide › État de Lucium… and the notice of an internal error lead here. */
const STATUS_ANCHOR = 'status' satisfies SettingsAnchor

type Reading = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; host: EngineHost; appVersion: string; at: number }

interface Status {
  text: string
  failed: boolean
}

/** A block of plain text with a name (the log, the report). A bare <pre> is a generic element, whose `aria-label` is not exposed: the role makes the name heard. */
export function NamedText({ className, name, text }: { className: string; name: string; text: string }) {
  return (
    <pre className={className} role="group" aria-label={name}>
      {text}
    </pre>
  )
}

export function EngineStatus({ snapshot }: { snapshot: UiSnapshot }) {
  const [reading, setReading] = useState<Reading>({ state: 'loading' })
  const [status, setStatus] = useState<Status | null>(null)

  const read = useCallback(() => {
    Promise.all([api().engineStatus(), api().aboutVersion()])
      .then(([host, appVersion]) => setReading(host === null ? { state: 'failed' } : { state: 'ready', host, appVersion, at: Date.now() }))
      .catch((error: unknown) => {
        // The window is closing or the application is locked: the pane says it could not read, instead of staying blank.
        console.warn('[status] the state of the engine could not be read:', error)
        setReading({ state: 'failed' })
      })
  }, [])
  useEffect(read, [read])

  const copy = (text: string, done: string) => {
    api()
      .writeClipboardText(text)
      .then((ok) => setStatus(ok ? { text: done, failed: false } : { text: t('engine-status.le-presse-papiers-n-est-pas-accessible'), failed: true }))
      .catch((error: unknown) => {
        console.warn('[status] the clipboard refused the text:', error)
        setStatus({ text: t('engine-status.le-presse-papiers-n-est-pas-accessible'), failed: true })
      })
  }

  // The group keeps its place while the state is read (the same first child of a fragment): the link that landed on it keeps its light and its focus.
  if (reading.state !== 'ready') {
    return (
      <>
        <Group id={STATUS_ANCHOR} placement="more" title={t('engine-status.etat-d-lucium')}>
          <Row label={<span className="muted">{reading.state === 'loading' ? t('engine-status.lecture-en-cours') : t('engine-status.l-etat-du-moteur-n-a-pas-pu-etre-lu')}</span>}>
            {reading.state === 'failed' && (
              <button className="button" onClick={read}>
                {t('engine-status.actualiser')}
              </button>
            )}
          </Row>
        </Group>
      </>
    )
  }

  const { host, appVersion } = reading
  const { settings } = snapshot.state
  const lists = summarizeLists(snapshot.blocking?.lists)
  const modified = Object.keys(defaultSettings()).filter((key) => isModified(settings, key as SettingKey))
  const report = buildReport({ now: reading.at, appVersion, engine: snapshot.engine, platform: snapshot.platform, host, lists, extensions: snapshot.extensions, boosts: snapshot.state.boosts.length, tabs: snapshot.state.tabs.length, modified })
  return (
    <>
      <Group id={STATUS_ANCHOR} placement="more" title={t('engine-status.etat-d-lucium')} footnote={t('engine-status.ce-que-le-support-demande-sur-une-page-rien-ne-part-d-ici')}>
        <Row label="Lucium">
          <span className="insight-num">{appVersion || '?'}</span>
        </Row>
        <Row label="Electron">
          <span className="insight-num">{snapshot.engine.version}</span>
        </Row>
        <Row label="Chromium">
          <span className="insight-num">{snapshot.engine.chromium}</span>
        </Row>
        <Row label={t('engine-status.variante')} hint={host.variant === 'ecs' ? t('engine-status.cette-variante-contacte-le-service-de-composants-de-google') : t('engine-status.les-videos-protegees-ne-se-lisent-pas')}>
          <span className={`insight-chip ${host.variant === 'ecs' ? 'on' : ''}`}>{variantName(host.variant)}</span>
        </Row>
        <Row label="Widevine">
          <span className="insight-text">{widevineText(host.widevine)}</span>
        </Row>
        <Row label={t('engine-status.systeme')}>
          <span className="insight-text">{`${platformName(snapshot.platform)} ${host.osRelease} · ${host.arch}`}</span>
        </Row>
        <Row label={t('engine-status.listes-du-bloqueur')}>
          <span className={`insight-chip ${lists.installed === 0 ? 'warn' : ''}`}>{listsText(lists)}</span>
        </Row>
        <Row label={t('engine-status.extensions-et-retouches')}>
          <span className="insight-text">{t('engine-status.extensions-boosts-value', { extensions: snapshot.extensions.length, boosts: snapshot.state.boosts.length })}</span>
        </Row>
        <Row label={t('engine-status.memoire-et-processus')} hint={t('engine-status.mesure-a-time', { time: formatWhen(reading.at) })}>
          <span className="insight-num">{t('engine-status.memoire-value', { memory: number(host.memoryMb), processes: host.processes })}</span>
        </Row>
        <Row label={t('engine-status.actualiser')}>
          <button className="button" onClick={read}>
            {t('engine-status.actualiser')}
          </button>
        </Row>
      </Group>

      <Group placement="more" title={t('engine-status.journal-des-erreurs')} footnote={t('engine-status.les-dernieres-lignes-du-processus-principal-sur-cet-ordinateur-seulement')}>
        {host.log.length === 0 ? (
          <Row label={<span className="muted">{t('engine-status.rien-a-signaler-depuis-le-lancement')}</span>} />
        ) : (
          <>
            <NamedText className="insight-log" name={t('engine-status.journal-des-erreurs')} text={host.log.join('\n')} />
            <Row label={<span className="muted">{tp('engine-status.count-lignes', host.log.length)}</span>}>
              <button className="button" onClick={() => copy(host.log.join('\n'), t('engine-status.journal-copie-count-lignes', { count: host.log.length }))}>
                {t('engine-status.copier-le-journal')}
              </button>
              <button className="button" onClick={() => api().clearErrorLog().then(read).catch((error: unknown) => console.warn('[status] the log could not be cleared:', error))}>
                {t('engine-status.effacer-le-journal')}
              </button>
            </Row>
          </>
        )}
      </Group>

      <Group placement="more" title={t('engine-status.rapport')} footnote={t('engine-status.texte-brut-versions-listes-nombres-sans-adresse-sans-historique')}>
        <NamedText className="insight-report" name={t('engine-status.apercu-du-rapport-ce-qui-sera-copie')} text={report} />
        <Row label={<span className="muted">{t('engine-status.apercu-du-rapport-ce-qui-sera-copie')}</span>}>
          <button className="button primary" onClick={() => copy(report, t('engine-status.rapport-copie-count-caracteres', { count: number(report.length) }))}>
            {t('engine-status.copier-le-rapport')}
          </button>
        </Row>
        {status && (
          <p className={`insight-status ${status.failed ? 'failed' : ''}`} role={status.failed ? 'alert' : 'status'}>
            {status.text}
          </p>
        )}
      </Group>
    </>
  )
}
