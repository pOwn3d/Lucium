import type { KeyboardEvent, MouseEvent } from 'react'
import type { Folder } from '@shared/model'
import { liveItemDate, type LiveFolder } from '@shared/live-folders'
import { hostOf } from '@shared/url'
import { api } from './api'
import { focusSibling } from './SidebarRows'
import './live-folders.css'
import { t } from '@shared/i18n'

/** A page, small: the glyph at the head of an item of a live folder. */
function ItemGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2.500h5.500L12.500 5.500v8a1 1 0 0 1-1 1h-7.500a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
      <path d="M9.500 2.500v3h3M5.500 8.500h5M5.500 11h3.500" />
    </svg>
  )
}

/**
 * What a live folder holds: the latest items of its feed or repository, one row each, like the pinned tabs of a folder (the same row, so the
 * sidebar keeps its cotes). A click opens the page in a new tab, ⌘-click in the background. Only drawn while the function is on; with it off the
 * folder is an ordinary, empty one and this component is not rendered at all.
 *
 * The row is not a button for assistive technology, it holds one (as a tab row does): Return and Space click that button, the click reaches the row,
 * and the arrows move between the rows of the sidebar, these ones included (`focusSibling` walks the `.tab > .tab-main` buttons).
 */
export function LiveItems({ folder }: { folder: Folder & { live: LiveFolder } }) {
  const act = api()
  const { items, failure, checkedAt } = folder.live
  const open = (url: string, background: boolean) => void act.dispatch({ type: 'tab/open', url, ...(background ? { background: true } : {}) })
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    focusSibling(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1)
  }
  const onClick = (url: string) => (e: MouseEvent<HTMLDivElement>) => open(url, e.metaKey || e.ctrlKey)
  return (
    <>
      {items.map((item) => (
        <div key={item.url} className="tab live-item" data-live-item={folder.id} onClick={onClick(item.url)} onAuxClick={(e) => e.button === 1 && open(item.url, true)}>
          <button type="button" className="tab-main" tabIndex={-1} title={`${item.title}\n${hostOf(item.url)}${item.at ? ` · ${liveItemDate(item.at)}` : ''}`} onKeyDown={onKey}>
            <span className="tab-icon live-glyph">
              <ItemGlyph />
            </span>
            <span className="tab-title">{item.title}</span>
          </button>
        </div>
      ))}
      {items.length === 0 && (
        <div className="live-status" role="status" data-live-status={folder.id}>
          {failure ? t('live-rows.lecture-impossible-error', { error: failure }) : checkedAt === undefined ? t('live-rows.premiere-lecture-en-cours') : t('live-rows.rien-a-afficher-pour-le-moment')}
        </div>
      )}
      {items.length > 0 && failure && (
        <div className="live-status" role="status" data-live-status={folder.id} title={failure}>
          {t('live-rows.derniere-lecture-impossible-error', { error: failure })}
        </div>
      )}
    </>
  )
}
