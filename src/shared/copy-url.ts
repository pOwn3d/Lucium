// The three ways to copy the current page's address (Copy URL, Copy URL as Markdown, Copy URL as Quote).

import { displayAddress } from './internal-page'
import { stripTrackingParams } from './privacy'

/**
 * The address as it goes to the clipboard. With `strip` (the setting "Retirer les paramètres de suivi des liens copiés") the known tracking
 * parameters of the fixed list in privacy.ts leave it; every other part of the address stays as it is. Without it, or when the address is
 * not a web address or has nothing to remove, the very same text comes back. The Extensions page is copied as `chrome://extensions`, the address a person
 * sees and can type again (its own address, `lucium-ui://extensions/`, is not one to hand out).
 */
export function copyableUrl(url: string, strip: boolean): string {
  const shown = displayAddress(url)
  if (shown !== url) return shown
  return strip ? (stripTrackingParams(url) ?? url) : url
}

export type CopyUrlFormat = 'plain' | 'markdown' | 'quote'

export interface CopySource {
  url: string
  title: string
  /** What is selected in the page, if anything. */
  selection: string
}

/** Percent-encodes text for a `#:~:text=` directive, where `-`, `,` and `&` also have a meaning of their own. */
function fragmentText(text: string): string {
  return encodeURIComponent(text).replace(/-/g, '%2D')
}

/** A link that scrolls to and highlights the selection when opened ("text fragment"), or the plain URL without a selection. */
export function urlWithHighlight(url: string, selection: string): string {
  const words = selection.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || !URL.canParse(url)) return url
  const parsed = new URL(url)
  // A page that already has a fragment keeps it: the directive follows it after `:~:`.
  const directive =
    words.length > 8
      ? `${fragmentText(words.slice(0, 4).join(' '))},${fragmentText(words.slice(-4).join(' '))}`
      : fragmentText(words.join(' '))
  const hash = parsed.hash.includes(':~:') ? parsed.hash.split(':~:')[0]! : parsed.hash
  parsed.hash = `${hash}:~:text=${directive}`
  return parsed.href
}

const escapeMarkdown = (text: string) => text.replace(/([\\[\]])/g, '\\$1')

export function formatCopiedUrl(format: CopyUrlFormat, { url, title, selection }: CopySource): string {
  if (format === 'plain') return url
  const label = title.trim() || url
  if (format === 'markdown') return `[${escapeMarkdown(label)}](${url})`
  const quote = selection.trim().replace(/\s+/g, ' ')
  return quote ? `“${quote}”\n— ${label}\n${urlWithHighlight(url, quote)}` : `${label}\n${url}`
}
