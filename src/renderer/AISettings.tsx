// The page summary by a local model (Settings › Outils web): what happens to the page with the settings as they are, the switch of the summary,
// and the configuration of Ollama. The address is one of this Mac or a private one of the local network, or it is refused; another computer is
// said in words as soon as its address is in the field.

import { useState } from 'react'
import {
  DEFAULT_OLLAMA_CONFIG,
  OLLAMA_TEMPERATURE_MAX,
  OLLAMA_TOKENS_MAX,
  OLLAMA_TOKENS_MIN,
  isLocalOllamaAddress,
  isOllamaAddress,
  ollamaModelField,
  ollamaModelOptions,
  readOllamaModels,
  sameOllamaModel,
  summaryDestination,
  type OllamaConfig,
  type OllamaModelsRead,
  type SummarySettings
} from '@shared/ollama'
import { api } from './api'
import { Check, Row } from './settings-parts'
import { t, tp } from '@shared/i18n'

/** What a connection test that worked says: the first five models of the server, and how many more it has. */
export function connectedText(models: readonly string[]): string {
  if (models.length === 0) return t('ollama-settings.test-connecte-aucun-modele')
  const listed = t('ollama-settings.test-connecte', { models: models.slice(0, 5).join(', ') })
  return models.length > 5 ? `${listed} ${tp('ollama-settings.test-autres-modeles', models.length - 5)}` : listed
}

/**
 * The sentence at the head of the section: what happens to a page with the settings as they are. With Ollama on another computer it names that
 * computer and says that the page leaves this Mac.
 */
export function summaryDataText(settings: SummarySettings): string {
  const destination = summaryDestination(settings)
  switch (destination.kind) {
    case 'off':
      return t('ollama-settings.donnees-off')
    case 'none':
      return t('ollama-settings.donnees-aucun')
    case 'local':
      return t('ollama-settings.donnees-local')
    case 'network':
      return t('ollama-settings.donnees-reseau', { host: destination.host })
  }
}

/**
 * What the row of the address says of the address in it, or null for an address of this Mac: that it is refused, or that it is the one of another
 * computer and that the text of the page leaves this Mac, in clear over http. Said for the address as typed, whether or not Ollama answers there.
 */
export function addressNote(url: string): string | null {
  if (!isOllamaAddress(url)) return t('ollama-settings.adresse-refusee')
  if (isLocalOllamaAddress(url)) return null
  return new URL(url).protocol === 'http:' ? t('ollama-settings.reseau-en-clair') : t('ollama-settings.reseau-chiffre')
}

interface AiProps {
  settings: { ollamaConfig: OllamaConfig; aiSummary: boolean }
  update: (patch: Partial<{ ollamaConfig: OllamaConfig; aiSummary: boolean }>) => void
}

export function AISettings({ settings, update }: AiProps) {
  const config = { ...DEFAULT_OLLAMA_CONFIG, ...settings.ollamaConfig }
  const [testing, setTesting] = useState(false)
  const [testStatus, setTestStatus] = useState<{ ok: boolean; message: string }>({ ok: false, message: '' })
  // The models of the server, read from its /api/tags for the address it was asked at. Only a click asks for it: turning Ollama on,
  // « Lire les modèles installés », or a connection test that succeeds; never the drawing of the pane (the search draws every pane).
  const [models, setModels] = useState<OllamaModelsRead | null>(null)
  const field = ollamaModelField(models, config.url)
  const listed = models?.url === config.url ? models : null
  // A refused address is never asked anything: the row says so, and the buttons that would reach it are disabled.
  const refused = !isOllamaAddress(config.url)
  const note = addressNote(config.url)

  const readModels = async (url: string) => {
    setModels({ url, status: 'loading' })
    const read = await readOllamaModels(url, (address) => api().ollamaModels(address))
    // An answer for an address the field no longer holds is dropped: the row would offer the models of another server.
    setModels((current) => (current?.url === url ? read : current))
  }

  const handleTest = async () => {
    setTesting(true)
    setTestStatus({ ok: false, message: t('ollama-settings.connection-testing') })
    try {
      const result = await api().ollamaTest(config.url)
      if (result.ok) {
        void readModels(config.url)
        setTestStatus({ ok: true, message: connectedText(result.models) })
      } else {
        setTestStatus({ ok: false, message: t('ollama-settings.test-echec', { error: result.error }) })
      }
    } catch (error) {
      // The request itself did not come back (the window is closing, the main process refused it): the row says so, as for a server that does not answer.
      console.warn('[ai] the connection test of Ollama could not be asked for:', error)
      setTestStatus({ ok: false, message: t('ollama-settings.test-echec', { error: error instanceof Error ? error.message : String(error) }) })
    } finally {
      // Whatever happened, the button comes back: left disabled, it could only be had again by opening the pane anew.
      setTesting(false)
    }
  }

  const data = summaryDataText({ aiSummary: settings.aiSummary !== false, ollamaConfig: config })

  return (
    <>
      <p className="pref-note ai-data-note">{data}</p>

      <Check
        label={t('ollama-settings.summary-label')}
        hint={t('ollama-settings.summary-hint')}
        checked={settings.aiSummary !== false}
        onChange={(aiSummary) => update({ aiSummary })}
      />

      <Check
        label={t('ollama-settings.enable-label')}
        hint={t('ollama-settings.enable-hint')}
        checked={config.enabled}
        onChange={(enabled) => {
          update({ ollamaConfig: { ...config, enabled } })
          if (enabled && !refused) void readModels(config.url)
        }}
      />

      {config.enabled && (
        <>
          <Row label={t('ollama-settings.url-label')} hint={t('ollama-settings.url-hint')}>
            <input
              className="field"
              type="text"
              spellCheck={false}
              autoComplete="off"
              aria-label={t('ollama-settings.url-label')}
              placeholder={t('ollama-settings.url-placeholder')}
              value={config.url}
              onChange={(e) => update({ ollamaConfig: { ...config, url: e.target.value } })}
            />
          </Row>
          {note !== null && (
            <div className="pref-row pref-message" role="status">
              {note}
            </div>
          )}

          <Row label={t('ollama-settings.model-label')} hint={t('ollama-settings.model-hint')}>
            {field === 'list' && listed?.status === 'ok' ? (
              <select
                className="field pop"
                aria-label={t('ollama-settings.model-label')}
                value={listed.models.find((name) => sameOllamaModel(name, config.model)) ?? config.model}
                onChange={(e) => update({ ollamaConfig: { ...config, model: e.target.value } })}
              >
                {ollamaModelOptions(listed.models, config.model).map((m) => (
                  <option key={m} value={m}>
                    {listed.models.includes(m) ? m : t('ollama-settings.model-not-installed', { model: m })}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="field"
                type="text"
                spellCheck={false}
                autoComplete="off"
                aria-label={t('ollama-settings.model-label')}
                placeholder={t('ollama-settings.model-placeholder')}
                value={config.model}
                onChange={(e) => update({ ollamaConfig: { ...config, model: e.target.value.trim() } })}
              />
            )}
            <button className="link-button" disabled={listed?.status === 'loading' || refused} onClick={() => void readModels(config.url)}>
              {listed?.status === 'loading' ? t('ollama-settings.models-reading') : field === 'list' ? t('ollama-settings.models-refresh') : t('ollama-settings.models-read')}
            </button>
          </Row>
          {listed?.status === 'failed' && (
            <div className="pref-row pref-message" role="status">
              {t('ollama-settings.models-unreachable', { error: listed.error })}
            </div>
          )}
          {listed?.status === 'ok' && listed.models.length === 0 && (
            <div className="pref-row pref-message" role="status">
              {t('ollama-settings.models-none')}
            </div>
          )}

          <Row label={t('ollama-settings.max-tokens-label')} hint={t('ollama-settings.max-tokens-hint')}>
            <input
              className="field"
              type="number"
              aria-label={t('ollama-settings.max-tokens-label')}
              min={OLLAMA_TOKENS_MIN}
              max={OLLAMA_TOKENS_MAX}
              step="100"
              value={config.maxTokens}
              onChange={(e) => update({ ollamaConfig: { ...config, maxTokens: Number(e.target.value) } })}
            />
          </Row>

          <Row label={t('ollama-settings.temperature-label')} hint={t('ollama-settings.temperature-hint')}>
            <input
              className="field"
              type="number"
              aria-label={t('ollama-settings.temperature-label')}
              min="0"
              max={OLLAMA_TEMPERATURE_MAX}
              step="0.1"
              value={config.temperature}
              onChange={(e) => update({ ollamaConfig: { ...config, temperature: Number(e.target.value) } })}
            />
          </Row>

          <div className="pref-buttons">
            <button className="button" disabled={testing || refused} onClick={() => void handleTest()}>
              {testing ? t('ollama-settings.testing') : t('ollama-settings.test-button')}
            </button>
          </div>

          {testStatus.message && (
            <p className={`pref-note ${testStatus.ok ? '' : 'pref-error'}`} role="status">
              {testStatus.message}
            </p>
          )}

          <p className="pref-note">
            {t('ollama-settings.install-note', {
              link: 'ollama.com',
              code: 'ollama pull mistral'
            })}
          </p>
        </>
      )}
    </>
  )
}
