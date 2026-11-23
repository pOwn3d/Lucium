// What the application does when its windows are gone or hidden. Pure: main/index.ts hands in what it reads
// from Electron and does what these rules answer.

/**
 * What closing the last window does. macOS keeps the application running with no window, as its other applications do (⌘Q quits it); everywhere else
 * the application quits.
 */
export function lastWindowClosedStep(platform: string): 'keep-running' | 'quit' {
  return platform === 'darwin' ? 'keep-running' : 'quit'
}

/**
 * What closing the main window (the red button, ⇧⌘W, an extension) does. The main window holds what the whole session runs on (the hooks of the
 * engine, the downloads, the menus, the way back of the mini windows): on macOS, where the application outlives its windows, it is put away
 * (hidden, its pages dropped, the other windows closed with it as before) and comes back from the Dock, ⌘N, a link of another application or a
 * menu entry. Destroying it left a record the menus and the Dock kept using ("Object has been destroyed" at each click). Once the quit is decided,
 * and on the other systems (where closing the last window quits), it closes for real.
 */
export function mainCloseStep(platform: string, quitting: boolean): 'put-away' | 'close' {
  return !quitting && lastWindowClosedStep(platform) === 'keep-running' ? 'put-away' : 'close'
}

/** What the application knows of one of its windows. */
export interface WindowFacts {
  destroyed: boolean
  visible: boolean
  minimized: boolean
}

/**
 * What a click on the icon of the Dock does (the `activate` event, which also fires at launch). `nothing`: a window is on screen already. `open-window`:
 * every window was closed, the last one cannot be shown again, so a new one opens. `show-last`: the windows are minimized or hidden, the last one comes back.
 */
export function dockClickStep(windows: readonly WindowFacts[]): 'nothing' | 'open-window' | 'show-last' {
  if (windows.some((win) => !win.destroyed && win.visible && !win.minimized)) return 'nothing'
  if (windows.every((win) => win.destroyed)) return 'open-window'
  return 'show-last'
}

/** A window as the Dock click sees it: what the application knows of it, and the id that finds it again (the id of its record). */
export interface DockWindowFacts extends WindowFacts {
  id: string
}

/** What a click on the icon of the Dock does to the windows: `open` a new one (every window is gone), or `raise` these ones, in this order. */
export interface DockClickPlan {
  open: boolean
  raise: string[]
}

/**
 * What a click on the icon of the Dock does (macOS only: the Dock does not exist elsewhere). Every window that is not destroyed comes back to the front,
 * whether it sat behind another application, was minimized or was hidden, as the Dock of other applications does; the last used one is raised last, so that
 * it ends on top and keeps the keyboard focus. The event also fires at launch: the windows are on screen already then and raising them changes nothing, and
 * a new window opens only when none is left, as `dockClickStep` says. A locked window comes back too: the lock screen covers it, it shows nothing more.
 */
export function dockClickPlan(platform: string, windows: readonly DockWindowFacts[], lastUsedId: string): DockClickPlan {
  if (platform !== 'darwin') return { open: false, raise: [] }
  if (dockClickStep(windows) === 'open-window') return { open: true, raise: [] }
  const alive = windows.filter((win) => !win.destroyed)
  const rest = alive.filter((win) => win.id !== lastUsedId)
  const last = alive.filter((win) => win.id === lastUsedId)
  return { open: false, raise: [...rest, ...last].map((win) => win.id) }
}
