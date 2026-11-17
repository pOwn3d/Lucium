import { useEffect, useState, type ReactNode } from 'react'
import type { CandidatePreview } from '@shared/command-bar'
import { api } from './api'

/** The picture of a page is asked for once the highlight has rested on the line for this long: the arrows can run through a list without a request per line. */
const PICTURE_DELAY_MS = 80

/** The picture to draw: the one found, unless the page could not draw it (`broken` is that one's address). */
export function shownPicture(found: string | null, broken: string | null): string | null {
  return found !== null && found !== broken ? found : null
}

/** The picture the main process holds of a tab (the one the hover card shows), or null: a tab never shown since the launch has none. */
function usePicture(tabId: string | undefined): string | null {
  const [picture, setPicture] = useState<string | null>(null)
  useEffect(() => {
    setPicture(null)
    if (!tabId) return
    let live = true
    const timer = window.setTimeout(() => {
      api()
        .tabThumbnail(tabId)
        .then((found) => live && setPicture(found))
        .catch((error: unknown) => console.warn('[command bar] no picture for the preview:', error))
    }, PICTURE_DELAY_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [tabId])
  return picture
}

/**
 * The column on the right of the list: what the highlighted line is. The picture of the page when there is one, else the line's own glyph;
 * its name and address; what is known of it; and the keys that do something on it. It is not announced when the arrows move (the line itself is):
 * a screen reader would otherwise read it out for every row passed.
 */
export function CommandPreview({ preview, lead }: { preview: CandidatePreview; lead: ReactNode }) {
  const found = usePicture(preview.thumbTabId)
  // A picture the page cannot draw (a damaged or empty capture) is not shown as a broken image: the line's own glyph stands in, as for a tab without a picture.
  const [brokenPicture, setBrokenPicture] = useState<string | null>(null)
  const picture = shownPicture(found, brokenPicture)
  const big = preview.glyph === 'calc'
  return (
    <>
      <div className={`cb-thumb${picture ? ' has-picture' : ''}${big ? ' calc' : ''}`} aria-hidden="true">
        {picture ? <img src={picture} alt="" draggable={false} onError={() => setBrokenPicture(picture)} /> : big ? <span className="cb-big">{preview.title}</span> : preview.emoji ? <span className="cb-emoji">{preview.emoji}</span> : <span className="cb-glyph">{lead}</span>}
      </div>
      {!big && <h3 className="cb-p-title">{preview.title}</h3>}
      {preview.address && <div className="cb-p-url">{preview.address}</div>}
      {preview.note && <p className="cb-p-note">{preview.note}</p>}
      {preview.chips.length > 0 && (
        <ul className="cb-p-chips">
          {preview.chips.map((chip) => (
            <li key={chip}>{chip}</li>
          ))}
        </ul>
      )}
      {preview.keys.length > 0 && (
        <dl className="cb-p-keys">
          {preview.keys.map((key) => (
            <div key={key.keys}>
              <dt>
                <kbd>{key.keys}</kbd>
              </dt>
              <dd>{key.label}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  )
}
