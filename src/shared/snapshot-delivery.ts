// Which surfaces are sent a snapshot at each publish. The snapshot is cloned into every window that receives it: a surface that draws nothing
// does not need it.

/**
 * Whether the floating sidebar is sent the snapshot now. It is while it shows (`floating` is in the snapshot), and once more at the publish
 * after it stopped showing, so that it draws nothing; while it stays hidden, it gets nothing.
 */
export function floatingNeedsSnapshot(showingNow: boolean, shownAtLastPublish: boolean): boolean {
  return showingNow || shownAtLastPublish
}

/**
 * Whether the layer of panels (the command bar, the panels, Glance's header) is sent the snapshot at a publish: only while a panel is open. A
 * closed layer is out of the window and draws nothing; the state it missed is sent once, when the next panel opens, before the panel.
 */
export function overlayNeedsSnapshot(panelOpen: boolean): boolean {
  return panelOpen
}
