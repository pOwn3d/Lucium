// The sizes the main process and the interface must agree on (the heights of the bars, the margins, the place of the window buttons,
// the boxes of the find panels, the tooltip) and the styles of the find highlights. Moved out of ipc.ts as they were; ipc.ts still
// exports them.



/**
 * Height of the header of the mini window drawn by its own UI, above the page: 40 px with the traffic lights, the
 * page's icon, title and address, "Ouvrir dans" and the pin. The banner of the archiving delay is under it: `LITTLE_STRIP_HEIGHT`.
 */
export const LITTLE_HEADER_HEIGHT = 40

/** The banner under the header ("Fermée et archivée après 12 h sans activité", with the link to the setting); the page starts under both. */
export const LITTLE_STRIP_HEIGHT = 28

/** Height of the header of an application window (setting `webAppWindows`), drawn by the UI of the mini window's page (`app` mode) above the page. */
export const WEB_APP_HEADER_HEIGHT = 38

/** Gap between the window edge and the page card (top, right, bottom). */
export const PAGE_MARGIN = 10

/** How long the floating sidebar takes to leave: the panel is gone ≈ 0.10 s after the pointer leaves it. */
export const FLOAT_LEAVE_MS = 110

/**
 * Where the native traffic lights go (top-left corner of the first one). The design has 16 px lights 23 px apart, centred on x = 20, 43, 66
 * and y = 24; the system's are 14 px, 20 px apart and cannot be spaced differently, so the group is centred on the middle one (x = 43): the
 * lights sit within 3 px of the design.
 */
export const TRAFFIC_LIGHTS = { x: 16, y: 17 } as const

/** The floating sidebar is inset this far from the window's left, top and bottom edges; the traffic lights move with it. */
export const FLOATING_INSET = 5

/** Height of the toolbar bar itself above the page (32 px: y = 10 → 42). */
export const TOOLBAR_BAR_HEIGHT = 32

/**
 * Where the page starts under a LIGHT toolbar: the 32 px bar and the 1 px line that closes it (#f2f2f2 on white).
 * Under a dark bar there is no line and the page starts one row higher (see `toolbarIsLight`).
 */
export const TOOLBAR_HEIGHT = 33

/** Height of the strip above the side panel (extension name and close button), drawn by the sidebar UI. */
export const SIDE_PANEL_HEADER_HEIGHT = 40

/** Height of the Glance header drawn by the overlay above the previewed page: 40 px with the page's icon and title, its address and the named actions. */
export const PEEK_HEADER_HEIGHT = 40

/**
 * Find-in-page panel: 300 x 32, 17 px under the top of the page card and 10 px from its right
 * edge. `shadow` is the transparent margin kept around it inside its overlay view so the drop shadow is not clipped.
 */
export const FIND_PANEL = { width: 300, height: 32, top: 17, right: 10, shadow: 10 } as const

/** The find panel when the setting `findRegex` adds its buttons (".*", case, whole words, accents): the same, wider. */
export const FIND_PANEL_WIDE = { ...FIND_PANEL, width: 404 } as const

/** Find and Replace: the find panel's width, two fields tall (built from the find panel's cotes). */
export const FIND_REPLACE_PANEL = { width: 300, height: 70, top: 17, right: 10, shadow: 10 } as const

/** Match colours (Chromium's own are brighter): olive for every match, orange for the current one. */
export const FIND_HIGHLIGHT_CSS = '::search-text { background-color: #a5a623; color: #000 } ::search-text:current { background-color: #ff9633; color: #000 }'

/** The same colours for the regular-expression search, which paints with the CSS Custom Highlight API instead of Chromium's find (names: main/engine/regex-find.ts). */
export const REGEX_HIGHLIGHT_CSS = '::highlight(lucium-find) { background-color: #a5a623; color: #000 } ::highlight(lucium-find-current) { background-color: #ff9633; color: #000 }'

/** The tooltip capsule: 29 px tall, 1.0 s after the pointer rests. */
export const TOOLTIP = { height: 29, delayMs: 1000, offsetX: 9, offsetY: 6, shadow: 12 } as const
