// The editor of one proxy setting (Settings): the mode, the address of the server, the hosts that go direct, and the facultative test.
// Shared by Vie privée et sécurité › DNS chiffré et proxy (the global setting) and Profils (one profile's own). No login is typed here: a proxy that asks for one gets the
// sign-in prompt of the window, and what is typed there is kept nowhere.

import { useState } from 'react'
import { PROXY_MODES, PROXY_MODE_LABELS, cleanBypass, describeProxyTest, parseProxyAddress, type ProxyMode, type ProxySetting, type ProxyTestResult } from '@shared/proxy'
import { api } from './api'
import { Row } from './settings-parts'
import { t } from '@shared/i18n'

/** `title` names the network this editor sets: a profile's own by default; the general one (Vie privée et sécurité › DNS chiffré et proxy) says it is not a profile's. */
export function ProxyEditor({ value, onChange, name, title }: { value: ProxySetting; onChange: (value: ProxySetting) => void; name: string; title?: string }) {
  const [mode, setMode] = useState<ProxyMode>(value.mode)
  const [address, setAddress] = useState(value.address)
  const [bypass, setBypass] = useState(value.bypass)
  // 'failed': the test could not be asked of the main process at all, which is not an answer of the server.
  const [test, setTest] = useState<ProxyTestResult | 'running' | 'failed' | null>(null)
  const parsed = parseProxyAddress(address)
  const invalid = mode === 'manual' && address.trim() !== '' && parsed === null
  // The list says « manuel » as soon as it is chosen, but a manual proxy is saved only with a valid address, once the field is left or Return is
  // pressed: until then the setting that applies is still the one before, and the editor says so.
  const unsaved = mode === 'manual' && !(value.mode === 'manual' && parsed !== null && parsed.address === value.address)

  /** What is saved: a manual proxy only once its address is valid, the others at once. */
  const commit = (nextMode: ProxyMode, nextAddress: string, nextBypass: string) => {
    if (nextMode !== 'manual') return onChange({ mode: nextMode, address: '', bypass: '' })
    const checked = parseProxyAddress(nextAddress)
    if (checked) onChange({ mode: 'manual', address: checked.address, bypass: cleanBypass(nextBypass) })
  }

  return (
    <>
      <Row label={title ?? t('proxy-editor.reseau-de-ce-profil')} hint={mode === 'manual' ? undefined : mode === 'direct' ? t('proxy-editor.aucun-proxy-meme-si-le-systeme-en-impose-un') : t('proxy-editor.le-proxy-regle-dans-les-reglages-du-systeme')}>
        <select
          className="field pop"
          aria-label={t('proxy-editor.proxy-name', { name })}
          value={mode}
          onChange={(e) => {
            const next = e.target.value as ProxyMode
            setMode(next)
            setTest(null)
            commit(next, address, bypass)
          }}
        >
          {PROXY_MODES.map((m) => (
            <option key={m} value={m}>
              {PROXY_MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </Row>
      {mode === 'manual' && (
        <>
          <Row label={t('privacy-extra-settings.serveur')} hint={t('proxy-editor.http-hote-port-sans-identifiant')}>
            <input
              className="field"
              spellCheck={false}
              aria-label={t('proxy-editor.adresse-du-proxy-name', { name })}
              aria-invalid={invalid}
              placeholder="socks5://127.0.0.1:1080"
              value={address}
              onChange={(e) => {
                // Nothing is saved while the address is typed: « host:8 », « host:80 » and « host:808 » are valid addresses on the way to
                // « host:8080 », and each one saved would send the traffic of the profile to a port that is not the proxy.
                setAddress(e.target.value)
                setTest(null)
              }}
              onBlur={() => commit('manual', address, bypass)}
              onKeyDown={(e) => e.key === 'Enter' && commit('manual', address, bypass)}
            />
          </Row>
          {invalid && (
            <div className="pref-row pref-message" role="alert">
              {t('proxy-editor.adresse-non-valide-schema-facultatif')}
            </div>
          )}
          {unsaved && (
            <div className="pref-row pref-message" role="status" data-role="proxy-unsaved">
              {t('proxy-editor.pas-encore-enregistre')}
            </div>
          )}
          <Row label={t('proxy-editor.sans-proxy-pour')} hint={t('proxy-editor.hotes-separes-par-des-virgules')}>
            <input
              className="field"
              spellCheck={false}
              aria-label={t('proxy-editor.hotes-sans-proxy-name', { name })}
              placeholder={t('proxy-editor.exemple-org-10-0-0-0-8')}
              value={bypass}
              onChange={(e) => setBypass(e.target.value)}
              onBlur={() => {
                setBypass(cleanBypass(bypass))
                commit('manual', address, bypass)
              }}
            />
          </Row>
          <Row label={t('proxy-editor.tester-la-connexion')} hint={t('proxy-editor.verifie-que-le-serveur-accepte-une-connexion')}>
            <button
              className="button"
              disabled={parsed === null || test === 'running'}
              onClick={() => {
                setTest('running')
                api()
                  .testProxy(parsed!.address)
                  .then(setTest, (error: unknown) => {
                    // The request itself failed: the server said nothing, and the text of the error is for the log, not for the person.
                    console.warn('[proxy] the connection test could not be run:', error)
                    setTest('failed')
                  })
              }}
            >
              {test === 'running' ? t('proxy-editor.test') : t('proxy-editor.tester')}
            </button>
          </Row>
          {test !== null && test !== 'running' && (
            <div className="pref-row pref-message" role="status">
              {test === 'failed' ? t('proxy-editor.le-test-n-a-pas-pu-etre-lance') : describeProxyTest(test)}
            </div>
          )}
        </>
      )}
    </>
  )
}
