// « Dans le contenu des pages »: under the history list, the pages whose text holds the words typed in its search (the full-text index, page-index.ts).
// Nothing is asked while the setting is off or the search is empty; an answer that is no longer the last one is dropped.

import { useEffect, useRef, useState } from 'react'
import type { PageMatch } from '@shared/page-index'
import { hostOf } from '@shared/url'
import { t } from '@shared/i18n'
import { api } from './api'
import { ListGroup, ListRow } from './templates'

const DELAY_MS = 200

export function PageContentResults({ enabled, query, profileId, onOpen }: { enabled: boolean; query: string; profileId: string; onOpen: (url: string) => void }) {
  const [matches, setMatches] = useState<PageMatch[]>([])
  const latest = useRef(0)
  const words = query.trim()

  useEffect(() => {
    const ticket = ++latest.current
    if (!enabled || words === '') {
      setMatches([])
      return
    }
    const timer = setTimeout(() => {
      api()
        .searchPageContent(words, profileId)
        .then(
          (found) => { if (ticket === latest.current) setMatches(found) },
          (error: unknown) => console.warn('[page-index] the search in the content of the pages failed:', error)
        )
    }, DELAY_MS)
    return () => clearTimeout(timer)
  }, [enabled, words, profileId])

  if (!enabled || words === '' || matches.length === 0) return null
  return (
    <div className="hist-content">
      <ListGroup title={t('manage-panels.dans-le-contenu-des-pages')}>
        {matches.map((match) => (
          <ListRow key={match.url} title={match.title || hostOf(match.url)} subtitle={`${hostOf(match.url)} — ${match.snippet}`} hint={match.url} onOpen={() => onOpen(match.url)} />
        ))}
      </ListGroup>
    </div>
  )
}
