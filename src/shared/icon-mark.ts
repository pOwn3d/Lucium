// The dot a tab wears when its page's icon moved while the tab was in the background (the mark of a row: a chat or a mail site changes
// its icon when a message comes). Only the ADDRESS of the icon is compared: the image is never read, and nothing is asked of the page.
//
// The base is the icon the tab had when it was last on screen, or when its page last loaded: a change during a load (a site sets its icon
// twice) or while the tab is shown is not news. Pure: the shell keeps the base per tab and writes the mark in the runtime of the tab.

export interface IconMark {
  /** The address of the icon the tab is measured against; undefined until the page gave one. */
  base: string | undefined
  /** The icon moved away from its base while the tab was in the background, and the tab was not shown since. */
  marked: boolean
}

/**
 * An icon address a page sent. `quiet` is true while the page loads or while the tab is on screen: the address becomes the base and nothing
 * is marked. Otherwise the tab is marked when the address is not the base, and stays marked until the tab is shown.
 */
export function iconSent(mark: IconMark, url: string, quiet: boolean): IconMark {
  if (quiet || mark.base === undefined) return { base: url, marked: mark.marked }
  return { base: mark.base, marked: mark.marked || url !== mark.base }
}

/** The tab is shown: its current icon is the base again and the mark goes. */
export function iconShown(url: string | undefined): IconMark {
  return { base: url, marked: false }
}

/** A runtime entry of a tab without its dot: the tab is shown, so nothing says its icon moved. */
export function unmarked<T extends { changedIcon?: true }>(entry: T): T {
  const { changedIcon: _was, ...rest } = entry
  return rest as T
}
