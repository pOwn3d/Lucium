// Settings › À propos: the name and version of the application, what it is, who made it, and four links. Plain and quiet: no
// banner, no notice, nothing sent anywhere. A link is a button that asks the main process to open a tab (the Settings window never
// navigates); the licences open the folder of the documentation.

import { useEffect, useState } from 'react'
import { ABOUT_NAME, ABOUT_ROWS, aboutFootnote, aboutTagline, aboutVersionLabel } from '@shared/about'
import { api } from './api'
import { ARROW_RIGHT, Group, Row } from './settings-parts'
import './about.css'

export function AboutSettings() {
  // null while the main process answers; '' when it gave no version (the label then says "Version inconnue").
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api()
      .aboutVersion()
      .then((value) => live && setVersion(value))
      .catch((error: unknown) => {
        console.warn('[about] the version could not be read:', error)
        if (live) setVersion('')
      })
    return () => {
      live = false
    }
  }, [])

  return (
    <>
      <Group id="about" title={t('about-settings.a-propos')} className="about-group" footnote={aboutFootnote()}>
        <Row label={<span className="about-name">{ABOUT_NAME}</span>} searchKey="version">
          <span className="about-version">{version === null ? ' ' : aboutVersionLabel(version)}</span>
        </Row>
        <Row className="about-tagline" label={aboutTagline()} />
        {ABOUT_ROWS.map((row) => (
          <button key={row.target} type="button" className="pref-row nav-row about-link" aria-label={`${row.label} (${row.detail})`} onClick={() => api().openAbout(row.target)}>
            <span className="pref-label">{row.label}</span>
            <span className="about-detail">{row.detail}</span>
            <span className="nav-arrow">{ARROW_RIGHT}</span>
          </button>
        ))}
      </Group>
    </>
  )
}

import { t } from '@shared/i18n'