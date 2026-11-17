// "Créer un raccourci pour ce site": a centred sheet with the keyword, name and address of the site, filled from the page. The keyword
// opens the site directly from the command bar (no search address is needed).

import { useId, useState } from 'react'
import { siteSearchProblem, siteSearchProblemText } from '@shared/site-search'
import { t } from '@shared/i18n'
import { api, useSnapshot } from './api'
import './shortcut-sheet.css'

/** A keyword suggested from the site's address: the name of the domain, without the www and the ending (twitch.tv gives twitch). */
export function keywordFor(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return (host.split('.')[0] ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12)
  } catch {
    return ''
  }
}

type SiteSearchEntry = { keyword: string; name: string; url: string }

/**
 * The list of site searches to save with the shortcut added, or null while the list the user has is not known (`existing` undefined: the sheet
 * was drawn before the first state arrived). Saving then would write a list of one, in the place of every search the user made.
 */
export function withShortcut<T extends SiteSearchEntry>(existing: readonly T[] | undefined, draft: SiteSearchEntry): Array<T | SiteSearchEntry> | null {
  if (existing === undefined) return null
  return [...existing, { keyword: draft.keyword.toLowerCase(), name: draft.name.trim(), url: draft.url }]
}

export function ShortcutSheet({ url, title }: { url: string; title: string }) {
  const snapshot = useSnapshot()
  const existing = snapshot?.state.settings.siteSearches ?? []
  const origin = (() => {
    try {
      return new URL(url).origin + '/'
    } catch {
      return url
    }
  })()
  const [draft, setDraft] = useState({ keyword: keywordFor(url), name: title.trim() || keywordFor(url), url: origin })
  const titleId = useId()
  const helpId = useId()
  // Without a snapshot the list of shortcuts is not known: saving then would write this one in place of all the others.
  if (!snapshot) return null
  const problem = siteSearchProblem(draft, existing)
  // The field a problem is about: it is marked, and tied to the sentence that says what is wrong, as the button that the problem switches off is.
  const wrongField = problem === null ? null : problem === 'name' ? 'name' : problem === 'address' ? 'url' : 'keyword'
  const tied = (field: 'keyword' | 'name' | 'url') => (wrongField === field ? { 'aria-invalid': true, 'aria-describedby': helpId } : {})

  const save = () => {
    if (problem) return
    // Nothing is saved before the first state: the sheet stays open, and the same click works once the list is known.
    const siteSearches = withShortcut(snapshot?.state.settings.siteSearches, draft)
    if (siteSearches === null) return
    void api().dispatch({ type: 'settings/update', patch: { siteSearches } })
    api().closeOverlay()
  }

  return (
    <form
      className="shortcut-sheet"
      role="dialog"
      aria-labelledby={titleId}
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <h3 id={titleId}>{t('shortcut.titre')}</h3>
      <label>
        <span>{t('shortcut.mot-cle')}</span>
        <input className="tk-field" value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} autoFocus spellCheck={false} {...tied('keyword')} />
      </label>
      <label>
        <span>{t('shortcut.nom')}</span>
        <input className="tk-field" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} spellCheck={false} {...tied('name')} />
      </label>
      <label>
        <span>{t('shortcut.adresse')}</span>
        <input className="tk-field" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} spellCheck={false} {...tied('url')} />
      </label>
      {/* The same line is the help, then the reason « Créer » is off: said when it comes, since nothing else tells a screen reader why. */}
      <p id={helpId} className="shortcut-help" role={problem ? 'alert' : undefined}>
        {problem ? siteSearchProblemText(problem) : t('shortcut.aide')}
      </p>
      <div className="shortcut-actions">
        <button type="button" className="tk-btn quiet" onClick={() => api().closeOverlay()}>
          {t('shortcut.annuler')}
        </button>
        <button type="submit" className="tk-btn primary" disabled={problem !== null} aria-describedby={problem ? helpId : undefined}>
          {t('shortcut.creer')}
        </button>
      </div>
    </form>
  )
}
