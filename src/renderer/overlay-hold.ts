// A panel that is writing something that cannot be stopped half way (an import being brought in) holds the layer: Escape and a click outside do
// not close it until the work is over. The panel greys its own way out for the same time; this is for the ways out the host owns.

let holds = 0

/** Holds the layer open; the function returned lets it go (once). */
export function holdOverlay(): () => void {
  holds++
  let held = true
  return () => {
    if (!held) return
    held = false
    holds--
  }
}

/** Whether a panel asked that the layer stays open for now. */
export function overlayHeld(): boolean {
  return holds > 0
}
