// Settings › Téléchargements et fichiers › Synchronisation (docs/synchronisation.md §13.1): the switch, whether this Mac is listening for its iPhone, what is synchronised,
// the devices, and the sheet that adds an iPhone (a QR, the address and a code to type, then the question « Autoriser / Refuser » when the iPhone asks).
//
// The synchronisation lives in the main process (src/main/sync/): this page holds no key and no secret of its own. It asks (`api().sync`), it draws the state it is
// given, and it asks again once a second while it is on screen (the countdowns). The Mac listens for as long as the switch is on, Lucium is unlocked and an iPhone is
// paired (§6.1): nothing here opens or closes it, and leaving the page only closes the sheet of a pairing. The state is asked for only while the page is drawn.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { encodeQr, qrPath } from '@shared/qr'
import { syncSummary } from '@shared/settings-subpages'
import { SYNC_CATEGORIES, type SyncCategory, type SyncRequest, type SyncStatus } from '@shared/sync-ipc'
import { api } from './api'
import { Check, Group, Row, Subpage, SubpageEntry } from './settings-parts'
import './sync-settings.css'

const POLL_MS = 1000
const MARGIN = 4

/** `8:40`: what is left of a window, a code or a question. */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const when = (ms: number): string => new Date(ms).toLocaleString(getLanguage(), { dateStyle: 'medium', timeStyle: 'short' })

/** Getters: the texts are looked up when the page draws, in the language chosen then. */
const CATEGORY_TEXT: Record<SyncCategory, { label: () => string; hint: () => string }> = {
  structure: { label: () => t('sync.category-structure'), hint: () => t('sync.category-structure-hint') },
  settings: { label: () => t('sync.category-settings'), hint: () => t('sync.category-settings-hint') },
  archive: { label: () => t('sync.category-archive'), hint: () => t('sync.category-archive-hint') },
  openTabs: { label: () => t('sync.category-opentabs'), hint: () => t('sync.category-opentabs-hint') }
}

/**
 * The state of the synchronisation and the way to change it. `ask` sends one request and keeps the state that comes back; a refusal keeps its sentence, which the page
 * shows. While `watch` is true the state is read again every second; leaving sends `leave`, which closes the window.
 */
function useSync(watch: boolean) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [message, setMessage] = useState('')
  const live = useRef(true)

  const ask = useCallback(async (request: SyncRequest): Promise<void> => {
    try {
      const reply = await api().sync(request)
      if (!live.current) return
      if (reply.status !== null) setStatus(reply.status)
      setMessage(reply.ok ? '' : reply.message)
    } catch (error) {
      // The main process did not answer (the window is closing, the channel refused): the sentence says so, and the log has the rest.
      console.warn('[sync] the request of the page failed:', error)
      if (live.current) setMessage(t('sync.error.internal'))
    }
  }, [])

  useEffect(() => {
    live.current = true
    void ask({ kind: 'status' })
    if (!watch) return () => void (live.current = false)
    const timer = setInterval(() => void ask({ kind: 'status' }), POLL_MS)
    return () => {
      live.current = false
      clearInterval(timer)
      // The page is left: the sheet of a pairing closes with it (the main process does the same when the Settings window itself closes).
      void api()
        .sync({ kind: 'leave' })
        .catch((error: unknown) => console.warn('[sync] leaving the page could not be told:', error))
    }
  }, [ask, watch])

  return { status, message, ask }
}

/** The QR as a drawing, from the encoder of the project: nothing is sent to a service. A white square whatever the theme: a reader needs a light margin. */
function QrDrawing({ text }: { text: string }) {
  const result = useMemo(() => encodeQr(text), [text])
  if ('error' in result) return <p className="sync-problem" role="alert">{result.error}</p>
  const side = result.size + MARGIN * 2
  return (
    <svg className="sync-qr" viewBox={`0 0 ${side} ${side}`} role="img" aria-label={t('sync.add-qr-label')} shapeRendering="crispEdges">
      <rect width={side} height={side} fill="#fff" />
      <path d={qrPath(result, MARGIN)} fill="#000" />
    </svg>
  )
}

/** The row of the page « Fichiers » that opens the subpage: its state, read once when the page is drawn (no polling, no window is opened for it). */
export function SyncEntry({ snapshot }: { snapshot: UiSnapshot }) {
  const { status } = useSync(false)
  const summary = status === null ? '' : syncSummary({ enabled: status.enabled, devices: status.devices.length, listening: status.listening })
  return <SubpageEntry id="sync" snapshot={snapshot} summary={summary} />
}

function Panel() {
  const { status, message, ask } = useSync(true)
  if (status === null) return message ? <div className="pref-row sync-problem" role="alert">{message}</div> : null
  const on = status.enabled
  return (
    <>
      <Group title={t('sync.title')}>
        <Check label={t('sync.switch-label')} hint={t('sync.switch-hint')} checked={on} disabled={!status.available && !on} onChange={(enabled) => void ask({ kind: 'enable', on: enabled })} />
        {!status.available && <Row label={<span className="muted">{t('sync.unavailable')}</span>} />}
        {status.identityReplaced && <Row label={<span className="sync-notice" role="status">{t('sync.identity-replaced')}</span>} />}
        {message && <Row label={<span className="sync-problem" role="alert">{message}</span>} />}
      </Group>
      {on && (
        <>
          <Group title={t('sync.listening-title')} footnote={t('sync.listening-hint')}>
            <Row label={<span className={status.listening ? 'sync-notice' : 'muted'} role="status">{t(status.listening ? 'sync.listening-on' : status.devices.length > 0 ? 'sync.listening-failed' : 'sync.listening-off')}</span>} />
          </Group>
          <Group title={t('sync.categories-title')} footnote={t('sync.categories-never')}>
            {SYNC_CATEGORIES.map((category) => (
              <Check key={category} label={CATEGORY_TEXT[category].label()} hint={CATEGORY_TEXT[category].hint()} checked={status.categories[category]} onChange={(checked) => void ask({ kind: 'category', category, on: checked })} />
            ))}
          </Group>
          <Group title={t('sync.devices-title')}>
            {status.devices.length === 0 && <Row label={<span className="muted">{t('sync.devices-none')}</span>} />}
            {status.devices.map((device) => (
              <Row
                key={device.id}
                label={<span className="sync-device-name">{device.name}</span>}
                hint={`${device.platform === 'ios' ? t('sync.device-ios') : t('sync.device-mac')} · ${t('sync.device-paired', { date: when(device.pairedAt) })} · ${device.lastSessionAt === null ? t('sync.device-never') : t('sync.device-last', { date: when(device.lastSessionAt) })}`}
              >
                <button type="button" className="link-button" aria-label={t('sync.device-forget-label', { name: device.name })} onClick={() => void ask({ kind: 'forget', id: device.id })}>
                  {t('sync.device-forget')}
                </button>
              </Row>
            ))}
            {status.justPaired !== null && <Row label={<span className="sync-notice" role="status">{t('sync.paired', { name: status.justPaired })}</span>} />}
            <Row label={t('sync.add-title')}>
              <button type="button" className="button" onClick={() => void ask({ kind: 'pair-start' })}>
                {t('sync.add-button')}
              </button>
            </Row>
          </Group>
          {status.pairing !== null && (
            <Group title={t('sync.add-title')}>
              <div className="sync-sheet" role="group" aria-label={t('sync.add-title')}>
                <p className="pref-hint">{t('sync.add-steps')}</p>
                <QrDrawing text={status.pairing.qr} />
                <dl className="sync-fields">
                  <dt>{t('sync.add-address')}</dt>
                  <dd>{status.pairing.address}</dd>
                  <dt>{t('sync.add-code')}</dt>
                  <dd>{status.pairing.code}</dd>
                </dl>
                <p className="sync-timer" role="timer">
                  {t('sync.add-expires', { time: countdown(status.pairing.remainingMs) })}
                </p>
                <div className="sync-buttons">
                  <button type="button" className="button" onClick={() => void ask({ kind: 'pair-close' })}>
                    {t('sync.add-close')}
                  </button>
                </div>
              </div>
            </Group>
          )}
          {status.confirm !== null && (
            <div className="sync-confirm" role="alertdialog" aria-labelledby="sync-confirm-title" aria-describedby="sync-confirm-text">
              <p className="sync-confirm-title" id="sync-confirm-title">
                {t(status.confirm.waiting ? 'sync.confirm-waiting-title' : 'sync.confirm-title')}
              </p>
              <p className="sync-confirm-text" id="sync-confirm-text">
                {t(status.confirm.waiting ? 'sync.confirm-waiting-body' : 'sync.confirm-body', { name: status.confirm.name })}
              </p>
              <p className="sync-confirm-code">
                <span>{t('sync.confirm-code')}</span> <strong className="sync-code">{status.confirm.code}</strong>
              </p>
              {status.confirm.address !== '' && <p className="pref-hint">{t('sync.confirm-address', { address: status.confirm.address })}</p>}
              <p className="pref-hint" role="timer">
                {t(status.confirm.waiting ? 'sync.confirm-waiting-timer' : 'sync.confirm-timer', { time: countdown(status.confirm.remainingMs) })}
              </p>
              <div className="sync-buttons">
                {status.confirm.waiting ? (
                  <button type="button" className="button" onClick={() => void ask({ kind: 'answer', allow: false })}>
                    {t('sync.confirm-cancel')}
                  </button>
                ) : (
                  <>
                    <button type="button" className="button primary" onClick={() => void ask({ kind: 'answer', allow: true })}>
                      {t('sync.confirm-allow')}
                    </button>
                    <button type="button" className="button" onClick={() => void ask({ kind: 'answer', allow: false })}>
                      {t('sync.confirm-refuse')}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}

/** The subpage: drawn (and the state asked for) only while it is the page on screen. */
export function SyncSettings() {
  return (
    <Subpage id="sync">
      <Panel />
    </Subpage>
  )
}
