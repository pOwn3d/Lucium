// Which tab, and so which window, a click on an extension's icon is for. The extension library keeps one state per profile and hangs the popup from the window of the
// tab it is given (`tabToWindow.get(tab)`), so with several windows on one profile the tab is the whole decision: a number that belongs to another window opens the
// popup in that other window (the one the library last saw take the focus, or the one the icon was drawn for). Pure rules, so that they are checked without a window.

export interface IconClick {
  /** The tab on screen in the window of the icon, among the tabs of the profile of the icon; undefined when that window shows none. */
  shown: number | undefined
  /** The tab number the icon carries (the library's idea of "the" active tab when the toolbar was last drawn), undefined when it carries none. */
  named: number | undefined
  /** Whether the tab the icon carries is still a tab of the window of the icon: a tab lives in one window at a time and goes to another one when that one selects it. */
  namedIsHere: boolean
}

/**
 * The tab to hand to the library for a click, or undefined when the window has none to give (it is then given a new one). The tab on screen in the window decides.
 * The number on the icon is only used for a window that shows none of the profile, and only while that tab is still in this window: a window the user emptied by
 * selecting its tab in another window still carries that tab on its icons, and a click there must not open the popup in the window that took the tab.
 */
export function iconClickTab(click: IconClick): number | undefined {
  if (click.shown !== undefined) return click.shown
  return click.named !== undefined && click.namedIsHere ? click.named : undefined
}
