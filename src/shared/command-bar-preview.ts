// The preview pane of the command bar: what is shown beside the row under the selection. Moved out of command-bar.ts as it was.

import type { CommandBarMode } from './ipc'
import { SEARCH_ENGINES, type HistoryEntry, type RuntimeState, type SidebarState } from './model'
import { activeProfileId, profileSearch } from './profiles'
import { hasIcon } from './favicon'
import { quoted, t, tp } from './i18n'
import { relativeAgo } from './relative-time'
import { splitAddress, cardStatus } from './hover-card'
import type { Candidate } from './command-bar-types'
import { candidateHint, actionShortcut } from './command-bar-shortcuts'
import { formatAccelerator } from './keybindings'
import { commandPress, type PlatformId } from './platform'
import { workViewPlace, workViewSummary } from './work-views'
import { hostOf } from './url'

export interface PreviewKey {
  keys: string
  label: string
}

/** What the column of the bar says of the highlighted line. */
export interface CandidatePreview {
  /** The picture when there is no screenshot of the page: what kind of thing the line is. */
  glyph: 'page' | 'search' | 'command' | 'calc' | 'space' | 'archive' | 'settings' | 'extension'
  title: string
  /** The address as people read it (host, then the rest), or '' when the line has none. */
  address: string
  /** One sentence of detail (the calculation, the kind of search). */
  note: string
  chips: string[]
  keys: PreviewKey[]
  /** The tab whose screenshot the column asks for. */
  thumbTabId?: string
  /** The emoji of a space, for the picture of a line that leads to one. */
  emoji?: string
  /** The icon of the site, when it is known (see `pageFavicon`): it leads the column when there is no picture. */
  faviconUrl?: string
}

export interface PreviewContext {
  state: SidebarState
  runtime?: RuntimeState | undefined
  history?: readonly HistoryEntry[] | undefined
  now: number
  mode: CommandBarMode
  /** The system the keys of the preview are drawn for. */
  platform: PlatformId
  /**
   * Whether the line was chosen with the arrows. ⇧⌫ forgets a page of the history only then (while typing, the key is the field's): with false, the
   * preview does not list a key that would do nothing. Left out, the line counts as chosen.
   */
  picked?: boolean
}

const ENTER = '↵'

/**
 * The icon to show for an address, from what the application already knows (no request): the icon of a tab open on that address, else the icon of a
 * bookmark or of a page to read later kept for it. Undefined when none is known (the line keeps its own glyph, a globe for an address).
 */
export function pageFavicon(url: string, state: Pick<SidebarState, 'tabs' | 'bookmarks' | 'readLater'>): string | undefined {
  const known = (faviconUrl: string | undefined) => (hasIcon(faviconUrl) ? faviconUrl : undefined)
  return (
    state.tabs.find((tab) => tab.url === url && known(tab.faviconUrl))?.faviconUrl ??
    state.bookmarks.find((b) => b.url === url && known(b.faviconUrl))?.faviconUrl ??
    state.readLater.find((item) => item.url === url && known(item.faviconUrl))?.faviconUrl
  )
}

/**
 * The preview of a line: the picture of the page (asked for by the interface), its name and address, what is known of it (its space, when it was
 * last used, how often it was visited) and the keys that do something on it. Only keys that do something are listed: ↵, ⌘↵ (a new tab) where it differs
 * from ↵, and ⇧⌫ (forget a page of the history).
 */
export function candidatePreview(candidate: Candidate, ctx: PreviewContext): CandidatePreview {
  const { state, runtime, now } = ctx
  const make = (preview: Partial<CandidatePreview> & Pick<CandidatePreview, 'glyph' | 'title'>): CandidatePreview => ({ address: '', note: '', chips: [], keys: [], ...preview })
  const address = (url: string): string => {
    const parts = splitAddress(url)
    return `${parts.host}${parts.rest}`
  }
  const where = ctx.mode === 'current' ? t('cmd.dans-cet-onglet') : ctx.mode === 'split' ? t('cmd.dans-le-volet-de-droite') : t('cmd.dans-un-nouvel-onglet')
  // ⌘↵ opens in a new tab: it says something only where ↵ does not already.
  const newTabPress = commandPress('↵', ctx.platform)
  const newTabKey: PreviewKey[] = ctx.mode === 'current' ? [{ keys: newTabPress, label: t('cmd.ouvrir-dans-un-nouvel-onglet') }] : []
  switch (candidate.kind) {
    case 'tab': {
      const tab = state.tabs.find((x) => x.id === candidate.tabId)
      const space = tab ? state.spaces.find((s) => s.id === tab.spaceId) : undefined
      const status = tab ? cardStatus(tab, runtime?.tabs[tab.id]).split(' · ').filter(Boolean) : []
      return make({
        glyph: 'page',
        title: candidate.label,
        address: address(candidate.url),
        chips: [...(space && state.spaces.length > 1 ? [`${space.emoji} ${space.name}`.trim()] : []), ...(tab ? [t('cmd.actif', { when: relativeAgo(tab.lastActiveAt, now) })] : []), ...status],
        keys: [{ keys: ENTER, label: candidateHint(candidate) }, { keys: newTabPress, label: t('cmd.ouvrir-dans-un-nouvel-onglet') }],
        thumbTabId: candidate.tabId
      })
    }
    case 'open': {
      if (candidate.search === true || candidate.id === 'open:site' || candidate.id === 'open:bang') {
        const engine = SEARCH_ENGINES.find((e) => e.url === profileSearch(state.settings, activeProfileId(state)).url)?.name
        return make({
          glyph: 'search',
          title: quoted(candidate.label),
          note: candidate.detail || (engine ? t('cmd.rechercher-avec', { engine }) : t('cmd.rechercher-sur-le-web')),
          chips: [where],
          keys: [{ keys: ENTER, label: t('cmd.rechercher') }, ...newTabKey.map((k) => ({ ...k, label: t('cmd.rechercher-dans-un-nouvel-onglet') }))]
        })
      }
      return make({ glyph: 'page', title: candidate.label, address: address(candidate.url), chips: [where], keys: [{ keys: ENTER, label: t('cmd.ouvrir-la-page') }, ...newTabKey], faviconUrl: pageFavicon(candidate.url, state) })
    }
    case 'history': {
      const entry = ctx.history?.find((h) => h.url === candidate.url)
      return make({
        glyph: 'page',
        title: candidate.label,
        address: address(candidate.url),
        chips: entry ? [t('cmd.visite', { when: relativeAgo(entry.lastVisitAt, now) }), tp('cmd.visites', entry.visitCount)] : [],
        keys: [{ keys: ENTER, label: t('cmd.ouvrir-la-page') }, ...newTabKey, ...(ctx.picked === false ? [] : [{ keys: formatAccelerator('Shift+Backspace', ctx.platform), label: t('cmd.retirer-de-l-historique') }])],
        faviconUrl: pageFavicon(candidate.url, state)
      })
    }
    case 'bookmark': {
      const bookmark = state.bookmarks.find((b) => b.id === candidate.bookmarkId)
      return make({ glyph: 'page', title: candidate.label, address: bookmark ? address(bookmark.url) : '', chips: [t('cmd.signet'), ...(bookmark?.tags.map((tag) => `#${tag}`) ?? [])], keys: [{ keys: ENTER, label: t('cmd.ouvrir-la-page') }] })
    }
    case 'readlater': {
      const item = state.readLater.find((r) => r.id === candidate.readLaterId)
      return make({ glyph: 'page', title: candidate.label, address: item ? address(item.url) : '', chips: [t('cmd.groupe-lire-plus-tard'), ...(item ? [t('cmd.enregistre', { when: relativeAgo(item.savedAt, now) })] : [])], keys: [{ keys: ENTER, label: t('cmd.ouvrir-la-page') }] })
    }
    case 'archived': {
      const entry = state.archive.find((a) => a.id === candidate.archivedId)
      const space = entry ? state.spaces.find((s) => s.id === entry.spaceId) : undefined
      return make({
        glyph: 'archive',
        title: candidate.label,
        address: entry ? address(entry.url) : '',
        chips: [...(entry ? [t('cmd.archive-le', { when: relativeAgo(entry.archivedAt, now) })] : []), ...(space && state.spaces.length > 1 ? [`${space.emoji} ${space.name}`.trim()] : [])],
        keys: [{ keys: ENTER, label: candidateHint(candidate) }]
      })
    }
    case 'calc':
      return make({ glyph: 'calc', title: candidate.label, note: candidate.detail, keys: [{ keys: ENTER, label: candidateHint(candidate) }] })
    case 'action': {
      // "note <text>": where the note will go, and what Enter does with it.
      if (candidate.action === 'jot-note') return make({ glyph: 'command', title: candidate.label, note: candidate.detail, keys: [{ keys: ENTER, label: t('command-bar.creer-la-note') }] })
      const shortcut = actionShortcut(candidate.action, state, ctx.platform)
      return make({ glyph: 'command', title: candidate.label, chips: [shortcut ? t('cmd.raccourci', { keys: shortcut }) : t('cmd.sans-raccourci')], keys: [{ keys: ENTER, label: t('cmd.executer') }] })
    }
    case 'workview': {
      // The layout, the addresses one per line, and where it opens.
      const view = state.workViews.find((each) => each.id === candidate.viewId)
      return make({
        glyph: 'space',
        title: candidate.label,
        emoji: candidate.emoji,
        note: view ? view.panes.map((pane) => hostOf(pane.url) || pane.url).join(' · ') : '',
        chips: view ? [workViewSummary(view), workViewPlace(view, state)] : [],
        keys: [{ keys: ENTER, label: t('work-view.ouvrir') }]
      })
    }
    case 'space':
    case 'move':
      return make({ glyph: 'space', title: candidate.label, emoji: candidate.emoji, chips: [t('cmd.groupe-commandes')], keys: [{ keys: ENTER, label: candidate.kind === 'space' ? t('cmd.aller-a-l-espace') : t('cmd.deplacer-l-onglet') }] })
    case 'pane':
    case 'internal':
    case 'extpage':
      return make({ glyph: 'settings', title: candidate.label, note: candidate.detail, keys: [{ keys: ENTER, label: t('cmd.ouvrir-la-page') }] })
    case 'extension':
    case 'omnibox':
      return make({ glyph: 'extension', title: candidate.label, note: candidate.detail, keys: [{ keys: ENTER, label: candidateHint(candidate) || t('cmd.executer') }] })
    default:
      return make({ glyph: 'command', title: candidate.label, note: candidate.detail, keys: [{ keys: ENTER, label: candidateHint(candidate) || t('cmd.executer') }] })
  }
}
