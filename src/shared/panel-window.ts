// The background of the windows of their own that are drawn by the tokens (Réglages, Extensions, the task manager): what shows at the edges while the
// window is resized, and before the page has painted. It follows the appearance like the page does, so a light window does not
// open on a dark ground. The two values are `--surface-2` of tokens.css at the default hue; a test keeps them equal.

export const PANEL_WINDOW_BACKGROUND = { light: '#f6f6f9', dark: '#262932' } as const

/** The colour to give `backgroundColor` for a window of this appearance (`nativeTheme.shouldUseDarkColors`). */
export const panelWindowBackground = (dark: boolean): string => (dark ? PANEL_WINDOW_BACKGROUND.dark : PANEL_WINDOW_BACKGROUND.light)
