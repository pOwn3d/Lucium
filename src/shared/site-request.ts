import type { OverlayRequest } from './ipc'

/** The request for the panel of the site from the strip of a split pane: it hangs from that strip, not from the window's right edge (which is the other pane's). */
export function siteRequest(strip: { getBoundingClientRect(): { x: number; y: number; width: number; height: number } } | null): OverlayRequest {
  if (!strip) return { panel: 'site' }
  const { x, y, width, height } = strip.getBoundingClientRect()
  return { panel: 'site', anchor: { x, y, width, height } }
}
