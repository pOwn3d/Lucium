// Which side panel an extension shows for a tab: pure resolution of chrome.sidePanel options.

export interface PanelOptions {
  path?: string
  enabled?: boolean
}

export interface PanelConfig {
  /** Options set without a tab id: they apply everywhere. */
  defaults: PanelOptions
  /** Options set for one tab (keyed by the tab's id in Lucium): they win over the defaults. */
  byTab: Record<string, PanelOptions>
}

export const emptyPanelConfig = (): PanelConfig => ({ defaults: {}, byTab: {} })

/** Applies `setOptions`: only the fields that were provided change. */
export function applyOptions(config: PanelConfig | undefined, tabKey: string | undefined, patch: PanelOptions): PanelConfig {
  const base = config ?? emptyPanelConfig()
  const clean: PanelOptions = {
    ...(typeof patch.path === 'string' ? { path: patch.path } : {}),
    ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {})
  }
  if (tabKey === undefined) return { ...base, defaults: { ...base.defaults, ...clean } }
  return { ...base, byTab: { ...base.byTab, [tabKey]: { ...base.byTab[tabKey], ...clean } } }
}

/**
 * Precedence: the tab's own options, then the extension-wide options, then the manifest's `side_panel.default_path`.
 * A panel with no path cannot open; `enabled` defaults to true, as the `chrome.sidePanel` API has it.
 */
export function resolvePanel(
  config: PanelConfig | undefined,
  tabKey: string | undefined,
  manifestPath: string | undefined
): { enabled: boolean; path: string | undefined } {
  const tab = tabKey === undefined ? undefined : config?.byTab[tabKey]
  const path = tab?.path ?? config?.defaults.path ?? manifestPath
  const enabled = tab?.enabled ?? config?.defaults.enabled ?? true
  return { enabled: enabled && path !== undefined && path !== '', path: path || undefined }
}

/**
 * Whether options an extension just set can change the panel docked in a window: only when they are the docked extension's own, and set for every tab
 * or for the tab on screen. Any other call leaves what the tab on screen resolves to as it was, so it must leave the panel as it is. A panel opened for
 * a tab that is not on screen is docked beside the one that is (Browser.openSidePanel): reconciling it after another extension's call, or after a
 * call for a third tab, closed it although nothing about it had changed.
 */
export function optionsReachDockedPanel(set: { extensionId: string; tabKey: string | undefined }, dockedExtensionId: string, shownTabKey: string | undefined): boolean {
  return set.extensionId === dockedExtensionId && (set.tabKey === undefined || set.tabKey === shownTabKey)
}

/**
 * A panel path is relative to the extension: absolute URLs and traversal must never reach the loader. The one absolute form that is let in is the address of
 * the extension's own page (`chrome.runtime.getURL(...)`), which the `chrome.sidePanel` API takes as it is and Merci gives: it is cut back to the path it names, so that nothing but
 * a file of the extension is ever loaded (an address of another extension, or of anything else, still comes out as no panel).
 */
export function panelUrl(extensionId: string, path: string): string | null {
  if (!/^[a-p]{32}$/.test(extensionId)) return null
  const own = `chrome-extension://${extensionId}/`
  const relative = (path.startsWith(own) ? path.slice(own.length) : path).replace(/^\/+/, '')
  if (relative === '' || /^[a-z][a-z0-9+.-]*:/i.test(relative) || relative.split('/').includes('..')) return null
  return `chrome-extension://${extensionId}/${relative}`
}

/** The message of a panel refused over a private tab: what an extension that asked for it is told. */
export const PRIVATE_PANEL_REFUSAL = 'A side panel does not open over a private tab or in a private window.'

/**
 * The profile a panel opened for a tab belongs to: the profile of the tab's space (of the space on screen when no tab is known). Null over a
 * private tab and in a private window: no extension lives there, and a panel docked beside such a tab would be told its number (`onOpened`) and
 * sit over a page no extension is given.
 */
export function panelProfile(
  state: { activeSpaceId: string; spaces: ReadonlyArray<{ id: string; profileId: string }> },
  tab: { spaceId: string; private?: boolean | undefined } | undefined,
  privateWindow: boolean
): string | null {
  if (privateWindow || tab?.private === true) return null
  return state.spaces.find((space) => space.id === (tab?.spaceId ?? state.activeSpaceId))?.profileId ?? 'default'
}

/** A panel docked in a window, with the profile of the tab it was opened for. */
export interface DockedPanel {
  extensionId: string
  path: string
  profileId: string
  windowId: number
}

/**
 * The panels `chrome.runtime.getContexts` reports to an extension: its own, in the windows where it is docked, for its profile only. The same
 * extension (one folder, or one Web Store extension installed twice) can have a panel open in a window of each profile; each copy hears of its own.
 */
export function panelContextsOf(open: readonly DockedPanel[], extensionId: string, profileId: string): Array<{ documentUrl: string; windowId: number }> {
  return open.flatMap((panel) => {
    const documentUrl = panel.extensionId === extensionId && panel.profileId === profileId ? panelUrl(panel.extensionId, panel.path) : null
    return documentUrl ? [{ documentUrl, windowId: panel.windowId }] : []
  })
}

