// "À propos de Lucium" in a small window of its own, in the theme: the version, which can be copied for a bug report, the engine
// under the browser, the licence in a sentence, "Rechercher les mises à jour" (it follows the setting and contacts nothing else) and the four links of the About group.
// Nothing is sent anywhere, no account: a link is a word the main process turns into a tab (or the folder of the licences).

import { useEffect, useState } from 'react'
import { ABOUT_COMPANY, ABOUT_NAME, ABOUT_ROWS, ABOUT_YEAR, aboutEngineLabel, aboutFootnote, aboutReport, aboutTagline, aboutVersionLabel, type AboutEngine } from '@shared/about'
import { t } from '@shared/i18n'
import { api } from './api'
// The logo, in its default version (the icon of the application): Vite gives the file of resources/app-icons its address.
import ICON_PICTURE from '../../resources/app-icons/clair.png'
import './about.css'

const NO_ENGINE: AboutEngine = { chromium: '', electron: '', platform: '' }
const COPIED_MS = 2000

export function AboutWindow() {
  // null while the main process answers; '' when it gave no version (the label then says "Version inconnue").
  const [version, setVersion] = useState<string | null>(null)
  const [engine, setEngine] = useState<AboutEngine | null>(null)
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let live = true
    api()
      .aboutVersion()
      .then((value) => live && setVersion(value))
      .catch((error: unknown) => {
        console.warn('[about] the version could not be read:', error)
        if (live) setVersion('')
      })
    api()
      .aboutEngine()
      .then((value) => live && setEngine(value))
      .catch((error: unknown) => {
        console.warn('[about] the engine could not be read:', error)
        if (live) setEngine(NO_ENGINE)
      })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (copy === 'idle') return
    const timer = setTimeout(() => setCopy('idle'), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copy])

  const ready = version !== null && engine !== null
  const copyReport = () => {
    if (!ready) return
    api()
      .writeClipboardText(aboutReport(version, engine))
      .then((ok) => setCopy(ok ? 'done' : 'failed'))
      .catch((error: unknown) => {
        console.warn('[about] the version could not be copied:', error)
        setCopy('failed')
      })
  }
  const check = () => {
    setChecking(true)
    // The answer is a box of the system on this window (up to date, a newer version, no feed, a failure): the button only waits for it.
    api()
      .aboutCheckUpdates()
      .catch((error: unknown) => console.warn('[about] the update check failed:', error))
      .finally(() => setChecking(false))
  }

  return (
    <main className="about-window" aria-label={t('menu.a-propos-d-lucium')}>
      <div className="about-body">
        <div className="about-icon" aria-hidden="true">
          <img src={ICON_PICTURE} alt="" width={80} height={80} draggable={false} />
        </div>
        <h1>{ABOUT_NAME}</h1>
        <div className="about-ver">
          <span>{version === null ? ' ' : aboutVersionLabel(version)}</span>
          <button type="button" className="about-btn quiet" disabled={!ready} aria-label={t('about-window.copier-la-version-et-le-moteur')} onClick={copyReport}>
            {copy === 'done' ? t('about-window.copie') : t('about-window.copier')}
          </button>
        </div>
        <div className="about-engine">{engine === null ? ' ' : aboutEngineLabel(engine)}</div>
        <p className="about-status" role="status">
          {copy === 'failed' ? t('about-window.copie-impossible') : ''}
        </p>
        <p className="about-lic">{aboutTagline()}</p>
        <div className="about-actions">
          <button type="button" className="about-btn primary" aria-busy={checking} disabled={checking} onClick={check}>
            {checking ? t('about-window.recherche') : t('about-window.rechercher-les-mises-a-jour')}
          </button>
          <p className="about-note">{t('about-window.cherche-maintenant-setting', { setting: t('features.rechercher-les-mises-a-jour-automatiquement') })}</p>
          <div className="about-links">
            {ABOUT_ROWS.map((row) => (
              <button key={row.target} type="button" className="about-btn" aria-label={`${row.label} (${row.detail})`} onClick={() => api().openAbout(row.target)}>
                {row.label}
              </button>
            ))}
          </div>
        </div>
        <p className="about-note">{aboutFootnote()}</p>
      </div>
      <footer className="about-foot">{t('about-window.droits', { year: ABOUT_YEAR, company: ABOUT_COMPANY })}</footer>
    </main>
  )
}
