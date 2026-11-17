// What a toolbar of extension icons shows, for the window it is in. The library keeps one state per profile: the badge, the title and the
// popup of each action, by tab, and "the tab on screen" of the window that last had the focus. A window of the profile that is not that one
// then draws the other window's tab (and its badge), and a text set for no tab in particular hides the one set for this tab. Pure rules.

/** What an action holds for one tab (the library leaves out the icon: it is fetched as a picture). */
export interface ActionTabDetails {
  text?: string
  color?: unknown
  title?: string
  popup?: string
  iconModified?: number
}

/** One extension's action, as `browserAction.getState` hands it to the toolbar. */
export interface ActionDetails extends ActionTabDetails {
  id: string
  tabs: Record<string, ActionTabDetails>
}

export interface ActionBarState {
  activeTabId?: number
  actions: ActionDetails[]
}

/**
 * The state as the window whose tab on screen is `tabNumber` should draw it: that tab is the active one, and what an action set for that tab
 * (the rule of the chrome.action API: it beats what was set for every tab) is what the action shows. With no tab on screen the default of each action is shown.
 * Anything that is not a state is returned as it came.
 */
export function actionBarStateFor<T>(state: T, tabNumber: number | undefined): T {
  const value = state as unknown as ActionBarState | null | undefined
  if (typeof value !== 'object' || value === null || !Array.isArray(value.actions)) return state
  const actions = value.actions.map((action) => {
    const own = tabNumber === undefined ? undefined : action.tabs?.[String(tabNumber)]
    const { tabs: _others, ...rest } = action
    return { ...rest, ...own, tabs: {} }
  })
  const { activeTabId: _library, ...others } = value
  return { ...others, ...(tabNumber === undefined ? {} : { activeTabId: tabNumber }), actions } as unknown as T
}
