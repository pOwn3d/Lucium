/**
 * Starts a drag from a pointerdown. Listens on the window rather than relying on pointer capture, which Chromium drops
 * when the layout changes under the pointer. `onMove` is throttled; the final position is always delivered.
 *
 * The drag ends when the button is released, and also when the release can no longer arrive here: the system cancels the pointer
 * (`pointercancel`), or the window stops being the one in front (`blur`: another application was brought forward with the button held, and the
 * button is released there). Without those ends every later move of the pointer, no button held, went on resizing what was dragged.
 */
export function startDrag(onMove: (event: PointerEvent) => void): void {
  const INTERVAL_MS = 14
  let last = 0
  let pending: PointerEvent | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (pending) onMove(pending)
    pending = null
    last = performance.now()
  }
  const move = (event: PointerEvent) => {
    pending = event
    if (performance.now() - last >= INTERVAL_MS) flush()
    else if (!timer) timer = setTimeout(flush, INTERVAL_MS)
  }
  const end = () => {
    flush()
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    window.removeEventListener('blur', end)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  window.addEventListener('blur', end)
}
