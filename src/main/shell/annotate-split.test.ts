// The split view of the annotation: the bar goes on the left edge of the pane of the page that has the focus. The button « Annoter » in the strip of the
// focused pane is drawn for real in renderer/annotate-split-pane.test.ts.

import { describe, expect, it } from 'vitest'
import { paneOnScreen } from '@shared/page-annotate'

describe('the annotation in a split view', () => {
  // Two panes side by side in a stage that starts 40 points under the top of the content area, itself placed at (100, 50) on the screen.
  const content = { x: 100, y: 50, width: 1200, height: 800 }
  const stage = { x: 200, y: 40, width: 1000, height: 760 }
  const panes = [
    { x: 0, y: 0, width: 500, height: 760 },
    { x: 500, y: 0, width: 500, height: 760 }
  ]

  // Guard: the bar goes on the left edge of the pane of the page it annotates, when the page is in a split view.
  it('the bar follows the pane of the page that has the focus', () => {
    expect(paneOnScreen(content, stage, panes, 0)).toEqual({ x: 300, y: 90, width: 500, height: 760 })
    expect(paneOnScreen(content, stage, panes, 1)).toEqual({ x: 800, y: 90, width: 500, height: 760 })
  })

  it('has no pane for a page that is not in the layout, and the bar then stays on the window', () => {
    expect(paneOnScreen(content, stage, panes, -1)).toBeNull()
    expect(paneOnScreen(content, stage, panes, 2)).toBeNull()
    expect(paneOnScreen(content, stage, [], 0)).toBeNull()
  })
})
