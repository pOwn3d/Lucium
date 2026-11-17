import { useMemo } from 'react'
import { encodeQr, qrPath } from '@shared/qr'
import { api } from './api'
import { QrGlyph, Sheet, useSpaceHue } from './templates'
import './qr.css'
import { t } from '@shared/i18n'

const MARGIN = 4

/**
 * The QR code of an address (File › Code QR de cette page, or a link's menu), drawn here from the modules the encoder gives: nothing is
 * asked of a service, and the address never leaves the window. A text the code cannot hold is said so, not cut short.
 * It sits in the template of the small editors (templates/Sheet.tsx): Escape and "Fermer" leave it, the focus goes back to what had it.
 */
export function QrPanel({ text }: { text: string }) {
  const result = useMemo(() => encodeQr(text), [text])
  const hue = useSpaceHue()
  const close = () => api().closeOverlay()
  const side = 'error' in result ? 0 : result.size + MARGIN * 2
  return (
    <Sheet className="qr-panel" title={t('qr-panel.code-qr')} glyph={<QrGlyph />} hue={hue} onCancel={close} cancelLabel={null} primary={{ label: t('templates.fermer') }} onSubmit={close}>
      {'error' in result ? (
        <p className="muted warning" role="alert">
          {result.error}
        </p>
      ) : (
        <>
          {/* A white square whatever the theme: a reader needs a light margin around the dark modules. */}
          <svg className="qr-code" viewBox={`0 0 ${side} ${side}`} role="img" aria-label={t('qr-panel.code-qr-de-l-adresse')} shapeRendering="crispEdges">
            <rect width={side} height={side} fill="#fff" />
            <path d={qrPath(result, MARGIN)} fill="#000" />
          </svg>
          <p className="muted qr-text" title={text}>
            {text}
          </p>
          <p className="muted qr-hint">{t('qr-panel.scannez-le-avec-l-appareil-photo-d-un-telephone')}</p>
        </>
      )}
    </Sheet>
  )
}
