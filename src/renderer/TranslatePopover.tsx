// The popover of the toolbar button « Traduction de la page » (Toolbar.tsx `TranslateButton`), hung from the button: what the page is (« Page en anglais »,
// « Traduit de l'anglais vers le français »), « Traduire » or « Afficher l'original » in one click, « Toujours traduire l'anglais », « Ne jamais traduire ce
// site », another language, and « Plus d'options… » for the full panel (models, engine). Every action is a request to the main process (`Channel.translate`):
// it names no site (the main process reads it from the page) and writes nothing from a private window or tab. The states come from the window's snapshot,
// so the popover follows a translation that ends while it is open.

import { useId, useRef, useState } from 'react'
import { getLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { PlusAnchor } from '@shared/plus-menu'
import { activeTab } from '@shared/sidebar'
import { targetLanguage, type TranslateRequest } from '@shared/translate-local'
import { OTHER_LANGUAGES, languageName, languagePhrase, neverTranslated, translateOffer, translateSentence, translateSiteOf, type TranslateOffer } from '@shared/translate-quick'
import { api, useSnapshot } from './api'
import { AnchoredBubble } from './templates/AnchoredBubble'
import { useFocusScope } from './templates/useFocusScope'
import './templates/primitives.css'
import './translate.css'

/** What the popover shows for the window's snapshot: the page's offer, its sentence, the two switches (none where nothing may be written), the other languages. */
export interface PopoverModel {
  offer: TranslateOffer | null
  sentence: string
  /** The main action: translate, show the original, or stop a translation under way. */
  primary: { label: string; request: TranslateRequest } | null
  /** Absent in a private window and on a private tab: their preferences are not written down. */
  always?: { label: string; checked: boolean }
  never?: { checked: boolean; host: string }
  /** The languages « Autre langue… » offers: the common ones, but the page's own and the one it is in now. */
  others: string[]
}

export function popoverModel(snapshot: Pick<UiSnapshot, 'state' | 'runtime' | 'private'>): PopoverModel {
  const { settings } = snapshot.state
  const tab = activeTab(snapshot.state)
  const offer = translateOffer(settings.translateLocal, tab?.url, tab ? snapshot.runtime.tabs[tab.id] : undefined, targetLanguage(settings, getLanguage()))
  if (!offer || !tab) return { offer: null, sentence: '', primary: null, others: [] }
  const sentence = translateSentence(offer)
  const primary =
    offer.state === 'offered'
      ? { label: t('translate.translate'), request: { action: 'quick' } as const }
      : { label: offer.state === 'working' ? t('translate.stop') : t('translate.show-original'), request: { action: 'restore' } as const }
  const writes = snapshot.private !== true && tab.private !== true
  const host = translateSiteOf(tab.url)
  return {
    offer,
    sentence,
    primary,
    ...(writes ? { always: { label: t('translate.quick-always', { language: languagePhrase(offer.from, 'the') }), checked: settings.translateAlways.includes(offer.from) } } : {}),
    ...(writes && host !== null ? { never: { checked: neverTranslated(settings.translateNeverSites, tab.url), host } } : {}),
    others: OTHER_LANGUAGES.filter((code) => code !== offer.from && !(offer.state !== 'offered' && code === offer.to))
  }
}

/** The glyph of the header: the 文 and the A of the toolbar button, without its colour. */
const Glyph = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d="M3 5h8M7 3v2M5 5c0 3 2 5 5 6M9 5c0 2-2 5-5 6M11 17l3.5-8L18 17M12.2 14.5h4.6" />
  </svg>
)

export function TranslatePopover({ anchor }: { anchor: PlusAnchor }) {
  const snapshot = useSnapshot()
  const root = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [problem, setProblem] = useState('')
  const [pending, setPending] = useState(false)
  useFocusScope(root, { trap: true })
  const model: PopoverModel = snapshot ? popoverModel(snapshot) : { offer: null, sentence: '', primary: null, others: [] }

  /** One request; what went wrong is said under the button (the main process answers a sentence), never swallowed. */
  const ask = async (request: TranslateRequest): Promise<void> => {
    setPending(true)
    try {
      const view = await api().translate(request)
      setProblem(view === null ? t('translate.unavailable') : view.state === 'error' ? view.message : '')
    } catch (error) {
      console.warn('[translate] a request of the popover failed:', error instanceof Error ? error.message : String(error))
      setProblem(t('translate.unavailable'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AnchoredBubble anchor={anchor} side="bottom" align="end">
      <div ref={root} className="tk-panel translate-pop" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="tp-head">
          <span className="tk-glyph" aria-hidden="true">
            <Glyph />
          </span>
          <h2 id={titleId}>{model.sentence || t('translate.quick-title')}</h2>
        </header>
        {model.primary && (
          <button type="button" className="tk-btn primary tp-main" data-autofocus disabled={pending && model.offer?.state === 'offered'} onClick={() => void ask(model.primary!.request)}>
            {model.primary.label}
          </button>
        )}
        <p className="tp-problem" role="status">
          {problem}
        </p>
        {model.always && (
          <label className="tp-switch">
            <span>{model.always.label}</span>
            <input type="checkbox" role="switch" checked={model.always.checked} onChange={(e) => void ask({ action: 'always', language: model.offer!.from, on: e.target.checked })} />
          </label>
        )}
        {model.never && (
          <label className="tp-switch">
            <span>
              {t('translate.quick-never-site')}
              <small>{model.never.host}</small>
            </span>
            <input type="checkbox" role="switch" checked={model.never.checked} aria-description={t('translate.quick-never-site-hint', { host: model.never.host })} onChange={(e) => void ask({ action: 'never-site', on: e.target.checked })} />
          </label>
        )}
        {model.offer && (
          <select
            className="tk-field tp-other"
            aria-label={t('translate.quick-other-label')}
            value=""
            onChange={(e) => {
              if (e.target.value !== '') void ask({ action: 'quick', to: e.target.value })
            }}
          >
            <option value="">{t('translate.quick-other')}</option>
            {model.others.map((code) => (
              <option key={code} value={code}>
                {languageName(code)}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="tk-btn quiet tp-more" onClick={() => api().openOverlay({ panel: 'translate' })}>
          {t('translate.quick-more')}
        </button>
      </div>
    </AnchoredBubble>
  )
}
