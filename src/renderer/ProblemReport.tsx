import { useEffect, useState } from 'react'
import type { ProblemReportView } from '@shared/problem-report'
import { t } from '@shared/i18n'
import { api } from './api'
import { copyReport, loadReport, saveReport, type ReportNotice } from './problem-report-actions'
import { InfoGlyph, Sheet, useSpaceHue } from './templates'
import './problem-report.css'

export interface ProblemReportSheetProps {
  report: ProblemReportView
  notice: ReportNotice | null
  hue?: number | undefined
  onCopy: () => void
  onSave: () => void
  onSite: () => void
  onClose: () => void
}

/**
 * The sheet as it is drawn from the report it is given: the text to read, the two buttons that take it away (the clipboard, a file) and the link to the page of the
 * site. It sits in the template of the small editors (templates/Sheet.tsx): Escape and « Fermer » leave it.
 */
export function ProblemReportSheet({ report, notice, hue, onCopy, onSave, onSite, onClose }: ProblemReportSheetProps) {
  const ready = report.state === 'ready'
  return (
    <Sheet className="problem-report" title={t('problem-report.signaler-un-probleme')} glyph={<InfoGlyph />} hue={hue} onCancel={onClose} cancelLabel={null} primary={{ label: t('templates.fermer') }} onSubmit={onClose}>
      <p className="muted pr-intro">{t('problem-report.intro')}</p>
      {report.state === 'ready' ? (
        <pre className="pr-text" tabIndex={0} aria-label={t('problem-report.apercu-du-rapport-a-relire')}>
          {report.text}
        </pre>
      ) : (
        <p className="muted pr-wait" role={report.state === 'failed' ? 'alert' : 'status'}>
          {report.state === 'failed' ? t('problem-report.le-rapport-n-a-pas-pu-etre-prepare') : t('problem-report.preparation-du-rapport')}
        </p>
      )}
      <div className="pr-actions">
        <button type="button" className="tk-btn" disabled={!ready} onClick={onCopy}>
          {t('problem-report.copier')}
        </button>
        <button type="button" className="tk-btn" disabled={!ready} onClick={onSave}>
          {t('problem-report.enregistrer')}
        </button>
        <button type="button" className="tk-btn quiet" onClick={onSite}>
          {t('problem-report.ouvrir-la-page-communaute-du-site')}
        </button>
      </div>
      {notice && (
        <p className={`pr-status${notice.failed ? ' failed' : ''}`} role={notice.failed ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}
      <p className="muted pr-note">{t('problem-report.ce-que-contient-le-rapport')}</p>
    </Sheet>
  )
}

/**
 * « Signaler un problème… » (Aide): asks the main process for the report when it opens, and shows it. Nothing is sent: « Copier » puts the text on the clipboard,
 * « Enregistrer… » has the main process write it where the user chooses, and the link opens the page of the site in a tab (the address is the main process's).
 */
export function ProblemReport() {
  const act = api()
  const hue = useSpaceHue()
  const [report, setReport] = useState<ProblemReportView>({ state: 'loading' })
  const [notice, setNotice] = useState<ReportNotice | null>(null)

  useEffect(() => {
    let current = true
    void loadReport(act).then((view) => current && setReport(view))
    return () => {
      current = false
    }
  }, [act])

  return (
    <ProblemReportSheet
      report={report}
      notice={notice}
      hue={hue}
      onCopy={() => report.state === 'ready' && void copyReport(act, report.text).then(setNotice)}
      onSave={() => void saveReport(act).then((saved) => saved && setNotice(saved))}
      onSite={() => {
        // The sheet goes, then the page opens in a tab: the clipboard keeps the report for the message.
        act.closeOverlay()
        act.openProblemSite()
      }}
      onClose={() => act.closeOverlay()}
    />
  )
}
